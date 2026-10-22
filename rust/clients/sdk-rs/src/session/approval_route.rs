use std::collections::HashSet;
use std::future::Future;
use std::sync::{Arc, Mutex, Weak};

use tokio::sync::mpsc;

use super::SessionInner;
use super::state::detach_client;
use crate::approval::{ApprovalDecisionInput, ApprovalRouter};
use crate::client::{FacadeError, lock};
use crate::errors::{ErrorCode, ProtocolError};
use crate::msp::{
    ApprovalDecideParams, ApprovalDecideResult, ApprovalDecision, ApprovalRequestParams,
    ApprovalUpdatedParams,
};

mod pending;
mod retired;
mod worker;
use pending::{PendingApprovals, TrackedApproval};
use retired::{Owed, RetiredApprovals};
use worker::route_requests;

const MAX_PENDING_APPROVAL_REQUESTS: usize = 32;
// Bounds the memory of approvals already settled here, so a late repeat of a
// recent one routes nothing unless its own fault, or its settled turn with no
// reject to send, left that stage unanswered and routing has not moved past it.
const MAX_RETIRED_APPROVALS: usize = 256;
const STAGE_RESOLVED_CHANGE: &str = "stageResolved";
const ALREADY_TERMINAL_CHANGE: &str = "alreadyTerminal";

pub(super) struct ApprovalRoute {
    router: Mutex<ApprovalRouter>,
    handoff: Mutex<Option<HandoffRouting>>,
    contexts: Mutex<PendingApprovals>,
    retired: Mutex<RetiredApprovals>,
    // Wakes the worker for a queued approval or an owed answer; it holds at
    // most one wake, and the worker takes everything waiting before it sleeps.
    wake: mpsc::Sender<()>,
    worker: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl Owed {
    fn from_tracked(tracked: TrackedApproval) -> Self {
        Self::new(
            tracked.routed_stage(),
            tracked.answered,
            tracked.request.turn_id,
        )
    }
}

// What routing a request or stage update did: queued a stage for the worker,
// refused a new approval at the pending cap, or nothing more to do.
enum Routed {
    Queued {
        approval_id: String,
        turn_id: String,
    },
    CapRefused {
        approval_id: String,
        turn_id: String,
        stage: usize,
    },
    Done,
}

// Approvals pending at resume keep the router installed at handoff, however
// late their payload arrives; a settled turn still wins.
struct HandoffRouting {
    router: ApprovalRouter,
    approval_ids: HashSet<String>,
}

impl ApprovalRoute {
    pub(super) fn new() -> (Self, mpsc::Receiver<()>) {
        let (wake, woken) = mpsc::channel(1);
        (
            Self {
                router: Mutex::new(ApprovalRouter::new()),
                handoff: Mutex::new(None),
                contexts: Mutex::new(PendingApprovals::default()),
                retired: Mutex::new(RetiredApprovals::default()),
                wake,
                worker: Mutex::new(None),
            },
            woken,
        )
    }

    pub(super) fn spawn(
        &self,
        runtime: &tokio::runtime::Handle,
        session: Weak<SessionInner>,
        woken: mpsc::Receiver<()>,
    ) {
        *lock(&self.worker) = Some(runtime.spawn(route_requests(session, woken)));
    }

    pub(super) fn abort(&self) {
        lock(&self.contexts).clear();
        if let Some(worker) = lock(&self.worker).as_ref() {
            // Can run on the worker (its handler opened a newer session for its id): let it finish.
            abort_unless_current(worker);
        }
    }

    /// Takes the worker out of its slot, so no later abort can reach it, and
    /// aborts it unless it is the task closing the client.
    pub(super) fn detach(&self) -> Option<tokio::task::JoinHandle<()>> {
        lock(&self.contexts).clear();
        let worker = lock(&self.worker).take()?;
        if worker_is_current(&worker) {
            return None;
        }
        worker.abort();
        Some(worker)
    }

    /// Resolves once the worker has stopped and dropped its wake receiver.
    #[cfg(test)]
    pub(super) async fn worker_stopped(&self) {
        self.wake.closed().await;
    }

    pub(super) fn on_approval<Handler, HandlerFuture>(&self, handler: Handler)
    where
        Handler: Fn(ApprovalRequestParams) -> HandlerFuture + Send + Sync + 'static,
        HandlerFuture: Future<Output = ApprovalDecisionInput> + Send + 'static,
    {
        lock(&self.router).on_approval(handler);
    }

    pub(super) fn fix_handoff_routing(&self, approval_ids: impl IntoIterator<Item = String>) {
        let approval_ids: HashSet<String> = approval_ids.into_iter().collect();
        if approval_ids.is_empty() {
            return;
        }
        let router = lock(&self.router).clone();
        *lock(&self.handoff) = Some(HandoffRouting {
            router,
            approval_ids,
        });
    }

    pub(super) fn enqueue_requested(
        &self,
        session: &Arc<SessionInner>,
        request: ApprovalRequestParams,
    ) {
        match self.route_requested(request) {
            Routed::Queued {
                approval_id,
                turn_id,
            } => {
                self.wake_worker(session, &approval_id, &turn_id);
            }
            Routed::CapRefused {
                approval_id,
                turn_id,
                stage,
            } => {
                // Its other form must not reach a handler for a turn this fails.
                session.fail_named_turn(
                    Some(turn_id.clone()),
                    ProtocolError::new("too many pending approvals for this session", None),
                );
                self.retire_owing(&approval_id, &turn_id, stage);
            }
            Routed::Done => {}
        }
    }

    // Records and queues a stage in one `contexts` section, so a fault the
    // worker raises in between cannot find it recorded but not queued and
    // lose its owed answer.
    fn route_requested(&self, request: ApprovalRequestParams) -> Routed {
        let stage = request.current_requirement_id.source_index;
        let router = self.router_for(&request.approval_id);
        let mut contexts = lock(&self.contexts);
        // One approval arrives as the view notification, the server request,
        // and stage updates, in any order: route forward only, and not again
        // while it is among the recently retired, except a stage
        // its own fault, or its settled turn with no reject to send, left
        // unanswered.
        let owes = {
            let mut retired = lock(&self.retired);
            retired
                .contains(&request.approval_id)
                .then(|| retired.accept_owed(&request.approval_id, stage))
        };
        if let Some(owes) = owes {
            drop(contexts);
            if owes {
                self.enqueue_owed(request);
            }
            return Routed::Done;
        }
        let at_cap = contexts.len() >= MAX_PENDING_APPROVAL_REQUESTS;
        match contexts.get_mut(&request.approval_id) {
            Some(tracked) if stage <= tracked.routed_stage() => return Routed::Done,
            Some(_) => {}
            None if at_cap => {
                return Routed::CapRefused {
                    approval_id: request.approval_id,
                    turn_id: request.turn_id,
                    stage,
                };
            }
            None => {}
        }
        contexts.route_stage(request.clone(), router);
        Routed::Queued {
            approval_id: request.approval_id,
            turn_id: request.turn_id,
        }
    }

    pub(super) fn enqueue_updated(
        &self,
        session: &Arc<SessionInner>,
        update: ApprovalUpdatedParams,
    ) {
        if let Routed::Queued {
            approval_id,
            turn_id,
        } = self.route_updated(update)
        {
            self.wake_worker(session, &approval_id, &turn_id);
        }
    }

    // As `route_requested`: a stage update records and queues its stage in
    // one `contexts` section.
    fn route_updated(&self, update: ApprovalUpdatedParams) -> Routed {
        if update.change.kind == ALREADY_TERMINAL_CHANGE {
            self.retire(&update.approval_id);
            return Routed::Done;
        }
        let router = self.router_for(&update.approval_id);
        let mut contexts = lock(&self.contexts);
        let Some(tracked) = contexts.get_mut(&update.approval_id) else {
            // A stage update for an approval its own fault, or its settled
            // turn with no reject to send, retired owes the settled-turn
            // answer as a copy would.
            let owed = (update.change.kind == STAGE_RESOLVED_CHANGE)
                .then(|| lock(&self.retired).owed_request(&update))
                .flatten();
            drop(contexts);
            if let Some(request) = owed {
                self.enqueue_owed(request);
            }
            return Routed::Done;
        };
        // A late update for an earlier stage must not move the tracked
        // stage back, or the worker skips the stage already queued.
        if update.current_requirement_id.source_index < tracked.routed_stage() {
            return Routed::Done;
        }
        let request = &mut tracked.request;
        request.session_id = update.session_id;
        request.view_cursor = update.view_cursor;
        request.source_range = update.source_range;
        request.subject = update.subject;
        request.current_requirement_id = update.current_requirement_id;
        request.available_choices = update.available_choices;
        request.subagent_origin = update.subagent_origin;
        let stage = request.current_requirement_id.source_index;
        // A stage already routed from its server request is not re-queued.
        if update.change.kind != STAGE_RESOLVED_CHANGE || stage <= tracked.routed_stage() {
            return Routed::Done;
        }
        let request = tracked.request.clone();
        contexts.route_stage(request.clone(), router);
        Routed::Queued {
            approval_id: request.approval_id,
            turn_id: request.turn_id,
        }
    }

    // The id stays in the handoff set, which resume bounds: a re-issue after it
    // leaves the retired window still reaches the handoff router.
    // Answered or resolved by the host: it owes no settled-turn answer.
    pub(super) fn retire(&self, approval_id: &str) {
        // `retire_owing`'s lock order, so a fault cannot re-mark it owed.
        let mut contexts = lock(&self.contexts);
        let mut retired = lock(&self.retired);
        retired.insert(approval_id);
        retired.settle_owed(approval_id);
        contexts.remove(approval_id);
    }

    /// The turn of a tracked approval, which a broken frame naming no turn of
    /// its own fails before `retire_tracked`.
    pub(super) fn tracked_turn(&self, approval_id: &str) -> Option<String> {
        lock(&self.contexts)
            .get(approval_id)
            .map(|tracked| tracked.request.turn_id.clone())
    }

    /// Retires only a tracked approval: a broken frame that names no turn of
    /// its own must not block that approval's later payload.
    /// From the dispatcher, call `fail_named_turn` first.
    pub(super) fn retire_tracked(&self, approval_id: &str) {
        // Hold `contexts` while retiring, in `route_requested`'s lock order, so
        // no request sees the approval neither tracked nor retired.
        let mut contexts = lock(&self.contexts);
        if let Some((tracked, queued)) = contexts.remove(approval_id) {
            self.owe_tracked(&mut lock(&self.retired), approval_id, tracked, queued);
        }
    }

    /// Retires an approval whose own fault settles its named turn, or whose
    /// settled turn left it no reject to send: the first copy or stage update
    /// of a stage at or above its floor that it has not answered owes one
    /// settled-turn answer. An untracked one takes `stage` as
    /// its floor; one already retired another way keeps routing nothing.
    /// From the dispatcher, call `fail_named_turn` first.
    pub(super) fn retire_owing(&self, approval_id: &str, turn_id: &str, stage: usize) {
        let mut contexts = lock(&self.contexts);
        let mut retired = lock(&self.retired);
        match contexts.remove(approval_id) {
            Some((tracked, queued)) => self.owe_tracked(&mut retired, approval_id, tracked, queued),
            None if retired.contains(approval_id) => {}
            None => retired.insert_owed(approval_id, Owed::new(stage, None, turn_id.to_owned())),
        }
    }

    // A stage its fault leaves in the queue keeps the settled-turn answer it
    // owes, waiting outside the queue like any owed answer.
    fn owe_tracked(
        &self,
        retired: &mut RetiredApprovals,
        approval_id: &str,
        tracked: TrackedApproval,
        queued: Option<ApprovalRequestParams>,
    ) {
        retired.insert_owed(approval_id, Owed::from_tracked(tracked));
        if let Some(request) = queued {
            retired.hold(request);
            let _ = self.wake.try_send(());
        }
    }

    fn has_owed(&self, approval_id: &str) -> bool {
        lock(&self.retired).has_owed(approval_id)
    }

    fn owes(&self, request: &ApprovalRequestParams) -> bool {
        lock(&self.retired).owes(
            &request.approval_id,
            request.current_requirement_id.source_index,
        )
    }

    fn note_answered(&self, request: &ApprovalRequestParams) {
        let stage = request.current_requirement_id.source_index;
        let mut contexts = lock(&self.contexts);
        if let Some(tracked) = contexts.get_mut(&request.approval_id) {
            tracked.answered = Some(
                tracked
                    .answered
                    .map_or(stage, |answered| answered.max(stage)),
            );
            return;
        }
        // An owed entry, or one a fault retired on another thread since the
        // worker's last check, records the stage on its mark.
        lock(&self.retired).note_answered(&request.approval_id, stage);
    }

    fn is_current(&self, request: &ApprovalRequestParams) -> bool {
        lock(&self.contexts)
            .get(&request.approval_id)
            .is_some_and(|tracked| {
                tracked.request.current_requirement_id == request.current_requirement_id
            })
    }

    fn router_for(&self, approval_id: &str) -> ApprovalRouter {
        let handoff = lock(&self.handoff)
            .as_ref()
            .filter(|handoff| handoff.approval_ids.contains(approval_id))
            .map(|handoff| handoff.router.clone());
        handoff.unwrap_or_else(|| lock(&self.router).clone())
    }

    // A closed wake channel means the worker is gone: retire the approval and
    // fail only its turn.
    fn wake_worker(&self, session: &Arc<SessionInner>, approval_id: &str, turn_id: &str) {
        if let Err(mpsc::error::TrySendError::Closed(())) = self.wake.try_send(()) {
            self.retire(approval_id);
            session.fail_named_turn(
                Some(turn_id.to_owned()),
                ProtocolError::new("approval request router closed for this session", None),
            );
        }
    }

    // An owed answer waits on its approval's mark, never in the request queue;
    // the worker sends it before the next queued approval.
    fn enqueue_owed(&self, request: ApprovalRequestParams) {
        lock(&self.retired).hold(request);
        let _ = self.wake.try_send(());
    }

    // An owed answer goes first and has no router, so it can never reach a
    // handler.
    fn take_next(&self) -> Option<(ApprovalRequestParams, Option<ApprovalRouter>)> {
        if let Some(request) = lock(&self.retired).take_held() {
            return Some((request, None));
        }
        lock(&self.contexts)
            .take_queued()
            .map(|(request, router)| (request, Some(router)))
    }
}

impl Drop for ApprovalRoute {
    fn drop(&mut self) {
        if let Some(worker) = lock(&self.worker).take() {
            // Can run on the worker, when its handler drops the last handle mid-run: let it finish.
            abort_unless_current(&worker);
        }
    }
}

fn abort_unless_current(worker: &tokio::task::JoinHandle<()>) {
    if !worker_is_current(worker) {
        worker.abort();
    }
}

fn worker_is_current(worker: &tokio::task::JoinHandle<()>) -> bool {
    tokio::task::try_id().is_some_and(|current| current == worker.id())
}

#[cfg(test)]
mod tests;
