//! Session verbs and turn submission.

mod approval_route;
mod fold_view;
mod gap_route;
mod notification_params;
mod reconnect;
mod state;
mod submit;
mod turn_route;
mod user_input;

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, Weak};

use serde_json::Value;

use crate::approval::ApprovalDecisionInput;
use crate::client::{ClientShared, lock};
use crate::fold::SessionFold;
use crate::msp::{
    ApprovalRequestParams, ApprovalResolvedParams, ApprovalUpdatedParams, Item,
    ItemCompletedParams, ItemDeltaParams, ItemStartedParams, ItemUpdatedParams, Notification,
    PendingRequestKind, SessionHistory, SessionResumeResult, SessionStartResult,
    TurnCompletedParams, TurnStartedParams, TurnUnqueuedParams,
};
use crate::turn::TurnWaitError;

use approval_route::ApprovalRoute;
pub use fold_view::SessionFoldView;
pub(crate) use fold_view::{drop_unreadable_snapshot, resume_history_items};
use gap_route::GapRoute;
use notification_params::{approval_id, decode, turn_id};
use state::{PendingCommandGuard, SessionState};

pub use reconnect::{PendingTurn, ReconnectResolution, Reconnected};
pub use submit::SendUserTurnOptions;

const MAX_SETTLED_TURN_ALIASES: usize = 128;
pub(crate) const MAX_RETIRED_TURNS: usize = 256;
pub(crate) const MAX_ACTIVE_TURNS: usize = 128;

/// The server's result that opened a session, as typed by this SDK.
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub enum SessionOpening {
    /// The `session/start` result.
    Start(Box<SessionStartResult>),
    /// The `session/resume` result: the history it served and the turn the
    /// host still runs, if any.
    Resume(Box<SessionResumeResult>),
}

/// One server session on a client: it submits turns, answers approvals and
/// questions, and keeps a fold of the events it applied. Clones share it.
#[derive(Clone)]
pub struct Session {
    inner: Arc<SessionInner>,
}

/// The items a resume served: `history.items` when inline, else the
/// snapshot's `state.items` (`snapshot` and `anchoredSnapshot` modes).
fn served_history_items(history: &SessionHistory) -> Option<&[Item]> {
    history.items.as_deref().or_else(|| {
        history
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.state.items.as_slice())
    })
}

impl Session {
    pub(crate) fn from_opening(
        client: Arc<ClientShared>,
        opening: SessionOpening,
        history: &[Value],
        dropped_snapshot_schema_version: Option<u64>,
    ) -> Self {
        let session_id = match &opening {
            SessionOpening::Start(result) => result.session.session_id.clone(),
            SessionOpening::Resume(result) => result.session.session_id.clone(),
        };
        let (approval, pending_approvals) = ApprovalRoute::new();
        let gaps = GapRoute::new(&session_id);
        let fold = fold_view::seeded_fold(&session_id, history);
        let inner = Arc::new(SessionInner {
            client,
            session_id,
            opening,
            fold: Mutex::new(fold),
            state: Arc::new(Mutex::new(SessionState::default())),
            approval,
            gaps,
            dropped_snapshot_schema_version,
        });
        if let SessionOpening::Resume(result) = &inner.opening {
            let mut state = lock(&inner.state);
            // A resend's answer may name a turn that settles before the first
            // `resolve_reconnect`; keep it claimable until such a call, past its
            // refusals, ends.
            state.hold_settled_aliases = true;
            state.last_turn_id = result.last_turn.as_ref().map(|last| last.turn_id.clone());
        }
        inner
            .approval
            .spawn(inner.runtime(), Arc::downgrade(&inner), pending_approvals);
        if let SessionOpening::Resume(result) = &inner.opening
            && let Some(items) = served_history_items(&result.history)
        {
            // History reaches a turn when its route opens: now for the turn the
            // host still runs, later for a finished turn once a live event (the
            // reconciliation terminal) or a claim opens its route.
            // Opening no route for the rest keeps MAX_ACTIVE_TURNS slots free;
            // finished turns stay readable through `opening()`.
            let mut history_turn_items: HashMap<String, Vec<usize>> = HashMap::new();
            for (index, item) in items.iter().enumerate() {
                if let Some(turn_id) = &item.turn_id {
                    history_turn_items
                        .entry(turn_id.clone())
                        .or_default()
                        .push(index);
                }
            }
            lock(&inner.state).history_turn_items = history_turn_items;
            if let Some(active_turn_id) = result.session.active_turn_id.as_deref() {
                inner.turn_handle(active_turn_id);
            }
        }
        Self { inner }
    }

    /// The session id the server returned: the one the start or resume named,
    /// or one the server minted.
    pub fn session_id(&self) -> &str {
        self.inner.session_id()
    }

    /// The result that opened this session. For a resume, `history.mode` can
    /// name a snapshot mode while `history.snapshot` is `None`: the SDK
    /// dropped a snapshot newer than it understands (see
    /// [`Session::dropped_snapshot_schema_version`]).
    pub fn opening(&self) -> &SessionOpening {
        &self.inner.opening
    }

    /// The `schemaVersion` of a resume snapshot this SDK dropped because it is
    /// newer than the session view this SDK understands, if it dropped one.
    /// The resume then used none of the snapshot's state, for the fold or the
    /// turns, and the opening's `history.snapshot` is `None`. Events after the
    /// snapshot's cursor still stream and apply, so the fold holds only what
    /// came after it. To get the earlier history, upgrade
    /// muse-code-sdk, or close this client and resume the session on a new one
    /// asking for inline history (`ResumeSessionOptions::history`), which the
    /// host serves when it fits its budget. Resuming the same session again on
    /// this client is no remedy: the newer session's fold stops.
    pub fn dropped_snapshot_schema_version(&self) -> Option<u64> {
        self.inner.dropped_snapshot_schema_version
    }

    /// True once the transport ended on a client that is not durable (an
    /// ephemeral host, or a durability value this SDK does not know): the SDK
    /// assumes nothing survives to resume, so its fallible verbs refuse with
    /// [`MuseError::SessionDiscarded`](crate::errors::MuseError::SessionDiscarded).
    pub fn is_discarded(&self) -> bool {
        lock(&self.inner.state).discarded
    }

    /// Fixes the routing of approvals the resume result lists as pending.
    pub(crate) fn fix_resume_approval_routing(&self) {
        if let SessionOpening::Resume(result) = &self.inner.opening {
            self.inner.approval.fix_handoff_routing(
                result
                    .pending_requests
                    .iter()
                    .filter(|pointer| pointer.kind == PendingRequestKind::Approval)
                    .filter_map(|pointer| pointer.approval_id.clone()),
            );
        }
    }

    /// Replaces the approval handler for this session.
    ///
    /// A request for a turn this session has already settled gets the offered
    /// rejecting choice without reaching the handler, and an answer whose turn
    /// settles while the handler decides is replaced the same way; with no
    /// rejecting choice offered, nothing is sent, and a later stage that offers
    /// one gets it. Approvals for a turn refused at the active-turn cap,
    /// or for a turn this `Session` no longer remembers as settled (it
    /// keeps only its most recent settled turns, and a resumed `Session` starts
    /// with none), still reach the handler as usual.
    pub fn on_approval<Handler, HandlerFuture>(&self, handler: Handler)
    where
        Handler: Fn(ApprovalRequestParams) -> HandlerFuture + Send + Sync + 'static,
        HandlerFuture: Future<Output = ApprovalDecisionInput> + Send + 'static,
    {
        self.inner.approval.on_approval(handler);
    }

    pub(crate) fn downgrade(&self) -> Weak<SessionInner> {
        Arc::downgrade(&self.inner)
    }
}

pub(crate) struct SessionInner {
    client: Arc<ClientShared>,
    session_id: String,
    opening: SessionOpening,
    fold: Mutex<SessionFold>,
    state: Arc<Mutex<SessionState>>,
    approval: ApprovalRoute,
    gaps: GapRoute,
    dropped_snapshot_schema_version: Option<u64>,
}

impl SessionInner {
    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The runtime that built the client: this session's background tasks
    /// run there, whichever runtime opened the session.
    pub(super) fn runtime(&self) -> &tokio::runtime::Handle {
        &self.client.runtime
    }

    /// Every live notification enters through the gap route: a
    /// `view/gap` starts the splice-fill, a frame behind a pending hole is
    /// held, a served twin is refused once, and everything else applies now.
    pub(crate) fn apply(self: &Arc<Self>, notification: Notification) {
        self.gaps.route(self, notification);
    }

    fn apply_now(self: &Arc<Self>, notification: Notification) {
        self.fold_event(&notification);
        self.route_now(notification);
    }

    /// Hands one notification to the turn and item routes, without folding it.
    fn route_now(self: &Arc<Self>, notification: Notification) {
        let Notification { method, params, .. } = notification;
        match method.as_str() {
            "item/started" => {
                let _ = decode::<ItemStartedParams>(&method, params)
                    .map(|params| self.push_item(params.item));
            }
            "item/updated" => {
                let _ = decode::<ItemUpdatedParams>(&method, params)
                    .map(|params| self.push_item(params.item));
            }
            "item/completed" => {
                let _ = decode::<ItemCompletedParams>(&method, params)
                    .map(|params| self.push_item(params.item));
            }
            "item/delta" => {
                let _ = decode::<ItemDeltaParams>(&method, params)
                    .map(|params| self.push_delta(params));
            }
            // The server-request form carries the same params.
            "approval/requested" | "approval/request" => {
                let turn_id = turn_id(&params);
                let approval_id = approval_id(&params);
                match decode::<ApprovalRequestParams>(&method, params) {
                    Ok(params) => self.approval.enqueue_requested(self, params),
                    Err(error) => {
                        // Its other form must not reach a handler for a turn this
                        // fails; a frame naming no turn fails nothing and is dropped.
                        // The turn settles first, so no owed copy sees it unsettled.
                        self.fail_named_turn(turn_id.clone(), error);
                        if let (Some(turn_id), Some(approval_id)) =
                            (turn_id.as_deref(), approval_id.as_deref())
                        {
                            self.approval.retire_owing(approval_id, turn_id, 0);
                        }
                    }
                }
            }
            "approval/updated" => {
                let approval_id = approval_id(&params);
                match decode::<ApprovalUpdatedParams>(&method, params) {
                    Ok(params) => self.approval.enqueue_updated(self, params),
                    Err(error) => {
                        let tracked = approval_id.as_deref().and_then(|approval_id| {
                            Some((approval_id, self.approval.tracked_turn(approval_id)?))
                        });
                        let turn_id = tracked.as_ref().map(|(_, turn_id)| turn_id.clone());
                        self.fail_named_turn(turn_id, error);
                        if let Some((approval_id, _)) = tracked {
                            self.approval.retire_tracked(approval_id);
                        }
                    }
                }
            }
            "approval/resolved" => {
                let approval_id = approval_id(&params);
                match decode::<ApprovalResolvedParams>(&method, params) {
                    Ok(params) => {
                        self.approval.retire(&params.approval_id);
                    }
                    Err(_) => {
                        if let Some(approval_id) = approval_id.as_deref() {
                            self.approval.retire(approval_id);
                        }
                    }
                }
            }
            "turn/started" => {
                let turn_id = turn_id(&params);
                match decode::<TurnStartedParams>(&method, params) {
                    Ok(params) => self.mark_started(&params.turn_id),
                    Err(error) => self.fail_named_turn(turn_id, error),
                }
            }
            "turn/completed" => {
                let turn_id = turn_id(&params);
                match decode::<TurnCompletedParams>(&method, params) {
                    Ok(params) => self.settle_turn(params),
                    Err(error) => self.fail_named_turn(turn_id, error),
                }
            }
            "turn/unqueued" => {
                let turn_id = turn_id(&params);
                match decode::<TurnUnqueuedParams>(&method, params) {
                    Ok(params) => self.settle_unqueued(params),
                    Err(error) => self.fail_named_turn(turn_id, error),
                }
            }
            _ => {}
        }
    }

    pub(crate) fn transport_ended(&self, discard: bool) {
        self.approval.abort();
        self.gaps.abort();
        // After the walker abort, so the hole it was filling can never fill;
        // before the settle, so a turn it wakes already reads the stop.
        self.stop_fold_on_cut_fill();
        let mut state = lock(&self.state);
        state.settle_source_failure(TurnWaitError::SourceClosed);
        if !discard {
            return;
        }
        state.discarded = true;
        state.last_turn_settled = None;
        state.pending_commands.clear();
        state.forget_submissions();
        state.settled_turns.clear();
        state.settled_turn_order.clear();
        state.retired_turns.clear();
        state.retired_turn_order.clear();
    }

    pub(crate) fn is_command_discarded(&self, command_id: &str) -> bool {
        lock(&self.state).is_command_discarded(command_id)
    }

    pub(crate) fn fail_event_source(&self, failure: TurnWaitError) {
        if matches!(failure, TurnWaitError::EventSourceFailed { .. }) {
            self.mark_fold_lost();
        }
        self.approval.abort();
        self.gaps.abort();
        // After the walker abort and before the settle, as in `transport_ended`.
        self.stop_fold_on_cut_fill();
        lock(&self.state).settle_source_failure(failure);
    }

    /// The session's retained event-source failure, for the client's own
    /// ordering tests.
    #[cfg(test)]
    pub(crate) fn event_source_failure(&self) -> Option<TurnWaitError> {
        lock(&self.state).event_source_failure.clone()
    }

    /// Whether this session's client has begun `close()`. The approval route
    /// reads it here, so it holds no client of its own.
    fn client_closed(&self) -> bool {
        self.client.is_closed()
    }

    pub(crate) fn begin_close(&self) -> Option<tokio::task::JoinHandle<()>> {
        let worker = self.approval.detach();
        // The slot is empty now, so this abort cannot reach the caller's worker.
        self.fail_event_source(TurnWaitError::ClientClosed);
        worker
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;
    use std::future::Future;
    use std::io;
    use std::pin::Pin;
    use std::task::{Context, Poll, Waker};

    use tokio::sync::mpsc;

    use super::state::TurnRoute;
    use super::*;
    use crate::DuplexTransport;
    use crate::client::{MuseClient, ResumeSessionOptions, StartSessionOptions};
    use crate::msp::SessionDurability;
    use crate::turn::{TurnHandle, TurnOutcome};

    struct ChannelTransport {
        inbound: mpsc::UnboundedReceiver<String>,
    }

    impl DuplexTransport for ChannelTransport {
        fn read_chunk(
            &mut self,
        ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
            Box::pin(async { Ok(self.inbound.recv().await) })
        }

        fn write(
            &mut self,
            _frame: &str,
        ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
            Box::pin(async { Ok(()) })
        }
    }

    /// Hands each scripted reply out only when its request is written,
    /// re-keyed to that request's id (as the scripted test host does), so a
    /// reply can never reach the driver before the request it answers is
    /// pending. A request with no scripted reply gets none.
    struct RepliesOnWrite {
        inbound: mpsc::UnboundedReceiver<String>,
        outbound: mpsc::UnboundedSender<String>,
        replies: std::collections::VecDeque<(&'static str, serde_json::Value)>,
    }

    impl DuplexTransport for RepliesOnWrite {
        fn read_chunk(
            &mut self,
        ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
            Box::pin(async { Ok(self.inbound.recv().await) })
        }

        fn write(
            &mut self,
            frame: &str,
        ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
            if let Ok(request) = serde_json::from_str::<serde_json::Value>(frame.trim())
                && self
                    .replies
                    .front()
                    .is_some_and(|(method, _)| request["method"] == *method)
                && let Some((_, mut reply)) = self.replies.pop_front()
            {
                reply["id"] = request["id"].clone();
                let _ = self.outbound.send(format!("{reply}\n"));
            }
            Box::pin(async { Ok(()) })
        }
    }

    fn poll_once<F: Future + ?Sized>(future: Pin<&mut F>) -> Poll<F::Output> {
        future.poll(&mut Context::from_waker(Waker::noop()))
    }

    /// `close()` takes the calling handler's own worker
    /// out of its slot, so a transport end while that handler waits in
    /// `close()` cannot abort it. Without a host the handler's `close()` would
    /// finish first, so the handler parks inside `close()` until released.
    #[tokio::test(flavor = "current_thread")]
    async fn transport_end_does_not_abort_a_handler_waiting_in_close() {
        let (outbound, inbound) = mpsc::unbounded_channel();
        let replies = std::collections::VecDeque::from([(
            "session/start",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 0,
                "result": {
                    "session": {
                        "sessionId": "session-1",
                        "path": "/tmp/session-1.jsonl",
                        "status": "idle",
                        "activeTurnId": null,
                        "createdAt": "2026-09-29T00:00:00Z",
                        "updatedAt": "2026-09-29T00:00:00Z",
                        "workspaceRoot": null,
                        "providerId": null,
                        "modelId": null,
                        "turnCount": 0,
                        "forkedFrom": null
                    },
                    "viewCursor": "cursor-1"
                }
            }),
        )]);
        let client = Arc::new(MuseClient::with_command_id_minter(
            RepliesOnWrite {
                inbound,
                outbound,
                replies,
            },
            SessionDurability::Durable,
            || "command-1".to_owned(),
        ));
        let session = client.start_session(StartSessionOptions::default()).await;
        assert!(session.is_ok(), "session opens");
        let Ok(session) = session else {
            return;
        };

        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel::<()>();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<()>();
        let signals = Arc::new(Mutex::new(Some((entered_tx, release_rx, done_tx))));
        let handler_client = Arc::clone(&client);
        session.on_approval(move |_| {
            let client = Arc::clone(&handler_client);
            let signals = lock(&signals).take();
            async move {
                if let Some((entered_tx, release_rx, done_tx)) = signals {
                    let mut close = Box::pin(client.close());
                    let _ = poll_once(close.as_mut());
                    let _ = entered_tx.send(());
                    let _ = release_rx.await;
                    let _ = done_tx.send(());
                }
                ApprovalDecisionInput {
                    choice_id: "allow_once".to_owned(),
                    feedback: None,
                }
            }
        });
        session.inner.apply(approval_requested("approval-1"));

        // An aborted handler drops its senders, so each wait resolves either way.
        assert!(entered_rx.await.is_ok(), "handler entered close()");
        session.inner.transport_ended(false);
        let _ = release_tx.send(());
        assert!(
            done_rx.await.is_ok(),
            "transport end aborted the closing handler"
        );
    }

    /// An approval for turn-1 that offers allow-once and an abort.
    fn approval_requested(approval_id: &str) -> Notification {
        Notification {
            jsonrpc: crate::msp::JsonRpcVersion::V2,
            method: "approval/requested".to_owned(),
            params: serde_json::json!({
                "sessionId": "session-1",
                "approvalId": approval_id,
                "turnId": "turn-1",
                "taskId": "task-1",
                "itemId": "item-1",
                "toolCallId": "call-1",
                "toolName": "shell",
                "rawArgs": "{}",
                "viewCursor": "cursor-2",
                "sourceRange": {
                    "stream": {"kind": "run", "id": "turn-1"},
                    "first": {"id": "event-1", "sequence": 1},
                    "last": {"id": "event-1", "sequence": 1}
                },
                "subject": {"kind": "shell", "command": "pwd"},
                "currentRequirementId": {"approvalId": approval_id, "sourceIndex": 0},
                "availableChoices": [
                    {
                        "choiceId": "allow_once",
                        "label": "Allow once",
                        "decision": "approved",
                        "scope": "once"
                    },
                    {
                        "choiceId": "abort",
                        "label": "Abort",
                        "decision": "abort",
                        "scope": "once"
                    }
                ],
                "protectedWrite": false,
                "judgeEscalated": false
            })
            .as_object()
            .cloned(),
            emitted_at_ms: None,
        }
    }

    /// Builds an `approval/requested` notification for one approval id.
    type ApprovalFixture = fn(&str) -> Notification;

    /// The same approval offering only allow-once, so the worker has no deny
    /// to send for an answer the host never offered.
    fn allow_only_approval_requested(approval_id: &str) -> Notification {
        let mut notification = approval_requested(approval_id);
        if let Some(params) = notification.params.as_mut() {
            params.insert(
                "availableChoices".to_owned(),
                serde_json::json!([{
                    "choiceId": "allow_once",
                    "label": "Allow once",
                    "decision": "approved",
                    "scope": "once"
                }]),
            );
        }
        notification
    }

    /// A handler that closes the client runs on the session's approval
    /// worker, which `close()` cannot abort. Whatever that handler then
    /// answers (a choice the host never offered, with or without a deny
    /// offered, an offered allow, or the offered abort), the worker stops
    /// there, so an approval routed to the session once `close()` has begun
    /// reaches no handler.
    #[tokio::test(flavor = "current_thread")]
    async fn an_approval_routed_while_a_handler_closes_the_client_reaches_no_handler() {
        let cases: [(&str, ApprovalFixture, &str); 4] = [
            ("an allow and an abort", approval_requested, "not_offered"),
            ("an allow and an abort", approval_requested, "allow_once"),
            ("an allow and an abort", approval_requested, "abort"),
            (
                "only an allow",
                allow_only_approval_requested,
                "not_offered",
            ),
        ];
        for (offered, approval, answer) in cases {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = Arc::new(MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            ));
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };

            let (routed_tx, mut routed) = mpsc::unbounded_channel::<String>();
            let (closed_tx, closed_rx) = tokio::sync::oneshot::channel::<()>();
            let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
            let (answered_tx, answered_rx) = tokio::sync::oneshot::channel::<()>();
            let signals = Arc::new(Mutex::new(Some((closed_tx, release_rx, answered_tx))));
            let handler_client = Arc::clone(&client);
            session.on_approval(move |request| {
                let _ = routed_tx.send(request.approval_id);
                let client = Arc::clone(&handler_client);
                let signals = lock(&signals).take();
                async move {
                    if let Some((closed_tx, release_rx, answered_tx)) = signals {
                        client.close().await;
                        let _ = closed_tx.send(());
                        let _ = release_rx.await;
                        let _ = answered_tx.send(());
                    }
                    ApprovalDecisionInput {
                        choice_id: answer.to_owned(),
                        feedback: None,
                    }
                }
            });
            session.inner.apply(approval("approval-1"));
            assert!(closed_rx.await.is_ok(), "the handler closed the client");
            assert_eq!(routed.recv().await.as_deref(), Some("approval-1"));
            // A frame the connection read before its close took effect, which
            // its dispatcher still hands over.
            session.inner.apply(approval("approval-2"));
            let _ = release_tx.send(());
            assert!(answered_rx.await.is_ok(), "the closing handler answered");

            // Wait until the worker routes again or stops, however many polls
            // that takes. A worker that routes again and then stops has both
            // ready, so the route is read first.
            let rerouted = tokio::select! {
                biased;
                approval_id = routed.recv() => approval_id,
                () = session.inner.approval.worker_stopped() => None,
            };
            assert_eq!(
                rerouted, None,
                "after answering {answer:?} to an approval offering {offered}, the closing handler's worker routed another approval"
            );
        }
    }

    /// A transport end with no `close()` sets the client's transport-ended flag
    /// before its sweep reaches each session. An approval the worker answers
    /// in that window is refused with `TransportEnded`; the worker must stop
    /// and leave the approval's turn to the sweep, which settles it as
    /// transport ended, instead of failing it first. A session the sweep has
    /// not reached stands in for that window.
    #[tokio::test(flavor = "current_thread")]
    async fn an_approval_answered_after_the_transport_ended_leaves_its_turn_to_the_sweep() {
        let (inbound, reads) = mpsc::unbounded_channel();
        let client = MuseClient::with_command_id_minter(
            ChannelTransport { inbound: reads },
            SessionDurability::Durable,
            || "command-1".to_owned(),
        );
        assert!(inbound.send(opened_session(1, "session-1")).is_ok());
        let session = client.start_session(StartSessionOptions::default()).await;
        assert!(session.is_ok(), "the session opens");
        let Ok(session) = session else {
            return;
        };
        // The host goes away; a request made after that returns only once the
        // transport-end sweep has run.
        drop(inbound);
        let ended = client
            .start_session(StartSessionOptions::default())
            .await
            .err();
        assert!(
            matches!(ended, Some(crate::client::FacadeError::TransportEnded)),
            "control: a request after the end sees TransportEnded, got {ended:?}"
        );

        // Same client, never registered with its router, so the sweep skips it.
        let unsettled = Session::from_opening(
            Arc::clone(&session.inner.client),
            session.opening().clone(),
            &[],
            None,
        );
        let turn = unsettled.inner.claim_turn_for_ordering_tests("turn-1");
        unsettled.inner.apply(approval_requested("approval-1"));
        let completion = turn.completed();
        let stopped = unsettled.inner.approval.worker_stopped();
        // antipattern-ok(timeout-wrapper): failure-only cap; success ends when the worker stops or the turn settles
        let settled = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::select! {
                biased;
                // A worker that fails the turn and then stops has both ready,
                // so the turn is read first.
                outcome = completion => Some(outcome),
                () = stopped => None,
            }
        })
        .await;
        assert!(
            matches!(settled, Ok(None)),
            "a worker refused with TransportEnded must stop and leave the turn to the sweep, got {settled:?}"
        );
    }

    /// The same window, met by the `approval/decide` request itself: the
    /// transport ends after the worker minted its command id, so the decide
    /// is cut short and returns `TransportEnded`. The worker must stop there
    /// too.
    #[tokio::test(flavor = "current_thread")]
    async fn an_approval_decide_cut_short_by_the_transport_end_leaves_its_turn_to_the_sweep() {
        let (inbound, reads) = mpsc::unbounded_channel();
        assert!(inbound.send(opened_session(1, "session-1")).is_ok());
        // The second id is the approval's: minting it ends the host's stream.
        let host = Arc::new(Mutex::new(Some(inbound)));
        let minted = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let minter_host = Arc::clone(&host);
        let client = MuseClient::with_command_id_minter(
            ChannelTransport { inbound: reads },
            SessionDurability::Durable,
            move || {
                if minted.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 1 {
                    lock(&minter_host).take();
                }
                "command-1".to_owned()
            },
        );
        let session = client.start_session(StartSessionOptions::default()).await;
        assert!(session.is_ok(), "the session opens");
        let Ok(session) = session else {
            return;
        };

        // Same client, never registered with its router, so the sweep skips it.
        let unsettled = Session::from_opening(
            Arc::clone(&session.inner.client),
            session.opening().clone(),
            &[],
            None,
        );
        let turn = unsettled.inner.claim_turn_for_ordering_tests("turn-1");
        unsettled.inner.apply(approval_requested("approval-1"));
        let completion = turn.completed();
        let stopped = unsettled.inner.approval.worker_stopped();
        // antipattern-ok(timeout-wrapper): failure-only cap; success ends when the worker stops or the turn settles
        let settled = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            tokio::select! {
                biased;
                // A worker that fails the turn and then stops has both ready,
                // so the turn is read first.
                outcome = completion => Some(outcome),
                () = stopped => None,
            }
        })
        .await;
        assert!(
            lock(&host).is_none(),
            "control: the worker minted the approval's command id"
        );
        assert!(
            matches!(settled, Ok(None)),
            "a decide cut short by the transport end must stop the worker and leave the turn to the sweep, got {settled:?}"
        );
    }

    #[test]
    fn settled_turns_leave_session_routing_state() {
        let handle = TurnHandle::new("turn-1");
        let mut state = SessionState::default();
        state.turns.insert(
            "turn-1".to_owned(),
            TurnRoute {
                handle,
                item_ids: HashSet::from(["item-1".to_owned(), "item-2".to_owned()]),
            },
        );
        state
            .item_turns
            .insert("item-1".to_owned(), "turn-1".to_owned());
        state
            .item_turns
            .insert("item-2".to_owned(), "turn-1".to_owned());

        assert!(state.settle_and_retire_turn("turn-1", |handle| {
            handle.fail(TurnWaitError::EventSourceFailed {
                message: "settled".to_owned(),
            });
        }));
        assert!(state.turns.is_empty());
        assert!(state.item_turns.is_empty());
    }

    /// The gap hold's own bound. Frames applied
    /// straight through the session while a `view/gap` hole is still
    /// pending (its `view/page` never answered) are held; the frame past
    /// `MAX_HELD_GAP_FRAMES` fails the event source with the hold's message,
    /// not the connection's.
    #[test]
    fn frames_held_past_the_gap_hold_bound_fail_the_event_source() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (outbound, inbound) = mpsc::unbounded_channel();
            let replies = std::collections::VecDeque::from([
                ("session/start", serde_json::json!({
                "jsonrpc": "2.0",
                "id": 0,
                "result": {
                    "session": {
                        "sessionId": "session-1",
                        "path": "/tmp/session.jsonl",
                        "status": "idle",
                        "activeTurnId": null,
                        "createdAt": "2026-09-29T00:00:00Z",
                        "updatedAt": "2026-09-29T00:00:00Z",
                        "workspaceRoot": null,
                        "providerId": null,
                        "modelId": null,
                        "turnCount": 0,
                        "forkedFrom": null
                    },
                    "viewCursor": "cursor-1"
                }
            })),
                ("session/start", serde_json::json!({
                "jsonrpc": "2.0",
                "id": 0,
                "result": {
                    "session": {
                        "sessionId": "session-2",
                        "path": "/tmp/session-2.jsonl",
                        "status": "idle",
                        "activeTurnId": null,
                        "createdAt": "2026-09-29T00:00:00Z",
                        "updatedAt": "2026-09-29T00:00:00Z",
                        "workspaceRoot": null,
                        "providerId": null,
                        "modelId": null,
                        "turnCount": 0,
                        "forkedFrom": null
                    },
                    "viewCursor": "cursor-1"
                }
            })),
            ]);
            let client = MuseClient::with_command_id_minter(
                RepliesOnWrite {
                    inbound,
                    outbound,
                    replies,
                },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "session opens");
            let Ok(session) = session else {
                return;
            };
            let notification = |method: &str, params: serde_json::Value| Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: method.to_owned(),
                params: params.as_object().cloned(),
                emitted_at_ms: None,
            };
            session.inner.apply(notification(
                "view/gap",
                serde_json::json!({"sessionId": "session-1", "after": "cursor-2", "next": "cursor-5"}),
            ));
            for index in 0..=gap_route::MAX_HELD_GAP_FRAMES {
                assert!(
                    lock(&session.inner.state).event_source_failure.is_none(),
                    "frame {index} is within the hold's bound"
                );
                session.inner.apply(notification(
                    "item/completed",
                    serde_json::json!({
                        "sessionId": "session-1",
                        "viewCursor": format!("cursor-{}", index + 6),
                    }),
                ));
            }
            assert_eq!(
                lock(&session.inner.state).event_source_failure,
                Some(TurnWaitError::EventSourceFailed {
                    message: "notification backlog exceeded for this session behind a pending \
                              delivery gap"
                        .to_owned(),
                })
            );
            // Robust continuity under this fault: the refusal is
            // scoped to that session; the client still correlates responses
            // and opens another.
            let survivor = client.start_session(StartSessionOptions::default()).await;
            assert!(
                survivor.is_ok_and(|survivor| survivor.session_id() == "session-2"),
                "another session on the same client survives the hold bound"
            );
            client.close().await;
        });
    }

    fn opened_session(id: i64, session_id: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "result": {
                    "session": {
                        "sessionId": session_id,
                        "path": "/tmp/session.jsonl",
                        "status": "idle",
                        "activeTurnId": null,
                        "createdAt": "2026-09-29T00:00:00Z",
                        "updatedAt": "2026-09-29T00:00:00Z",
                        "workspaceRoot": null,
                        "providerId": null,
                        "modelId": null,
                        "turnCount": 0,
                        "forkedFrom": null
                    },
                    "viewCursor": "cursor-1"
                }
            })
        )
    }

    fn item_completed(session_id: &str, item_id: &str) -> Notification {
        Notification {
            jsonrpc: crate::msp::JsonRpcVersion::V2,
            method: "item/completed".to_owned(),
            params: serde_json::json!({
                "sessionId": session_id,
                "viewCursor": format!("cursor-{item_id}"),
                "sourceRange": {
                    "stream": {"kind": "run", "id": "turn-1"},
                    "first": {"id": "event-1", "sequence": 1},
                    "last": {"id": "event-1", "sequence": 1}
                },
                "item": {
                    "itemId": item_id,
                    "kind": "agentMessage",
                    "turnId": "turn-1",
                    "revision": 1,
                    "status": "completed",
                    "text": "reply"
                }
            })
            .as_object()
            .cloned(),
            emitted_at_ms: None,
        }
    }

    /// Once a session's event source fails
    /// on a lost event, its fold stops at the last applied event and reports
    /// not current; another session's fold keeps applying, and closing the
    /// client, with no fill pending and no later frame, leaves that fold
    /// current.
    #[test]
    fn a_lost_event_stops_only_its_own_session_fold() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let affected = client.start_session(StartSessionOptions::default()).await;
            assert!(affected.is_ok(), "the affected session opens");
            assert!(inbound.send(opened_session(2, "session-2")).is_ok());
            let unaffected = client.start_session(StartSessionOptions::default()).await;
            assert!(unaffected.is_ok(), "the unaffected session opens");
            let (Ok(affected), Ok(unaffected)) = (affected, unaffected) else {
                return;
            };

            affected
                .inner
                .apply(item_completed("session-1", "item-before"));
            affected
                .inner
                .fail_event_source(TurnWaitError::EventSourceFailed {
                    message: "notification backlog exceeded for this session; close this client, then resume the session on a new client to continue".to_owned(),
                });
            assert!(
                affected.fold().is_stopped(),
                "the loss alone stops the fold"
            );
            assert!(
                !affected.fold().is_current(),
                "the loss alone ends currency"
            );
            affected
                .inner
                .apply(item_completed("session-1", "item-after"));
            affected.inner.apply(Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: "userInput/requested".to_owned(),
                params: serde_json::json!({"sessionId": "session-1", "userInputId": "input-after"})
                    .as_object()
                    .cloned(),
                emitted_at_ms: None,
            });
            unaffected
                .inner
                .apply(item_completed("session-2", "item-other"));

            {
                let fold = affected.fold();
                assert!(fold.item("item-before").is_some());
                assert!(
                    fold.item("item-after").is_none(),
                    "nothing folds across the lost event"
                );
                assert!(
                    fold.pending_user_inputs().is_empty(),
                    "a lost event stops questions too"
                );
                assert!(!fold.is_current(), "the fold says it is incomplete");
                assert!(fold.is_stopped(), "the fold says it stopped for good");
                assert!(fold.pending_gap().is_none(), "no gap names the loss");
            }
            {
                let fold = unaffected.fold();
                assert!(fold.item("item-other").is_some());
                assert!(fold.is_current());
                assert!(!fold.is_stopped());
            }

            client.close().await;
            assert!(
                unaffected.fold().is_current(),
                "closing the client loses no event"
            );
            assert!(!unaffected.fold().is_stopped());
        });
    }

    /// A source failure stops a cut
    /// fill before it wakes the failed turns, so a turn woken by close or by
    /// the transport's end never reads the pending gap as a fill still running.
    #[test]
    fn a_failed_turn_wakes_to_a_stopped_fold_when_its_fill_was_cut() {
        struct ReadFoldOnWake {
            session: Session,
            seen: std::sync::Mutex<Option<bool>>,
        }
        impl std::task::Wake for ReadFoldOnWake {
            fn wake(self: Arc<Self>) {
                self.wake_by_ref();
            }
            fn wake_by_ref(self: &Arc<Self>) {
                let mut seen = self
                    .seen
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if seen.is_none() {
                    *seen = Some(self.session.fold().is_stopped());
                }
            }
        }
        let cuts: [fn(&SessionInner); 2] = [
            |inner| inner.fail_event_source(TurnWaitError::ClientClosed),
            |inner| inner.transport_ended(false),
        ];
        for cut in cuts {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build();
            assert!(runtime.is_ok(), "caller runtime builds");
            let Ok(runtime) = runtime else {
                return;
            };
            runtime.block_on(async {
                let (inbound, reads) = mpsc::unbounded_channel();
                let client = MuseClient::with_command_id_minter(
                    ChannelTransport { inbound: reads },
                    SessionDurability::Durable,
                    || "command-1".to_owned(),
                );
                assert!(inbound.send(opened_session(1, "session-1")).is_ok());
                let session = client.start_session(StartSessionOptions::default()).await;
                assert!(session.is_ok(), "the session opens");
                let Ok(session) = session else {
                    return;
                };
                let handle = TurnHandle::new("turn-1");
                let turn = handle.turn();
                lock(&session.inner.state).turns.insert(
                    "turn-1".to_owned(),
                    TurnRoute {
                        handle,
                        item_ids: HashSet::new(),
                    },
                );
                let reader = Arc::new(ReadFoldOnWake {
                    session: session.clone(),
                    seen: std::sync::Mutex::new(None),
                });
                let waker = Waker::from(Arc::clone(&reader));
                let mut completed = Box::pin(turn.completed());
                assert!(
                    completed
                        .as_mut()
                        .poll(&mut Context::from_waker(&waker))
                        .is_pending()
                );
                session.inner.mirror_gap(Some(&crate::msp::ViewGapParams {
                    session_id: "session-1".to_owned(),
                    after: "cursor-2".to_owned(),
                    next: "cursor-3".to_owned(),
                }));

                cut(&session.inner);
                let seen = *reader
                    .seen
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                assert_eq!(seen, Some(true), "the woken turn reads a stopped fold");
                drop(completed);
                client.close().await;
            });
        }
    }

    /// The close failure itself stops a
    /// fold whose fill it cuts, so a hole recorded just before the walker is
    /// aborted cannot read as a fill still running.
    #[test]
    fn a_client_closed_failure_stops_a_fold_whose_fill_it_cuts() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };
            session.inner.mirror_gap(Some(&crate::msp::ViewGapParams {
                session_id: "session-1".to_owned(),
                after: "cursor-2".to_owned(),
                next: "cursor-3".to_owned(),
            }));
            assert!(!session.fold().is_stopped(), "the fill is still running");
            session.inner.fail_event_source(TurnWaitError::ClientClosed);
            let fold = session.fold();
            assert!(fold.pending_gap().is_some());
            assert!(fold.is_stopped(), "the close failure cut the fill");
            client.close().await;
        });
    }

    /// A transport end cuts a pending
    /// gap fill, so it stops the fold there, whichever the walker sees first.
    #[test]
    fn transport_end_stops_a_fold_whose_fill_it_cuts() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };
            session.inner.mirror_gap(Some(&crate::msp::ViewGapParams {
                session_id: "session-1".to_owned(),
                after: "cursor-2".to_owned(),
                next: "cursor-3".to_owned(),
            }));
            assert!(!session.fold().is_stopped(), "the fill is still running");

            session.inner.transport_ended(false);
            let fold = session.fold();
            assert!(fold.pending_gap().is_some());
            assert!(fold.is_stopped(), "nothing can fill the hole after the end");
            client.close().await;
        });
    }

    /// Close cuts a pending gap fill
    /// at once, so it stops the fold there, before any transport end.
    #[test]
    fn close_stops_a_fold_whose_fill_it_cuts() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };
            session.inner.mirror_gap(Some(&crate::msp::ViewGapParams {
                session_id: "session-1".to_owned(),
                after: "cursor-2".to_owned(),
                next: "cursor-3".to_owned(),
            }));
            assert!(!session.fold().is_stopped(), "the fill is still running");

            // Close's first, synchronous step; no transport end has run yet.
            drop(session.inner.begin_close());
            let fold = session.fold();
            assert!(fold.pending_gap().is_some());
            assert!(fold.is_stopped(), "nothing can fill the hole after close");
            client.close().await;
        });
    }

    /// A frame that reaches a session
    /// after close is a late frame, so it never folds (a twin a gap page
    /// already served could repeat); the handoff accepted it, so dropping it
    /// stops the fold.
    #[test]
    fn a_frame_after_close_does_not_fold() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };
            session
                .inner
                .apply(item_completed("session-1", "item-before"));
            drop(session.inner.begin_close());
            session
                .inner
                .apply(item_completed("session-1", "item-after"));

            {
                let fold = session.fold();
                assert!(fold.item("item-before").is_some());
                assert!(
                    fold.item("item-after").is_none(),
                    "the tail after close never folds"
                );
                assert!(fold.is_stopped(), "the dropped frame stops the fold");
                assert!(!fold.is_current());
            }
            client.close().await;
        });
    }

    /// A loss after a re-open
    /// ends the question-event exception, so the fold then applies nothing.
    #[test]
    fn a_loss_after_a_reopen_stops_question_events() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };
            let question = |id: &str| Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: "userInput/requested".to_owned(),
                params: serde_json::json!({"sessionId": "session-1", "userInputId": id})
                    .as_object()
                    .cloned(),
                emitted_at_ms: None,
            };
            session.mark_fold_reopened();
            session.inner.apply(question("input-before"));
            session
                .inner
                .fail_event_source(TurnWaitError::EventSourceFailed {
                    message: "notification backlog exceeded for this session; close this client, then resume the session on a new client to continue".to_owned(),
                });
            session.inner.apply(question("input-after"));

            let pending: Vec<String> = session
                .fold()
                .pending_user_inputs()
                .iter()
                .filter_map(|input| input["userInputId"].as_str().map(str::to_owned))
                .collect();
            assert_eq!(
                pending,
                ["input-before"],
                "the re-opened fold took the first question; the loss stopped the second"
            );
            client.close().await;
        });
    }

    /// Any other source failure
    /// after a re-open ends the question-event exception too: the session's
    /// turns fail with that first source failure, and its late frames never fold.
    #[test]
    fn a_close_after_a_reopen_stops_question_events() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };
            let question = |id: &str| Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: "userInput/requested".to_owned(),
                params: serde_json::json!({"sessionId": "session-1", "userInputId": id})
                    .as_object()
                    .cloned(),
                emitted_at_ms: None,
            };
            session.mark_fold_reopened();
            session.inner.apply(question("input-before"));
            drop(session.inner.begin_close());
            session.inner.apply(question("input-after"));

            let pending: Vec<String> = session
                .fold()
                .pending_user_inputs()
                .iter()
                .filter_map(|input| input["userInputId"].as_str().map(str::to_owned))
                .collect();
            assert_eq!(
                pending,
                ["input-before"],
                "the re-opened fold took the first question; the close stopped the second"
            );
            client.close().await;
        });
    }

    /// A fold view holds no lock between
    /// reads, so a caller keeping one never holds up event application, and
    /// each read sees the events applied before it.
    #[test]
    fn a_fold_view_holds_no_lock_between_reads() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };

            let view = session.fold();
            assert!(view.item("item-later").is_none());
            assert!(
                session.inner.fold.try_lock().is_ok(),
                "a kept view must not hold the fold lock"
            );
            session
                .inner
                .apply(item_completed("session-1", "item-later"));
            assert!(
                view.item("item-later").is_some(),
                "the next read sees the event applied after the last one"
            );
            client.close().await;
        });
    }

    /// A second `view/gap` that extends a hole the walk is
    /// still paging moves the fold's pending hole to the walk's new target.
    #[test]
    fn an_extended_delivery_gap_moves_the_fold_to_the_new_target() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };
            let gap = |after: &str, next: &str| Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: "view/gap".to_owned(),
                params: serde_json::json!({"sessionId": "session-1", "after": after, "next": next})
                    .as_object()
                    .cloned(),
                emitted_at_ms: None,
            };

            session.inner.apply(gap("cursor-2", "cursor-3"));
            session.inner.apply(gap("cursor-3", "cursor-5"));

            let fold = session.fold();
            assert!(!fold.is_current());
            let pending = fold
                .pending_gap()
                .map(|gap| (gap.after().to_owned(), gap.next().to_owned()));
            assert_eq!(
                pending,
                Some(("cursor-2".to_owned(), "cursor-5".to_owned()))
            );
            client.close().await;
        });
    }

    /// The fold view reads each family the fold keeps:
    /// approvals, user inputs in order, accumulated deltas and the running
    /// turn.
    #[test]
    fn a_fold_view_reads_approvals_user_inputs_deltas_and_the_active_turn() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };
            let note = |method: &str, params: serde_json::Value| Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: method.to_owned(),
                params: params.as_object().cloned(),
                emitted_at_ms: None,
            };
            let range = serde_json::json!({
                "stream": {"kind": "run", "id": "turn-9"},
                "first": {"id": "event-1", "sequence": 1},
                "last": {"id": "event-1", "sequence": 1}
            });
            for (approval_id, resolve) in [("approval-1", true), ("approval-2", false)] {
                session.inner.apply(note(
                    "approval/requested",
                    serde_json::json!({
                        "sessionId": "session-1",
                        "approvalId": approval_id,
                        "turnId": "turn-9",
                        "taskId": format!("task-{approval_id}"),
                        "itemId": format!("item-{approval_id}"),
                        "toolCallId": format!("call-{approval_id}"),
                        "toolName": "shell",
                        "rawArgs": "{}",
                        "viewCursor": format!("cursor-{approval_id}"),
                        "sourceRange": range,
                        "subject": {"kind": "shell", "command": "pwd"},
                        "currentRequirementId": {"approvalId": approval_id, "sourceIndex": 0},
                        "availableChoices": [],
                        "protectedWrite": false,
                        "judgeEscalated": false
                    }),
                ));
                if resolve {
                    session.inner.apply(note(
                        "approval/resolved",
                        serde_json::json!({"sessionId": "session-1", "approvalId": approval_id}),
                    ));
                }
            }
            for input in ["input-1", "input-2"] {
                session.inner.apply(note(
                    "userInput/requested",
                    serde_json::json!({"sessionId": "session-1", "userInputId": input}),
                ));
            }
            session.inner.apply(note(
                "userInput/settled",
                serde_json::json!({"sessionId": "session-1", "userInputId": "input-1"}),
            ));
            session.inner.apply(note(
                "turn/started",
                serde_json::json!({
                    "sessionId": "session-1",
                    "viewCursor": "cursor-t",
                    "sourceRange": range,
                    "turnId": "turn-9",
                    "commandId": "command-9"
                }),
            ));
            session.inner.apply(note(
                "item/started",
                serde_json::json!({
                    "sessionId": "session-1",
                    "viewCursor": "cursor-i",
                    "sourceRange": range,
                    "item": {
                        "itemId": "item-a",
                        "kind": "agentMessage",
                        "turnId": "turn-9",
                        "revision": 1,
                        "status": "inProgress",
                        "text": ""
                    }
                }),
            ));
            session.inner.apply(note(
                "item/delta",
                serde_json::json!({
                    "sessionId": "session-1",
                    "viewCursor": "cursor-d",
                    "itemId": "item-a",
                    "delta": "hi"
                }),
            ));

            let fold = session.fold();
            assert!(fold.pending_approval("approval-1").is_none());
            assert!(fold.resolved_approval("approval-1").is_some());
            assert!(fold.pending_approval("approval-2").is_some());
            assert!(fold.resolved_approval("approval-2").is_none());
            let ids = |inputs: Vec<serde_json::Value>| -> Vec<String> {
                inputs
                    .iter()
                    .filter_map(|input| input["userInputId"].as_str().map(str::to_owned))
                    .collect()
            };
            assert_eq!(ids(fold.pending_user_inputs()), ["input-2"]);
            assert_eq!(ids(fold.settled_user_inputs()), ["input-1"]);
            assert!(fold.pending_user_input("input-2").is_some());
            assert!(fold.settled_user_input("input-1").is_some());
            assert_eq!(fold.accumulated("item-a", "text"), Some("hi".to_owned()));
            assert_eq!(fold.active_turn_id(), Some("turn-9".to_owned()));
            client.close().await;
        });
    }

    /// The fold view lists the item and turn ids it holds
    /// in first-seen order, so a caller can walk a resumed fold without the
    /// raw opening; a later update to a held id does not move it.
    #[test]
    fn a_fold_view_lists_item_and_turn_ids_in_first_seen_order() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            assert!(inbound.send(opened_session(1, "session-1")).is_ok());
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "the session opens");
            let Ok(session) = session else {
                return;
            };
            let note = |method: &str, params: serde_json::Value| Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: method.to_owned(),
                params: params.as_object().cloned(),
                emitted_at_ms: None,
            };
            // Eight ids each, neither alphabetical nor shared between the two
            // lists, so HashMap iteration cannot pass by luck.
            let order = ["e", "b", "g", "a", "h", "c", "f", "d"];
            for (revision, id) in [(1, "e"), (1, "b"), (1, "g"), (1, "a"), (2, "b")]
                .into_iter()
                .chain([(1, "h"), (1, "c"), (1, "f"), (1, "d"), (2, "e")])
            {
                session.inner.apply(note(
                    "item/updated",
                    serde_json::json!({
                        "sessionId": "session-1",
                        "viewCursor": format!("cursor-{id}-{revision}"),
                        "item": {"itemId": format!("item-{id}"), "revision": revision}
                    }),
                ));
            }
            for id in order.iter().rev().chain(["d", "a"].iter()) {
                session.inner.apply(note(
                    "turn/started",
                    serde_json::json!({
                        "sessionId": "session-1",
                        "viewCursor": format!("cursor-turn-{id}"),
                        "turnId": format!("turn-{id}"),
                        "commandId": format!("command-{id}")
                    }),
                ));
            }

            let fold = session.fold();
            assert_eq!(
                fold.item_ids(),
                order.map(|id| format!("item-{id}")),
                "items list in first-seen order; updates do not move them"
            );
            assert_eq!(
                fold.turn_ids(),
                order
                    .map(|id| format!("turn-{id}"))
                    .into_iter()
                    .rev()
                    .collect::<Vec<_>>(),
                "turns list in first-seen order; repeats do not move them"
            );
            client.close().await;
        });
    }

    #[test]
    fn source_failure_settlement_records_first_cause_and_clears_routes() {
        let handle = TurnHandle::new("turn-1");
        let turn = handle.turn();
        let mut state = SessionState::default();
        state.turns.insert(
            "turn-1".to_owned(),
            TurnRoute {
                handle,
                item_ids: HashSet::from(["item-1".to_owned()]),
            },
        );
        state
            .item_turns
            .insert("item-1".to_owned(), "turn-1".to_owned());

        state.settle_source_failure(TurnWaitError::ClientClosed);
        state.settle_source_failure(TurnWaitError::SourceClosed);

        assert_eq!(
            state.event_source_failure,
            Some(TurnWaitError::ClientClosed)
        );
        assert!(state.turns.is_empty());
        assert!(state.item_turns.is_empty());
        let mut completed = turn.completed();
        assert!(matches!(
            poll_once(completed.as_mut()),
            Poll::Ready(Err(crate::errors::MuseError::ClientClosed))
        ));
    }

    #[test]
    fn dropping_send_user_turn_retires_its_pending_command() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "session": {
                            "sessionId": "session-1",
                            "path": "/tmp/session.jsonl",
                            "status": "idle",
                            "activeTurnId": null,
                            "createdAt": "2026-09-29T00:00:00Z",
                            "updatedAt": "2026-09-29T00:00:00Z",
                            "workspaceRoot": null,
                            "providerId": null,
                            "modelId": null,
                            "turnCount": 0,
                            "forkedFrom": null
                        },
                        "viewCursor": "cursor-1"
                    }
                })
            ));
            assert!(queued.is_ok(), "session response queued");
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "session opens");
            let Ok(session) = session else {
                return;
            };
            let mut turn = Box::pin(session.send_user_turn(SendUserTurnOptions::default()));
            assert!(poll_once(turn.as_mut()).is_pending());
            assert_eq!(lock(&session.inner.state).pending_commands.len(), 1);

            drop(turn);

            assert!(lock(&session.inner.state).pending_commands.is_empty());
            client.close().await;
        });
    }

    #[test]
    fn turn_claimed_after_client_close_keeps_closed_error() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "session": {
                            "sessionId": "session-1",
                            "path": "/tmp/session.jsonl",
                            "status": "idle",
                            "activeTurnId": null,
                            "createdAt": "2026-09-29T00:00:00Z",
                            "updatedAt": "2026-09-29T00:00:00Z",
                            "workspaceRoot": null,
                            "providerId": null,
                            "modelId": null,
                            "turnCount": 0,
                            "forkedFrom": null
                        },
                        "viewCursor": "cursor-1"
                    }
                })
            ));
            assert!(queued.is_ok(), "session response queued");
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            let session = client.start_session(StartSessionOptions::default()).await;
            assert!(session.is_ok(), "session opens");
            let Ok(session) = session else {
                return;
            };

            client.close().await;
            session.inner.transport_ended(false);
            let turn = session.inner.claim_turn("turn-after-close");

            assert!(matches!(
                turn.completed().await,
                Err(crate::errors::MuseError::ClientClosed)
            ));
        });
    }

    #[test]
    fn settled_alias_capacity_evicts_instead_of_poisoning_the_session() {
        let mut state = SessionState::default();
        state.pending_commands.insert("command-1".to_owned());
        for sequence in 0..=MAX_SETTLED_TURN_ALIASES {
            let turn_id = format!("turn-{sequence}");
            let handle = TurnHandle::new(&turn_id);
            state.turns.insert(
                turn_id.clone(),
                TurnRoute {
                    handle,
                    item_ids: HashSet::new(),
                },
            );
            assert!(state.settle_and_retire_turn(&turn_id, |handle| {
                handle.fail(TurnWaitError::EventSourceFailed {
                    message: "settled".to_owned(),
                });
            }));
        }

        assert!(state.event_source_failure.is_none());
        assert_eq!(state.settled_turns.len(), MAX_SETTLED_TURN_ALIASES);
        assert!(
            state
                .settled_turns
                .contains_key(&format!("turn-{MAX_SETTLED_TURN_ALIASES}"))
        );
    }

    #[test]
    fn a_resumed_session_holds_settled_aliases_until_released() {
        let mut state = SessionState::default();
        state.hold_settled_aliases = true;
        let handle = TurnHandle::new("turn-1");
        state.turns.insert(
            "turn-1".to_owned(),
            TurnRoute {
                handle,
                item_ids: HashSet::new(),
            },
        );

        // Retired with no command in flight: only the hold keeps the alias.
        assert!(state.settle_and_retire_turn("turn-1", |handle| {
            handle.fail(TurnWaitError::EventSourceFailed {
                message: "settled".to_owned(),
            });
        }));
        assert!(state.settled_turns.contains_key("turn-1"));
        state.pending_commands.insert("command-other".to_owned());
        state.finish_pending_command("command-other");
        assert!(state.settled_turns.contains_key("turn-1"));

        state.release_settled_alias_hold();
        assert!(state.settled_turns.is_empty());
    }

    fn carried(session_id: &str, command_id: &str, turn_id: Option<&str>) -> PendingTurn {
        PendingTurn {
            session_id: session_id.to_owned(),
            command_id: command_id.to_owned(),
            options: SendUserTurnOptions::default(),
            turn_id: turn_id.map(str::to_owned),
        }
    }

    /// A durable `session-1` resumed over `RepliesOnWrite`, which answers each
    /// later scripted method only once its request is written.
    async fn resumed_session(
        later: Vec<(&'static str, serde_json::Value)>,
    ) -> Option<(MuseClient, Session)> {
        let (outbound, inbound) = mpsc::unbounded_channel();
        let mut replies = std::collections::VecDeque::from([(
            "session/resume",
            serde_json::json!({
                "jsonrpc": "2.0",
                "id": 0,
                "result": {
                    "session": {
                        "sessionId": "session-1",
                        "path": "/tmp/session.jsonl",
                        "status": "idle",
                        "activeTurnId": null,
                        "createdAt": "2026-09-29T00:00:00Z",
                        "updatedAt": "2026-09-29T00:00:00Z",
                        "workspaceRoot": null,
                        "providerId": null,
                        "modelId": null,
                        "turnCount": 1,
                        "forkedFrom": null
                    },
                    "viewCursor": "cursor-1",
                    "history": {"mode": "inline", "items": [], "snapshot": null},
                    "pendingRequests": []
                }
            }),
        )]);
        replies.extend(later);
        let client = MuseClient::with_command_id_minter(
            RepliesOnWrite {
                inbound,
                outbound,
                replies,
            },
            SessionDurability::Durable,
            || "command-resume".to_owned(),
        );
        let session = client
            .resume_session(ResumeSessionOptions {
                session_id: "session-1".to_owned(),
                ..ResumeSessionOptions::default()
            })
            .await;
        assert!(session.is_ok(), "session resumes");
        Some((client, session.ok()?))
    }

    /// Applies a turn's terminal synchronously, as the dispatcher would.
    fn apply_turn_completed(session: &Session, turn_id: &str) {
        session.inner.apply(Notification {
            jsonrpc: crate::msp::JsonRpcVersion::V2,
            method: "turn/completed".to_owned(),
            params: serde_json::json!({
                "sessionId": "session-1",
                "viewCursor": "cursor-2",
                "sourceRange": {
                    "stream": {"kind": "run", "id": turn_id},
                    "first": {"id": "event-1", "sequence": 1},
                    "last": {"id": "event-1", "sequence": 1}
                },
                "turnId": turn_id,
                "terminal": "completed",
                "durationMs": 5
            })
            .as_object()
            .cloned(),
            emitted_at_ms: None,
        });
    }

    #[test]
    fn a_refused_resolve_reconnect_keeps_the_hold_for_the_corrected_call() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            // The refused call writes nothing, so this answers the corrected one.
            let answer = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 0,
                "result": {
                    "commandId": "command-own",
                    "status": "accepted",
                    "turnId": "turn-1",
                    "startedNewTurn": true,
                    "disposition": "started"
                }
            });
            let Some((client, session)) = resumed_session(vec![("turn/start", answer)]).await
            else {
                return;
            };
            // turn-1 finished before any resolve_reconnect: only the hold keeps it.
            apply_turn_completed(&session, "turn-1");
            assert!(
                lock(&session.inner.state)
                    .settled_turns
                    .contains_key("turn-1")
            );
            let own = carried("session-1", "command-own", Some("turn-1"));

            let refused = session
                .resolve_reconnect(vec![
                    own.clone(),
                    carried("session-2", "command-foreign", None),
                ])
                .await;

            assert!(matches!(
                refused,
                Err(crate::errors::MuseError::Protocol(_))
            ));
            assert!(
                lock(&session.inner.state)
                    .settled_turns
                    .contains_key("turn-1"),
                "a refused call keeps the hold for the corrected call"
            );
            let corrected = session.resolve_reconnect(vec![own]).await;
            let live = corrected
                .ok()
                .and_then(|mut resolved| resolved.pop())
                .and_then(|resolution| resolution.result.ok());
            assert!(
                matches!(live, Some(Reconnected::Live(_))),
                "the corrected call follows turn-1"
            );
            if let Some(Reconnected::Live(turn)) = live {
                assert!(matches!(
                    turn.completed().await,
                    Ok(TurnOutcome::Completed { .. })
                ));
            }
            client.close().await;
        });
    }

    #[test]
    fn an_empty_resolve_reconnect_releases_the_hold() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let Some((client, session)) = resumed_session(Vec::new()).await else {
                return;
            };
            apply_turn_completed(&session, "turn-1");
            assert!(
                lock(&session.inner.state)
                    .settled_turns
                    .contains_key("turn-1")
            );

            let resolved = session.resolve_reconnect(Vec::new()).await;

            assert!(matches!(resolved.as_deref(), Ok([])));
            assert!(!lock(&session.inner.state).hold_settled_aliases);
            assert!(lock(&session.inner.state).settled_turns.is_empty());
            client.close().await;
        });
    }

    #[test]
    fn a_cancelled_resolve_reconnect_releases_the_hold() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            // No scripted `turn/start` answer: the resend stays in flight.
            let Some((client, session)) = resumed_session(Vec::new()).await else {
                return;
            };
            assert!(lock(&session.inner.state).hold_settled_aliases);
            let mut resolving = Box::pin(session.resolve_reconnect(vec![carried(
                "session-1",
                "command-own",
                None,
            )]));
            assert!(poll_once(resolving.as_mut()).is_pending());
            assert!(lock(&session.inner.state).hold_settled_aliases);

            drop(resolving);

            assert!(!lock(&session.inner.state).hold_settled_aliases);
            client.close().await;
        });
    }

    #[test]
    fn an_answered_turn_refused_a_route_at_the_cap_stays_pending() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let answer = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 0,
                "result": {
                    "commandId": "command-resume",
                    "status": "accepted",
                    "turnId": "turn-over-cap",
                    "startedNewTurn": true,
                    "disposition": "started"
                }
            });
            let Some((client, session)) = resumed_session(vec![("turn/start", answer)]).await
            else {
                return;
            };
            {
                let mut state = lock(&session.inner.state);
                for sequence in 0..MAX_ACTIVE_TURNS {
                    let turn_id = format!("live-{sequence}");
                    state
                        .turns
                        .insert(turn_id.clone(), TurnRoute::new(&turn_id));
                }
            }

            // The server started the turn, but the cap refuses it a route: until
            // that turn's terminal is routed here, it must stay pending.
            let turn = session.send_user_turn(SendUserTurnOptions::default()).await;
            assert!(turn.is_ok(), "the answer is accepted");
            assert!(
                !lock(&session.inner.state)
                    .turns
                    .contains_key("turn-over-cap"),
                "the cap refused the turn a route"
            );

            let pending = session.pending();
            assert_eq!(pending.len(), 1);
            assert_eq!(pending[0].command_id(), "command-resume");
            assert_eq!(pending[0].turn_id(), Some("turn-over-cap"));
            // All 128 routes are still taken, so its own terminal is not applied.
            apply_turn_completed(&session, "turn-over-cap");
            assert_eq!(
                session.pending().len(),
                1,
                "a terminal under a full cap is not applied"
            );
            client.close().await;
        });
    }

    #[test]
    fn a_cap_refused_turn_leaves_pending_once_its_terminal_arrives() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let answer = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 0,
                "result": {
                    "commandId": "command-resume",
                    "status": "accepted",
                    "turnId": "turn-over-cap",
                    "startedNewTurn": true,
                    "disposition": "started"
                }
            });
            let Some((client, session)) = resumed_session(vec![("turn/start", answer)]).await
            else {
                return;
            };
            {
                let mut state = lock(&session.inner.state);
                for sequence in 0..MAX_ACTIVE_TURNS {
                    let turn_id = format!("live-{sequence}");
                    state
                        .turns
                        .insert(turn_id.clone(), TurnRoute::new(&turn_id));
                }
            }
            let turn = session.send_user_turn(SendUserTurnOptions::default()).await;
            assert!(turn.is_ok(), "the answer is accepted");
            assert!(
                !lock(&session.inner.state)
                    .turns
                    .contains_key("turn-over-cap"),
                "the cap refused the turn a route"
            );
            assert_eq!(session.pending().len(), 1);

            // The cap is transient: once a live turn ends, the refused turn's own
            // terminal is routed here, and that answers its submission.
            apply_turn_completed(&session, "live-0");
            assert_eq!(
                session.pending().len(),
                1,
                "another turn's terminal answers nothing"
            );
            apply_turn_completed(&session, "turn-over-cap");

            assert!(session.pending().is_empty());
            client.close().await;
        });
    }

    /// What a turn's waiter could see of the session when settlement woke it.
    #[derive(Debug)]
    enum SeenOnWake {
        /// The settler held the session state when it woke the waiter. It
        /// retires the turn before releasing it because
        /// `SessionState::settle_and_retire_turn` does both in one `&mut self`
        /// call.
        Locked,
        Unlocked {
            still_routed: bool,
            new_route_fits: bool,
        },
    }

    /// A waker that looks at the session state the moment it is woken: tokio's
    /// `watch` wakes it inline, inside the settle.
    struct LookOnWake {
        inner: Arc<SessionInner>,
        turn_id: &'static str,
        seen: Mutex<Option<SeenOnWake>>,
    }

    impl std::task::Wake for LookOnWake {
        fn wake(self: Arc<Self>) {
            self.wake_by_ref();
        }

        fn wake_by_ref(self: &Arc<Self>) {
            let seen = match self.inner.state.try_lock() {
                Ok(state) => SeenOnWake::Unlocked {
                    still_routed: state.turns.contains_key(self.turn_id),
                    new_route_fits: state.accepts_turn_notification("turn-after"),
                },
                Err(std::sync::TryLockError::WouldBlock) => SeenOnWake::Locked,
                Err(std::sync::TryLockError::Poisoned(state)) => {
                    let state = state.into_inner();
                    SeenOnWake::Unlocked {
                        still_routed: state.turns.contains_key(self.turn_id),
                        new_route_fits: state.accepts_turn_notification("turn-after"),
                    }
                }
            };
            *lock(&self.seen) = Some(seen);
        }
    }

    /// A server terminal retires its turn under the lock that wakes
    /// `completed()`, so a caller that resumes at the active-turn cap can open
    /// a new route at once instead of being refused.
    fn settled_turn_is_retired_before_its_waiter_wakes(
        turn_id: &'static str,
        settle: fn(&Session, &str),
    ) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let answer = serde_json::json!({
                "jsonrpc": "2.0",
                "id": 0,
                "result": {
                    "commandId": "command-resume",
                    "status": "accepted",
                    "turnId": "turn-after",
                    "startedNewTurn": true,
                    "disposition": "started"
                }
            });
            let Some((client, session)) = resumed_session(vec![("turn/start", answer)]).await
            else {
                return;
            };
            let turn = session.inner.claim_turn(turn_id);
            {
                let mut state = lock(&session.inner.state);
                for sequence in 1..MAX_ACTIVE_TURNS {
                    let live = format!("live-{sequence}");
                    state.turns.insert(live.clone(), TurnRoute::new(&live));
                }
                assert!(
                    !state.accepts_turn_notification("turn-after"),
                    "the active-turn cap is full"
                );
            }
            let look = Arc::new(LookOnWake {
                inner: Arc::clone(&session.inner),
                turn_id,
                seen: Mutex::new(None),
            });
            let waker = Waker::from(Arc::clone(&look));
            let mut context = Context::from_waker(&waker);
            let mut completed = turn.completed();
            assert!(completed.as_mut().poll(&mut context).is_pending());

            settle(&session, turn_id);

            let seen = lock(&look.seen).take();
            assert!(
                matches!(
                    seen,
                    Some(
                        SeenOnWake::Locked
                            | SeenOnWake::Unlocked {
                                still_routed: false,
                                new_route_fits: true
                            }
                    )
                ),
                "the woken waiter saw the settled turn still holding its route: {seen:?}"
            );
            assert!(matches!(
                completed.as_mut().poll(&mut context),
                Poll::Ready(Ok(_))
            ));
            let after = session.send_user_turn(SendUserTurnOptions::default()).await;
            assert!(after.is_ok(), "the next turn/start is accepted");
            assert!(
                lock(&session.inner.state).turns.contains_key("turn-after"),
                "a turn started right after completed() resolves gets a route"
            );
            client.close().await;
        });
    }

    #[test]
    fn a_completed_turn_is_retired_before_its_waiter_wakes() {
        settled_turn_is_retired_before_its_waiter_wakes("turn-1", apply_turn_completed);
    }

    #[test]
    fn an_unqueued_turn_is_retired_before_its_waiter_wakes() {
        settled_turn_is_retired_before_its_waiter_wakes("turn-queued", |session, turn_id| {
            session.inner.apply(Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: "turn/unqueued".to_owned(),
                params: serde_json::json!({
                    "sessionId": "session-1",
                    "viewCursor": "cursor-2",
                    "sourceRange": {
                        "stream": {"kind": "session", "id": "session-1"},
                        "first": {"id": "event-1", "sequence": 1},
                        "last": {"id": "event-1", "sequence": 1}
                    },
                    "turnId": turn_id,
                    "commandId": "command-1"
                })
                .as_object()
                .cloned(),
                emitted_at_ms: None,
            });
        });
    }

    #[test]
    fn settle_and_retire_turn_settles_the_routed_handle_then_retires_it() {
        let mut state = SessionState::default();
        let handle = TurnHandle::new("turn-1");
        state.turns.insert(
            "turn-1".to_owned(),
            TurnRoute {
                handle: handle.clone(),
                item_ids: HashSet::new(),
            },
        );

        assert!(state.settle_and_retire_turn("turn-1", |turn| {
            turn.fail(TurnWaitError::EventSourceFailed {
                message: "settled".to_owned(),
            });
        }));
        assert!(handle.is_settled());
        assert!(state.turns.is_empty());

        let mut settled_unrouted = false;
        assert!(!state.settle_and_retire_turn("turn-unrouted", |_| settled_unrouted = true));
        assert!(
            !settled_unrouted,
            "an unrouted turn has no handle to settle"
        );
    }

    #[test]
    fn retired_turns_reject_late_notification_recreation() {
        let mut state = SessionState::default();
        for sequence in 0..=(MAX_RETIRED_TURNS + MAX_ACTIVE_TURNS) {
            let turn_id = format!("turn-{sequence}");
            let handle = TurnHandle::new(&turn_id);
            state.turns.insert(
                turn_id.clone(),
                TurnRoute {
                    handle,
                    item_ids: HashSet::new(),
                },
            );
            assert!(state.settle_and_retire_turn(&turn_id, |handle| {
                handle.fail(TurnWaitError::EventSourceFailed {
                    message: "settled".to_owned(),
                });
            }));
        }

        assert!(!state.accepts_turn_notification(&format!("turn-{MAX_RETIRED_TURNS}")));
        for sequence in 0..=(MAX_RETIRED_TURNS + MAX_ACTIVE_TURNS) {
            let turn_id = format!("turn-{sequence}");
            if state.accepts_turn_notification(&turn_id) {
                state
                    .turns
                    .insert(turn_id.clone(), TurnRoute::new(&turn_id));
            }
        }
        assert_eq!(state.turns.len(), MAX_ACTIVE_TURNS);
        assert!(!state.accepts_turn_notification("another-late-turn"));
    }

    #[test]
    fn retired_discard_history_is_bounded_per_session() {
        let mut state = SessionState::default();
        for sequence in 0..=MAX_RETIRED_TURNS {
            let turn_id = format!("turn-{sequence}");
            let command_id = format!("command-{sequence}");
            let handle = TurnHandle::new(&turn_id);
            let turn = handle.turn().with_discard(command_id);
            drop(turn);
            state.turns.insert(
                turn_id.clone(),
                TurnRoute {
                    handle,
                    item_ids: HashSet::new(),
                },
            );
            assert!(state.settle_and_retire_turn(&turn_id, |handle| {
                handle.fail(TurnWaitError::EventSourceFailed {
                    message: "settled".to_owned(),
                });
            }));
        }

        assert_eq!(state.retired_turns.len(), MAX_RETIRED_TURNS);
        assert!(!state.is_command_discarded("command-0"));
        assert!(state.is_command_discarded(&format!("command-{MAX_RETIRED_TURNS}")));
    }

    #[test]
    fn inline_history_resume_keeps_new_turns_runnable_past_the_active_turn_cap() {
        // A resumed session's finished history turns must not hold live
        // turn routes at resume, or the MAX_ACTIVE_TURNS cap refuses every new
        // turn.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let history: Vec<serde_json::Value> = (0..=MAX_ACTIVE_TURNS)
                .map(|sequence| {
                    serde_json::json!({
                        "itemId": format!("item-{sequence}"),
                        "kind": "agentMessage",
                        "turnId": format!("turn-{sequence}"),
                        "revision": 1,
                        "status": "completed",
                        "text": "earlier reply"
                    })
                })
                .collect();
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "session": {
                            "sessionId": "session-1",
                            "path": "/tmp/session.jsonl",
                            "status": "idle",
                            "activeTurnId": null,
                            "createdAt": "2026-09-29T00:00:00Z",
                            "updatedAt": "2026-09-29T00:00:00Z",
                            "workspaceRoot": null,
                            "providerId": null,
                            "modelId": null,
                            "turnCount": MAX_ACTIVE_TURNS + 1,
                            "forkedFrom": null
                        },
                        "viewCursor": "cursor-1",
                        "history": {"mode": "inline", "items": history, "snapshot": null},
                        "pendingRequests": []
                    }
                })
            ));
            assert!(queued.is_ok(), "resume response queued");
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            let session = client
                .resume_session(ResumeSessionOptions {
                    session_id: "session-1".to_owned(),
                    ..ResumeSessionOptions::default()
                })
                .await;
            assert!(session.is_ok(), "session resumes");
            let Ok(session) = session else {
                return;
            };

            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "result": {
                        "commandId": "command-1",
                        "status": "accepted",
                        "turnId": "turn-new",
                        "startedNewTurn": true,
                        "disposition": "started"
                    }
                })
            ));
            assert!(queued.is_ok(), "turn/start response queued");
            let turn = session.send_user_turn(SendUserTurnOptions::default()).await;
            assert!(turn.is_ok(), "turn/start is accepted");
            let Ok(turn) = turn else {
                return;
            };
            let mut completed = turn.completed();
            let first_poll = poll_once(completed.as_mut());
            assert!(
                first_poll.is_pending(),
                "a new turn after an inline-history resume must wait for its own terminal, got {first_poll:?}"
            );
            assert!(
                lock(&session.inner.state).turns.len() <= 1,
                "finished history turns must hold no live route; routes: {}",
                lock(&session.inner.state).turns.len()
            );

            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "turn/completed",
                    "params": {
                        "sessionId": "session-1",
                        "viewCursor": "cursor-2",
                        "sourceRange": {
                            "stream": {"kind": "run", "id": "turn-new"},
                            "first": {"id": "event-1", "sequence": 1},
                            "last": {"id": "event-1", "sequence": 1}
                        },
                        "turnId": "turn-new",
                        "terminal": "completed",
                        "reason": null,
                        "durationMs": 5,
                        "timeToFirstTokenMs": 1,
                        "usage": null
                    }
                })
            ));
            assert!(queued.is_ok(), "turn/completed queued");
            let outcome = completed.await;
            assert!(
                matches!(outcome, Ok(TurnOutcome::Completed { .. })),
                "the new turn settles on its own terminal, got {outcome:?}"
            );
            client.close().await;
        });
    }

    #[test]
    fn inline_history_resume_routes_the_running_turn_with_no_held_items() {
        // Resume opens the running turn's route even when the history
        // holds none of its items, and that turn's own terminal retires it.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "session": {
                            "sessionId": "session-1",
                            "path": "/tmp/session.jsonl",
                            "status": "running",
                            "activeTurnId": "turn-live",
                            "createdAt": "2026-09-29T00:00:00Z",
                            "updatedAt": "2026-09-29T00:00:00Z",
                            "workspaceRoot": null,
                            "providerId": null,
                            "modelId": null,
                            "turnCount": 2,
                            "forkedFrom": null
                        },
                        "viewCursor": "cursor-1",
                        "history": {
                            "mode": "inline",
                            "items": [
                                {
                                    "itemId": "item-old",
                                    "kind": "agentMessage",
                                    "turnId": "turn-old",
                                    "revision": 1,
                                    "status": "completed",
                                    "text": "earlier reply"
                                }
                            ],
                            "snapshot": null
                        },
                        "pendingRequests": []
                    }
                })
            ));
            assert!(queued.is_ok(), "resume response queued");
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            let session = client
                .resume_session(ResumeSessionOptions {
                    session_id: "session-1".to_owned(),
                    ..ResumeSessionOptions::default()
                })
                .await;
            assert!(session.is_ok(), "session resumes");
            let Ok(session) = session else {
                return;
            };
            {
                let state = lock(&session.inner.state);
                let routed: Vec<&str> = state.turns.keys().map(String::as_str).collect();
                assert_eq!(routed, ["turn-live"], "resume routes only the running turn");
            }

            session.inner.apply(Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: "turn/completed".to_owned(),
                params: serde_json::json!({
                    "sessionId": "session-1",
                    "viewCursor": "cursor-2",
                    "sourceRange": {
                        "stream": {"kind": "run", "id": "turn-live"},
                        "first": {"id": "event-1", "sequence": 1},
                        "last": {"id": "event-1", "sequence": 1}
                    },
                    "turnId": "turn-live",
                    "terminal": "completed",
                    "reason": null,
                    "durationMs": 5,
                    "timeToFirstTokenMs": 1,
                    "usage": null
                })
                .as_object()
                .cloned(),
                emitted_at_ms: None,
            });
            assert!(
                lock(&session.inner.state).turns.is_empty(),
                "the running turn's terminal retires its route"
            );
            client.close().await;
        });
    }

    /// Where a resume serves its history: inline in `history.items`, or in a
    /// snapshot's `state.items` (`snapshot` mode, or `anchoredSnapshot` with
    /// its anchor).
    #[derive(Clone, Copy)]
    enum HistoryForm {
        Inline,
        Snapshot,
        AnchoredSnapshot,
    }

    fn served_history(form: HistoryForm, items: serde_json::Value) -> serde_json::Value {
        match form {
            HistoryForm::Inline => {
                serde_json::json!({"mode": "inline", "items": items, "snapshot": null})
            }
            HistoryForm::Snapshot | HistoryForm::AnchoredSnapshot => serde_json::json!({
                "mode": match form {
                    HistoryForm::AnchoredSnapshot => "anchoredSnapshot",
                    _ => "snapshot",
                },
                "items": null,
                "snapshot": {
                    "schemaVersion": 1,
                    "viewCursor": "cursor-1",
                    "anchor": match form {
                        HistoryForm::AnchoredSnapshot => serde_json::json!({
                            "boundaryCursor": "cursor-0",
                            "summarizedThrough": "anchor-0"
                        }),
                        _ => serde_json::Value::Null,
                    },
                    "state": {
                        "items": items,
                        "activeTurn": null,
                        "queuedTurns": [],
                        "pendingApprovals": [],
                        "pendingUserInputs": [],
                        "approvalMode": {"mode": "promptUnmatched", "source": "replay", "lastCommandId": null},
                        "effectiveModel": null,
                        "goal": null,
                        "todoList": null,
                        "branch": null,
                        "tokenUsage": {"promptTokens": 0, "outputTokens": 0, "totalTokens": 0},
                        "turnCount": 1
                    }
                }
            }),
        }
    }

    #[test]
    fn inline_history_resume_keeps_the_running_turn_routed_and_settles_it() {
        resume_keeps_the_running_turn_routed_and_settles_it(HistoryForm::Inline);
    }

    #[test]
    fn snapshot_history_resume_keeps_the_running_turn_routed_and_settles_it() {
        resume_keeps_the_running_turn_routed_and_settles_it(HistoryForm::Snapshot);
    }

    #[test]
    fn anchored_snapshot_history_resume_keeps_the_running_turn_routed_and_settles_it() {
        resume_keeps_the_running_turn_routed_and_settles_it(HistoryForm::AnchoredSnapshot);
    }

    fn resume_keeps_the_running_turn_routed_and_settles_it(form: HistoryForm) {
        // Resume must open the route for the turn the host still runs,
        // so its held items replay once, its live deltas still route, and its
        // own terminal settles it.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "session": {
                            "sessionId": "session-1",
                            "path": "/tmp/session.jsonl",
                            "status": "running",
                            "activeTurnId": "turn-live",
                            "createdAt": "2026-09-29T00:00:00Z",
                            "updatedAt": "2026-09-29T00:00:00Z",
                            "workspaceRoot": null,
                            "providerId": null,
                            "modelId": null,
                            "turnCount": 2,
                            "forkedFrom": null
                        },
                        "viewCursor": "cursor-1",
                        "history": served_history(form, serde_json::json!([
                                {
                                    "itemId": "item-old",
                                    "kind": "agentMessage",
                                    "turnId": "turn-old",
                                    "revision": 1,
                                    "status": "completed",
                                    "text": "finished reply"
                                },
                                {
                                    "itemId": "item-live",
                                    "kind": "agentMessage",
                                    "turnId": "turn-live",
                                    "revision": 1,
                                    "status": "inProgress",
                                    "text": "partial reply"
                                }
                            ])),
                        "pendingRequests": []
                    }
                })
            ));
            assert!(queued.is_ok(), "resume response queued");
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            let session = client
                .resume_session(ResumeSessionOptions {
                    session_id: "session-1".to_owned(),
                    ..ResumeSessionOptions::default()
                })
                .await;
            assert!(session.is_ok(), "session resumes");
            let Ok(session) = session else {
                return;
            };
            {
                let state = lock(&session.inner.state);
                let mut routed: Vec<&String> = state.turns.keys().collect();
                routed.sort();
                assert_eq!(
                    routed,
                    vec!["turn-live"],
                    "only the running turn holds a route after resume"
                );
            }

            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "result": {
                        "commandId": "command-1",
                        "status": "accepted",
                        "turnId": "turn-live",
                        "startedNewTurn": false,
                        "disposition": "steered"
                    }
                })
            ));
            assert!(queued.is_ok(), "turn/start response queued");
            let turn = session.send_user_turn(SendUserTurnOptions::default()).await;
            assert!(turn.is_ok(), "steered turn/start is accepted");
            let Ok(turn) = turn else {
                return;
            };
            let mut items = turn.items();
            let mut deltas = turn.deltas();
            let held = poll_once(std::pin::pin!(items.recv()));
            assert!(
                matches!(&held, Poll::Ready(Ok(Some(item))) if item.item_id == "item-live"),
                "the running turn's held item replays first, got {held:?}"
            );

            let queued = inbound.send(format!(
                "{}\n{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "item/delta",
                    "params": {
                        "sessionId": "session-1",
                        "viewCursor": "cursor-2",
                        "itemId": "item-live",
                        "field": "text",
                        "delta": " continued"
                    }
                }),
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "method": "turn/completed",
                    "params": {
                        "sessionId": "session-1",
                        "viewCursor": "cursor-3",
                        "sourceRange": {
                            "stream": {"kind": "run", "id": "turn-live"},
                            "first": {"id": "event-1", "sequence": 1},
                            "last": {"id": "event-1", "sequence": 1}
                        },
                        "turnId": "turn-live",
                        "terminal": "completed",
                        "reason": null,
                        "durationMs": 5,
                        "timeToFirstTokenMs": 1,
                        "usage": null
                    }
                })
            ));
            assert!(queued.is_ok(), "item/delta and turn/completed queued");
            let delta = deltas.recv().await;
            assert!(
                matches!(&delta, Ok(Some(delta)) if delta.item_id == "item-live"),
                "a live delta for the replayed history item still routes, got {delta:?}"
            );
            let outcome = turn.completed().await;
            assert!(
                matches!(outcome, Ok(TurnOutcome::Completed { .. })),
                "the running turn settles on its own terminal, got {outcome:?}"
            );
            // open_route ran at resume (opening the route) and again at the
            // steered claim and the terminal (reusing it); the held item still
            // replays only once.
            let end = items.recv().await;
            assert!(
                matches!(end, Ok(None)),
                "the held item replays once, got {end:?}"
            );
            client.close().await;
        });
    }

    #[test]
    fn inline_history_resume_replays_history_when_a_claim_opens_the_turn_first() {
        // When a claim, not a live event, first opens a finished
        // history turn's route, the claimed Turn replays that turn's history
        // once and in history order.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "session": {
                            "sessionId": "session-1",
                            "path": "/tmp/session.jsonl",
                            "status": "idle",
                            "activeTurnId": null,
                            "createdAt": "2026-09-29T00:00:00Z",
                            "updatedAt": "2026-09-29T00:00:00Z",
                            "workspaceRoot": null,
                            "providerId": null,
                            "modelId": null,
                            "turnCount": 1,
                            "forkedFrom": null
                        },
                        "viewCursor": "cursor-1",
                        "history": {
                            "mode": "inline",
                            "items": [
                                {
                                    "itemId": "item-first",
                                    "kind": "userMessage",
                                    "turnId": "turn-killed",
                                    "commandId": "command-1",
                                    "revision": 1,
                                    "status": "completed",
                                    "text": "retry me"
                                },
                                {
                                    "itemId": "item-second",
                                    "kind": "agentMessage",
                                    "turnId": "turn-killed",
                                    "revision": 1,
                                    "status": "completed",
                                    "text": "partial reply"
                                }
                            ],
                            "snapshot": null
                        },
                        "pendingRequests": []
                    }
                })
            ));
            assert!(queued.is_ok(), "resume response queued");
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            let session = client
                .resume_session(ResumeSessionOptions {
                    session_id: "session-1".to_owned(),
                    ..ResumeSessionOptions::default()
                })
                .await;
            assert!(session.is_ok(), "session resumes");
            let Ok(session) = session else {
                return;
            };
            assert!(
                lock(&session.inner.state).turns.is_empty(),
                "resume opens no route for the finished turn"
            );

            // Only the retry answer is queued, so the claim opens the route
            // before any live event for the turn can.
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "result": {
                        "commandId": "command-1",
                        "status": "accepted",
                        "turnId": "turn-killed",
                        "startedNewTurn": true,
                        "disposition": "started"
                    }
                })
            ));
            assert!(queued.is_ok(), "retry answer queued");
            let turn = session.send_user_turn(SendUserTurnOptions::default()).await;
            assert!(turn.is_ok(), "same-command retry is accepted");
            let Ok(turn) = turn else {
                return;
            };
            let mut items = turn.items();
            // The claim opened the route, so the history is there before any
            // live event names the turn.
            let first = poll_once(std::pin::pin!(items.recv()));
            assert!(
                matches!(first, Poll::Ready(Ok(Some(_)))),
                "the claim replays the turn's history at once, got {first:?}"
            );
            let mut replayed = Vec::new();
            if let Poll::Ready(Ok(Some(item))) = first {
                replayed.push(item.item_id);
            }

            // Applied directly, so the terminal settles before `completed()` is
            // awaited. The settle retires the turn under the lock that wakes the
            // waiter, so the waiter never sees it unretired.
            session.inner.apply(Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: "turn/completed".to_owned(),
                params: serde_json::json!({
                    "sessionId": "session-1",
                    "viewCursor": "cursor-2",
                    "sourceRange": {
                        "stream": {"kind": "session", "id": "session-1"},
                        "first": {"id": "event-1", "sequence": 1},
                        "last": {"id": "event-1", "sequence": 1}
                    },
                    "turnId": "turn-killed",
                    "terminal": "cancelled",
                    "reason": "resume_reconcile:orphaned_by_process_loss"
                })
                .as_object()
                .cloned(),
                emitted_at_ms: None,
            });
            let outcome = turn.completed().await;
            assert!(
                matches!(outcome, Ok(TurnOutcome::Completed { .. })),
                "the claimed turn settles on its terminal, got {outcome:?}"
            );
            assert!(
                lock(&session.inner.state).item_turns.is_empty(),
                "the retired turn drops its replayed items' delta routes"
            );
            loop {
                match items.recv().await {
                    Ok(Some(item)) => replayed.push(item.item_id),
                    end => {
                        assert!(matches!(end, Ok(None)), "item stream failed: {end:?}");
                        break;
                    }
                }
            }
            assert_eq!(
                replayed,
                ["item-first", "item-second"],
                "the claimed turn replays its history once, in history order"
            );
            client.close().await;
        });
    }

    #[test]
    fn inline_history_resume_replays_a_reconciled_turn_into_its_same_command_retry() {
        resume_replays_a_reconciled_turn_into_its_same_command_retry(HistoryForm::Inline);
    }

    #[test]
    fn snapshot_history_resume_replays_a_reconciled_turn_into_its_same_command_retry() {
        resume_replays_a_reconciled_turn_into_its_same_command_retry(HistoryForm::Snapshot);
    }

    #[test]
    fn a_newer_snapshot_schema_version_replays_no_turn_history() {
        // A snapshot newer than the fold this SDK understands, here in a shape
        // the current types cannot decode, still resumes: it is dropped before
        // decoding, so none of its items are indexed and no route opens at
        // resume.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let mut history = served_history(
                HistoryForm::Snapshot,
                serde_json::json!([{
                    "itemId": "item-live",
                    "kind": "agentMessage",
                    "turnId": "turn-live",
                    "revision": 1,
                    "status": "inProgress",
                    "text": "partial reply"
                }]),
            );
            history["snapshot"]["schemaVersion"] = serde_json::json!(2);
            history["snapshot"]["state"] = serde_json::json!({"entries": []});
            let (inbound, reads) = mpsc::unbounded_channel();
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "session": {
                            "sessionId": "session-1",
                            "path": "/tmp/session.jsonl",
                            "status": "running",
                            "activeTurnId": "turn-live",
                            "createdAt": "2026-09-29T00:00:00Z",
                            "updatedAt": "2026-09-29T00:00:00Z",
                            "workspaceRoot": null,
                            "providerId": null,
                            "modelId": null,
                            "turnCount": 1,
                            "forkedFrom": null
                        },
                        "viewCursor": "cursor-1",
                        "history": history,
                        "pendingRequests": []
                    }
                })
            ));
            assert!(queued.is_ok(), "resume response queued");
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            let session = client
                .resume_session(ResumeSessionOptions {
                    session_id: "session-1".to_owned(),
                    ..ResumeSessionOptions::default()
                })
                .await;
            assert!(session.is_ok(), "session resumes");
            let Ok(session) = session else {
                return;
            };
            {
                let state = lock(&session.inner.state);
                assert!(
                    state.history_turn_items.is_empty(),
                    "a newer snapshot indexes no turn items"
                );
                assert!(
                    state.turns.is_empty(),
                    "a newer snapshot opens no route at resume"
                );
            }
            assert!(
                matches!(&session.inner.opening, SessionOpening::Resume(_)),
                "a resume opens with its resume result"
            );
            let SessionOpening::Resume(result) = &session.inner.opening else {
                return;
            };
            assert!(
                result.history.snapshot.is_none(),
                "the opening carries no snapshot the SDK cannot read"
            );
            assert_eq!(result.history.mode, crate::msp::HistoryMode::Snapshot);
            assert_eq!(
                session.dropped_snapshot_schema_version(),
                Some(2),
                "the session names the snapshot version it dropped"
            );
            client.close().await;
        });
    }

    #[test]
    fn anchored_snapshot_history_resume_replays_a_reconciled_turn_into_its_same_command_retry() {
        resume_replays_a_reconciled_turn_into_its_same_command_retry(HistoryForm::AnchoredSnapshot);
    }

    fn resume_replays_a_reconciled_turn_into_its_same_command_retry(form: HistoryForm) {
        // After a transport kill the host resumes with no active turn,
        // keeps the killed turn's userMessage in history, reconciles that turn
        // with a live terminal, and answers the same-command retry with the same
        // turn. The retried Turn must replay its history item, and resume must
        // still open no route for the finished turn.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "session": {
                            "sessionId": "session-1",
                            "path": "/tmp/session.jsonl",
                            "status": "idle",
                            "activeTurnId": null,
                            "createdAt": "2026-09-29T00:00:00Z",
                            "updatedAt": "2026-09-29T00:00:00Z",
                            "workspaceRoot": null,
                            "providerId": null,
                            "modelId": null,
                            "turnCount": 1,
                            "forkedFrom": null
                        },
                        "viewCursor": "cursor-1",
                        "history": served_history(form, serde_json::json!([
                                {
                                    "itemId": "item-killed",
                                    "kind": "userMessage",
                                    "turnId": "turn-killed",
                                    "commandId": "command-1",
                                    "revision": 1,
                                    "status": "completed",
                                    "text": "retry me"
                                }
                            ])),
                        "lastTurn": {
                            "turnId": "turn-killed",
                            "terminal": "cancelled",
                            "reason": "resume_reconcile:orphaned_by_process_loss"
                        },
                        "pendingRequests": []
                    }
                })
            ));
            assert!(queued.is_ok(), "resume response queued");
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            let session = client
                .resume_session(ResumeSessionOptions {
                    session_id: "session-1".to_owned(),
                    ..ResumeSessionOptions::default()
                })
                .await;
            assert!(session.is_ok(), "session resumes");
            let Ok(session) = session else {
                return;
            };
            assert!(
                lock(&session.inner.state).turns.is_empty(),
                "resume opens no route for the finished turn"
            );

            // As on the real host, the reconciliation terminal arrives before the
            // retry answer: it opens the finished turn's route, replays its
            // history, settles and retires it into a held settled turn.
            session.inner.apply(Notification {
                jsonrpc: crate::msp::JsonRpcVersion::V2,
                method: "turn/completed".to_owned(),
                params: serde_json::json!({
                    "sessionId": "session-1",
                    "viewCursor": "cursor-2",
                    "sourceRange": {
                        "stream": {"kind": "session", "id": "session-1"},
                        "first": {"id": "event-1", "sequence": 1},
                        "last": {"id": "event-1", "sequence": 1}
                    },
                    "turnId": "turn-killed",
                    "terminal": "cancelled",
                    "reason": "resume_reconcile:orphaned_by_process_loss"
                })
                .as_object()
                .cloned(),
                emitted_at_ms: None,
            });
            {
                let state = lock(&session.inner.state);
                assert!(
                    state.settled_turns.contains_key("turn-killed"),
                    "the reconciled turn is held as a settled turn for its retry"
                );
                assert!(
                    !state.history_turn_items.contains_key("turn-killed"),
                    "opening the route takes the turn's history entry"
                );
                assert!(
                    state.item_turns.is_empty(),
                    "the retired turn drops its replayed items' delta routes"
                );
            }

            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "result": {
                        "commandId": "command-1",
                        "status": "accepted",
                        "turnId": "turn-killed",
                        "startedNewTurn": true,
                        "disposition": "started"
                    }
                })
            ));
            assert!(queued.is_ok(), "retry answer queued");
            let turn = session.send_user_turn(SendUserTurnOptions::default()).await;
            assert!(turn.is_ok(), "same-command retry is accepted");
            let Ok(turn) = turn else {
                return;
            };
            let outcome = turn.completed().await;
            assert!(
                matches!(outcome, Ok(TurnOutcome::Completed { .. })),
                "the retried turn settles on the reconciliation terminal, got {outcome:?}"
            );
            let mut items = turn.items();
            let replayed = items.recv().await;
            assert!(
                matches!(&replayed, Ok(Some(item)) if item.item_id == "item-killed"),
                "the retried turn replays its history userMessage, got {replayed:?}"
            );
            let end = items.recv().await;
            assert!(
                matches!(end, Ok(None)),
                "the history item replays once, got {end:?}"
            );
            client.close().await;
        });
    }

    #[test]
    fn a_same_command_retry_of_a_turn_that_ended_before_the_resume_settles() {
        // The turn's terminal went out before the resume, so the resume
        // restates it as `lastTurn` and no live terminal follows. A
        // same-command retry gets the original ack; its Turn must still settle
        // rather than wait until close.
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build();
        assert!(runtime.is_ok(), "caller runtime builds");
        let Ok(runtime) = runtime else {
            return;
        };
        runtime.block_on(async {
            let (inbound, reads) = mpsc::unbounded_channel();
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "result": {
                        "session": {
                            "sessionId": "session-1",
                            "path": "/tmp/session.jsonl",
                            "status": "idle",
                            "activeTurnId": null,
                            "createdAt": "2026-09-29T00:00:00Z",
                            "updatedAt": "2026-09-29T00:00:00Z",
                            "workspaceRoot": null,
                            "providerId": null,
                            "modelId": null,
                            "turnCount": 1,
                            "forkedFrom": null
                        },
                        "viewCursor": "cursor-1",
                        "history": served_history(HistoryForm::Inline, serde_json::json!([
                                {
                                    "itemId": "item-done",
                                    "kind": "userMessage",
                                    "turnId": "turn-done",
                                    "commandId": "command-1",
                                    "revision": 1,
                                    "status": "completed",
                                    "text": "retry me"
                                }
                            ])),
                        "lastTurn": {"turnId": "turn-done", "terminal": "completed"},
                        "pendingRequests": []
                    }
                })
            ));
            assert!(queued.is_ok(), "resume response queued");
            let client = MuseClient::with_command_id_minter(
                ChannelTransport { inbound: reads },
                SessionDurability::Durable,
                || "command-1".to_owned(),
            );
            let session = client
                .resume_session(ResumeSessionOptions {
                    session_id: "session-1".to_owned(),
                    ..ResumeSessionOptions::default()
                })
                .await;
            assert!(session.is_ok(), "session resumes");
            let Ok(session) = session else {
                return;
            };
            let queued = inbound.send(format!(
                "{}\n",
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 2,
                    "result": {
                        "commandId": "command-1",
                        "status": "accepted",
                        "turnId": "turn-done",
                        "startedNewTurn": true,
                        "disposition": "started"
                    }
                })
            ));
            assert!(queued.is_ok(), "retry answer queued");
            let turn = session.send_user_turn(SendUserTurnOptions::default()).await;
            assert!(turn.is_ok(), "same-command retry is accepted");
            let Ok(turn) = turn else {
                return;
            };
            let completion = turn.completed();
            // antipattern-ok(timeout-wrapper): failure-only cap; success ends when the retried turn settles
            let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), completion).await;
            assert!(
                matches!(
                    &outcome,
                    Ok(Ok(TurnOutcome::Ended(last_turn)))
                        if last_turn.turn_id == "turn-done"
                            && last_turn.terminal == crate::msp::TurnTerminal::Completed
                ),
                "a retry of a turn that ended before the resume must settle Ended from its \
                 lastTurn, not wait for close, got {outcome:?}"
            );
            assert!(
                session.pending().is_empty(),
                "a retry settled from lastTurn leaves pending()"
            );
            client.close().await;
        });
    }
}
