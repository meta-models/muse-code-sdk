// The approvals a session retired, and the settled-turn answer some of them
// still owe.
use std::collections::{HashMap, HashSet, VecDeque};

use super::MAX_RETIRED_APPROVALS;
use crate::msp::{ApprovalRequestParams, ApprovalUpdatedParams};

#[derive(Default)]
pub(super) struct RetiredApprovals {
    ids: HashSet<String>,
    order: VecDeque<String>,
    // Retired by their own fault, or by a settled turn with no reject to send:
    // while in this window, each owes a settled-turn answer for an unanswered
    // stage and no handler call.
    owed: HashMap<String, Owed>,
    // Approvals whose owed answer waits for the worker, oldest first.
    held: VecDeque<String>,
}

pub(super) struct Owed {
    // The highest stage routed: an earlier one is a late repeat.
    floor: usize,
    // The highest stage this session sent `approval/decide` for.
    answered: Option<usize>,
    // The tracked request's turn, else the one its faulted frame named: a
    // stage update is answered only while it stays recorded as settled.
    turn_id: String,
    // Its owed answer, waiting for the worker outside the request queue.
    held: Option<ApprovalRequestParams>,
}

impl Owed {
    // A new mark holds no answer yet: only `hold` adds one, and lists it.
    pub(super) fn new(floor: usize, answered: Option<usize>, turn_id: String) -> Self {
        Self {
            floor,
            answered,
            turn_id,
            held: None,
        }
    }
}

impl RetiredApprovals {
    pub(super) fn insert(&mut self, approval_id: &str) {
        if self.ids.insert(approval_id.to_owned()) {
            self.order.push_back(approval_id.to_owned());
            if self.order.len() > MAX_RETIRED_APPROVALS
                && let Some(oldest) = self.order.pop_front()
            {
                self.ids.remove(&oldest);
                self.forget_owed(&oldest);
            }
        }
    }

    pub(super) fn insert_owed(&mut self, approval_id: &str, owed: Owed) {
        self.insert(approval_id);
        self.owed.insert(approval_id.to_owned(), owed);
    }

    pub(super) fn contains(&self, approval_id: &str) -> bool {
        self.ids.contains(approval_id)
    }

    // Retired by its own fault, or by a settled turn, and not yet resolved by
    // the host: whatever stage it is at.
    pub(super) fn has_owed(&self, approval_id: &str) -> bool {
        self.owed.contains_key(approval_id)
    }

    pub(super) fn owes(&self, approval_id: &str, stage: usize) -> bool {
        self.owed.get(approval_id).is_some_and(|owed| {
            stage >= owed.floor && owed.answered.is_none_or(|answered| stage > answered)
        })
    }

    // An owed copy or stage update moves routing forward, as a tracked one
    // does, so an earlier stage still queued becomes a late repeat.
    pub(super) fn accept_owed(&mut self, approval_id: &str, stage: usize) -> bool {
        if !self.owes(approval_id, stage) {
            return false;
        }
        if let Some(owed) = self.owed.get_mut(approval_id) {
            owed.floor = stage;
        }
        true
    }

    // A sent decide answers its stage; the host's terminal reply or
    // `approval/resolved` then settles the mark.
    pub(super) fn note_answered(&mut self, approval_id: &str, stage: usize) {
        if let Some(owed) = self.owed.get_mut(approval_id) {
            owed.answered = Some(owed.answered.map_or(stage, |answered| answered.max(stage)));
        }
    }

    // Holds an owed answer for the worker; a newer stage replaces it.
    pub(super) fn hold(&mut self, request: ApprovalRequestParams) {
        if let Some(owed) = self.owed.get_mut(&request.approval_id) {
            let approval_id = request.approval_id.clone();
            if owed.held.replace(request).is_none() {
                self.held.push_back(approval_id);
            }
        }
    }

    // The oldest held answer: `held` lists exactly the marks holding one.
    pub(super) fn take_held(&mut self) -> Option<ApprovalRequestParams> {
        let approval_id = self.held.pop_front()?;
        self.owed.get_mut(&approval_id)?.held.take()
    }

    // Resolved by the host (its terminal reply, `approval/resolved` or -32051):
    // later copies owe nothing.
    pub(super) fn settle_owed(&mut self, approval_id: &str) {
        self.forget_owed(approval_id);
    }

    // A mark leaves with its held answer, so `held` never outgrows the window.
    fn forget_owed(&mut self, approval_id: &str) {
        if self
            .owed
            .remove(approval_id)
            .is_some_and(|owed| owed.held.is_some())
        {
            self.held.retain(|held| held != approval_id);
        }
    }

    // The request a stage update owes the settled-turn answer for. An owed
    // entry never reaches a handler, so the tool fields an update lacks stay
    // empty: the worker reads only the turn, the requirement and the offer.
    pub(super) fn owed_request(
        &mut self,
        update: &ApprovalUpdatedParams,
    ) -> Option<ApprovalRequestParams> {
        let stage = update.current_requirement_id.source_index;
        if !self.accept_owed(&update.approval_id, stage) {
            return None;
        }
        Some(ApprovalRequestParams {
            session_id: update.session_id.clone(),
            approval_id: update.approval_id.clone(),
            turn_id: self.owed.get(&update.approval_id)?.turn_id.clone(),
            task_id: String::new(),
            item_id: String::new(),
            tool_call_id: String::new(),
            tool_name: String::new(),
            raw_args: String::new(),
            view_cursor: update.view_cursor.clone(),
            source_range: update.source_range.clone(),
            subject: update.subject.clone(),
            current_requirement_id: update.current_requirement_id.clone(),
            available_choices: update.available_choices.clone(),
            protected_write: false,
            judge_escalated: false,
            subagent_origin: update.subagent_origin.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{ApprovalRequestParams, MAX_RETIRED_APPROVALS, Owed, RetiredApprovals};

    #[test]
    fn retired_approvals_keep_only_the_newest_ids() {
        let mut retired = RetiredApprovals::default();
        for index in 0..=MAX_RETIRED_APPROVALS {
            retired.insert(&format!("approval-{index}"));
        }
        retired.insert("approval-1");

        assert!(!retired.contains("approval-0"));
        assert!(retired.contains("approval-1"));
        assert!(retired.contains(&format!("approval-{MAX_RETIRED_APPROVALS}")));
        assert_eq!(retired.order.len(), MAX_RETIRED_APPROVALS);
        assert_eq!(retired.ids.len(), MAX_RETIRED_APPROVALS);
    }

    #[test]
    fn a_fault_retired_approval_owes_one_answer_for_an_unanswered_stage() {
        let mut retired = RetiredApprovals::default();
        let owed = |floor, answered| Owed {
            floor,
            answered,
            turn_id: "turn-1".to_owned(),
            held: None,
        };
        retired.insert_owed("never-answered", owed(0, None));
        assert!(retired.owes("never-answered", 0));
        retired.settle_owed("never-answered");
        assert!(!retired.owes("never-answered", 1));

        retired.insert_owed("stage-0-answered", owed(0, Some(0)));
        assert!(!retired.owes("stage-0-answered", 0));
        assert!(retired.owes("stage-0-answered", 1));

        // Routing had reached stage 2, so a stage-1 copy is a late repeat.
        retired.insert_owed("routed-to-stage-2", owed(2, None));
        assert!(!retired.owes("routed-to-stage-2", 1));
        assert!(retired.owes("routed-to-stage-2", 2));

        retired.insert_owed("decided-in-flight", owed(0, None));
        retired.note_answered("decided-in-flight", 0);
        assert!(!retired.owes("decided-in-flight", 0));
        assert!(retired.owes("decided-in-flight", 1));

        retired.insert("decided");
        assert!(!retired.owes("decided", 2));

        retired.insert_owed("evicted", owed(0, None));
        for index in 0..MAX_RETIRED_APPROVALS {
            retired.insert(&format!("approval-{index}"));
        }
        assert!(!retired.contains("evicted"));
        assert!(!retired.owed.contains_key("evicted"));
    }

    // A held answer goes out once, and leaves with its mark.
    #[test]
    fn held_answers_go_out_once_and_leave_with_their_mark() -> Result<(), String> {
        let request = |approval_id: &str| -> Result<ApprovalRequestParams, String> {
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
                "currentRequirementId": {"approvalId": approval_id, "sourceIndex": 0},
                "availableChoices": [],
                "protectedWrite": false,
                "judgeEscalated": false
            }))
            .map_err(|error| error.to_string())
        };
        let owed = || Owed {
            floor: 0,
            answered: None,
            turn_id: "turn-1".to_owned(),
            held: None,
        };
        let mut retired = RetiredApprovals::default();
        retired.insert_owed("held", owed());
        retired.hold(request("held")?);
        // A newer stage replaces the held one, so the newest goes out.
        let mut newer = request("held")?;
        newer.current_requirement_id.source_index = 1;
        retired.hold(newer);
        assert_eq!(retired.held.len(), 1);
        assert_eq!(
            retired
                .take_held()
                .map(|held| held.current_requirement_id.source_index),
            Some(1)
        );
        assert!(retired.take_held().is_none());

        retired.hold(request("held")?);
        assert_eq!(retired.held.len(), 1);
        retired.settle_owed("held");
        assert!(retired.held.is_empty());

        retired.insert_owed("evicted", owed());
        retired.hold(request("evicted")?);
        for index in 0..MAX_RETIRED_APPROVALS {
            retired.insert(&format!("approval-{index}"));
        }
        assert!(retired.held.is_empty());
        assert!(retired.take_held().is_none());
        Ok(())
    }
}
