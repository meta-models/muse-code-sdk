use super::{ApprovalRoute, Routed};
use crate::client::lock;
use crate::msp::ApprovalRequestParams;

fn request() -> Result<ApprovalRequestParams, String> {
    serde_json::from_value(serde_json::json!({
        "sessionId": "session-1",
        "approvalId": "approval-1",
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
        "currentRequirementId": {"approvalId": "approval-1", "sourceIndex": 0},
        "availableChoices": [],
        "protectedWrite": false,
        "judgeEscalated": false
    }))
    .map_err(|error| error.to_string())
}

// A resume-pending approval that ages out of the retired window and is
// re-issued must still reach the handoff router.
#[test]
fn retired_handoff_approval_keeps_the_handoff_router() {
    let (route, _pending) = ApprovalRoute::new();
    route.fix_handoff_routing(["approval-1".to_owned()]);
    route.retire("approval-1");

    assert!(
        lock(&route.handoff)
            .as_ref()
            .is_some_and(|handoff| handoff.approval_ids.contains("approval-1"))
    );
}

// `note_answered` records the stage on an owed mark, so a copy of that
// stage owes nothing more.
#[test]
fn a_decide_sent_for_an_owed_approval_answers_its_stage() -> Result<(), String> {
    let request = request()?;
    let (route, _pending) = ApprovalRoute::new();
    route.retire_owing("approval-1", "turn-1", 0);
    assert!(route.owes(&request));
    route.note_answered(&request);
    assert!(!route.owes(&request));
    Ok(())
}

// The host re-issues stage 1 while the worker decides stage 0, and that
// decide then fails: the fault finds stage 1 queued and carries it to its
// owed answer. That no fault can land between recording
// and queueing rests on `route_stage` doing both under one lock.
#[test]
fn a_fault_right_after_a_stage_is_recorded_keeps_its_owed_answer() -> Result<(), String> {
    let (route, _woken) = ApprovalRoute::new();
    let stage_0 = request()?;
    assert!(matches!(
        route.route_requested(stage_0.clone()),
        Routed::Queued { .. }
    ));
    let taken = route.take_next();
    assert_eq!(
        taken.map(|(request, _)| request.current_requirement_id.source_index),
        Some(0)
    );
    let mut stage_1 = stage_0;
    stage_1.current_requirement_id.source_index = 1;
    assert!(matches!(
        route.route_requested(stage_1),
        Routed::Queued { .. }
    ));
    route.retire_owing("approval-1", "turn-1", 0);

    let owed = route.take_next();
    assert_eq!(
        owed.map(|(request, router)| (
            request.current_requirement_id.source_index,
            router.is_some()
        )),
        Some((1, false))
    );
    Ok(())
}
