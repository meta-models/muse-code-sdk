"""PY-the governing ruledjacent fold-composition arms and the turn-lifecycle
and approval/user-input fold-input contract: port of ``clients/sdk-ts/test/session-fold.test.ts``, every
runtime case.

The TS suite's compile-time probes are
type-system tests with no runtime twin; their INTENT — mutators never leak
onto the read surface, the surface is an allowlist, every generated view
notification is routed — is ported as the runtime tests at the end.
"""

from __future__ import annotations

from typing import Any

from muse_code.fold import (
    LIVE_HOST_STATE_PROJECTIONS,
    VIEW_EVENT_METHODS,
    ApprovalResolvedFold,
    DeliveryGap,
    FoldItems,
    FoldSessionState,
    IgnoredMissingParams,
    IgnoredStaleFrame,
    IgnoredUnrecognizedMethod,
    SessionFold,
    TurnFold,
    UserInputPending,
    UserInputSettledFold,
)

SOURCE: dict[str, Any] = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}
SESSION = "s-1"


def turn_started(turn_id: str, command_id: str, view_cursor: str) -> dict[str, Any]:
    return {
        "method": "turn/started",
        "params": {
            "commandId": command_id,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "turnId": turn_id,
            "viewCursor": view_cursor,
        },
    }


def turn_completed(
    turn_id: str,
    terminal: str,
    view_cursor: str,
    error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "sessionId": SESSION,
        "sourceRange": SOURCE,
        "terminal": terminal,
        "turnId": turn_id,
        "viewCursor": view_cursor,
    }
    if error is not None:
        params["error"] = error
    return {"method": "turn/completed", "params": params}


def turn_retracted(turn_id: str, command_id: str, view_cursor: str) -> dict[str, Any]:
    return {
        "method": "turn/retracted",
        "params": {
            "commandId": command_id,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "turnId": turn_id,
            "viewCursor": view_cursor,
        },
    }


def turn_unqueued(turn_id: str, command_id: str, view_cursor: str) -> dict[str, Any]:
    return {
        "method": "turn/unqueued",
        "params": {
            "commandId": command_id,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "turnId": turn_id,
            "viewCursor": view_cursor,
        },
    }


def retry_scheduled(turn_id: str, view_cursor: str) -> dict[str, Any]:
    return {
        "method": "turn/retryScheduled",
        "params": {
            "attempt": 1,
            "maxAttempts": 3,
            "nextAttempt": 2,
            "reason": "overloaded",
            "retryDelayMs": 500,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "turnId": turn_id,
            "viewCursor": view_cursor,
        },
    }


def item(item_id: str, revision: int, **extra: Any) -> dict[str, Any]:
    fixture: dict[str, Any] = {
        "itemId": item_id,
        "kind": "agentMessage",
        "revision": revision,
        "status": "inProgress",
    }
    fixture.update(extra)
    return fixture


def approval_requested(
    approval_id: str, view_cursor: str, command: str = "ls"
) -> dict[str, Any]:
    return {
        "method": "approval/requested",
        "params": {
            "approvalId": approval_id,
            "availableChoices": [],
            "currentRequirementId": {"approvalId": approval_id, "sourceIndex": 0},
            "itemId": "i-1",
            "judgeEscalated": False,
            "protectedWrite": False,
            "rawArgs": "{}",
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "subject": {"kind": "shell", "command": command},
            "taskId": "t-1",
            "toolCallId": "call-1",
            "toolName": "shell",
            "turnId": "turn-1",
            "viewCursor": view_cursor,
        },
    }


def approval_updated(
    approval_id: str, view_cursor: str, source_index: int = 1, command: str | None = None
) -> dict[str, Any]:
    subject: dict[str, Any] = {"kind": "shell"}
    if command is not None:
        subject["command"] = command
    return {
        "method": "approval/updated",
        "params": {
            "approvalId": approval_id,
            "availableChoices": [],
            "change": {"kind": "stageAdvanced"},
            "currentRequirementId": {"approvalId": approval_id, "sourceIndex": source_index},
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "subject": subject,
            "viewCursor": view_cursor,
        },
    }


def approval_resolved(approval_id: str, decision: str, view_cursor: str) -> dict[str, Any]:
    return {
        "method": "approval/resolved",
        "params": {
            "approvalId": approval_id,
            "decision": decision,
            "itemId": "i-1",
            "policyResult": "allow",
            "resolvedBy": "user",
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "stageEvidence": [],
            "turnId": "turn-1",
            "viewCursor": view_cursor,
        },
    }


def user_input_requested(user_input_id: str, view_cursor: str) -> dict[str, Any]:
    return {
        "method": "userInput/requested",
        "params": {
            "itemId": "i-2",
            "questions": [],
            "sessionId": SESSION,
            "toolCallId": "call-2",
            "toolName": "ask",
            "turnId": "turn-1",
            "userInputId": user_input_id,
            "viewCursor": view_cursor,
        },
    }


def user_input_settled(user_input_id: str, outcome: str, view_cursor: str) -> dict[str, Any]:
    return {
        "method": "userInput/settled",
        "params": {
            "answers": [],
            "clarification": None,
            "decidedByCommandId": None,
            "outcome": outcome,
            "reason": None,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "userInputId": user_input_id,
            "viewCursor": view_cursor,
        },
    }


# ---- turn lifecycle ---------------------------------------------------------


def test_turn_started_opens_a_running_turn_and_names_the_active_turn() -> None:
    fold = SessionFold()
    assert fold.active_turn_id is None, "no turn is running before any event"

    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))

    assert fold.active_turn_id == "turn-1"
    assert [(t.turn_id, t.state) for t in fold.turns()] == [("turn-1", "running")]
    held = fold.turn("turn-1")
    assert held is not None and held.command_id == "cmd-1"


def test_turn_completed_settles_the_turn_and_carries_the_wire_terminal_verbatim() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(turn_completed("turn-1", "failed", "v:s:2"))

    assert fold.active_turn_id is None, "a settled turn is no longer running"
    settled = fold.turn("turn-1")
    assert settled is not None
    assert settled.state == "settled"
    assert settled.terminal == "failed"
    # `turn/completed` carries no `commandId` on the wire, so the held entry
    # is the ONLY reason a settled turn still knows its command.
    assert settled.command_id == "cmd-1", "settling must not forget the started event's command"


def test_an_unknown_turn_terminal_value_is_recorded_verbatim_never_normalized() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    # TurnTerminal is wire-open: a value this SDK does not know is still the
    # server's terminal, and the fold must not rewrite it to a known one.
    fold.apply(turn_completed("turn-1", "supersededByFork", "v:s:2"))

    held = fold.turn("turn-1")
    assert held is not None
    assert held.terminal == "supersededByFork"
    assert held.state == "settled"


def test_a_failed_turns_wire_error_folds_verbatim_a_non_failed_terminal_carries_none() -> None:
    fold = SessionFold()
    wire_error = {"kind": "modelError", "message": "the provider returned a 500", "retryable": True}
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(turn_completed("turn-1", "failed", "v:s:2", wire_error))

    held = fold.turn("turn-1")
    assert held is not None and held.error == wire_error

    fold.apply(turn_started("turn-2", "cmd-2", "v:s:3"))
    fold.apply(turn_completed("turn-2", "completed", "v:s:4"))
    second = fold.turn("turn-2")
    assert second is not None and second.error is None, "error is present iff the turn failed"


def test_an_accepted_retract_after_turn_completed_cancelled_still_marks_the_turn_retracted() -> None:
    fold = SessionFold()
    # The wire's REAL ordering for a ran-then-retracted turn.
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(turn_completed("turn-1", "cancelled", "v:s:2"))
    fold.apply(turn_retracted("turn-1", "cmd-1", "v:s:3"))

    retracted = fold.turn("turn-1")
    assert retracted is not None
    assert retracted.state == "retracted"
    assert retracted.terminal == "cancelled", "the wire terminal is kept verbatim"


def test_turn_completed_for_a_turn_never_started_still_settles_it() -> None:
    fold = SessionFold()
    fold.apply(turn_completed("turn-9", "completed", "v:s:1"))

    held = fold.turn("turn-9")
    assert held is not None
    assert held.state == "settled"
    assert held.terminal == "completed"
    assert fold.active_turn_id is None


def test_turn_retracted_retires_the_submissions_turn_without_inventing_a_terminal() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(turn_retracted("turn-1", "cmd-1", "v:s:2"))

    retracted = fold.turn("turn-1")
    assert retracted is not None
    assert retracted.state == "retracted"
    assert retracted.terminal is None, "a retract is not a TurnTerminal"
    assert fold.active_turn_id is None


def test_turn_unqueued_records_a_reclaimed_turn_that_never_ran_and_never_becomes_active() -> None:
    fold = SessionFold()
    fold.apply(turn_unqueued("turn-2", "cmd-2", "v:s:1"))

    unqueued = fold.turn("turn-2")
    assert unqueued is not None
    assert unqueued.state == "unqueued"
    assert unqueued.command_id == "cmd-2"
    assert unqueued.terminal is None, "a reclaim is not a terminal"
    assert fold.active_turn_id is None, "a reclaimed turn never runs"


def test_turn_unqueued_for_a_queued_turn_does_not_disturb_the_running_turn() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(turn_unqueued("turn-2", "cmd-2", "v:s:2"))

    assert fold.active_turn_id == "turn-1", "the reclaim was another turn's"
    held = fold.turn("turn-2")
    assert held is not None and held.state == "unqueued"


def test_a_redelivered_turn_started_for_a_still_running_turn_folds_and_is_not_dropped() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    # The legal half of the redelivery guard: only a turn that LEFT `running`
    # is dropped.
    outcome = fold.apply(turn_started("turn-1", "cmd-1", "v:s:2"))

    assert outcome == TurnFold("turn-1", "running")
    assert fold.active_turn_id == "turn-1"
    assert len(fold.turns()) == 1, "a re-start never duplicates the turn"


def test_a_redelivered_turn_started_never_resurrects_a_turn_that_left_running() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(turn_completed("turn-1", "completed", "v:s:2"))
    outcome = fold.apply(turn_started("turn-1", "cmd-1", "v:s:3"))

    assert outcome == IgnoredStaleFrame("turn/started", "turn-1")
    held = fold.turn("turn-1")
    assert held is not None
    assert held.state == "settled"
    assert held.terminal == "completed"
    assert fold.active_turn_id is None, "a replayed start never re-arms the active turn"


def test_a_redelivered_turn_completed_never_un_retracts_a_retracted_turn() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(turn_completed("turn-1", "cancelled", "v:s:2"))
    fold.apply(turn_retracted("turn-1", "cmd-1", "v:s:3"))
    outcome = fold.apply(turn_completed("turn-1", "cancelled", "v:s:2"))

    assert outcome == IgnoredStaleFrame("turn/completed", "turn-1")
    held = fold.turn("turn-1")
    assert held is not None
    assert held.state == "retracted"
    assert held.terminal == "cancelled", "the wire terminal is still verbatim"


def test_a_redelivered_turn_completed_on_a_settled_turn_folds_and_is_not_dropped() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(turn_completed("turn-1", "completed", "v:s:2"))
    # Re-applying a completion to a settled turn rewrites identical facts and
    # is harmless; widening the guard to `state != "running"` would turn this
    # legal redelivery into a drop.
    outcome = fold.apply(turn_completed("turn-1", "completed", "v:s:3"))

    assert outcome == TurnFold("turn-1", "settled")
    held = fold.turn("turn-1")
    assert held is not None and held.terminal == "completed"
    assert len(fold.turns()) == 1, "a redelivered completion never duplicates the turn"


def test_a_reclaimed_turn_stays_unqueued_no_turn_completed_ever_settles_it() -> None:
    fold = SessionFold()
    fold.apply(turn_unqueued("turn-2", "cmd-2", "v:s:1"))
    outcome = fold.apply(turn_completed("turn-2", "completed", "v:s:2"))

    assert outcome == IgnoredStaleFrame("turn/completed", "turn-2")
    held = fold.turn("turn-2")
    assert held is not None
    assert held.state == "unqueued"
    assert held.terminal is None, "a reclaim is not a terminal"


def test_turn_retracted_carries_the_command_id_when_the_retract_is_the_first_frame() -> None:
    fold = SessionFold()
    # A client joining mid-session can see `turn/retracted` as its first
    # frame for a turn; the retract arm's own commandId capture is the only
    # way that entry joins the retracted turn to its submission.
    fold.apply(turn_retracted("turn-9", "cmd-9", "v:s:1"))

    retracted = fold.turn("turn-9")
    assert retracted is not None
    assert retracted.state == "retracted"
    assert retracted.command_id == "cmd-9"
    assert retracted.terminal is None, "a retract is not a TurnTerminal"


def test_turn_completed_clears_the_retry_countdown() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(retry_scheduled("turn-1", "v:s:2"))
    held = fold.turn("turn-1")
    assert held is not None and held.retry_scheduled is not None, (
        "the hint is set while the turn runs"
    )

    fold.apply(turn_completed("turn-1", "completed", "v:s:3"))

    held = fold.turn("turn-1")
    assert held is not None and held.retry_scheduled is None


def test_a_redelivered_turn_unqueued_on_a_reclaimed_turn_folds_and_is_not_dropped() -> None:
    fold = SessionFold()
    fold.apply(turn_unqueued("turn-2", "cmd-2", "v:s:1"))
    outcome = fold.apply(turn_unqueued("turn-2", "cmd-2", "v:s:2"))

    assert outcome == TurnFold("turn-2", "unqueued")
    assert len(fold.turns()) == 1, "a redelivered reclaim never duplicates the turn"
    held = fold.turn("turn-2")
    assert held is not None and held.terminal is None
    assert fold.active_turn_id is None, "a reclaimed turn never runs"


def test_turn_retry_scheduled_is_non_terminal_the_turn_keeps_running() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(retry_scheduled("turn-1", "v:s:2"))

    assert fold.active_turn_id == "turn-1", "a scheduled retry never settles a turn"
    held = fold.turn("turn-1")
    assert held is not None
    assert held.state == "running"
    assert held.retry_scheduled is not None
    assert held.retry_scheduled["nextAttempt"] == 2


def test_a_replayed_page_never_re_plants_the_retry_hint_on_a_turn_that_left_running() -> None:
    fold = SessionFold()
    retry = retry_scheduled("turn-1", "v:s:2")
    page = [
        turn_started("turn-1", "cmd-1", "v:s:1"),
        retry,
        turn_completed("turn-1", "cancelled", "v:s:3"),
        turn_retracted("turn-1", "cmd-1", "v:s:4"),
    ]
    for event in page:
        fold.apply(event)
    held = fold.turn("turn-1")
    assert held is not None and held.retry_scheduled is None, "in-order delivery is clean"

    for event in page:
        fold.apply(event)

    held = fold.turn("turn-1")
    assert held is not None
    assert held.state == "retracted"
    assert held.retry_scheduled is None, "the replayed hint is dropped"
    assert fold.apply(retry) == IgnoredStaleFrame("turn/retryScheduled", "turn-1")


def test_turns_are_listed_in_first_observed_order() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    fold.apply(turn_completed("turn-1", "completed", "v:s:2"))
    fold.apply(turn_unqueued("turn-3", "cmd-3", "v:s:3"))
    fold.apply(turn_started("turn-2", "cmd-2", "v:s:4"))

    assert [t.turn_id for t in fold.turns()] == ["turn-1", "turn-3", "turn-2"]


# ---- approvals as fold inputs -----------------------------------------------


def test_approval_requested_adds_a_pending_approval() -> None:
    fold = SessionFold()
    fold.apply(approval_requested("a-1", "v:s:1"))

    assert [a.approval_id for a in fold.pending_approvals()] == ["a-1"]
    assert fold.pending_approvals()[0].requested["toolName"] == "shell"


def test_a_re_requested_approval_refreshes_to_the_second_payload_without_duplicating() -> None:
    fold = SessionFold()
    fold.apply(approval_requested("a-1", "v:s:1", "ls"))
    fold.apply(approval_updated("a-1", "v:s:1b", command="ls"))
    assert fold.pending_approvals()[0].latest_update is not None, (
        "the update landed on the first request"
    )

    # A redelivered request for a STILL-PENDING approval must refresh the held
    # payload: a re-issued request already embodies the latest refresh (protocol spec
    # the protocol), so no stale refresh survives it.
    second = approval_requested("a-1", "v:s:2", "rm -rf /tmp/x")
    fold.apply(second)

    pending = fold.pending_approvals()
    assert len(pending) == 1, "a re-request never duplicates the entry"
    assert pending[0].requested == second["params"], "the WHOLE second payload is held"
    assert pending[0].latest_update is None, (
        "the re-request replaces the entry: no stale refresh survives it"
    )


def test_a_re_requested_prompt_refreshes_to_the_second_payload_without_duplicating() -> None:
    fold = SessionFold()
    first = user_input_requested("u-1", "v:s:1")
    fold.apply(first)
    second = user_input_requested("u-1", "v:s:2")
    outcome = fold.apply(second)

    assert outcome == UserInputPending("u-1")
    pending = fold.pending_user_inputs()
    assert len(pending) == 1, "a re-request never duplicates the entry"
    assert pending[0] == second["params"], "the SECOND payload is the one held"
    assert pending[0] != first["params"], "the first payload was replaced, not kept"


def test_approval_updated_refreshes_the_pending_view_in_place_and_keeps_it_pending() -> None:
    fold = SessionFold()
    fold.apply(approval_requested("a-1", "v:s:1"))
    fold.apply(approval_updated("a-1", "v:s:2", command="ls -la"))

    pending = fold.pending_approvals()
    assert len(pending) == 1, "an update never duplicates the entry"
    latest = pending[0].latest_update
    assert latest is not None
    assert latest["currentRequirementId"]["sourceIndex"] == 1
    assert fold.resolved_approvals() == [], "an update is not a resolution"


def test_approval_updated_for_an_approval_never_requested_is_tolerated() -> None:
    fold = SessionFold()
    outcome = fold.apply(approval_updated("a-ghost", "v:s:1", source_index=0))

    assert fold.pending_approvals() == [], "the fold never invents a request it did not see"
    assert outcome == IgnoredStaleFrame("approval/updated", "a-ghost")


def test_approval_updated_after_approval_resolved_never_resurrects_the_decision_either() -> None:
    fold = SessionFold()
    fold.apply(approval_requested("a-1", "v:s:1"))
    fold.apply(approval_resolved("a-1", "approved", "v:s:2"))
    # The exact frame a tracked issue is about: a post-terminal update carrying a
    # FAILED policyPersistence report. Re-opening the decided approval to hang
    # the fact on is the careless shape this pins against.
    outcome = fold.apply(approval_updated("a-1", "v:s:3", command="rm -rf /tmp/x"))

    assert outcome == IgnoredStaleFrame("approval/updated", "a-1")
    assert fold.pending_approvals() == [], "a decided approval is never re-opened"
    assert [r["decision"] for r in fold.resolved_approvals()] == ["approved"], (
        "the durable terminal is untouched"
    )


def test_approval_requested_after_approval_resolved_never_resurrects_the_decision() -> None:
    fold = SessionFold()
    fold.apply(approval_requested("a-1", "v:s:1"))
    fold.apply(approval_resolved("a-1", "approved", "v:s:2"))
    outcome = fold.apply(approval_requested("a-1", "v:s:3"))

    assert outcome == IgnoredStaleFrame("approval/requested", "a-1")
    assert fold.pending_approvals() == [], "the decided approval stays decided"
    assert [r["decision"] for r in fold.resolved_approvals()] == ["approved"]


def test_user_input_requested_after_user_input_settled_never_resurrects_the_prompt() -> None:
    fold = SessionFold()
    fold.apply(user_input_requested("u-1", "v:s:1"))
    fold.apply(user_input_settled("u-1", "answered", "v:s:2"))
    outcome = fold.apply(user_input_requested("u-1", "v:s:3"))

    assert outcome == IgnoredStaleFrame("userInput/requested", "u-1")
    assert fold.pending_user_inputs() == [], "the settled prompt stays settled"
    assert [s["outcome"] for s in fold.settled_user_inputs()] == ["answered"]


def test_approval_resolved_retires_the_pending_approval_and_records_the_terminal() -> None:
    fold = SessionFold()
    fold.apply(approval_requested("a-1", "v:s:1"))
    fold.apply(approval_resolved("a-1", "approved", "v:s:2"))

    assert fold.pending_approvals() == []
    assert [(r["approvalId"], r["decision"]) for r in fold.resolved_approvals()] == [
        ("a-1", "approved")
    ]


def test_the_first_durable_approval_terminal_wins_a_second_never_overwrites_it() -> None:
    fold = SessionFold()
    fold.apply(approval_requested("a-1", "v:s:1"))
    fold.apply(approval_resolved("a-1", "approved", "v:s:2"))
    second = fold.apply(approval_resolved("a-1", "denied", "v:s:3"))

    assert second == ApprovalResolvedFold("a-1", first_terminal=False)
    assert [r["decision"] for r in fold.resolved_approvals()] == ["approved"], (
        "the first durable terminal decision is the one that stands"
    )


def test_approval_resolved_with_no_prior_request_still_records_the_terminal() -> None:
    fold = SessionFold()
    outcome = fold.apply(approval_resolved("a-7", "denied", "v:s:1"))

    assert outcome == ApprovalResolvedFold("a-7", first_terminal=True)
    assert len(fold.resolved_approvals()) == 1


# ---- user input as fold inputs ----------------------------------------------


def test_user_input_requested_adds_a_pending_prompt_and_settled_retires_it() -> None:
    fold = SessionFold()
    requested = user_input_requested("u-1", "v:s:1")
    fold.apply(requested)
    assert [u["userInputId"] for u in fold.pending_user_inputs()] == ["u-1"]
    # The pending entry IS the generated request params — the wire shape
    # already carries `userInputId`, so no wrapper duplicates it.
    assert fold.pending_user_inputs()[0] == requested["params"]

    fold.apply(user_input_settled("u-1", "answered", "v:s:2"))
    assert fold.pending_user_inputs() == []
    assert [(s["userInputId"], s["outcome"]) for s in fold.settled_user_inputs()] == [
        ("u-1", "answered")
    ]


def test_the_first_user_input_settlement_wins_a_second_never_overwrites_it() -> None:
    fold = SessionFold()
    fold.apply(user_input_requested("u-1", "v:s:1"))
    fold.apply(user_input_settled("u-1", "answered", "v:s:2"))
    second = fold.apply(user_input_settled("u-1", "cancelled", "v:s:3"))

    assert second == UserInputSettledFold("u-1", first_settlement=False)
    assert [s["outcome"] for s in fold.settled_user_inputs()] == ["answered"]


def test_user_input_settled_with_no_prior_request_still_records_the_settlement() -> None:
    fold = SessionFold()
    outcome = fold.apply(user_input_settled("u-7", "cancelled", "v:s:1"))

    assert outcome == UserInputSettledFold("u-7", first_settlement=True)
    assert [(s["userInputId"], s["outcome"]) for s in fold.settled_user_inputs()] == [
        ("u-7", "cancelled")
    ]

    resurrect = fold.apply(user_input_requested("u-7", "v:s:2"))
    assert resurrect == IgnoredStaleFrame("userInput/requested", "u-7")
    assert fold.pending_user_inputs() == [], "the settled prompt stays settled"


def test_pending_approvals_and_prompts_list_in_first_observed_order() -> None:
    fold = SessionFold()
    fold.apply(approval_requested("a-2", "v:s:1"))
    fold.apply(approval_requested("a-1", "v:s:2"))
    fold.apply(user_input_requested("u-9", "v:s:3"))
    fold.apply(user_input_requested("u-4", "v:s:4"))

    assert [a.approval_id for a in fold.pending_approvals()] == ["a-2", "a-1"]
    assert [u["userInputId"] for u in fold.pending_user_inputs()] == ["u-9", "u-4"]


# ---- the two-store composition ----------------------------------------------


def test_item_events_fold_into_the_item_store_bound_to_the_generated_item() -> None:
    fold = SessionFold()
    fold.apply(
        {
            "method": "item/started",
            "params": {"item": item("i-1", 1), "sessionId": SESSION, "viewCursor": "v:s:1"},
        }
    )
    fold.apply(
        {
            "method": "item/delta",
            "params": {"delta": "hello ", "itemId": "i-1", "sessionId": SESSION, "viewCursor": "v:s:2"},
        }
    )
    fold.apply(
        {
            "method": "item/delta",
            "params": {"delta": "world", "itemId": "i-1", "sessionId": SESSION, "viewCursor": "v:s:3"},
        }
    )

    assert fold.items.accumulated("i-1", "text") == "hello world"

    # The wire really sends deltas for non-default fields ("output",
    # "summary.0" — the protocol spec); the fold must route `field` through, not
    # pile every delta into `text`.
    fold.apply(
        {
            "method": "item/delta",
            "params": {
                "delta": "tool bytes",
                "field": "output",
                "itemId": "i-1",
                "sessionId": SESSION,
                "viewCursor": "v:s:3b",
            },
        }
    )
    assert fold.items.accumulated("i-1", "output") == "tool bytes"
    assert fold.items.accumulated("i-1", "text") == "hello world", "text is untouched"

    fold.apply(
        {
            "method": "item/completed",
            "params": {
                "item": item("i-1", 2, status="completed", text="hello world"),
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "viewCursor": "v:s:4",
            },
        }
    )

    held = fold.items.get("i-1")
    assert held is not None
    assert held["status"] == "completed"
    assert held["revision"] == 2


def test_session_state_events_fold_into_the_store_keyed_by_their_method_name() -> None:
    fold = SessionFold()
    fold.apply(
        {
            "method": "session/modelChanged",
            "params": {
                "modelId": "muse-large",
                "sessionId": SESSION,
                "source": "user",
                "sourceRange": SOURCE,
                "viewCursor": "v:s:1",
            },
        }
    )
    fold.apply(
        {
            "method": "session/goalChanged",
            "params": {"sessionId": SESSION, "sourceRange": SOURCE, "viewCursor": "v:s:2"},
        }
    )

    model = fold.session_state.get("session/modelChanged")
    assert isinstance(model, dict) and model["modelId"] == "muse-large"
    assert fold.session_state.has("session/goalChanged"), (
        "an absent `goal` member is an explicit clear, and the family holds that fact"
    )


def test_the_fold_passes_view_cursor_through_so_a_redelivered_state_frame_is_refused() -> None:
    fold = SessionFold()
    event = {
        "method": "session/modelChanged",
        "params": {
            "modelId": "muse-large",
            "sessionId": SESSION,
            "source": "user",
            "sourceRange": SOURCE,
            "viewCursor": "v:s:1",
        },
    }
    first = fold.apply(event)
    from muse_code.fold import SessionStateFold

    assert isinstance(first, SessionStateFold)
    assert first.outcome.applied is True

    # The SAME frame again: the store's exact-cursor replay refusal
    # is the whole reason `apply` hands `viewCursor` down.
    replay = fold.apply(event)
    assert isinstance(replay, SessionStateFold)
    assert replay.outcome.applied is False, "an exact-cursor redelivery is refused, not re-applied"


def test_an_unrecognized_notification_method_folds_without_raising() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))
    outcome = fold.apply(
        {"method": "session/somethingNew", "params": {"sessionId": SESSION, "viewCursor": "v:s:2"}}
    )

    assert outcome == IgnoredUnrecognizedMethod("session/somethingNew")
    assert fold.active_turn_id == "turn-1", "the rest of the fold is untouched"


def test_a_real_view_gap_frame_moves_the_folds_currency_and_no_store() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:0"))

    assert fold.apply(
        {"method": "view/gap", "params": {"sessionId": SESSION, "after": "v:s:1", "next": "v:s:5"}}
    ) == DeliveryGap(after="v:s:1", next="v:s:5")
    assert fold.current is False, "the governing rule: not current until the hole is filled"
    assert fold.pending_gap == {"after": "v:s:1", "next": "v:s:5", "sessionId": SESSION}
    assert fold.items.size == 0, "the marker seeds no item"
    assert fold.session_state.families() == [], "and no state family"
    assert fold.active_turn_id == "turn-1", "the rest of the fold is untouched"


def test_consecutive_gaps_coalesce_on_the_first_after_gap_filled_clears_only_the_target_reached() -> None:
    fold = SessionFold()
    fold.apply({"method": "view/gap", "params": {"after": "v:s:1", "next": "v:s:5", "sessionId": SESSION}})
    fold.apply({"method": "view/gap", "params": {"after": "v:s:6", "next": "v:s:9", "sessionId": SESSION}})
    assert fold.pending_gap == {"after": "v:s:1", "next": "v:s:9", "sessionId": SESSION}

    # EQUALITY, never a relational compare: filling the ORIGINAL
    # target clears nothing, because the second hole is still open.
    assert fold.gap_filled("v:s:5") is False
    assert fold.current is False
    assert fold.gap_filled("v:s:9") is True
    assert fold.current is True
    assert fold.pending_gap is None
    # A repeat report of a hole already filled clears nothing.
    assert fold.gap_filled("v:s:9") is False
    assert fold.current is True


def test_the_generated_notification_frame_folds_with_no_re_wrapping() -> None:
    fold = SessionFold()
    # Exactly the frame shape a notification pump hands a consumer; envelope
    # members are tolerated.
    notification = {
        "jsonrpc": "2.0",
        "method": "session/somethingNew",
        "params": {"sessionId": SESSION, "viewCursor": "v:s:1"},
    }
    assert fold.apply(notification) == IgnoredUnrecognizedMethod("session/somethingNew")

    # The same frame with `params` genuinely absent — the wire omits it when
    # empty — must also fold rather than raise.
    bare = {"jsonrpc": "2.0", "method": "session/alsoNew"}
    assert fold.apply(bare) == IgnoredMissingParams("session/alsoNew")


def test_a_params_less_frame_for_a_known_method_is_dropped_never_raised() -> None:
    fold = SessionFold()
    fold.apply(turn_started("turn-1", "cmd-1", "v:s:1"))

    headless = {"jsonrpc": "2.0", "method": "turn/started"}
    outcome = fold.apply(headless)

    assert outcome == IgnoredMissingParams("turn/started")
    assert fold.active_turn_id == "turn-1", "the rest of the fold is untouched"
    assert len(fold.turns()) == 1, "no turn was minted from the params-less frame"


def test_null_scalar_and_array_params_are_all_classified_missing() -> None:
    fold = SessionFold()
    # `params: null`, a scalar, and a positional ARRAY are legal JSON-RPC
    # spellings no arm can fold; each must classify, never raise or mint a
    # phantom turn keyed on a missing id (the TS overload-pair rule).
    for params in (None, 42, "x", ["positional"]):
        outcome = fold.apply({"method": "turn/completed", "params": params})
        assert outcome == IgnoredMissingParams("turn/completed")
    assert fold.turns() == [], "no turn was minted or settled from unfoldable params"


# ---- the runtime twins of the TS compile-time seals -------------------------


def test_fold_items_and_fold_session_state_expose_no_mutators() -> None:
    fold = SessionFold()
    # The TS seal is compile-time (interface allowlists); this port seals at
    # runtime: the views carry no mutator attribute at all.
    for mutator in ("apply", "apply_delta", "seed", "mark_ephemeral_host_death"):
        assert not hasattr(fold.items, mutator), f"items view leaks mutator {mutator}"
    for mutator in ("apply", "seed"):
        assert not hasattr(fold.session_state, mutator), f"state view leaks mutator {mutator}"

    # The read half stays fully usable.
    assert fold.items.size == 0
    assert fold.session_state.families() == []


def test_the_items_surface_is_an_allowlist_pinned_by_member_set() -> None:
    # The runtime twin of the TS `Exactly<keyof FoldItems, ...>` pin: widening
    # the read surface is a deliberate edit here, never a side effect of a
    # store change.
    public = {name for name in dir(FoldItems) if not name.startswith("_")}
    assert public == {
        "accumulated",
        "accumulated_fields",
        "ephemeral_session_discarded",
        "get",
        "has",
        "is_terminal_unknown",
        "last_opened_item_id",
        "list",
        "size",
    }
    state_public = {name for name in dir(FoldSessionState) if not name.startswith("_")}
    assert state_public == {"families", "get", "has"}


def test_every_generated_view_notification_is_routed_never_the_default() -> None:
    # The runtime twin of the TS AssertNever coverage pins, PLUS the routing
    # table: every generated notification except the handshake's
    # `initialized` must be a fold input, and each must reach its own arm.
    from muse_code_msp import NOTIFICATIONS

    # `session/viewHealthChanged` is a COMMAND-PLANE health
    # push, not a view-fold input — it reports that the live view stream died,
    # so it carries no cursor and folds into no transcript state. Excluded here
    # like the handshake's `initialized`; the client handles it out of band.
    non_fold_notifications = {"initialized", "session/viewHealthChanged"}
    assert VIEW_EVENT_METHODS == set(NOTIFICATIONS) - non_fold_notifications - LIVE_HOST_STATE_PROJECTIONS, (
        "a a tracked issue enrollment added or retired a view notification; route it in"
        "SessionFold.apply (exclusions: `initialized`, the command-plane "
        "session/viewHealthChanged push, and the live host-state projections, "
        "the governing decision)"
    )
    # The reverse pin (the TS StaleExclusion twin): every excluded projection
    # names a REAL generated notification, so a retired or renamed method
    # cannot rot in the exclusion set as dead vocabulary.
    assert (LIVE_HOST_STATE_PROJECTIONS | non_fold_notifications) <= set(NOTIFICATIONS), (
        "an excluded method (live host-state projection or non-fold "
        "notification) names no generated notification"
    )

    by_method: dict[str, dict[str, Any]] = {
        "item/started": {
            "method": "item/started",
            "params": {"item": item("i-t", 1), "sessionId": SESSION, "viewCursor": "v:t:1"},
        },
        "item/updated": {
            "method": "item/updated",
            "params": {
                "item": item("i-t", 2),
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "viewCursor": "v:t:2",
            },
        },
        "item/completed": {
            "method": "item/completed",
            "params": {
                "item": item("i-t", 3, status="completed"),
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "viewCursor": "v:t:3",
            },
        },
        "item/delta": {
            "method": "item/delta",
            "params": {"delta": "d", "itemId": "i-t", "sessionId": SESSION, "viewCursor": "v:t:4"},
        },
        "turn/started": turn_started("turn-t", "cmd-t", "v:t:5"),
        "turn/completed": turn_completed("turn-t", "completed", "v:t:6"),
        "turn/retracted": turn_retracted("turn-t2", "cmd-t2", "v:t:7"),
        "turn/retryScheduled": retry_scheduled("turn-t3", "v:t:8"),
        "turn/unqueued": turn_unqueued("turn-t4", "cmd-t4", "v:t:9"),
        "approval/requested": approval_requested("a-t", "v:t:10"),
        "approval/updated": approval_updated("a-t", "v:t:10b"),
        "approval/resolved": approval_resolved("a-t", "approved", "v:t:11"),
        "userInput/requested": user_input_requested("u-t", "v:t:12"),
        "userInput/settled": user_input_settled("u-t", "answered", "v:t:13"),
        "session/modelChanged": {
            "method": "session/modelChanged",
            "params": {
                "modelId": "muse-large",
                "sessionId": SESSION,
                "source": "user",
                "sourceRange": SOURCE,
                "viewCursor": "v:t:14",
            },
        },
        "session/reasoningEffortChanged": {
            "method": "session/reasoningEffortChanged",
            "params": {
                "reasoningEffort": "high",
                "sessionId": SESSION,
                "source": "user",
                "sourceRange": SOURCE,
                "viewCursor": "v:t:22",
            },
        },
        "session/goalChanged": {
            "method": "session/goalChanged",
            "params": {"sessionId": SESSION, "sourceRange": SOURCE, "viewCursor": "v:t:15"},
        },
        "session/todoListChanged": {
            "method": "session/todoListChanged",
            "params": {
                "items": [{"status": "pending", "text": "one"}],
                "revision": 1,
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "sourceTool": "todo",
                "viewCursor": "v:t:16",
            },
        },
        "session/branchChanged": {
            "method": "session/branchChanged",
            "params": {
                "branch": "main",
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "viewCursor": "v:t:17",
                "workspaceRoot": "/w",
            },
        },
        "session/tokenUsage": {
            "method": "session/tokenUsage",
            "params": {
                "cumulative": {"outputTokens": 1, "promptTokens": 1, "totalTokens": 2},
                "promptTokens": 1,
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "totalTokens": 2,
                "turnId": "turn-t",
                "usage": {
                    "cachedTokens": 0,
                    "inputTokens": 1,
                    "outputTokens": 1,
                    "reasoningTokens": 0,
                },
                "viewCursor": "v:t:18",
            },
        },
        "session/contextUsage": {
            "method": "session/contextUsage",
            "params": {
                "pressure": "normal",
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "usedTokens": 10,
                "viewCursor": "v:t:19",
            },
        },
        "session/approvalModeChanged": {
            "method": "session/approvalModeChanged",
            "params": {
                "clientName": "sdk-test",
                "commandId": "cmd-t",
                "mode": "onRequest",
                "sessionId": SESSION,
                "source": "startup",
                "sourceRange": SOURCE,
                "viewCursor": "v:t:20",
            },
        },
        "session/modelRouteUnserved": {
            "method": "session/modelRouteUnserved",
            "params": {
                "commandId": "cmd-u",
                "installedProviderId": "meta",
                "modelId": "gpt-standing",
                "providerId": "openai",
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "viewCursor": "v:t:21",
            },
        },
        "session/nameChanged": {
            "method": "session/nameChanged",
            "params": {
                "name": "lease-fix",
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "viewCursor": "v:t:22",
            },
        },
        # The delivery marker is a routed arm: it changes no store,
        # but it MUST NOT reach the unrecognized default — that report is
        # reserved for a newer host's genuinely unknown method.
        "view/gap": {
            "method": "view/gap",
            "params": {"after": "v:t:20", "next": "v:t:22", "sessionId": SESSION},
        },
    }
    assert set(by_method) == set(VIEW_EVENT_METHODS), "the routing table must stay total"

    fold = SessionFold()
    for method, event in by_method.items():
        outcome = fold.apply(event)
        assert not isinstance(outcome, IgnoredUnrecognizedMethod), (
            f"`{method}` must route to its own arm, not fall through to the default"
        )
        assert not isinstance(outcome, IgnoredStaleFrame), (
            f"`{method}` with a fresh id must be consumed, not dropped as stale"
        )


def test_the_whole_fold_is_deterministic_over_the_same_sequence() -> None:
    sequence = [
        turn_started("turn-1", "cmd-1", "v:s:1"),
        approval_requested("a-1", "v:s:2"),
        user_input_requested("u-1", "v:s:3"),
        approval_resolved("a-1", "approved", "v:s:4"),
        user_input_settled("u-1", "answered", "v:s:5"),
        turn_completed("turn-1", "completed", "v:s:6"),
        turn_unqueued("turn-2", "cmd-2", "v:s:7"),
    ]

    def run() -> tuple[Any, ...]:
        fold = SessionFold()
        for event in sequence:
            fold.apply(event)
        return (
            fold.turns(),
            fold.pending_approvals(),
            fold.resolved_approvals(),
            fold.pending_user_inputs(),
            fold.settled_user_inputs(),
        )

    assert run() == run()


def test_mark_ephemeral_host_death_routes_through_the_fold_level_mutator() -> None:
    fold = SessionFold()
    fold.apply(
        {
            "method": "item/started",
            "params": {"item": item("open", 1), "sessionId": SESSION, "viewCursor": "v:s:1"},
        }
    )
    fold.apply(
        {
            "method": "item/completed",
            "params": {
                "item": item("done", 2, status="completed"),
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "viewCursor": "v:s:2",
            },
        }
    )

    annotations = fold.mark_ephemeral_host_death(
        lambda held: held.get("status") == "inProgress"
    )
    assert [a.item_id for a in annotations] == ["open"]
    assert fold.items.is_terminal_unknown("open") is True
    assert fold.items.is_terminal_unknown("done") is False
    assert fold.items.ephemeral_session_discarded is True
