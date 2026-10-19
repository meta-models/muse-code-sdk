//! MSP NDJSON framing and request matching.

mod dispatch;
mod driver;
mod error;
mod framing;
mod handshake;
mod matching;
mod stdio;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::{OwnedSemaphorePermit, Semaphore, broadcast, mpsc, oneshot, watch};

use crate::DuplexTransport;
use crate::msp::{JsonRpcVersion, Notification, Request, RequestId};

pub use driver::ConnectionDriver;
pub use error::ConnectionError;

pub use crate::errors::{MspError, ProtocolError};

#[cfg(test)]
use stdio::PipeTransport;
pub use stdio::StdioTransport;

const OUTBOUND_CAPACITY: usize = 64;
const PROTOCOL_ERROR_CAPACITY: usize = 32;
const NOTIFICATION_CAPACITY: usize = 64;
// Bounds live notifications waiting to be routed. The client router's pending
// total (`MAX_PENDING_NOTIFICATIONS_TOTAL`) covers only sessions that have not
// registered yet and is this same constant.
pub(crate) const NOTIFICATION_HANDLER_CAPACITY: usize = 1_024;
// Under contention, a session holding this many handoff permits gets no new
// one. The client router's per-session pending bound
// (`MAX_PENDING_NOTIFICATIONS_PER_SESSION`) is this same constant.
pub(crate) const NOTIFICATION_SESSION_SHARE: usize = 256;
// Every queued item keeps its normal permit or per-session overflow marker
// while it is in the channel, so the channel holds at most the handler
// capacity in normal notifications, the same number of overflow markers, and
// one FIFO slot for the global (saturated) marker. A send that holds its permit
// or marker therefore never finds it full (`debug_assert_dispatch_capacity`).
const NOTIFICATION_DISPATCH_CAPACITY: usize = NOTIFICATION_HANDLER_CAPACITY * 2 + 1;

type RequestResult = Result<serde_json::Map<String, serde_json::Value>, ConnectionError>;

struct OutboundRequest {
    id: RequestId,
    frame: String,
    response: oneshot::Sender<RequestResult>,
}

enum OutboundMessage {
    Request(OutboundRequest),
    Notification {
        frame: String,
        submitted: oneshot::Sender<Result<(), ConnectionError>>,
    },
}

type NotificationHandler = Arc<dyn Fn(Notification) + Send + Sync>;

enum NotificationDispatchItem {
    Notification {
        notification: Notification,
        permit: SessionPermit,
    },
    Overflow {
        notification: Notification,
        marker: OverflowMarker,
    },
}

// Handoff permits held per session. A session has an entry
// only while it holds at least one permit.
type SessionPermits = Arc<Mutex<HashMap<String, usize>>>;

// One handoff permit, counted against its frame's session if it has one.
// Dropping it releases both.
struct SessionPermit {
    session: Option<(String, SessionPermits)>,
    _permit: OwnedSemaphorePermit,
}

enum OverflowMarker {
    Session(String),
    Saturated,
}

#[derive(Default)]
struct SaturatedOverflow {
    queued: bool,
    sessions: HashSet<String>,
    pending: VecDeque<Notification>,
    // The frame refused at the cap; reported after the accepted drain.
    refused: Option<Notification>,
}

pub(super) struct NotificationDispatch {
    queue: mpsc::Sender<NotificationDispatchItem>,
    // Notifications queued for the handler, counted after each send; overflow
    // markers are not counted.
    accepted: Arc<AtomicU64>,
    notification_capacity: Arc<Semaphore>,
    session_permits: SessionPermits,
    queued_overflows: Arc<Mutex<HashSet<String>>>,
    saturated_overflow: Arc<Mutex<SaturatedOverflow>>,
}

pub(crate) struct NotificationDispatcher {
    queue: mpsc::Receiver<NotificationDispatchItem>,
    // Counted notifications the handler has finished, in queue order.
    applied: watch::Sender<u64>,
    handler: NotificationHandler,
    overflow: NotificationHandler,
    queued_overflows: Arc<Mutex<HashSet<String>>>,
    saturated_overflow: Arc<Mutex<SaturatedOverflow>>,
    closed: watch::Sender<bool>,
}

fn notification_session_id(notification: &Notification) -> Option<&str> {
    notification
        .params
        .as_ref()
        .and_then(|params| params.get("sessionId"))
        .and_then(serde_json::Value::as_str)
}

fn lock_notification_overflows(queued: &Mutex<HashSet<String>>) -> MutexGuard<'_, HashSet<String>> {
    match queued.lock() {
        Ok(queued) => queued,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn lock_session_permits(
    held: &Mutex<HashMap<String, usize>>,
) -> MutexGuard<'_, HashMap<String, usize>> {
    match held.lock() {
        Ok(held) => held,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn lock_saturated_overflow(
    saturated: &Mutex<SaturatedOverflow>,
) -> MutexGuard<'_, SaturatedOverflow> {
    match saturated.lock() {
        Ok(saturated) => saturated,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Cloneable request handle for one MSP transport.
///
/// [`Connection::new`] also returns a [`ConnectionDriver`]. The caller drives
/// that future on its own executor; this crate never creates or blocks an async
/// runtime.
#[derive(Clone)]
pub struct Connection {
    outbound: mpsc::Sender<OutboundMessage>,
    handoff: Option<NotificationHandoff>,
    notifications: broadcast::Sender<Notification>,
    protocol_errors: broadcast::Sender<ProtocolError>,
    shutdown: watch::Sender<bool>,
    closed: watch::Receiver<bool>,
    next_request_id: Arc<AtomicI64>,
}

impl Connection {
    /// Builds a request handle and its caller-driven transport loop.
    #[must_use]
    pub fn new<T>(transport: T) -> (Self, ConnectionDriver<T>)
    where
        T: DuplexTransport,
    {
        Self::build(transport, None)
    }

    pub(crate) fn with_notification_handler<T, F, G>(
        transport: T,
        handler: F,
        overflow: G,
    ) -> (Self, ConnectionDriver<T>, NotificationDispatcher)
    where
        T: DuplexTransport,
        F: Fn(Notification) + Send + Sync + 'static,
        G: Fn(Notification) + Send + Sync + 'static,
    {
        let handler: NotificationHandler = Arc::new(handler);
        let overflow: NotificationHandler = Arc::new(overflow);
        let queued_overflows = Arc::new(Mutex::new(HashSet::new()));
        let saturated_overflow = Arc::new(Mutex::new(SaturatedOverflow::default()));
        let (notification_queue, notifications) = mpsc::channel(NOTIFICATION_DISPATCH_CAPACITY);
        let accepted = Arc::new(AtomicU64::new(0));
        let (applied, applied_watch) = watch::channel(0);
        let dispatch = NotificationDispatch {
            queue: notification_queue,
            accepted: Arc::clone(&accepted),
            notification_capacity: Arc::new(Semaphore::new(NOTIFICATION_HANDLER_CAPACITY)),
            session_permits: SessionPermits::default(),
            queued_overflows: Arc::clone(&queued_overflows),
            saturated_overflow: Arc::clone(&saturated_overflow),
        };
        let (mut connection, driver) = Self::build(transport, Some(dispatch));
        connection.handoff = Some(NotificationHandoff {
            accepted,
            applied: applied_watch,
        });
        let closed = driver.closed_sender();
        (
            connection,
            driver,
            NotificationDispatcher {
                queue: notifications,
                applied,
                handler,
                overflow,
                queued_overflows,
                saturated_overflow,
                closed,
            },
        )
    }

    fn build<T>(
        transport: T,
        notification_dispatch: Option<NotificationDispatch>,
    ) -> (Self, ConnectionDriver<T>)
    where
        T: DuplexTransport,
    {
        let (outbound, outbound_rx) = mpsc::channel(OUTBOUND_CAPACITY);
        let (notifications, _) = broadcast::channel(NOTIFICATION_CAPACITY);
        let (protocol_errors, _) = broadcast::channel(PROTOCOL_ERROR_CAPACITY);
        let (shutdown, shutdown_rx) = watch::channel(false);
        let (closed_tx, closed) = watch::channel(false);
        (
            Self {
                outbound,
                handoff: None,
                notifications: notifications.clone(),
                protocol_errors: protocol_errors.clone(),
                shutdown,
                closed,
                next_request_id: Arc::new(AtomicI64::new(1)),
            },
            ConnectionDriver::new(
                transport,
                outbound_rx,
                notifications,
                notification_dispatch,
                protocol_errors,
                shutdown_rx,
                closed_tx,
            ),
        )
    }

    /// Sends one request and waits for the response carrying the same id.
    ///
    /// A successful transport write means only that the frame was submitted.
    /// This future remains pending until the matching result or error arrives.
    pub async fn request(
        &self,
        method: impl Into<String>,
        params: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> RequestResult {
        if *self.shutdown.borrow() {
            return Err(ConnectionError::Closed);
        }
        let id = RequestId::Integer(self.next_request_id.fetch_add(1, Ordering::Relaxed));
        let request = Request {
            jsonrpc: JsonRpcVersion::V2,
            id: id.clone(),
            method: method.into(),
            params,
            trace: None,
        };
        let mut frame = serde_json::to_string(&request).map_err(|error| {
            ConnectionError::Protocol(ProtocolError::new(
                format!("request could not be encoded: {error}"),
                None,
            ))
        })?;
        frame.push('\n');
        let (response, receiver) = oneshot::channel();
        self.outbound
            .send(OutboundMessage::Request(OutboundRequest {
                id,
                frame,
                response,
            }))
            .await
            .map_err(|_| ConnectionError::Closed)?;
        receiver.await.unwrap_or(Err(ConnectionError::Closed))
    }

    /// Submits one fire-and-forget notification to the transport.
    pub async fn notify(
        &self,
        method: impl Into<String>,
        params: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<(), ConnectionError> {
        if *self.shutdown.borrow() {
            return Err(ConnectionError::Closed);
        }
        let notification = Notification {
            jsonrpc: JsonRpcVersion::V2,
            method: method.into(),
            params,
            emitted_at_ms: None,
        };
        let mut frame = serde_json::to_string(&notification).map_err(|error| {
            ConnectionError::Protocol(ProtocolError::new(
                format!("notification could not be encoded: {error}"),
                None,
            ))
        })?;
        frame.push('\n');
        let (submitted, submitted_rx) = oneshot::channel();
        self.outbound
            .send(OutboundMessage::Notification { frame, submitted })
            .await
            .map_err(|_| ConnectionError::Closed)?;
        submitted_rx.await.unwrap_or(Err(ConnectionError::Closed))
    }

    /// Stops the transport loop without waiting for peer-side completion.
    pub async fn close(&self) {
        self.shutdown.send_replace(true);
    }

    /// Subscribes to server notifications received after subscription.
    #[must_use]
    pub fn subscribe_notifications(&self) -> broadcast::Receiver<Notification> {
        self.notifications.subscribe()
    }

    /// Subscribes to non-fatal framing and correlation errors.
    #[must_use]
    pub fn subscribe_protocol_errors(&self) -> broadcast::Receiver<ProtocolError> {
        self.protocol_errors.subscribe()
    }

    pub(crate) fn subscribe_closed(&self) -> watch::Receiver<bool> {
        self.closed.clone()
    }

    /// Returns once the notification handler has finished every notification
    /// queued for it before the call, or once its dispatcher is gone. A caller
    /// that saw a response first therefore finds every notification that
    /// preceded it on the wire handed to the handler; overflow markers are
    /// not counted. A connection with no notification handler returns at
    /// once.
    pub(crate) async fn notifications_received_applied(&self) {
        let Some(handoff) = &self.handoff else {
            return;
        };
        let accepted = handoff.accepted.load(Ordering::Acquire);
        let mut applied = handoff.applied.clone();
        // An error means the dispatcher dropped its sender: nothing more is
        // applied, so there is nothing left to wait for.
        let _ = applied.wait_for(|applied| *applied >= accepted).await;
    }
}

/// The notification handoff's progress, read by callers that must order
/// themselves after the notifications already received.
#[derive(Clone)]
struct NotificationHandoff {
    accepted: Arc<AtomicU64>,
    applied: watch::Receiver<u64>,
}
