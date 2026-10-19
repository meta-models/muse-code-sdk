use std::collections::hash_map::DefaultHasher;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::{Future, poll_fn};
use std::hash::{Hash, Hasher};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::task::Poll;

use super::{
    ClientShared, FacadeError, FacadeResult, connection_error, invalid_frame, lock, protocol_error,
};
use crate::connection::ConnectionError;
use crate::msp::{Notification, SessionDurability};
use crate::session::{Session, SessionInner};
use crate::turn::TurnWaitError;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

mod dispatch;
mod router_state;

impl ClientShared {
    /// Returns once the router has taken every notification queued before the
    /// call. A session applies each one then, unless a pending view-gap fill
    /// holds it back until the fill splices.
    pub(crate) async fn notifications_received_applied(&self) {
        self.connection.notifications_received_applied().await;
    }

    /// Whether `close()` has begun; it is set before close settles any session.
    pub(crate) fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    pub(crate) fn mint_command_id(&self) -> FacadeResult<String> {
        self.ensure_open()?;
        Ok((self.minter)())
    }

    pub(crate) async fn command<P, R>(&self, method: &str, params: &P) -> FacadeResult<R>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        self.ensure_open()?;
        let params = serde_json::to_value(params).map_err(invalid_frame)?;
        let params = params
            .as_object()
            .cloned()
            .ok_or_else(|| protocol_error("request params are not an object"))?;
        self.ensure_open()?;
        let request = self.connection.request(method, Some(params));
        let result = self.await_or_closed(request).await?;
        let result = match result {
            Ok(result) => result,
            Err(ConnectionError::Closed) => {
                self.mark_transport_ended();
                return Err(FacadeError::TransportEnded);
            }
            Err(error) => return Err(connection_error(error)),
        };
        serde_json::from_value(Value::Object(result)).map_err(invalid_frame)
    }

    async fn await_or_closed<F, T>(&self, future: F) -> FacadeResult<T>
    where
        F: Future<Output = T>,
    {
        self.ensure_open()?;
        let mut close_rx = self.close_tx.subscribe();
        let mut future = Box::pin(future);
        let mut closed = Box::pin(close_rx.changed());
        poll_fn(|context| {
            if self.closed.load(Ordering::Acquire) {
                return Poll::Ready(Err(FacadeError::ClientClosed));
            }
            if closed.as_mut().poll(context).is_ready() {
                return Poll::Ready(Err(FacadeError::ClientClosed));
            }
            match future.as_mut().poll(context) {
                Poll::Ready(_) if self.closed.load(Ordering::Acquire) => {
                    Poll::Ready(Err(FacadeError::ClientClosed))
                }
                Poll::Ready(output) => Poll::Ready(Ok(output)),
                Poll::Pending => Poll::Pending,
            }
        })
        .await
    }

    /// Whether this client already registered `session_id` or sent a resume
    /// or a named start for it; records the id either way.
    pub(super) fn note_open(&self, session_id: &str) -> bool {
        let (reopened, live) = {
            let mut state = lock(&self.router.state);
            let count = state.opened.entry(session_id.to_owned()).or_insert(0);
            *count += 1;
            let reopened = *count > 1;
            let live = state
                .sessions
                .get(session_id)
                .and_then(|route| route.session.upgrade());
            (reopened, live)
        };
        // This open's replay can repeat events into the live `Session`, even
        // if its caller drops it, so that fold cannot claim to be current.
        // Marked outside the router lock: it takes the fold's lock.
        if let Some(live) = live {
            live.mark_fold_reopened();
        }
        reopened
    }

    /// Undoes one `note_open` for an open the host refused: a refused resume
    /// leaves no subscription behind.
    pub(super) fn forget_open(&self, session_id: &str) {
        let mut state = lock(&self.router.state);
        if let Some(count) = state.opened.get_mut(session_id) {
            *count -= 1;
            if *count == 0 {
                state.opened.remove(session_id);
            }
        }
    }

    pub(super) fn register(&self, session: &Session, reopened: bool) {
        // `close()` and the transport-end sweep each settle the sessions in
        // their router snapshot; an open whose reply returned first can
        // register after either. Both sides decide under the router lock, so
        // exactly one settles each session, the same way: this one only when
        // that snapshot never saw it, and then without routing it. It never
        // takes the frames or loss queued for its id, so its fold cannot claim
        // to be whole. When both snapshots came first, it settles as the
        // earlier one settled its routed peers: the first failure wins.
        let registration = self.router.register(session, reopened);
        if registration == Registration::Routed {
            return;
        }
        let Some(inner) = session.downgrade().upgrade() else {
            return;
        };
        inner.mark_fold_lost();
        if registration == Registration::AfterClose {
            let _ = inner.begin_close();
            // With no route, the transport-end sweep cannot find it: the router
            // holds it for that sweep, or it ends here if the sweep already ran.
            if self.router.hold_for_transport_end(&inner) {
                return;
            }
        }
        self.end_transport(&inner);
    }

    fn ensure_open(&self) -> FacadeResult<()> {
        if self.closed.load(Ordering::Acquire) {
            Err(FacadeError::ClientClosed)
        } else if self.transport_ended.load(Ordering::Acquire) {
            Err(FacadeError::TransportEnded)
        } else {
            Ok(())
        }
    }

    pub(super) fn mark_transport_ended(&self) {
        self.transport_ended.store(true, Ordering::Release);
        for session in self.router.sessions_for_terminal_cleanup() {
            self.end_transport(&session);
        }
    }

    // An ephemeral host drops a session when its transport ends.
    fn end_transport(&self, session: &SessionInner) {
        let discard = !matches!(self.durability, SessionDurability::Durable);
        session.transport_ended(discard);
        if discard {
            lock(&self.discarded_session_ids).insert(session.session_id().to_owned());
        }
    }

    // Runs before close() first awaits, so a transport end seen after that
    // finds no routed approval worker left to abort, the caller's own included.
    pub(super) fn begin_close(&self) -> Vec<tokio::task::JoinHandle<()>> {
        self.router
            .sessions_for_close()
            .iter()
            .filter_map(|session| session.begin_close())
            .collect()
    }
}

#[derive(Default)]
pub(crate) struct NotificationRouter {
    state: Mutex<RouterState>,
    // The client's durability, set once it is built and before any session
    // registers; it picks the next step the overflow failure names.
    durability: OnceLock<SessionDurability>,
}

// A legitimate pre-ack burst is retained losslessly up to this explicit
// boundary; overflow settles the eventual session instead of dropping facts.
// Same constant as a session's share of the connection handoff under
// contention.
const MAX_PENDING_NOTIFICATIONS_PER_SESSION: usize = crate::connection::NOTIFICATION_SESSION_SHARE;
// Same constant as the connection handoff's capacity, so the two
// limits cannot drift; the per-session bound above still applies.
const MAX_PENDING_NOTIFICATIONS_TOTAL: usize = crate::connection::NOTIFICATION_HANDLER_CAPACITY;
const MAX_OVERFLOWED_SESSIONS: usize = 1_024;
// Past the marker cap a loss sets one bit of this table, keyed by a hash of
// the session id, so no affected session can register as complete.
// Sessions sharing a bit cannot be told apart, so an unaffected one may be
// refused too.
const OVERFLOW_TOMBSTONE_BITS: usize = 65_536;
const OVERFLOW_TOMBSTONE_WORDS: usize = OVERFLOW_TOMBSTONE_BITS / 64;

#[derive(Default)]
struct RouterState {
    sessions: HashMap<String, ActiveRoute>,
    pending: HashMap<String, PendingRoute>,
    pending_total: usize,
    overflowed_sessions: HashSet<String>,
    overflow_tombstones: Option<Box<[u64; OVERFLOW_TOMBSTONE_WORDS]>>,
    // How many opens of each session id this client registered or sent a
    // resume or a named start for. Opening one again cannot prove which
    // `Session` received each event; a count lets one refused resume undo only
    // its own note.
    opened: HashMap<String, usize>,
    // Every session id that registered. A resume is counted under the id it
    // asked for, so this catches a reply that names an id already registered.
    registered: HashSet<String>,
    // Set in the same critical section as `close()`'s snapshot: a session
    // registering after it is one `close()` never saw.
    closed: bool,
    // Set in the same critical section as the transport-end sweep's snapshot,
    // which also drains `unrouted`: a session registering after it is one
    // that sweep never saw.
    transport_swept: bool,
    // Whether the sweep's snapshot came before `close()`'s, so a session
    // registering after both settles as the earlier one did for its peers.
    swept_before_close: bool,
    // Sessions `close()` never saw, held for that sweep: it finds no route
    // for them.
    unrouted: Vec<Weak<SessionInner>>,
}

struct ActiveRoute {
    session: Weak<SessionInner>,
    notifications: VecDeque<RoutedNotification>,
    draining: bool,
    overflowed: bool,
}

#[derive(Default)]
struct PendingRoute {
    notifications: VecDeque<Notification>,
    overflow_at: Option<usize>,
    // Set when a shared tombstone bit is the only evidence, so the loss may
    // belong to another session.
    overflow_unconfirmed: bool,
}

/// How `NotificationRouter::register` placed a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Registration {
    /// Routed, so the next terminal snapshot reaches it.
    Routed,
    /// Not routed: `close()`'s snapshot was already taken, before any
    /// transport-end sweep.
    AfterClose,
    /// Not routed: the transport-end sweep already ran, before any `close()`
    /// snapshot.
    AfterTransportEnd,
}

enum RoutedNotification {
    Notification(Notification),
    Overflow,
    UnconfirmedOverflow,
}

impl NotificationRouter {
    pub(super) fn set_durability(&self, durability: SessionDurability) {
        let _ = self.durability.set(durability);
    }

    /// Routes `session`, or names the terminal snapshot already taken without
    /// routing it: such a session gets no route and no frames, so no snapshot
    /// reaches it, and the caller settles it.
    fn register(&self, session: &Session, reopened: bool) -> Registration {
        let session_id = session.session_id().to_owned();
        let newer = session.downgrade();
        let (should_drain, replaced, reopened) = {
            let mut state = lock(&self.state);
            if state.closed && !state.swept_before_close {
                return Registration::AfterClose;
            }
            if state.transport_swept {
                return Registration::AfterTransportEnd;
            }
            // Flagged when the id registered before, when an earlier open was
            // outstanding at send time, or when another open is outstanding now.
            let reopened = !state.registered.insert(session_id.clone())
                || reopened
                || state
                    .opened
                    .get(&session_id)
                    .is_some_and(|count| *count > 1);
            let replaced = state
                .sessions
                .get(&session_id)
                .filter(|route| !Weak::ptr_eq(&route.session, &newer))
                .and_then(|route| route.session.upgrade());
            let pending = state.take_pending(&session_id);
            let should_drain = state.install_session_route(session_id.clone(), newer, pending);
            (should_drain, replaced, reopened)
        };
        // An event can reach the earlier `Session`, or replay on top of the
        // history this one was served, so its fold cannot claim to be current.
        if reopened {
            session.mark_fold_reopened();
        }
        // The replaced session gets no more events, so it must not look live.
        // Failed outside the router lock: it takes its own locks.
        if let Some(replaced) = replaced {
            replaced.fail_event_source(TurnWaitError::EventSourceFailed {
                message: "a newer Session for this session id took over its events".to_owned(),
            });
        }
        if should_drain {
            self.drain(&session_id);
        }
        Registration::Routed
    }

    pub(super) fn sessions(&self) -> Vec<Arc<SessionInner>> {
        lock(&self.state).live_sessions()
    }

    /// The transport-end sweep's snapshot. It marks the sweep in the same
    /// critical section, so a session registering later knows the sweep never
    /// saw it; split in two, a session registering between them would be
    /// routed after the snapshot and never settled.
    fn sessions_for_terminal_cleanup(&self) -> Vec<Arc<SessionInner>> {
        let mut state = lock(&self.state);
        let mut sessions = state.terminal_snapshot();
        state.transport_swept = true;
        sessions.extend(state.unrouted.drain(..).filter_map(|held| held.upgrade()));
        sessions
    }

    /// Holds a session `close()` never saw for the transport-end sweep; false
    /// once that sweep has run, so the caller ends it itself.
    fn hold_for_transport_end(&self, session: &Arc<SessionInner>) -> bool {
        let mut state = lock(&self.state);
        if state.transport_swept {
            return false;
        }
        state.unrouted.push(Arc::downgrade(session));
        true
    }

    /// `close()`'s snapshot: it also marks the router closed, so a session
    /// registering later knows `close()` never saw it.
    fn sessions_for_close(&self) -> Vec<Arc<SessionInner>> {
        let mut state = lock(&self.state);
        // `close()` takes this snapshot once, behind the client's closed flag.
        state.swept_before_close = state.transport_swept;
        state.closed = true;
        state.terminal_snapshot()
    }
}

fn overflow_tombstone_slot(session_id: &str) -> (usize, u64) {
    // `DefaultHasher::new` uses fixed keys, so a session id keeps one slot for
    // the client's lifetime.
    let mut hasher = DefaultHasher::new();
    session_id.hash(&mut hasher);
    let index = (hasher.finish() % OVERFLOW_TOMBSTONE_BITS as u64) as usize;
    (index / 64, 1 << (index % 64))
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io;
    use std::pin::Pin;

    use serde_json::{Map, Value, json};

    use super::*;
    use crate::DuplexTransport;
    use crate::client::MuseClient;
    use crate::msp::{SessionDurability, SessionStartResult};
    use crate::session::SessionOpening;

    struct IdleTransport;

    impl DuplexTransport for IdleTransport {
        fn read_chunk(
            &mut self,
        ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
            Box::pin(std::future::pending())
        }

        fn write(
            &mut self,
            _frame: &str,
        ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
            Box::pin(async { Ok(()) })
        }
    }

    fn session_with_id(client: &MuseClient, session_id: &str) -> Result<Session, String> {
        let opening = serde_json::from_value::<SessionStartResult>(json!({
            "session": {
                "sessionId": session_id,
                "path": "/workspace/session.jsonl",
                "status": "idle",
                "activeTurnId": null,
                "createdAt": "2026-10-03T00:00:00Z",
                "updatedAt": "2026-10-03T00:00:00Z",
                "workspaceRoot": null,
                "providerId": null,
                "modelId": null,
                "turnCount": 0,
                "forkedFrom": null
            },
            "viewCursor": "cursor-1"
        }))
        .map_err(|error| format!("test session fixture is invalid: {error}"))?;
        Ok(Session::from_opening(
            Arc::clone(&client.shared),
            SessionOpening::Start(Box::new(opening)),
            &[],
            None,
        ))
    }

    pub(super) fn notification(session_id: &str, sequence: usize) -> Notification {
        let mut params = Map::new();
        params.insert("sessionId".to_owned(), Value::String(session_id.to_owned()));
        params.insert("sequence".to_owned(), Value::from(sequence));
        Notification {
            jsonrpc: crate::msp::JsonRpcVersion::V2,
            method: "item/completed".to_owned(),
            params: Some(params),
            emitted_at_ms: None,
        }
    }

    #[test]
    fn unknown_session_backlog_is_bounded_and_cleared() {
        let router = NotificationRouter::default();
        for sequence in 0..300 {
            router.route(notification("session-1", sequence));
        }
        for sequence in 0..1_100 {
            router.route(notification(&format!("unknown-{sequence}"), sequence));
        }

        let state = lock(&router.state);
        assert!(
            state.pending.values().all(|route| {
                route.notifications.len() <= MAX_PENDING_NOTIFICATIONS_PER_SESSION
            })
        );
        assert!(
            state
                .pending
                .values()
                .map(|route| route.notifications.len())
                .sum::<usize>()
                <= MAX_PENDING_NOTIFICATIONS_TOTAL
        );
        drop(state);

        lock(&router.state).clear_pending();
        assert!(lock(&router.state).pending.is_empty());
    }

    /// The router holds one full connection handoff of frames for sessions
    /// that have not registered yet, each session at exactly its handoff
    /// share, with no overflow. Both counts come from the connection's own
    /// constants, so a router bound set below either one fails here.
    #[test]
    fn one_handoff_of_frames_for_unregistered_sessions_overflows_nothing() {
        use crate::connection::{NOTIFICATION_HANDLER_CAPACITY, NOTIFICATION_SESSION_SHARE};

        let router = NotificationRouter::default();
        for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
            let session = sequence / NOTIFICATION_SESSION_SHARE;
            router.route(notification(&format!("unregistered-{session}"), sequence));
        }

        let mut state = lock(&router.state);
        assert_eq!(state.pending_total, NOTIFICATION_HANDLER_CAPACITY);
        assert!(state.overflowed_sessions.is_empty());
        let mut held = 0;
        for session in 0..NOTIFICATION_HANDLER_CAPACITY.div_ceil(NOTIFICATION_SESSION_SHARE) {
            let pending = state.take_pending(&format!("unregistered-{session}"));
            assert!(
                pending.overflow_at.is_none(),
                "unregistered-{session} overflowed within its handoff share"
            );
            held += pending.notifications.len();
        }
        assert_eq!(held, NOTIFICATION_HANDLER_CAPACITY, "every frame is held");
    }

    #[test]
    fn one_active_drainer_keeps_replay_before_live_arrivals() {
        let mut route = ActiveRoute {
            session: Weak::new(),
            notifications: [notification("session-1", 1), notification("session-1", 2)]
                .into_iter()
                .map(RoutedNotification::Notification)
                .collect(),
            draining: true,
            overflowed: false,
        };

        assert!(!route.enqueue(notification("session-1", 3)));
        let sequences = route
            .notifications
            .into_iter()
            .filter_map(|event| match event {
                RoutedNotification::Notification(notification) => notification
                    .params
                    .and_then(|params| params.get("sequence").cloned())
                    .and_then(|value| value.as_u64()),
                RoutedNotification::Overflow | RoutedNotification::UnconfirmedOverflow => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(sequences, [1, 2, 3]);
    }

    #[test]
    fn live_idle_overflow_claims_the_route_drainer() {
        let mut route = ActiveRoute {
            session: Weak::new(),
            notifications: VecDeque::new(),
            draining: false,
            overflowed: false,
        };

        assert!(route.mark_overflowed());

        assert!(route.draining);
        assert!(matches!(
            route.notifications.front(),
            Some(RoutedNotification::Overflow)
        ));
    }

    #[test]
    fn overflow_from_one_unknown_session_does_not_poison_every_registration() {
        let router = NotificationRouter::default();
        for sequence in 0..MAX_PENDING_NOTIFICATIONS_TOTAL {
            router.route(notification(&format!("unknown-{sequence}"), sequence));
        }
        router.route(notification("overflowed", 1));

        let mut state = lock(&router.state);
        assert!(state.take_pending("overflowed").overflow_at.is_some());
        assert!(state.take_pending("unknown-0").overflow_at.is_none());
    }

    #[test]
    fn dispatch_overflow_marks_only_its_named_session() {
        let router = NotificationRouter::default();
        router.overflow(notification("overflowed", 1));

        let mut state = lock(&router.state);
        assert!(state.take_pending("overflowed").overflow_at.is_some());
        assert!(state.take_pending("unrelated").overflow_at.is_none());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn re_registered_session_gets_a_fresh_overflow_marker() -> Result<(), String> {
        let client = MuseClient::new(IdleTransport, SessionDurability::Durable);
        let first = session_with_id(&client, "session-1")?;
        let second = session_with_id(&client, "session-1")?;
        let mut state = RouterState::default();

        state.install_session_route(
            "session-1".to_owned(),
            first.downgrade(),
            PendingRoute::default(),
        );
        let Some(route) = state.sessions.get_mut("session-1") else {
            return Err("first session route was not installed".to_owned());
        };
        if !route.mark_overflowed() {
            return Err("first session did not receive its overflow marker".to_owned());
        }
        route.notifications.clear();
        route.draining = false;

        state.install_session_route(
            "session-1".to_owned(),
            second.downgrade(),
            PendingRoute::default(),
        );
        let Some(route) = state.sessions.get_mut("session-1") else {
            return Err("replacement session route was not installed".to_owned());
        };
        if !route.mark_overflowed() {
            return Err("replacement session inherited stale overflow dedupe".to_owned());
        }
        route.notifications.clear();
        route.draining = false;

        state.install_session_route(
            "session-1".to_owned(),
            second.downgrade(),
            PendingRoute::default(),
        );
        let Some(route) = state.sessions.get_mut("session-1") else {
            return Err("same session route was not preserved".to_owned());
        };
        if route.mark_overflowed() {
            return Err("same session registered a duplicate overflow marker".to_owned());
        }
        Ok(())
    }

    #[test]
    fn re_registration_preserves_the_existing_route_queue() {
        let mut state = RouterState::default();
        state.sessions.insert(
            "session-1".to_owned(),
            ActiveRoute {
                session: Weak::new(),
                notifications: [notification("session-1", 1), notification("session-1", 2)]
                    .into_iter()
                    .map(RoutedNotification::Notification)
                    .collect(),
                draining: true,
                overflowed: false,
            },
        );
        let pending = PendingRoute {
            notifications: [notification("session-1", 3)].into_iter().collect(),
            overflow_at: None,
            overflow_unconfirmed: false,
        };

        assert!(!state.install_session_route("session-1".to_owned(), Weak::new(), pending));
        let route = state.sessions.get("session-1");
        assert!(route.is_some());
        let Some(route) = route else {
            return;
        };
        assert_eq!(route.notifications.len(), 3);
        assert!(route.draining);
    }

    #[test]
    fn dead_route_demotion_preserves_queued_notifications() {
        let mut state = RouterState::default();
        state.sessions.insert(
            "session-1".to_owned(),
            ActiveRoute {
                session: Weak::new(),
                notifications: [notification("session-1", 1), notification("session-1", 2)]
                    .into_iter()
                    .map(RoutedNotification::Notification)
                    .collect(),
                draining: false,
                overflowed: false,
            },
        );

        state.demote_dead_session_route("session-1");
        state.enqueue_pending("session-1".to_owned(), notification("session-1", 3));

        let pending = state.take_pending("session-1");
        let sequences = pending
            .notifications
            .into_iter()
            .filter_map(|notification| {
                notification
                    .params
                    .and_then(|params| params.get("sequence").cloned())
                    .and_then(|value| value.as_u64())
            })
            .collect::<Vec<_>>();
        assert_eq!(sequences, [1, 2, 3]);
    }

    #[test]
    fn session_snapshot_retires_dead_routes_without_losing_other_backlogs() {
        let router = NotificationRouter::default();
        let mut state = lock(&router.state);
        for sequence in 0..64 {
            state.sessions.insert(
                format!("quiet-{sequence}"),
                ActiveRoute {
                    session: Weak::new(),
                    notifications: VecDeque::new(),
                    draining: false,
                    overflowed: false,
                },
            );
        }
        state.sessions.insert(
            "queued".to_owned(),
            ActiveRoute {
                session: Weak::new(),
                notifications: VecDeque::from([
                    RoutedNotification::Notification(notification("queued", 1)),
                    RoutedNotification::Overflow,
                    RoutedNotification::Notification(notification("queued", 2)),
                ]),
                draining: false,
                overflowed: true,
            },
        );
        state.enqueue_pending("unrelated".to_owned(), notification("unrelated", 7));
        drop(state);

        assert!(router.sessions().is_empty());

        let mut state = lock(&router.state);
        assert!(state.sessions.is_empty());
        let queued = state.take_pending("queued");
        let sequences = queued
            .notifications
            .into_iter()
            .filter_map(|notification| {
                notification
                    .params
                    .and_then(|params| params.get("sequence").cloned())
                    .and_then(|value| value.as_u64())
            })
            .collect::<Vec<_>>();
        assert_eq!(sequences, [1, 2]);
        assert_eq!(queued.overflow_at, Some(1));

        let unrelated = state.take_pending("unrelated");
        assert_eq!(unrelated.notifications.len(), 1);
        assert!(unrelated.overflow_at.is_none());
    }

    #[test]
    fn re_registration_preserves_overflow_before_post_gap_notification() {
        let mut state = RouterState::default();
        state.sessions.insert(
            "session-1".to_owned(),
            ActiveRoute {
                session: Weak::new(),
                notifications: VecDeque::from([
                    RoutedNotification::Notification(notification("session-1", 1)),
                    RoutedNotification::Overflow,
                    RoutedNotification::Notification(notification("session-1", 2)),
                ]),
                draining: false,
                overflowed: true,
            },
        );

        state.demote_dead_session_route("session-1");
        let pending = state.take_pending("session-1");
        assert!(state.install_session_route("session-1".to_owned(), Weak::new(), pending));

        let route = state.sessions.get("session-1");
        assert!(route.is_some());
        let Some(route) = route else {
            return;
        };
        let mut events = route.notifications.iter();
        assert!(matches!(
            events.next(),
            Some(RoutedNotification::Notification(notification))
                if notification.params.as_ref()
                    .and_then(|params| params.get("sequence"))
                    .and_then(Value::as_u64) == Some(1)
        ));
        assert!(matches!(events.next(), Some(RoutedNotification::Overflow)));
        assert!(matches!(
            events.next(),
            Some(RoutedNotification::Notification(notification))
                if notification.params.as_ref()
                    .and_then(|params| params.get("sequence"))
                    .and_then(Value::as_u64) == Some(2)
        ));
        assert!(events.next().is_none());
    }

    #[test]
    fn global_cap_overflow_precedes_a_later_pending_notification() -> Result<(), String> {
        let router = NotificationRouter::default();
        for sequence in 0..MAX_PENDING_NOTIFICATIONS_TOTAL {
            router.route(notification(&format!("held-{sequence}"), sequence));
        }
        router.route(notification("session-1", 1));
        {
            let mut state = lock(&router.state);
            if !state.overflowed_sessions.contains("session-1") {
                return Err("the global cap did not record the dropped session".to_owned());
            }
            let freed = state.take_pending("held-0");
            if freed.notifications.len() != 1 {
                return Err("the fixture did not free one pending slot".to_owned());
            }
        }

        router.route(notification("session-1", 2));
        let mut state = lock(&router.state);
        let pending = state.take_pending("session-1");
        if !state.install_session_route("session-1".to_owned(), Weak::new(), pending) {
            return Err("the restored route did not claim its drainer".to_owned());
        }

        let Some(route) = state.sessions.get("session-1") else {
            return Err("the restored route was not installed".to_owned());
        };
        let mut events = route.notifications.iter();
        if !matches!(events.next(), Some(RoutedNotification::Overflow)) {
            return Err("the global overflow marker was not restored first".to_owned());
        }
        if !matches!(
            events.next(),
            Some(RoutedNotification::Notification(notification))
                if notification.params.as_ref()
                    .and_then(|params| params.get("sequence"))
                    .and_then(Value::as_u64) == Some(2)
        ) {
            return Err("the post-gap notification was not restored second".to_owned());
        }
        if events.next().is_some() {
            return Err("the restored route contained an unexpected third item".to_owned());
        }
        Ok(())
    }

    #[test]
    fn overflow_marker_cap_keeps_older_markers_and_tombstones_the_newest() -> Result<(), String> {
        let router = NotificationRouter::default();
        for sequence in 0..MAX_PENDING_NOTIFICATIONS_TOTAL {
            router.route(notification(&format!("held-{sequence}"), sequence));
        }
        for sequence in 0..=MAX_OVERFLOWED_SESSIONS {
            router.route(notification(&format!("overflow-{sequence}"), sequence));
        }
        let newest = format!("overflow-{MAX_OVERFLOWED_SESSIONS}");
        let newest_slot = overflow_tombstone_slot(&newest);
        // A second session past the cap whose bit shares the newest one's
        // word: marking it must not wipe the newest session's bit.
        let Some(second) = (0..u32::MAX)
            .map(|sequence| format!("past-cap-{sequence}"))
            .find(|session_id| {
                let (word, bit) = overflow_tombstone_slot(session_id);
                word == newest_slot.0 && bit != newest_slot.1
            })
        else {
            return Err("no session id shares the newest session's tombstone word".to_owned());
        };
        router.route(notification(&second, 0));
        let second_slot = overflow_tombstone_slot(&second);
        // The price of a bounded table: an unaffected id sharing the newest
        // session's bit is refused too.
        let Some(collider) = (0..u32::MAX)
            .map(|sequence| format!("collider-{sequence}"))
            .find(|session_id| overflow_tombstone_slot(session_id) == newest_slot)
        else {
            return Err("no session id shares the newest session's tombstone".to_owned());
        };
        let Some(spared) = (0..u32::MAX)
            .map(|sequence| format!("spared-{sequence}"))
            .find(|session_id| {
                let slot = overflow_tombstone_slot(session_id);
                slot != newest_slot && slot != second_slot
            })
        else {
            return Err("every session id shares a set tombstone".to_owned());
        };

        let mut state = lock(&router.state);
        if state.overflowed_sessions.len() != MAX_OVERFLOWED_SESSIONS
            || state.overflowed_sessions.contains(&newest)
            || state.overflowed_sessions.contains(&second)
        {
            return Err("the marker cap traded an older marker for a newer one".to_owned());
        }
        let oldest = state.take_pending("overflow-0");
        if oldest.overflow_at != Some(0) || oldest.overflow_unconfirmed {
            return Err("the oldest marker did not report a confirmed loss".to_owned());
        }
        for session_id in [newest.as_str(), second.as_str(), collider.as_str()] {
            let pending = state.take_pending(session_id);
            if pending.overflow_at != Some(0) || !pending.overflow_unconfirmed {
                return Err(format!(
                    "{session_id} registered without its unconfirmed prior overflow"
                ));
            }
        }
        if state.take_pending(&spared).overflow_at.is_some() {
            return Err("a session outside every tombstone was refused".to_owned());
        }
        if state.take_pending(&newest).overflow_at != Some(0) {
            return Err("registering the newest session cleared its shared tombstone".to_owned());
        }
        Ok(())
    }
}

#[cfg(test)]
mod ordering_tests;

#[cfg(test)]
mod last_turn_retry;
