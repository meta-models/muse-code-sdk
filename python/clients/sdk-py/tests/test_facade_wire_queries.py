"""Wire-present facade helpers: session queries and commands the host already
serves (`task/list`, `skill/list`, `hook/list`, `workflow/pause`,
`workflow/resume`, `recap/request`, `feedback/submit`, `session/sideChat`,
`session/list`) reached through typed `Session`/`MuseClient` verbs.

Port of ``clients/sdk-ts/test/facade-wire-queries.test.ts``. Causal, never
time-based: every wait is a bounded loop-turn pump.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from muse_code import (
    MuseClient,
    MuseClientOptions,
    MuseSessionDiscardedError,
    Session,
    SyncMuseClient,
    read_session_durability,
)
from muse_code.connection import Connection
from muse_code.connection.spawn import ExitClassification
from muse_code.facade.client import LIST_FORWARDED
from muse_code_msp import SessionListParams

from helpers_connection import (
    AsyncChunks,
    FakeDuplex,
    answer,
    frame,
    pump,
    sent_frame,
    sent_params,
    wait_for_writes,
)

Params = dict[str, Any]

DURABLE = read_session_durability({"sessionDurability": "durable"})


def _wired_session() -> "tuple[Session[Any], FakeDuplex]":
    transport = FakeDuplex()
    session: Session[Any] = Session("s-1", DURABLE, connection=Connection(transport))
    return session, transport


@pytest.mark.asyncio
async def test_list_tasks_sends_task_list_for_this_session_and_returns_rows() -> None:
    session, transport = _wired_session()
    pending = asyncio.ensure_future(session.list_tasks())
    await wait_for_writes(transport, 1)
    assert sent_frame(transport, 0)["method"] == "task/list"
    assert sent_params(transport, 0)["sessionId"] == "s-1"
    assert "commandId" not in sent_params(transport, 0), "a read-only list mints no commandId"
    answer(
        transport,
        0,
        {"tasks": [{"taskId": "t-1", "kind": "tool", "status": "inProgress"}]},
    )
    assert (await pending)["tasks"][0]["taskId"] == "t-1"


@pytest.mark.asyncio
async def test_list_skills_and_list_hooks_send_skill_list_and_hook_list() -> None:
    for call, method, result in [
        (Session.list_skills, "skill/list", {"skills": []}),
        (Session.list_hooks, "hook/list", {"hooks": []}),
    ]:
        session, transport = _wired_session()
        pending = asyncio.ensure_future(call(session))
        await wait_for_writes(transport, 1)
        assert sent_frame(transport, 0)["method"] == method
        assert sent_params(transport, 0) == {"sessionId": "s-1"}, (
            f"{method} sends only this session's id: a read-only list mints no commandId")
        answer(transport, 0, result)
        await pending


@pytest.mark.asyncio
async def test_pause_resume_recap_feedback_side_chat_send_full_params_and_resolve_acks() -> None:
    # The last member says whether the verb rides ``command()`` and so mints a
    # ``commandId``; ``feedback/submit`` defines none, so it rides ``request()``.
    cases: list[tuple[str, Any, Params, Params, str, Any, bool]] = [
        (
            "workflow/pause",
            lambda s: s.pause_workflow("run-1"),
            {"sessionId": "s-1", "workflowRunId": "run-1"},
            {"status": "accepted"},
            "status",
            "accepted",
            True,
        ),
        (
            "workflow/resume",
            lambda s: s.resume_workflow("run-1"),
            {"sessionId": "s-1", "workflowRunId": "run-1"},
            {"status": "accepted", "turnId": "t-9"},
            "turnId",
            "t-9",
            True,
        ),
        (
            "recap/request",
            lambda s: s.request_recap(),
            {"sessionId": "s-1"},
            {"status": "accepted"},
            "status",
            "accepted",
            True,
        ),
        (
            "feedback/submit",
            lambda s: s.submit_feedback(
                {"classification": "bug", "note": "n", "withFiles": False}
            ),
            {
                "classification": "bug",
                "note": "n",
                "withFiles": False,
                "sessionId": "s-1",
            },
            {
                "bundlePath": "/b",
                "outcome": "recorded",
                "sessionRecordAttached": False,
                "sessionRecordTruncated": False,
            },
            "bundlePath",
            "/b",
            False,
        ),
        (
            "session/sideChat",
            lambda s: s.open_side_chat(),
            {"sessionId": "s-1"},
            {
                "session": {"sessionId": "side-1", "status": "idle"},
                "history": {"mode": "none", "items": []},
                "pendingRequests": [],
                "viewCursor": "v",
            },
            "viewCursor",
            "v",
            True,
        ),
    ]
    for method, call, params, result, ack_field, ack_value, mints in cases:
        session, transport = _wired_session()
        pending = asyncio.ensure_future(call(session))
        await wait_for_writes(transport, 1)
        assert sent_frame(transport, 0)["method"] == method
        sent = dict(sent_params(transport, 0))
        echoed = dict(result)
        if mints:
            command_id = sent.pop("commandId", None)
            assert isinstance(command_id, str) and command_id, f"{method} mints a non-empty commandId"
            echoed["commandId"] = command_id
        else:
            assert "commandId" not in sent, f"{method} mints no commandId: its wire params define none"
        assert sent == params, f"{method} sends the full params"
        answer(transport, 0, echoed)
        assert (await pending)[ack_field] == ack_value, f"{method} resolves its ack"


@pytest.mark.asyncio
async def test_fold_only_session_refuses_wire_queries_without_a_connection() -> None:
    session: Session[Any] = Session("s-1", DURABLE)
    with pytest.raises(Exception, match="needs a connection"):
        await session.list_tasks()

    # The refusal refuses only the send: local folding stays usable.
    session.apply(
        {
            "method": "item/completed",
            "params": {
                "sessionId": "s-1",
                "turnId": "turn-1",
                "item": {
                    "itemId": "m-1",
                    "kind": "agentMessage",
                    "revision": 1,
                    "status": "completed",
                    "text": "kept",
                },
            },
        }
    )
    assert session.fold.items.get("m-1") is not None


@pytest.mark.asyncio
async def test_client_list_sessions_forwards_every_option_and_resolves() -> None:
    transport = FakeDuplex()
    client: MuseClient[Any] = MuseClient(
        Connection(transport), MuseClientOptions(durability=DURABLE)
    )
    options: Params = {
        "cursor": "cur-1",
        "filter": {"text": {"allOf": ["check"], "fields": ["title"]}},
        "limit": 5,
        "updatedAfter": "2026-01-01T00:00:00Z",
        "workspaceRoot": "/repo",
    }
    pending = asyncio.ensure_future(client.list_sessions(options))  # type: ignore[arg-type]
    await wait_for_writes(transport, 1)
    assert sent_frame(transport, 0)["method"] == "session/list"
    assert "commandId" not in sent_params(transport, 0)
    assert sent_params(transport, 0) == options
    answer(transport, 0, {"sessions": [], "nextCursor": None})
    assert await pending == {"sessions": [], "nextCursor": None}


@pytest.mark.asyncio
async def test_discarded_session_refuses_wire_verbs_before_sending() -> None:
    transport = FakeDuplex()
    session: Session[Any] = Session(
        "s-9",
        read_session_durability({"sessionDurability": "ephemeral"}),
        connection=Connection(transport),
    )
    crash = ExitClassification(
        kind="crash",
        exit_code=77,
        exit_signal=None,
        stderr_tail=("thread 'main' panicked",),
    )
    assert session.host_exited(crash).kind == "discharged"

    listing = asyncio.ensure_future(session.list_tasks())
    pausing = asyncio.ensure_future(session.pause_workflow("run-1"))
    await pump()
    assert transport.writes == []
    with pytest.raises(MuseSessionDiscardedError):
        await listing
    with pytest.raises(MuseSessionDiscardedError):
        await pausing


def test_list_forwarded_covers_every_generated_member() -> None:
    assert set(LIST_FORWARDED) == set(SessionListParams.__annotations__)


class _AutoHost:
    """Answers each request from inside ``write`` (the sync loop is parked
    in the blocking verb, so frames cannot be fed from outside)."""

    def __init__(self) -> None:
        self.chunks = AsyncChunks()
        self.writes: list[str] = []

    @property
    def incoming(self) -> Any:
        return self.chunks

    async def write(self, chunk: str) -> None:
        self.writes.append(chunk)
        import json

        sent = json.loads(chunk)
        method = sent.get("method")
        results: dict[str, Params] = {
            "session/start": {
                "session": {"sessionId": "s-1", "status": "idle", "turnCount": 0},
                "viewCursor": "v:0",
            },
            "task/list": {"tasks": [{"taskId": "t-1"}]},
            "skill/list": {"skills": [{"name": "review"}]},
            "hook/list": {"hooks": [{"event": "preToolUse"}]},
            "workflow/pause": {"status": "accepted"},
            "workflow/resume": {"status": "accepted", "turnId": "t-9"},
            "recap/request": {"status": "accepted"},
            "feedback/submit": {
                "bundlePath": "/b",
                "outcome": "recorded",
                "sessionRecordAttached": False,
                "sessionRecordTruncated": False,
            },
            "session/sideChat": {
                "session": {"sessionId": "side-1", "status": "idle"},
                "history": {"mode": "none", "items": []},
                "pendingRequests": [],
                "viewCursor": "v",
            },
            "session/list": {"sessions": [], "nextCursor": None},
        }
        if method in results:
            result = dict(results[method])
            params = sent.get("params") or {}
            if "commandId" in params:
                result["commandId"] = params["commandId"]
            self.chunks.push(
                frame({"jsonrpc": "2.0", "id": sent["id"], "result": result})
            )

    async def close(self, flushed: object = None) -> None:
        if flushed is not None and hasattr(flushed, "__await__"):
            await flushed  # type: ignore[arg-type]
        self.chunks.end()


def test_sync_twins_run_the_wire_verbs() -> None:
    host = _AutoHost()

    async def factory() -> MuseClient[Any]:
        return MuseClient(
            Connection(host), MuseClientOptions(durability=DURABLE)  # type: ignore[arg-type]
        )

    client: SyncMuseClient[Any] = SyncMuseClient.create(factory)
    session = client.start_session()
    # All nine blocking twins, each delegating to its own async verb: the ack
    # field read below belongs to that verb's method alone.
    assert session.list_tasks()["tasks"][0]["taskId"] == "t-1"
    assert session.list_skills()["skills"][0]["name"] == "review"
    assert session.list_hooks()["hooks"][0]["event"] == "preToolUse"
    assert session.pause_workflow("run-1")["status"] == "accepted"
    assert session.resume_workflow("run-1")["turnId"] == "t-9"
    assert session.request_recap()["status"] == "accepted"
    feedback = session.submit_feedback(
        {"classification": "bug", "note": "n", "withFiles": False}
    )
    assert feedback["bundlePath"] == "/b"
    assert session.open_side_chat()["viewCursor"] == "v"
    assert client.list_sessions() == {"sessions": [], "nextCursor": None}
    methods = [json.loads(chunk)["method"] for chunk in host.writes]
    assert methods == [
        "session/start",
        "task/list",
        "skill/list",
        "hook/list",
        "workflow/pause",
        "workflow/resume",
        "recap/request",
        "feedback/submit",
        "session/sideChat",
        "session/list",
    ], "each twin sends its own method, once, in call order"
    client.close()


def test_fold_surfaces_agent_message_message_phase_verbatim() -> None:
    session: Session[Any] = Session("s-1", DURABLE)

    def item(item_id: str, kind: str, **extra: Any) -> Params:
        return {
            "method": "item/completed",
            "params": {
                "sessionId": "s-1",
                "turnId": "turn-1",
                "item": {
                    "itemId": item_id,
                    "kind": kind,
                    "revision": 1,
                    "status": "completed",
                    **extra,
                },
            },
        }

    session.apply(item("m-1", "agentMessage", messagePhase="commentary", text="working"))
    session.apply(item("tc-1", "toolCall"))
    session.apply(item("m-2", "agentMessage", messagePhase="finalAnswer", text="done"))
    commentary = session.fold.items.get("m-1")
    assert commentary is not None
    assert commentary["messagePhase"] == "commentary"
