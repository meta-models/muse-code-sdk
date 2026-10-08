"""The charter test ``approval_and_user_input_round_trip``.

Port of ``clients/sdk-ts/test/facade-approval.test.ts``, plus the user-input dialog arms the Python task names: the round
trip is the contract, so every arm either drives a real ``approval/decide``
(or ``userInput/answer``/``userInput/cancel``) frame out of the fake duplex,
or asserts that none was written.

SHAPE NOTE, established from the bundle rather than assumed (the TS twin's):
``approval/request`` as a SERVER REQUEST is not what the view stream carries —
the schema folds ``approval/requested`` as a NOTIFICATION — so the round trip
is notification-in / command-out, exactly the governing rule pair. USER INPUT is the
other shape: ``userInput/request`` IS a server request (integer id, answered
``{}``), and the decision travels separately as the ``userInput/answer`` /
``userInput/cancel`` command — the transcript arms below pin both halves.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
from typing import Any, List

import pytest

from muse_code import Session, read_session_durability
from muse_code.connection import Connection
from muse_code.facade import (
    ApprovalDecisionInput,
    ApprovalFailure,
)

from helpers_connection import (
    FakeDuplex,
    answer,
    answer_error,
    frame,
    pump,
    sent_frame,
    sent_params,
    settled_io,
    wait_for_writes,
)

Params = dict[str, Any]

SESSION = "s-1"
SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}

CHOICES: List[Params] = [
    {"choiceId": "allow_once", "decision": "approved", "label": "Allow once", "scope": "once"},
    {
        "acceptsFeedback": True,
        "choiceId": "deny",
        "decision": "denied",
        "label": "Deny",
        "scope": "once",
    },
]

TRANSCRIPTS = (
    pathlib.Path(__file__).resolve().parents[3] / "schema" / "msp" / "transcripts"
)


def approval_requested(**overrides: Any) -> Params:
    approval_id = str(overrides.get("approvalId", "a-1"))
    params: Params = {
        "approvalId": approval_id,
        "availableChoices": CHOICES,
        "currentRequirementId": {"approvalId": approval_id, "sourceIndex": 0},
        "itemId": "i-1",
        "judgeEscalated": False,
        "protectedWrite": False,
        "rawArgs": "{}",
        "sessionId": SESSION,
        "sourceRange": SOURCE,
        "subject": {"kind": "shell", "command": "ls"},
        "taskId": "task-1",
        "toolCallId": "call-1",
        "toolName": "shell",
        "turnId": "turn-1",
        "viewCursor": "v:1",
        **overrides,
    }
    return {"method": "approval/requested", "params": params}


def approval_resolved(decided_by: str, view_cursor: str = "v:2") -> Params:
    return {
        "method": "approval/resolved",
        "params": {
            "approvalId": "a-1",
            "decidedByCommandId": decided_by,
            "decision": "approved",
            "itemId": "i-1",
            "policyResult": {"kind": "allowed"},
            "resolvedBy": {"kind": "client"},
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "stageEvidence": [],
            "turnId": "turn-1",
            "viewCursor": view_cursor,
        },
    }


def decide_result(command_id: str, approval_id: str = "a-1") -> Params:
    return {
        "approvalId": approval_id,
        "commandId": command_id,
        "status": "accepted",
        "terminal": True,
    }


def wired() -> tuple[FakeDuplex, "Session[str]", List[str]]:
    transport = FakeDuplex()
    minted: List[str] = []

    def mint() -> str:
        minted.append(f"mint-{len(minted)}")
        return minted[-1]

    connection = Connection(transport, mint_command_id=mint)
    session: Session[str] = Session(
        SESSION,
        read_session_durability({"sessionDurability": "durable"}),
        connection=connection,
    )
    return transport, session, minted


def wired_notifying() -> tuple[FakeDuplex, "Session[str]"]:
    """Like :func:`wired`, but notifications reach the session through the
    connection, so a response and a notification can arrive in one read."""
    transport = FakeDuplex()
    minted: List[str] = []

    def mint() -> str:
        minted.append(f"mint-{len(minted)}")
        return minted[-1]

    connection = Connection(transport, mint_command_id=mint)
    session: Session[str] = Session(
        SESSION,
        read_session_durability({"sessionDurability": "durable"}),
        connection=connection,
    )
    connection.on_notification(lambda event: session.apply(event))
    return transport, session


def fold_only() -> "Session[str]":
    return Session(SESSION, read_session_durability({"sessionDurability": "durable"}))


# ---- the governing rule: the approval round trip ----------------------------------


@pytest.mark.asyncio
async def test_the_handlers_choice_reaches_the_wire_as_approval_decide() -> None:
    transport, session, minted = wired()
    seen: List[Params] = []

    def handler(request: Any) -> ApprovalDecisionInput:
        seen.append(dict(request))
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)

    outcome = session.apply(approval_requested())
    # Inbound half: the fold tracks it while the decision is in flight.
    assert [a.approval_id for a in session.fold.pending_approvals()] == ["a-1"]

    await wait_for_writes(transport, 1)
    assert sent_frame(transport, 0)["method"] == "approval/decide"
    params = sent_params(transport, 0)
    command_id = params.pop("commandId")
    # The rule: the connection's mint is still the only minter.
    assert minted == ["mint-0"]
    assert command_id == "mint-0"
    assert params == {
        "approvalId": "a-1",
        "choiceId": "allow_once",
        "requirementId": {"approvalId": "a-1", "sourceIndex": 0},
        "sessionId": SESSION,
    }
    # The handler saw the SERVER's request verbatim, choices included — that is
    # what makes "server-minted choices only" checkable by the consumer.
    assert len(seen) == 1
    assert seen[0]["availableChoices"] == CHOICES

    answer(transport, 0, decide_result("mint-0"))
    await settled_io(outcome.io)

    # Round trip closed: the authoritative outcome is the view stream's
    # approval/resolved, never the ack, so the fold must move only
    # when that lands.
    assert len(session.fold.pending_approvals()) == 1
    session.apply(approval_resolved("mint-0"))
    assert len(session.fold.pending_approvals()) == 0
    assert [r["decidedByCommandId"] for r in session.fold.resolved_approvals()] == [
        "mint-0"
    ]


@pytest.mark.asyncio
async def test_a_redelivered_request_decides_once_and_mints_no_second_command_id() -> None:
    # the protocol idempotency is about the SUBMISSION; the client half is not
    # sending a second one. A redelivered request for the same stage must not
    # author a second decide, or a two-stage approval races itself.
    transport, session, minted = wired()
    calls = 0

    def handler(_request: Any) -> ApprovalDecisionInput:
        nonlocal calls
        calls += 1
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)

    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    answer(transport, 0, decide_result("mint-0"))
    await settled_io(first.io)

    second = session.apply(approval_requested())
    await settled_io(second.io)
    await pump()

    assert len(transport.writes) == 1, "the redelivery must author no second decide"
    assert calls == 1, "the handler must not be asked twice for one stage"
    assert minted == ["mint-0"]


@pytest.mark.asyncio
async def test_a_new_requirement_id_is_a_new_stage_and_gets_its_own_decision() -> None:
    # the protocol spec: `requirementId` is the multi-stage race guard — a decision
    # aimed at stage 1 can never satisfy stage 2. Memoizing on `approvalId`
    # alone would leave stage 2 undecided forever.
    transport, session, minted = wired()
    session.on_approval(lambda _r: ApprovalDecisionInput(choice_id="allow_once"))

    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    answer(transport, 0, decide_result("mint-0"))
    await settled_io(first.io)

    second = session.apply(
        approval_requested(currentRequirementId={"approvalId": "a-1", "sourceIndex": 1})
    )
    await wait_for_writes(transport, 2)
    assert sent_params(transport, 1)["requirementId"] == {
        "approvalId": "a-1",
        "sourceIndex": 1,
    }
    assert sent_params(transport, 1)["commandId"] == "mint-1"
    answer(transport, 1, decide_result("mint-1"))
    await settled_io(second.io)
    assert minted == ["mint-0", "mint-1"]


@pytest.mark.asyncio
async def test_no_handler_registered_writes_nothing_and_parks_nothing() -> None:
    # The ruled default: "no handler registered means the client runs
    # under the server's default-deny posture — the SDK parks nothing".
    transport, session, _minted = wired()

    outcome = session.apply(approval_requested())
    # Settle the queue and assert BEFORE awaiting `io`: an implementation that
    # auto-answered would leave `io` pending on a round trip nobody answers, so
    # awaiting first turns a clean assertion failure into an arm hang.
    await pump()
    assert len(transport.writes) == 0, "no handler must produce no frame"
    assert await settled_io(outcome.io) == ()
    # The approval is still VISIBLE — folding it is the inbound half and is
    # not a park; the server's own timeout resolves it.
    assert [a.approval_id for a in session.fold.pending_approvals()] == ["a-1"]
    # And nothing was decided BEHIND the consumer's back either: registering a
    # handler afterwards must find the stage unclaimed, so the next delivery of
    # the same request still reaches it.
    calls = 0

    def handler(_request: Any) -> ApprovalDecisionInput:
        nonlocal calls
        calls += 1
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    second = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    assert calls == 1
    answer(transport, 0, decide_result("mint-0"))
    await settled_io(second.io)


@pytest.mark.asyncio
async def test_an_unoffered_choice_is_refused_before_the_wire() -> None:
    # Select-never-create: choices are server-minted. Sending an
    # invented one bounces -32052 a round trip later, and by then the stage may
    # have advanced — so the refusal belongs on this side of the transport.
    transport, session, _minted = wired()
    failures: List[ApprovalFailure] = []
    session.on_approval_error(failures.append)
    session.on_approval(lambda _r: ApprovalDecisionInput(choice_id="allow_always"))

    outcome = session.apply(approval_requested())
    await settled_io(outcome.io)
    await pump()

    assert len(transport.writes) == 0, "an unoffered choice must never reach the wire"
    assert len(failures) == 1
    failure = failures[0]
    assert failure.kind == "unofferedChoice"
    assert failure.approval_id == "a-1"
    assert failure.kind == "unofferedChoice" and failure.choice_id == "allow_always"
    assert failure.kind == "unofferedChoice" and failure.available_choice_ids == (
        "allow_once",
        "deny",
    )


@pytest.mark.asyncio
async def test_feedback_is_forwarded_when_set_and_omitted_when_unset() -> None:
    transport, session, _minted = wired()
    session.on_approval(
        lambda _r: ApprovalDecisionInput(choice_id="deny", feedback="not this path")
    )

    outcome = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    assert sent_params(transport, 0)["feedback"] == "not this path"
    answer(transport, 0, decide_result("mint-0"))
    await settled_io(outcome.io)

    # The twin: unset feedback is ABSENT from the frame, never null.
    transport2, session2, _minted2 = wired()
    session2.on_approval(lambda _r: ApprovalDecisionInput(choice_id="deny"))
    second = session2.apply(approval_requested())
    await wait_for_writes(transport2, 1)
    assert "feedback" not in sent_params(transport2, 0), "feedback must be omitted"
    answer(transport2, 0, decide_result("mint-0"))
    await settled_io(second.io)


@pytest.mark.asyncio
async def test_a_handler_that_raises_surfaces_the_failure_and_writes_nothing() -> None:
    transport, session, _minted = wired()
    failures: List[ApprovalFailure] = []
    session.on_approval_error(failures.append)

    def handler(_request: Any) -> ApprovalDecisionInput:
        raise RuntimeError("handler blew up")

    session.on_approval(handler)

    outcome = session.apply(approval_requested())
    # A raising handler must not escape the notification pump, and must not
    # take the fold down with it.
    await settled_io(outcome.io)
    await pump()

    assert len(transport.writes) == 0
    assert len(failures) == 1
    assert failures[0].kind == "handlerThrew"
    assert len(session.fold.pending_approvals()) == 1


@pytest.mark.asyncio
async def test_a_rejected_decide_surfaces_as_submit_failed_never_a_silent_drop() -> None:
    transport, session, _minted = wired()
    failures: List[ApprovalFailure] = []
    session.on_approval_error(failures.append)
    session.on_approval(lambda _r: ApprovalDecisionInput(choice_id="allow_once"))

    outcome = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    # -32053: the stale-requirement bounce. The client learns the stage moved.
    answer_error(
        transport,
        0,
        {"code": -32053, "message": "stale requirementId", "data": {"kind": "invalidParams"}},
    )
    await settled_io(outcome.io)

    assert len(failures) == 1
    assert failures[0].kind == "submitFailed"


@pytest.mark.asyncio
async def test_on_approval_does_not_fire_for_a_fold_only_sessions_approvals() -> None:
    # A handler on a session with no connection cannot answer, and calling it
    # would ask the consumer for a decision the SDK then drops on the floor.
    session = fold_only()
    failures: List[ApprovalFailure] = []
    calls = 0
    session.on_approval_error(failures.append)

    def handler(_request: Any) -> ApprovalDecisionInput:
        nonlocal calls
        calls += 1
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)

    outcome = session.apply(approval_requested())
    await settled_io(outcome.io)

    assert calls == 0
    assert len(failures) == 1
    assert failures[0].kind == "submitFailed"


@pytest.mark.asyncio
async def test_a_handler_returning_the_wrong_thing_is_reported_never_escaped() -> None:
    # A handler that forgot its `return` (or returned a wrong type) is the
    # consumer's callback misbehaving, exactly like a raise: it must reach
    # `on_approval_error` as `handlerThrew`, never escape into the
    # never-rejecting `io` as an unretrieved-task exception.
    transport, session, _minted = wired()
    failures: List[ApprovalFailure] = []
    session.on_approval_error(failures.append)
    session.on_approval(lambda _r: None)  # type: ignore[arg-type,return-value]

    outcome = session.apply(approval_requested())
    assert await settled_io(outcome.io) == ()
    await pump()

    assert len(transport.writes) == 0, "a malformed decision must write nothing"
    assert len(failures) == 1
    assert failures[0].kind == "handlerThrew"


def test_fold_only_approval_reports_submit_failed_with_no_event_loop_at_all() -> None:
    # Deliberately NO asyncio marker: a fold-only consumer may apply events
    # outside any loop, and the SubmitFailed report must fire synchronously
    # rather than ride a coroutine nothing can schedule — scheduling one here
    # minted an orphan event loop and the report never fired (a prior review
    # review round 1).
    session = fold_only()
    failures: List[ApprovalFailure] = []
    calls = 0
    session.on_approval_error(failures.append)

    def handler(_request: Any) -> ApprovalDecisionInput:
        nonlocal calls
        calls += 1
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    outcome = session.apply(approval_requested())

    assert calls == 0, "a handler with no connection to answer on is never asked"
    assert len(failures) == 1 and failures[0].kind == "submitFailed"

    async def drain_io() -> tuple[Any, ...]:
        return await outcome.io

    assert asyncio.run(drain_io()) == ()


UPDATE_SOURCE: Params = {
    "first": {"id": "e-3", "sequence": 3},
    "last": {"id": "e-3", "sequence": 3},
    "stream": {"id": "str-1", "kind": "session"},
}


def stage_resolved(
    advance_to: int,
    choices: List[Params],
    **overrides: Any,
) -> Params:
    """The host's stage-advance frame: stage 0 resolved, ``currentRequirementId``
    moved on, and NO second ``approval/requested`` follows."""
    params: Params = {
        "approvalId": "a-1",
        "availableChoices": choices,
        "change": {
            "choiceId": "allow_once",
            "decision": "approved",
            "kind": "stageResolved",
            "requirementId": {"approvalId": "a-1", "sourceIndex": 0},
        },
        "currentRequirementId": {"approvalId": "a-1", "sourceIndex": advance_to},
        "sessionId": SESSION,
        "sourceRange": UPDATE_SOURCE,
        "subject": {"kind": "shell", "command": "echo two > b.txt"},
        "viewCursor": "v:3",
        **overrides,
    }
    return {"method": "approval/updated", "params": params}


@pytest.mark.asyncio
async def test_an_approval_updated_that_advances_the_requirement_re_asks_the_handler() -> None:
    # A 3-stage shell approval where stages 0 and 2 need decisions. The host
    # resolves stage 0, advances `currentRequirementId` 0 -> 2 through
    # `approval/updated` (`change.kind: stageResolved`) and sends no second
    # `approval/requested` on the notification plane. Routing only
    # `approval/requested` leaves stage 2 undecided and the turn pending.
    transport, session, minted = wired()
    seen: List[Params] = []

    def handler(request: Any) -> ApprovalDecisionInput:
        seen.append(dict(request))
        # Stage 2 answers with a choice stage 0 NEVER offered, so a router
        # that validated against stage 0's retained choices refuses it.
        stage = request["currentRequirementId"]["sourceIndex"]
        return ApprovalDecisionInput(choice_id="allow_write" if stage == 2 else "allow_once")

    session.on_approval(handler)
    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    # The stage decision is accepted but the APPROVAL is not terminal.
    answer(transport, 0, {**decide_result("mint-0"), "terminal": False})
    await settled_io(first.io)

    stage_two_choices = [
        *CHOICES,
        {"choiceId": "allow_write", "decision": "approved", "label": "Allow write", "scope": "once"},
    ]
    subagent_origin = {"childRunId": "run-9", "childSessionId": "s-child", "subagentId": "sub-1"}
    updated = session.apply(
        stage_resolved(2, stage_two_choices, subagentOrigin=subagent_origin)
    )

    # The advanced stage reaches the wire as its own decision, choosing from
    # the UPDATE's refreshed choices.
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "approval/decide"
    assert sent_params(transport, 1)["requirementId"] == {"approvalId": "a-1", "sourceIndex": 2}
    assert sent_params(transport, 1)["choiceId"] == "allow_write"
    assert minted == ["mint-0", "mint-1"]
    # The handler saw an honest refreshed request: stage-scoped members from
    # the update, identity members from the retained original request.
    assert len(seen) == 2
    assert seen[1] == {
        "approvalId": "a-1",
        "availableChoices": stage_two_choices,
        "currentRequirementId": {"approvalId": "a-1", "sourceIndex": 2},
        "itemId": "i-1",
        "judgeEscalated": False,
        "protectedWrite": False,
        "rawArgs": "{}",
        "sessionId": SESSION,
        "sourceRange": UPDATE_SOURCE,
        "subagentOrigin": subagent_origin,
        "subject": {"kind": "shell", "command": "echo two > b.txt"},
        "taskId": "task-1",
        "toolCallId": "call-1",
        "toolName": "shell",
        "turnId": "turn-1",
        "viewCursor": "v:3",
    }
    answer(transport, 1, decide_result("mint-1"))
    await settled_io(updated.io)

    # A late re-issued approval/requested for the same stage (a host that
    # does both) authors no second decide: the stage latch already claimed it.
    reissued = session.apply(
        approval_requested(currentRequirementId={"approvalId": "a-1", "sourceIndex": 2})
    )
    await settled_io(reissued.io)
    await pump()
    assert len(seen) == 2, "one stage asks the consumer once, whichever frame delivers it"
    assert len(transport.writes) == 2, "the re-issued request must author no third decide"

    session.apply(approval_resolved("mint-1", view_cursor="v:4"))
    assert session.fold.pending_approvals() == []


@pytest.mark.asyncio
async def test_an_approval_updated_naming_the_decided_stage_asks_nothing() -> None:
    # The per-stage latch: an update that still names the stage this client
    # already decided (here a policy-persistence report on stage 0) is not a
    # new question.
    transport, session, _minted = wired()
    calls: List[int] = []

    def handler(_request: Any) -> ApprovalDecisionInput:
        calls.append(1)
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    answer(transport, 0, {**decide_result("mint-0"), "terminal": False})
    await settled_io(first.io)

    outcome = session.apply(
        stage_resolved(
            0,
            CHOICES,
            change={"kind": "policyPersistence", "status": "succeeded"},
        )
    )
    await pump()
    assert len(calls) == 1, "an update naming the decided stage must not re-ask the handler"
    assert len(transport.writes) == 1
    await settled_io(outcome.io)


@pytest.mark.asyncio
async def test_a_terminal_ack_and_its_trailing_update_in_one_read_ask_once() -> None:
    # The `terminal: true` ack and the trailing `stageResolved` update can be
    # delivered in ONE read, so the update is folded before the decide that
    # sent stage 0 has seen its ack. The update must wait for that ack.
    transport, session = wired_notifying()
    calls: List[int] = []

    def handler(_request: Any) -> ApprovalDecisionInput:
        calls.append(1)
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    ack = {
        "jsonrpc": "2.0",
        "id": sent_frame(transport, 0)["id"],
        "result": decide_result("mint-0"),
    }
    trailing = {"jsonrpc": "2.0", **stage_resolved(1, CHOICES)}
    transport.chunks.push(frame(ack) + frame(trailing))
    await settled_io(first.io)
    await pump()
    assert len(calls) == 1, "a stage the host closed in the same read must not re-ask"
    assert len(transport.writes) == 1, "no decide may chase a terminal ack"


@pytest.mark.asyncio
async def test_a_non_terminal_ack_and_a_stage_update_in_one_read_ask_the_new_stage() -> None:
    # The wait must END by asking when the ack was not terminal: the next
    # stage is still somebody's question.
    transport, session = wired_notifying()
    seen: List[int] = []

    def handler(request: Any) -> ApprovalDecisionInput:
        seen.append(request["currentRequirementId"]["sourceIndex"])
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    ack = {
        "jsonrpc": "2.0",
        "id": sent_frame(transport, 0)["id"],
        "result": {**decide_result("mint-0"), "terminal": False},
    }
    advance = {"jsonrpc": "2.0", **stage_resolved(2, CHOICES)}
    transport.chunks.push(frame(ack) + frame(advance))
    await settled_io(first.io)
    await wait_for_writes(transport, 2)
    assert seen == [0, 2]
    assert sent_params(transport, 1)["requirementId"] == {"approvalId": "a-1", "sourceIndex": 2}
    answer(transport, 1, decide_result("mint-1"))
    await pump()


@pytest.mark.asyncio
async def test_a_failed_decide_and_a_stage_update_in_one_read_ask_the_new_stage() -> None:
    # A failed earlier decide still lets the waiting stage be asked.
    transport, session = wired_notifying()
    seen: List[int] = []

    def handler(request: Any) -> ApprovalDecisionInput:
        seen.append(request["currentRequirementId"]["sourceIndex"])
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    session.on_approval_error(lambda _failure: None)
    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    refusal = {
        "jsonrpc": "2.0",
        "id": sent_frame(transport, 0)["id"],
        "error": {
            "code": -32053,
            "message": "approval requirement is stale",
            "data": {"kind": "approvalRequirementStale", "retryable": False},
        },
    }
    advance = {"jsonrpc": "2.0", **stage_resolved(2, CHOICES)}
    transport.chunks.push(frame(refusal) + frame(advance))
    await settled_io(first.io)
    await wait_for_writes(transport, 2)
    assert seen == [0, 2]
    assert sent_params(transport, 1)["requirementId"] == {"approvalId": "a-1", "sourceIndex": 2}
    answer(transport, 1, decide_result("mint-1"))
    await pump()


@pytest.mark.asyncio
async def test_a_stage_update_while_the_earlier_handler_is_open_is_asked() -> None:
    # Another client advanced the approval while stage 0's handler still
    # waits on a human. Stage 2 must not wait for that answer.
    transport, session, _minted = wired()
    seen: List[int] = []
    human = asyncio.get_running_loop().create_future()

    async def handler(request: Any) -> ApprovalDecisionInput:
        stage = request["currentRequirementId"]["sourceIndex"]
        seen.append(stage)
        if stage == 0:
            await human
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    first = session.apply(approval_requested())
    await pump()
    assert seen == [0]
    updated = session.apply(stage_resolved(2, CHOICES))
    await pump()
    assert seen == [0, 2], "stage 2 must not wait for stage 0's open handler"
    await wait_for_writes(transport, 1)
    assert sent_params(transport, 0)["requirementId"] == {"approvalId": "a-1", "sourceIndex": 2}
    answer(transport, 0, decide_result("mint-0"))
    await settled_io(updated.io)
    # The late stage-0 answer still authors its own decide; refuse it.
    human.set_result(None)
    await wait_for_writes(transport, 2)
    answer_error(
        transport,
        1,
        {
            "code": -32051,
            "message": "approval already resolved",
            "data": {"kind": "approvalAlreadyResolved", "retryable": False},
        },
    )
    await settled_io(first.io)


@pytest.mark.asyncio
async def test_a_cancelled_io_does_not_block_a_later_stage() -> None:
    # A consumer may cancel ``io``; a decide that never started must not
    # leave later stages of the same approval waiting forever. (The decide
    # that never ran is reported as a never-awaited coroutine when it is
    # garbage-collected, after this test: that warning is the scenario.)
    transport, session, _minted = wired()
    seen: List[int] = []

    def handler(request: Any) -> ApprovalDecisionInput:
        seen.append(request["currentRequirementId"]["sourceIndex"])
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    first = session.apply(approval_requested())
    first.io.cancel()
    await pump()
    updated = session.apply(stage_resolved(2, CHOICES))
    await wait_for_writes(transport, 1)
    assert seen == [2]
    assert sent_params(transport, 0)["requirementId"] == {"approvalId": "a-1", "sourceIndex": 2}
    answer(transport, 0, decide_result("mint-0"))
    await settled_io(updated.io)


@pytest.mark.asyncio
async def test_a_stage_resolved_update_after_a_terminal_decide_ack_asks_nothing() -> None:
    # A stage-0 answer whose rule also satisfies the remaining stages closes
    # the approval in one submission, but the host can still emit one
    # trailing `stageResolved` update naming a stage it already closed, just
    # before `approval/resolved`. The ack's `terminal: true` is the router's
    # evidence that the stage is nobody's question.
    transport, session, _minted = wired()
    calls: List[int] = []

    def handler(_request: Any) -> ApprovalDecisionInput:
        calls.append(1)
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    answer(transport, 0, decide_result("mint-0"))  # terminal: true
    await settled_io(first.io)

    outcome = session.apply(stage_resolved(1, CHOICES))
    await pump()
    assert len(calls) == 1, "a stage the host already closed must not re-ask the handler"
    assert len(transport.writes) == 1, "no decide may chase a terminal ack"
    await settled_io(outcome.io)

    session.apply(approval_resolved("mint-0", view_cursor="v:4"))
    assert session.fold.pending_approvals() == []


@pytest.mark.asyncio
async def test_an_already_terminal_approval_updated_asks_nothing() -> None:
    # `alreadyTerminal` says the host holds a durable terminal the resolve
    # frame has not delivered yet; a decision against it can only bounce, so
    # asking the consumer for one would be a pointless question.
    transport, session, _minted = wired()
    calls: List[int] = []

    def handler(_request: Any) -> ApprovalDecisionInput:
        calls.append(1)
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    answer(transport, 0, {**decide_result("mint-0"), "terminal": False})
    await settled_io(first.io)

    outcome = session.apply(
        stage_resolved(2, CHOICES, change={"kind": "alreadyTerminal"})
    )
    await pump()
    assert len(calls) == 1, "an alreadyTerminal update must not re-ask the handler"
    assert len(transport.writes) == 1
    await settled_io(outcome.io)


@pytest.mark.asyncio
async def test_an_approval_updated_the_fold_ignored_asks_nothing() -> None:
    # A failed policy write can arrive as `approval/updated` AFTER
    # `approval/resolved`, when the fold no longer holds the entry. The
    # fold's ignored-stale verdict must gate the route.
    transport, session, _minted = wired()
    calls: List[int] = []

    def handler(_request: Any) -> ApprovalDecisionInput:
        calls.append(1)
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    # Non-terminal, so the fold's verdict is the only thing that can block it.
    answer(transport, 0, {**decide_result("mint-0"), "terminal": False})
    await settled_io(first.io)
    session.apply(approval_resolved("mint-0"))

    outcome = session.apply(
        stage_resolved(
            5,
            CHOICES,
            change={"kind": "policyPersistence", "reason": "disk", "status": "failed"},
        )
    )
    await pump()
    assert len(calls) == 1, "an update the fold ignored must not re-ask the handler"
    assert len(transport.writes) == 1
    await settled_io(outcome.io)


@pytest.mark.asyncio
async def test_a_raising_on_approval_error_observer_still_lets_io_resolve() -> None:
    # The failure observer is a consumer entry point too. If its raise escaped
    # `_report`, it would ride the gather into `SessionApplyOutcome.io` — and
    # since most consumers never await `io`, that is an escaping failure the
    # "io never rejects" contract exists to prevent.
    transport, session, _minted = wired()

    def observer(_failure: ApprovalFailure) -> None:
        raise RuntimeError("observer boom")

    session.on_approval_error(observer)
    # An unoffered choice drives `_report` without needing any wire I/O.
    session.on_approval(lambda _r: ApprovalDecisionInput(choice_id="not-offered"))

    outcome = session.apply(approval_requested())
    await settled_io(outcome.io)  # must RESOLVE — an exception here fails the arm.

    assert len(transport.writes) == 0


@pytest.mark.asyncio
async def test_a_request_redelivered_after_resolved_authors_no_second_decide() -> None:
    # The `ApprovalPending` gate's own splitting arm. A post-resolution
    # redelivery arrives with an ADVANCED `sourceIndex`, so the router's stage
    # latch does NOT cover it — only the fold's verdict stands between the
    # handler and a doomed second decide (no second resolution is coming).
    transport, session, _minted = wired()
    calls = 0

    def handler(_request: Any) -> ApprovalDecisionInput:
        nonlocal calls
        calls += 1
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)
    first = session.apply(approval_requested())
    await wait_for_writes(transport, 1)
    answer(transport, 0, decide_result("mint-0"))
    await settled_io(first.io)
    session.apply(approval_resolved("mint-0"))

    redelivered = session.apply(
        approval_requested(currentRequirementId={"approvalId": "a-1", "sourceIndex": 1})
    )
    await settled_io(redelivered.io)
    await pump()

    assert calls == 1, "the handler must not be asked about a resolved approval"
    assert len(transport.writes) == 1, "no second approval/decide may reach the wire"


@pytest.mark.asyncio
async def test_a_redelivery_during_an_in_flight_decide_authors_no_second_decide() -> None:
    # The latch-before-first-await guard's own splitting arm: the handler
    # spans a loop yield, and the same stage folds again with NO await in
    # between. A latch moved past the first await lets both frames pass the
    # decided-stages check — two handler calls, two decide frames, the
    # double-decide the protocol forbids.
    transport, session, _minted = wired()
    calls = 0

    async def handler(_request: Any) -> ApprovalDecisionInput:
        nonlocal calls
        calls += 1
        await pump()
        return ApprovalDecisionInput(choice_id="allow_once")

    session.on_approval(handler)

    first = session.apply(approval_requested())
    second = session.apply(approval_requested())
    # Asserted BEFORE answering and awaiting the ios: under the latch-slipped
    # mutant a SECOND decide goes out, only the first is answered, and the io
    # gather would wait forever on a reply nobody sends — the arm must fail on
    # the extra WRITE, fast, not on a hang.
    await pump(40)
    assert len(transport.writes) == 1, "one stage authors one decide"
    assert calls == 1, "one stage asks the consumer once"
    answer(transport, 0, decide_result("mint-0"))
    await asyncio.gather(settled_io(first.io), settled_io(second.io))


# ---- the transcript arms ----------------------


def _transcript_lines(scenario: str) -> List[tuple[str, Params]]:
    lines: List[tuple[str, Params]] = []
    path = TRANSCRIPTS / scenario / "transcript.ndjson"
    for raw in path.read_text(encoding="utf-8").splitlines():
        if not raw:
            continue
        record = json.loads(raw)
        lines.append((str(record["dir"]), dict(json.loads(record["raw"]))))
    return lines


def _normalized_param_keys(scenario: str) -> List[str]:
    manifest = json.loads(
        (TRANSCRIPTS / scenario / "manifest.json").read_text(encoding="utf-8")
    )
    keys = [
        entry[len("params.") :]
        for entry in manifest["normalize"]
        if isinstance(entry, str) and entry.startswith("params.")
    ]
    assert "commandId" in keys, "sanity: the mint is per-run"
    return keys


def _strip(params: Params, normalized: List[str]) -> Params:
    return {key: value for key, value in params.items() if key not in normalized}


@pytest.mark.asyncio
async def test_the_approval_round_trip_transcript_drives_the_recorded_decide_back_out() -> None:
    # The charter names the transcripts as the vehicle, and hand-built params
    # are exactly the drift the transcript guards against. Fold the recorded
    # `approval/requested`, decide with the recorded choice, and require the
    # outbound `approval/decide` to match the recorded frame modulo the
    # manifest's normalize list — READ from manifest.json, never hand-copied.
    lines = _transcript_lines("approval-round-trip")
    normalized = _normalized_param_keys("approval-round-trip")
    requested = next(
        frame_
        for direction, frame_ in lines
        if direction == "server" and frame_.get("method") == "approval/requested"
    )
    recorded_decide = next(
        frame_
        for direction, frame_ in lines
        if direction == "client" and frame_.get("method") == "approval/decide"
    )
    requested_params = dict(requested["params"])
    recorded_params = dict(recorded_decide["params"])

    transport = FakeDuplex()
    connection = Connection(transport)
    session: Session[str] = Session(
        str(requested_params["sessionId"]),
        read_session_durability({"sessionDurability": "durable"}),
        connection=connection,
    )
    session.on_approval(
        lambda _r: ApprovalDecisionInput(choice_id=str(recorded_params["choiceId"]))
    )

    outcome = session.apply({"method": "approval/requested", "params": requested_params})
    await wait_for_writes(transport, 1)
    assert sent_frame(transport, 0)["method"] == "approval/decide"
    sent = sent_params(transport, 0)
    command_id = sent["commandId"]
    assert isinstance(command_id, str) and command_id
    assert _strip(sent, normalized) == _strip(recorded_params, normalized)

    answer(
        transport,
        0,
        {
            "approvalId": recorded_params["approvalId"],
            "commandId": command_id,
            "status": "accepted",
            "terminal": True,
        },
    )
    await settled_io(outcome.io)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("scenario", "decide_method"),
    [
        ("userinput-answer-round-trip", "userInput/answer"),
        ("userinput-cancel-round-trip", "userInput/cancel"),
    ],
)
async def test_the_user_input_transcripts_drive_the_recorded_decision_back_out(
    scenario: str, decide_method: str
) -> None:
    # The rule's user-input half, at TS parity: `userInput/request` is a
    # SERVER REQUEST answered `{}` (the dialog IN), the decision travels
    # separately as the recorded command (the dialog OUT), and the view
    # stream's `userInput/settled` is the authoritative settlement the fold
    # reports. The facade adds no second router here — the TS facade answers
    # through `Connection.command` and the fold's pending/settled surfaces,
    # and a Python-only handler type would be a drift surface with no oracle.
    lines = _transcript_lines(scenario)
    normalized = _normalized_param_keys(scenario)
    request = next(
        frame_
        for direction, frame_ in lines
        if direction == "server" and frame_.get("method") == "userInput/request"
    )
    recorded_decision = next(
        frame_
        for direction, frame_ in lines
        if direction == "client" and frame_.get("method") == decide_method
    )
    recorded_ack = next(
        frame_
        for direction, frame_ in lines
        if direction == "server"
        and frame_.get("id") == recorded_decision.get("id")
        and "result" in frame_
    )
    settled = next(
        frame_
        for direction, frame_ in lines
        if direction == "server" and frame_.get("method") == "userInput/settled"
    )
    request_params = dict(request["params"])
    session_id = str(request_params["sessionId"])

    transport = FakeDuplex()
    connection = Connection(transport)
    session: Session[str] = Session(
        session_id,
        read_session_durability({"sessionDurability": "durable"}),
        connection=connection,
    )

    # The dialog IN: the server request reaches the registered handler with
    # the recorded params, and is answered `{}` on its own id.
    asked: List[Params] = []

    async def on_request(frame_: Params) -> Params:
        asked.append(dict(frame_.get("params", {})))
        return {}

    connection.on_server_request(on_request)
    transport.chunks.push(
        json.dumps(request, ensure_ascii=False) + "\n"
    )
    await wait_for_writes(transport, 1)
    assert sent_frame(transport, 0) == {
        "jsonrpc": "2.0",
        "id": request["id"],
        "result": {},
    }
    assert asked == [request_params]
    # The prompt is a pending dialog from the fold's point of view: the
    # re-issue notification carries the same params.
    session.apply({"method": "userInput/requested", "params": request_params})
    assert [
        p["userInputId"] for p in session.fold.pending_user_inputs()
    ] == [request_params["userInputId"]]

    # The dialog OUT: the recorded decision, replayed through the public
    # command surface, reaches the wire byte-equal modulo the normalize list.
    decision_params = _strip(dict(recorded_decision["params"]), ["commandId"])
    pending = connection.command(decide_method, decision_params)
    await wait_for_writes(transport, 2)
    sent = sent_params(transport, 1)
    assert _strip(sent, normalized) == _strip(dict(recorded_decision["params"]), normalized)
    answer(
        transport,
        1,
        {**dict(recorded_ack["result"]), "commandId": sent["commandId"]},
    )
    ack = await pending
    assert ack["status"] == "accepted"
    assert ack["userInputId"] == request_params["userInputId"]

    # The authoritative settlement is the view stream's, never the ack.
    session.apply({"method": "userInput/settled", "params": dict(settled["params"])})
    assert session.fold.pending_user_inputs() == []
    assert [
        p["userInputId"] for p in session.fold.settled_user_inputs()
    ] == [request_params["userInputId"]]
