// The approvals a session is deciding, and the queue of those waiting for the
// worker: one entry per approval, so an approval retired or a stage superseded
// before the worker takes it holds no place a live one needs.
use std::collections::{HashMap, VecDeque};

use crate::approval::ApprovalRouter;
use crate::msp::ApprovalRequestParams;

#[derive(Default)]
pub(super) struct PendingApprovals {
    tracked: HashMap<String, TrackedApproval>,
    // Exactly the tracked approvals holding a `queued` stage, oldest first,
    // so it never outgrows `tracked`, which the pending cap bounds.
    queue: VecDeque<String>,
}

/// The current request of a pending approval and the highest stage
/// (`currentRequirementId.sourceIndex`) already queued for it: routing only
/// moves forward, so while it is pending each stage is decided at most once.
pub(super) struct TrackedApproval {
    pub(super) request: ApprovalRequestParams,
    // Raised only by `PendingApprovals::route_stage`, which queues that stage
    // in the same call.
    routed_stage: usize,
    // The highest stage this session has sent `approval/decide` for.
    pub(super) answered: Option<usize>,
    // While it waits for the worker: the stage it waits with.
    queued: Option<QueuedStage>,
}

// The request and router a stage was queued with: what the worker routes.
struct QueuedStage {
    request: ApprovalRequestParams,
    router: ApprovalRouter,
}

impl TrackedApproval {
    pub(super) fn routed_stage(&self) -> usize {
        self.routed_stage
    }
}

impl PendingApprovals {
    pub(super) fn len(&self) -> usize {
        self.tracked.len()
    }

    pub(super) fn get(&self, approval_id: &str) -> Option<&TrackedApproval> {
        self.tracked.get(approval_id)
    }

    pub(super) fn get_mut(&mut self, approval_id: &str) -> Option<&mut TrackedApproval> {
        self.tracked.get_mut(approval_id)
    }

    /// Records `request` as its approval's newest routed stage, tracking a
    /// new approval, and queues it with `router` in the same call: no caller
    /// can record a stage without queueing it, so a fault that retires the
    /// approval always finds that stage to answer. An
    /// approval waits once however many stages arrive before the worker
    /// takes it, so the queue never outgrows the pending cap.
    pub(super) fn route_stage(&mut self, request: ApprovalRequestParams, router: ApprovalRouter) {
        let stage = request.current_requirement_id.source_index;
        let tracked = self
            .tracked
            .entry(request.approval_id.clone())
            .or_insert_with(|| TrackedApproval {
                request: request.clone(),
                routed_stage: stage,
                answered: None,
                queued: None,
            });
        tracked.request = request.clone();
        tracked.routed_stage = stage;
        // A newer stage replaces one still waiting and goes to the back of
        // the queue, behind approvals queued before it.
        let approval_id = request.approval_id.clone();
        if tracked
            .queued
            .replace(QueuedStage { request, router })
            .is_some()
        {
            self.queue.retain(|queued| *queued != approval_id);
        }
        self.queue.push_back(approval_id);
    }

    /// Stops tracking an approval and takes it out of the queue, returning
    /// the stage it left waiting: a fault that retires it still owes that
    /// stage its settled-turn answer.
    pub(super) fn remove(
        &mut self,
        approval_id: &str,
    ) -> Option<(TrackedApproval, Option<ApprovalRequestParams>)> {
        let mut tracked = self.tracked.remove(approval_id)?;
        let queued = tracked.queued.take().map(|queued| queued.request);
        if queued.is_some() {
            self.queue.retain(|queued| queued != approval_id);
        }
        Some((tracked, queued))
    }

    pub(super) fn clear(&mut self) {
        self.tracked.clear();
        self.queue.clear();
    }

    /// The oldest waiting approval's queued stage and its router.
    pub(super) fn take_queued(&mut self) -> Option<(ApprovalRequestParams, ApprovalRouter)> {
        let approval_id = self.queue.pop_front()?;
        let queued = self.tracked.get_mut(&approval_id)?.queued.take()?;
        Some((queued.request, queued.router))
    }
}

#[cfg(test)]
mod tests {
    use super::{ApprovalRequestParams, ApprovalRouter, PendingApprovals, TrackedApproval};

    fn request(approval_id: &str, stage: usize) -> Result<ApprovalRequestParams, String> {
        serde_json::from_value(serde_json::json!({
            "sessionId": "session-1",
            "approvalId": approval_id,
            "turnId": "turn-1",
            "taskId": "task-1",
            "itemId": "item-1",
            "toolCallId": "call-1",
            "toolName": "shell",
            "rawArgs": "{}",
            "viewCursor": "cursor-1",
            "sourceRange": {
                "stream": {"kind": "run", "id": "turn-1"},
                "first": {"id": "event-1", "sequence": 1},
                "last": {"id": "event-1", "sequence": 1}
            },
            "subject": {"kind": "shell", "command": "pwd"},
            "currentRequirementId": {"approvalId": approval_id, "sourceIndex": stage},
            "availableChoices": [],
            "protectedWrite": false,
            "judgeEscalated": false
        }))
        .map_err(|error| error.to_string())
    }

    // Each tracked approval waits once, with the newest stage recorded and
    // queued for it in one call, and leaves the queue when it stops being
    // tracked, handing back the stage it left waiting.
    #[test]
    fn the_queue_holds_each_tracked_approval_once() -> Result<(), String> {
        let mut pending = PendingApprovals::default();
        pending.route_stage(request("approval-1", 0)?, ApprovalRouter::new());
        pending.route_stage(request("approval-2", 0)?, ApprovalRouter::new());
        // A later stage replaces approval-1's entry and goes behind
        // approval-2; the worker routes the stage as queued, whatever the
        // tracked request became since.
        pending.route_stage(request("approval-1", 1)?, ApprovalRouter::new());
        assert_eq!(
            pending.get("approval-1").map(TrackedApproval::routed_stage),
            Some(1)
        );
        if let Some(tracked) = pending.get_mut("approval-1") {
            tracked.request = request("approval-1", 2)?;
        }
        assert_eq!(pending.queue.len(), 2);
        let taken: Vec<(String, usize)> = std::iter::from_fn(|| pending.take_queued())
            .map(|(request, _)| {
                (
                    request.approval_id,
                    request.current_requirement_id.source_index,
                )
            })
            .collect();
        assert_eq!(
            taken,
            [("approval-2".to_owned(), 0), ("approval-1".to_owned(), 1)]
        );

        // A retired approval leaves its place and hands back its waiting
        // stage; one taken but still tracked can wait again.
        pending.route_stage(request("approval-2", 1)?, ApprovalRouter::new());
        let left = pending.remove("approval-2").and_then(|(_, queued)| queued);
        assert_eq!(
            left.map(|request| request.current_requirement_id.source_index),
            Some(1)
        );
        assert!(pending.queue.is_empty());
        assert!(pending.take_queued().is_none());
        pending.route_stage(request("approval-1", 2)?, ApprovalRouter::new());
        assert_eq!(pending.queue.len(), 1);
        pending.clear();
        assert!(pending.queue.is_empty());
        assert_eq!(pending.len(), 0);
        Ok(())
    }
}
