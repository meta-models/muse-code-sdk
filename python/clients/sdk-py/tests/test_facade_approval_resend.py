"""An approval still pending when a session is resumed is re-sent as an
``approval/request`` server request. The client that owns the connection routes
it to its session's approval routing and answers with the empty receipt ``{}``.
The resume options' ``on_approval`` handler is installed before the frames held
during the open are applied, so it receives a re-send that arrives with the
resume reply.

Port of ``clients/sdk-ts/test/facade-approval-resend.test.ts``. Causal, never
time-based: every wait is a bounded loop-turn pump.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from muse_code import (
    ApprovalDecisionInput,
    ApprovalFailure,
    MuseClient,
    MuseClientOptions,
    ResumeSessionOptions,
    Session,
    read_session_durability,
)
from muse_code.connection import Connection
from muse_code.fold import IgnoredMissingParams, IgnoredUnrecognizedMethod
from muse_code.facade.session import SessionGapBuffered, SessionGapOverlap

from helpers_connection import FakeDuplex, answer, frame, pump, sent_frame, wait_for_writes

Params = dict[str, Any]

SESSION = "s-9"
SOURCE: Params = {
    "first": {"recordIndex": 0, "streamOffset": 0},
    "last": {"recordIndex": 0, "streamOffset": 0},
    "stream": {"kind": "run", "runId": "r-1"},
}


def _approval(view_cursor: str) -> Params:
    return {
        "approvalId": "a-1",
        "availableChoices": [
            {"choiceId": "allow_once", "decision": "approved", "label": "Allow once", "scope": "once"},
            {"choiceId": "deny", "decision": "denied", "label": "Deny", "scope": "once"},
        ],
        "currentRequirementId": {"approvalId": "a-1", "sourceIndex": 0},
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
        "viewCursor": view_cursor,
    }


def _resend(view_cursor: str) -> str:
    return frame(
        {"jsonrpc": "2.0", "id": 7, "method": "approval/request", "params": _approval(view_cursor)}
    )


def _frames(transport: FakeDuplex) -> list[Params]:
    return [json.loads(line) for line in transport.writes]


def _decides(transport: FakeDuplex) -> list[Params]:
    return [sent for sent in _frames(transport) if sent.get("method") == "approval/decide"]


async def _resume(
    options: ResumeSessionOptions, same_chunk: str
) -> "tuple[MuseClient[Any], Session[Any], FakeDuplex]":
    transport = FakeDuplex()
    client: MuseClient[Any] = MuseClient(
        Connection(transport),
        MuseClientOptions(
            durability=read_session_durability({"sessionDurability": "durable"})
        ),
    )
    pending = asyncio.ensure_future(client.resume_session(options))
    await wait_for_writes(transport, 1)
    ack = frame(
        {
            "jsonrpc": "2.0",
            "id": sent_frame(transport, 0)["id"],
            "result": {
                "session": {"sessionId": SESSION, "status": "idle"},
                "history": {"mode": "none", "items": []},
                "pendingRequests": [],
                "viewCursor": "cursor-1",
            },
        }
    )
    transport.chunks.push(ack + same_chunk)
    return client, await pending, transport


def _handler(seen: list[Params]) -> Any:
    async def handler(request: Params) -> ApprovalDecisionInput:
        seen.append(request)
        return ApprovalDecisionInput(choice_id="deny")

    return handler


@pytest.mark.asyncio
async def test_resent_approval_read_with_the_resume_reply_reaches_the_resume_handler() -> None:
    seen: list[Params] = []
    # The host re-sends the params it folded, so the request keeps the
    # approval's own cursor, behind the resume cursor.
    client, _session, transport = await _resume(
        ResumeSessionOptions(session_id=SESSION, on_approval=_handler(seen)),
        _resend("cursor-0"),
    )
    await wait_for_writes(transport, 3)

    resume_params = dict(sent_frame(transport, 0)["params"])
    resume_params.pop("commandId", None)
    assert resume_params == {"sessionId": SESSION}, "on_approval is never sent"
    assert any(
        sent.get("id") == 7 and sent.get("result") == {} for sent in _frames(transport)
    ), "the re-sent request gets the {} receipt"
    assert len(seen) == 1
    (decide,) = _decides(transport)
    assert decide["params"]["approvalId"] == "a-1"
    assert decide["params"]["choiceId"] == "deny"
    await client.close()


@pytest.mark.asyncio
async def test_with_no_handler_a_resent_approval_is_receipted_and_authors_nothing() -> None:
    client, _session, transport = await _resume(
        ResumeSessionOptions(session_id=SESSION), _resend("cursor-0")
    )
    await wait_for_writes(transport, 2)
    await pump()

    assert sent_frame(transport, 1) == {"jsonrpc": "2.0", "id": 7, "result": {}}
    assert len(transport.writes) == 2, "no approval/decide without a handler"
    await client.close()


@pytest.mark.asyncio
async def test_a_resent_approval_the_session_saw_resolved_authors_nothing() -> None:
    seen: list[Params] = []
    resolved = frame(
        {
            "jsonrpc": "2.0",
            "method": "approval/resolved",
            "params": {
                "approvalId": "a-1",
                "decision": "approved",
                "itemId": "i-1",
                "policyResult": "allow",
                "resolvedBy": "user",
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "stageEvidence": [],
                "turnId": "turn-1",
                "viewCursor": "cursor-2",
            },
        }
    )
    client, _session, transport = await _resume(
        ResumeSessionOptions(session_id=SESSION, on_approval=_handler(seen)),
        resolved + _resend("cursor-0"),
    )
    await wait_for_writes(transport, 2)
    await pump()

    assert sent_frame(transport, 1) == {"jsonrpc": "2.0", "id": 7, "result": {}}
    assert seen == []
    assert _decides(transport) == []
    await client.close()


@pytest.mark.asyncio
async def test_the_notification_and_the_resent_request_for_one_stage_ask_once() -> None:
    seen: list[Params] = []
    notification = frame(
        {"jsonrpc": "2.0", "method": "approval/requested", "params": _approval("cursor-2")}
    )
    client, _session, transport = await _resume(
        ResumeSessionOptions(session_id=SESSION, on_approval=_handler(seen)),
        notification + _resend("cursor-2"),
    )
    await wait_for_writes(transport, 3)
    await pump()

    assert len(seen) == 1
    assert len(_decides(transport)) == 1
    await client.close()


@pytest.mark.asyncio
async def test_resume_handler_receives_an_approval_requested_read_with_the_reply() -> None:
    seen: list[Params] = []
    # A notification is routed synchronously, so it is always held while the
    # resume is in flight: this pins the handler's install before held frames.
    notification = frame(
        {"jsonrpc": "2.0", "method": "approval/requested", "params": _approval("cursor-2")}
    )
    client, _session, transport = await _resume(
        ResumeSessionOptions(session_id=SESSION, on_approval=_handler(seen)), notification
    )
    await wait_for_writes(transport, 2)

    assert len(seen) == 1
    assert len(_decides(transport)) == 1
    await client.close()


@pytest.mark.asyncio
async def test_a_malformed_resent_approval_read_with_the_reply_is_dropped() -> None:
    seen: list[Params] = []
    malformed = _approval("cursor-0")
    del malformed["currentRequirementId"]
    client, session, transport = await _resume(
        ResumeSessionOptions(session_id=SESSION, on_approval=_handler(seen)),
        frame({"jsonrpc": "2.0", "id": 7, "method": "approval/request", "params": malformed}),
    )
    await wait_for_writes(transport, 2)
    await pump()

    assert session.session_id == SESSION, "resume_session returned"
    assert sent_frame(transport, 1) == {"jsonrpc": "2.0", "id": 7, "result": {}}
    assert seen == []
    await client.close()


@pytest.mark.asyncio
async def test_a_resent_approval_naming_an_unknown_session_still_gets_the_receipt() -> None:
    seen: list[Params] = []
    client, _session, transport = await _resume(
        ResumeSessionOptions(session_id=SESSION, on_approval=_handler(seen)), ""
    )
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 8,
                "method": "approval/request",
                "params": {**_approval("cursor-0"), "sessionId": "s-other"},
            }
        )
    )
    await wait_for_writes(transport, 2)
    await pump()

    assert sent_frame(transport, 1) == {"jsonrpc": "2.0", "id": 8, "result": {}}
    assert seen == []
    await client.close()


@pytest.mark.asyncio
async def test_a_request_resolved_in_the_same_read_authors_nothing() -> None:
    # Python's handler task runs after the approval/resolved read with it, so
    # the resolved check skips the request (TypeScript routes it in arrival
    # order instead).
    seen: list[Params] = []
    client, _session, transport = await _resume(
        ResumeSessionOptions(session_id=SESSION, on_approval=_handler(seen)), ""
    )
    resolved = frame(
        {
            "jsonrpc": "2.0",
            "method": "approval/resolved",
            "params": {
                "approvalId": "a-1",
                "decision": "approved",
                "itemId": "i-1",
                "policyResult": "allow",
                "resolvedBy": "user",
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "stageEvidence": [],
                "turnId": "turn-1",
                "viewCursor": "cursor-2",
            },
        }
    )
    transport.chunks.push(_resend("cursor-0") + resolved)
    await wait_for_writes(transport, 2)
    await pump()

    assert sent_frame(transport, 1) == {"jsonrpc": "2.0", "id": 7, "result": {}}
    assert seen == []
    assert _decides(transport) == []
    await client.close()


def _raises(_request: Params) -> ApprovalDecisionInput:
    raise RuntimeError("boom")


def _unoffered(_request: Params) -> ApprovalDecisionInput:
    return ApprovalDecisionInput(choice_id="not-offered")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("handler", "kind"), [(_raises, "HandlerRaised"), (_unoffered, "UnofferedChoice")]
)
@pytest.mark.parametrize("eager", [False, True])
async def test_a_resume_on_approval_error_hears_a_held_approvals_handler_failure(
    handler: Any, kind: str, eager: bool
) -> None:
    # The observer rides in the resume options too, so it is installed before
    # the held frames whatever task the caller registers from. Under eager
    # tasks the handler runs inside the held frame's apply, so only that
    # install order lets the observer hear it.
    loop = asyncio.get_running_loop()
    if eager:
        factory = getattr(asyncio, "eager_task_factory", None)
        if factory is None:
            pytest.skip("asyncio.eager_task_factory needs Python 3.12")
        loop.set_task_factory(factory)
    try:
        failures: list[ApprovalFailure] = []
        client, _session, transport = await _resume(
            ResumeSessionOptions(
                session_id=SESSION, on_approval=handler, on_approval_error=failures.append
            ),
            _resend("cursor-0"),
        )
        await wait_for_writes(transport, 2)
        await pump()

        assert [type(failure).__name__ for failure in failures] == [kind]
        resume_params = dict(sent_frame(transport, 0)["params"])
        resume_params.pop("commandId", None)
        assert resume_params == {"sessionId": SESSION}, "neither handler is sent"
        await client.close()
    finally:
        loop.set_task_factory(None)


@pytest.mark.asyncio
@pytest.mark.parametrize("during_fill", [False, True])
async def test_a_resent_request_around_a_gap_fill_leaves_the_overlap_slot_to_its_twin(
    during_fill: bool,
) -> None:
    # A fill pages ``approval/requested@v:3`` and a stage-advancing
    # ``approval/updated@v:4``. The request shares its notification's cursor
    # and rides its own presenter lane, so it can land before the late twin,
    # while the fill runs (buffered, then drained) or after it.
    transport = FakeDuplex()
    session: Session[Any] = Session(
        SESSION,
        read_session_durability({"sessionDurability": "durable"}),
        connection=Connection(transport),
    )
    update: Params = {
        "approvalId": "a-1",
        "availableChoices": [
            {"choiceId": "deny", "decision": "denied", "label": "Deny", "scope": "once"}
        ],
        "change": {
            "choiceId": "allow_once",
            "decision": "approved",
            "kind": "stageResolved",
            "requirementId": {"approvalId": "a-1", "sourceIndex": 0},
        },
        "currentRequirementId": {"approvalId": "a-1", "sourceIndex": 1},
        "sessionId": SESSION,
        "sourceRange": SOURCE,
        "subject": {"kind": "shell", "command": "ls"},
        "viewCursor": "v:4",
    }
    gap = session.apply(
        {"method": "view/gap", "params": {"after": "v:1", "next": "v:3", "sessionId": SESSION}}
    )
    request: Params = {"method": "approval/request", "params": _approval("v:3")}
    await wait_for_writes(transport, 1)
    if during_fill:
        assert isinstance(session.apply(request).fold, SessionGapBuffered)
    answer(
        transport,
        0,
        {
            "events": [
                {"method": "approval/requested", "params": _approval("v:3")},
                {"method": "approval/updated", "params": update},
            ],
            "nextCursor": "v:4",
        },
    )
    await gap.io
    if not during_fill:
        session.apply(request)
    twin = session.apply({"method": "approval/requested", "params": _approval("v:3")})

    assert twin.fold == SessionGapOverlap(method="approval/requested", view_cursor="v:3")
    (pending,) = session.fold.pending_approvals()
    assert pending.latest_update is not None, "the stage advance is kept"
    assert pending.latest_update["viewCursor"] == "v:4"


def _malformed() -> list[tuple[str, Any]]:
    no_choices = _approval("cursor-0")
    del no_choices["availableChoices"]
    return [
        ("null params", None),
        ("list params", []),
        ("string params", "nope"),
        ("a non-string approvalId", {**_approval("cursor-0"), "approvalId": 7}),
        ("a null currentRequirementId", {**_approval("cursor-0"), "currentRequirementId": None}),
        ("an empty currentRequirementId", {**_approval("cursor-0"), "currentRequirementId": {}}),
        (
            "a requirement with no approvalId",
            {**_approval("cursor-0"), "currentRequirementId": {"sourceIndex": 0}},
        ),
        (
            "a string sourceIndex",
            {
                **_approval("cursor-0"),
                "currentRequirementId": {"approvalId": "a-1", "sourceIndex": "0"},
            },
        ),
        (
            "a boolean sourceIndex",
            {
                **_approval("cursor-0"),
                "currentRequirementId": {"approvalId": "a-1", "sourceIndex": True},
            },
        ),
        (
            "a fractional sourceIndex",
            {
                **_approval("cursor-0"),
                "currentRequirementId": {"approvalId": "a-1", "sourceIndex": 1.5},
            },
        ),
        ("no availableChoices", no_choices),
        (
            "a choice with no choiceId",
            {**_approval("cursor-0"), "availableChoices": [{"decision": "denied"}]},
        ),
        ("a null choice", {**_approval("cursor-0"), "availableChoices": [None]}),
    ]


def _fold_only(failures: list[ApprovalFailure]) -> Session[Any]:
    session: Session[Any] = Session(
        SESSION, read_session_durability({"sessionDurability": "durable"})
    )

    async def handler(request: Params) -> ApprovalDecisionInput:
        return ApprovalDecisionInput(choice_id="deny")

    session.on_approval(handler)
    session.on_approval_error(failures.append)
    return session


@pytest.mark.asyncio
async def test_apply_drops_an_approval_request_missing_a_member_the_router_reads() -> None:
    cases: list[tuple[str, dict[str, Any]]] = [("no params", {"method": "approval/request"})]
    cases += [(name, {"method": "approval/request", "params": params}) for name, params in _malformed()]
    for name, event in cases:
        failures: list[ApprovalFailure] = []
        outcome = _fold_only(failures).apply(event)
        await outcome.io
        await pump()

        # A request with no params dict reports what every such frame does;
        # one with params is the sanctioned interim verdict.
        expected = (
            IgnoredUnrecognizedMethod
            if isinstance(event.get("params"), dict)
            else IgnoredMissingParams
        )
        assert isinstance(outcome.fold, expected), name
        assert failures == [], name

    # A well-formed request reaches the router, which refuses it on this
    # fold-only session before asking: each row above is dropped by its own
    # member.
    failures = []
    outcome = _fold_only(failures).apply(
        {"method": "approval/request", "params": _approval("cursor-0")}
    )
    await outcome.io
    await pump()
    assert isinstance(outcome.fold, IgnoredUnrecognizedMethod)
    assert [type(failure).__name__ for failure in failures] == ["SubmitFailed"]
