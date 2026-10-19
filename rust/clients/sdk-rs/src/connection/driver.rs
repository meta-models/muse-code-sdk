use std::collections::{HashMap, VecDeque};
use std::future::poll_fn;
use std::io;
use std::task::Poll;

use tokio::sync::{broadcast, mpsc, oneshot, watch};

use crate::DuplexTransport;
use crate::errors::ErrorCode;
use crate::msp::{
    ErrorData, ErrorObject, ErrorResponse, JsonRpcVersion, Notification, Request, RequestId,
    SuccessResponse,
};

use super::framing::NdjsonDecoder;
use super::matching::{DisplayRequestId, RequestKey};
use super::{
    ConnectionError, MspError, NotificationDispatch, OutboundMessage, ProtocolError, RequestResult,
};

pub(super) async fn write_or_shutdown<T>(
    transport: &mut T,
    frame: &str,
    shutdown: &mut watch::Receiver<bool>,
) -> Option<io::Result<()>>
where
    T: DuplexTransport,
{
    if *shutdown.borrow() {
        return None;
    }
    tokio::select! {
        biased;
        _ = shutdown.changed() => None,
        result = transport.write(frame) => Some(result),
    }
}

/// The transport loop paired with a [`super::Connection`].
pub struct ConnectionDriver<T> {
    transport: T,
    outbound: mpsc::Receiver<OutboundMessage>,
    notifications: broadcast::Sender<Notification>,
    notification_dispatch: Option<NotificationDispatch>,
    protocol_errors: broadcast::Sender<ProtocolError>,
    shutdown: watch::Receiver<bool>,
    closed: watch::Sender<bool>,
    pending: HashMap<RequestKey, oneshot::Sender<RequestResult>>,
    decoder: NdjsonDecoder,
    /// Answers to server-initiated requests from the chunk being handled,
    /// written in arrival order before the next transport read.
    server_request_replies: VecDeque<String>,
}

impl<T> ConnectionDriver<T>
where
    T: DuplexTransport,
{
    pub(super) fn new(
        transport: T,
        outbound: mpsc::Receiver<OutboundMessage>,
        notifications: broadcast::Sender<Notification>,
        notification_dispatch: Option<NotificationDispatch>,
        protocol_errors: broadcast::Sender<ProtocolError>,
        shutdown: watch::Receiver<bool>,
        closed: watch::Sender<bool>,
    ) -> Self {
        Self {
            transport,
            outbound,
            notifications,
            notification_dispatch,
            protocol_errors,
            shutdown,
            closed,
            pending: HashMap::new(),
            decoder: NdjsonDecoder::default(),
            server_request_replies: VecDeque::new(),
        }
    }

    pub(super) fn closed_sender(&self) -> watch::Sender<bool> {
        self.closed.clone()
    }

    /// Runs until every request handle is dropped or the transport closes.
    pub async fn run(mut self) {
        let mut prefer_inbound = false;
        let mut drain_notifications = false;
        'driver: loop {
            let event = next_driver_event(
                &mut self.transport,
                &mut self.outbound,
                &mut self.shutdown,
                prefer_inbound,
            )
            .await;
            prefer_inbound = !prefer_inbound;
            match event {
                DriverEvent::Outbound(Some(OutboundMessage::Request(request))) => {
                    let key = RequestKey::from(&request.id);
                    self.pending.insert(key.clone(), request.response);
                    match write_or_shutdown(&mut self.transport, &request.frame, &mut self.shutdown)
                        .await
                    {
                        Some(Ok(())) => {}
                        Some(Err(error)) => {
                            self.fail_transport(error);
                            break;
                        }
                        None => break,
                    }
                }
                DriverEvent::Outbound(Some(OutboundMessage::Notification { frame, submitted })) => {
                    match write_or_shutdown(&mut self.transport, &frame, &mut self.shutdown).await {
                        Some(Ok(())) => {
                            let _ = submitted.send(Ok(()));
                        }
                        Some(Err(error)) => {
                            let kind = error.kind();
                            let message = error.to_string();
                            let _ = submitted.send(Err(ConnectionError::Transport(error)));
                            self.fail_transport(io::Error::new(kind, message));
                            break;
                        }
                        None => {
                            let _ = submitted.send(Err(ConnectionError::Closed));
                            break;
                        }
                    }
                }
                DriverEvent::Shutdown | DriverEvent::Outbound(None) => break,
                DriverEvent::Inbound(Err(error)) => {
                    self.fail_transport(error);
                    break;
                }
                DriverEvent::Inbound(Ok(None)) => {
                    if let Some(trailing_bytes) = self.decoder.truncated_frame_byte_len() {
                        let error = ProtocolError::new(
                            format!(
                                "inbound stream ended with a truncated frame of {trailing_bytes} bytes"
                            ),
                            None,
                        );
                        self.fail_protocol(error.clone());
                        self.report(error);
                    }
                    drain_notifications = true;
                    break;
                }
                DriverEvent::Inbound(Ok(Some(chunk))) => {
                    for line in self.decoder.push(&chunk) {
                        if !self.handle_line(line) {
                            drain_notifications = true;
                            break 'driver;
                        }
                    }
                    while let Some(reply) = self.server_request_replies.pop_front() {
                        match write_or_shutdown(&mut self.transport, &reply, &mut self.shutdown)
                            .await
                        {
                            Some(Ok(())) => {}
                            Some(Err(error)) => {
                                self.fail_transport(error);
                                break 'driver;
                            }
                            None => break 'driver,
                        }
                    }
                }
            }
        }
        // EOF and dispatch-cap refusal settle pending requests only after
        // already-accepted notifications apply. Explicit close must remain
        // independent of a wedged handler, so other exits do not await it.
        if drain_notifications && self.notification_dispatch.take().is_some() {
            let mut dispatch_closed = self.closed.subscribe();
            if !*dispatch_closed.borrow() && !*self.shutdown.borrow() {
                tokio::select! {
                    biased;
                    _ = self.shutdown.changed() => {}
                    _ = dispatch_closed.changed() => {}
                }
            }
        } else if self.notification_dispatch.is_none() {
            let _ = self.closed.send(true);
        }
    }

    fn handle_line(&mut self, raw_line: String) -> bool {
        let line = raw_line.strip_suffix('\r').unwrap_or(&raw_line);
        if line.trim().is_empty() {
            return true;
        }
        let value = match serde_json::from_str::<serde_json::Value>(line) {
            Ok(value) => value,
            Err(_) => {
                self.report(ProtocolError::new(
                    "inbound frame is not valid JSON",
                    Some(line),
                ));
                return true;
            }
        };
        let Some(object) = value.as_object() else {
            self.report(ProtocolError::new(
                "inbound frame is not a JSON-RPC 2.0 object",
                Some(line),
            ));
            return true;
        };
        if object.get("jsonrpc") != Some(&serde_json::Value::String("2.0".to_owned())) {
            self.report(ProtocolError::new(
                "inbound frame is not a JSON-RPC 2.0 object",
                Some(line),
            ));
            return true;
        }
        if object.get("method").is_some() && object.get("id").is_none() {
            match serde_json::from_value::<Notification>(value) {
                Ok(notification) => {
                    if let Some(dispatch) = &self.notification_dispatch
                        && !dispatch.try_send(notification.clone())
                    {
                        return false;
                    }
                    let _ = self.notifications.send(notification);
                }
                Err(_) => self.report(ProtocolError::new(
                    "inbound frame is not a valid notification",
                    Some(line),
                )),
            }
            return true;
        }
        // Server-initiated requests use the server's own id space, so they
        // must never be matched against our pending ids.
        if object.contains_key("method") {
            match serde_json::from_value::<Request>(value) {
                Ok(request) if !matches!(request.id, RequestId::Integer(id) if id > 0) => {
                    self.report(ProtocolError::new(
                        "server request id must be a positive integer",
                        Some(line),
                    ));
                }
                // A client-owned connection routes approvals and user-input
                // questions to their session in order with its view events; the
                // reply is only the presentation receipt.
                Ok(request)
                    if matches!(
                        request.method.as_str(),
                        APPROVAL_REQUEST_METHOD | USER_INPUT_REQUEST_METHOD
                    ) && self.notification_dispatch.is_some() =>
                {
                    let receipt = presentation_receipt(&request.id);
                    let routed = Notification {
                        jsonrpc: JsonRpcVersion::V2,
                        method: request.method,
                        params: request.params,
                        emitted_at_ms: None,
                    };
                    if let Some(dispatch) = &self.notification_dispatch
                        && !dispatch.try_send(routed)
                    {
                        return false;
                    }
                    self.queue_reply(receipt);
                }
                Ok(request) => self.queue_reply(method_not_found(request)),
                Err(_) => self.report(ProtocolError::new(
                    "inbound frame is not a valid server request",
                    Some(line),
                )),
            }
            return true;
        }
        let Some(id_value) = object.get("id") else {
            self.report(ProtocolError::new("response has no usable id", Some(line)));
            return true;
        };
        let id = match serde_json::from_value::<RequestId>(id_value.clone()) {
            Ok(id) => id,
            Err(_) => {
                self.report(ProtocolError::new("response has no usable id", Some(line)));
                return true;
            }
        };
        let key = RequestKey::from(&id);
        let Some(response) = self.pending.remove(&key) else {
            self.report(ProtocolError::new(
                format!("response for unknown request id {}", DisplayRequestId(&id)),
                Some(line),
            ));
            return true;
        };

        let has_result = object.contains_key("result");
        let has_error = object.contains_key("error");
        if has_result == has_error {
            let error = ProtocolError::new(
                "response must carry exactly one of result or error",
                Some(line),
            );
            let _ = response.send(Err(error.clone().into()));
            self.report(error);
            return true;
        }

        if has_result {
            match serde_json::from_value::<SuccessResponse>(value) {
                Ok(success) => {
                    let _ = response.send(Ok(success.result));
                }
                Err(_) => {
                    let error = ProtocolError::new("response result must be an object", Some(line));
                    let _ = response.send(Err(error.clone().into()));
                    self.report(error);
                }
            }
            return true;
        }

        match serde_json::from_value::<ErrorResponse>(value) {
            Ok(failure) => match MspError::try_from(failure.error) {
                Ok(error) => {
                    let _ = response.send(Err(error.into()));
                }
                Err(error) => {
                    let _ = response.send(Err(error.clone().into()));
                    self.report(error);
                }
            },
            Err(_) => {
                let error =
                    ProtocolError::new("error response has an invalid error object", Some(line));
                let _ = response.send(Err(error.clone().into()));
                self.report(error);
            }
        }
        true
    }

    fn queue_reply(&mut self, reply: Result<String, serde_json::Error>) {
        match reply {
            Ok(reply) => self.server_request_replies.push_back(reply),
            Err(error) => self.report(ProtocolError::new(
                format!("server request reply could not be encoded: {error}"),
                None,
            )),
        }
    }

    fn report(&self, error: ProtocolError) {
        let _ = self.protocol_errors.send(error);
    }

    fn fail_protocol(&mut self, error: ProtocolError) {
        for (_, response) in self.pending.drain() {
            let _ = response.send(Err(ConnectionError::Protocol(error.clone())));
        }
    }

    fn fail_transport(&mut self, error: io::Error) {
        // `io::Error` is not cloneable; every waiter receives the same stable
        // ErrorKind while the text remains diagnostic-only context.
        let kind = error.kind();
        let message = error.to_string();
        for (_, response) in self.pending.drain() {
            let _ = response.send(Err(ConnectionError::Transport(io::Error::new(
                kind,
                message.clone(),
            ))));
        }
    }
}

enum DriverEvent {
    Shutdown,
    Outbound(Option<OutboundMessage>),
    Inbound(io::Result<Option<String>>),
}

async fn next_driver_event<T>(
    transport: &mut T,
    outbound: &mut mpsc::Receiver<OutboundMessage>,
    shutdown: &mut watch::Receiver<bool>,
    prefer_inbound: bool,
) -> DriverEvent
where
    T: DuplexTransport,
{
    if *shutdown.borrow() {
        return DriverEvent::Shutdown;
    }
    let mut shutdown_changed = Box::pin(shutdown.changed());
    let mut receive = Box::pin(outbound.recv());
    let mut read = transport.read_chunk();
    poll_fn(move |context| {
        if shutdown_changed.as_mut().poll(context).is_ready() {
            return Poll::Ready(DriverEvent::Shutdown);
        }
        if prefer_inbound {
            if let Poll::Ready(chunk) = read.as_mut().poll(context) {
                return Poll::Ready(DriverEvent::Inbound(chunk));
            }
            receive.as_mut().poll(context).map(DriverEvent::Outbound)
        } else {
            if let Poll::Ready(request) = receive.as_mut().poll(context) {
                return Poll::Ready(DriverEvent::Outbound(request));
            }
            read.as_mut().poll(context).map(DriverEvent::Inbound)
        }
    })
    .await
}

const APPROVAL_REQUEST_METHOD: &str = "approval/request";
const USER_INPUT_REQUEST_METHOD: &str = "userInput/request";

/// The presentation receipt: "a surface showed or will show this".
fn presentation_receipt(id: &RequestId) -> Result<String, serde_json::Error> {
    let reply = SuccessResponse {
        jsonrpc: JsonRpcVersion::V2,
        id: id.clone(),
        result: serde_json::Map::new(),
    };
    let mut frame = serde_json::to_string(&reply)?;
    frame.push('\n');
    Ok(frame)
}

/// The TypeScript/Python connections' answer to a server request no handler
/// claims; the host treats any reply as presentation-only.
fn method_not_found(request: Request) -> Result<String, serde_json::Error> {
    let code = ErrorCode::MethodNotFound;
    let reply = ErrorResponse {
        jsonrpc: JsonRpcVersion::V2,
        id: Some(request.id),
        error: ErrorObject {
            code: code.code(),
            message: format!("method not found: {}", request.method),
            data: Some(Box::new(ErrorData {
                retryable: code.retryable(),
                ..ErrorData::new(code.kind())
            })),
        },
    };
    let mut frame = serde_json::to_string(&reply)?;
    frame.push('\n');
    Ok(frame)
}
