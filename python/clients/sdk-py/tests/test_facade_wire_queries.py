"""Port of ``clients/sdk-ts/test/facade-wire-queries.test.ts``.

The wire-present query and command facades on the public ``Session`` /
``MuseClient`` over the in-memory ``FakeDuplex``: ``task/list``,
``skill/list``, ``hook/list``, ``workflow/pause``, ``workflow/resume``,
``recap/request``, ``feedback/submit``, ``session/sideChat``, and
``session/list`` search, plus the fold ``messagePhase`` pin.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from muse_code import MuseClient, MuseClientOptions, Session, read_session_durability
from muse_code.connection import Connection

from helpers_connection import FakeDuplex, answer, sent_frame, sent_params, wait_for_writes

SESSION = "s-1"


def _durability() -> Any:
    return read_session_durability({"sessionDurability": "durable"})


def _wired_session() -> tuple[Session[Any], FakeDuplex]:
    transport = FakeDuplex()
    connection = Connection(transport)
    session: Session[Any] = Session(SESSION, _durability(), connection=connection)
    return session, transport


async def _exchange(transport: FakeDuplex, result: dict[str, Any]) -> dict[str, Any]:
    await wait_for_writes(transport, 1)
    sent = sent_frame(transport, 0)
    answer(transport, 0, result)
    return sent


@pytest.mark.asyncio
async def test_list_tasks_sends_task_list_for_this_session_and_returns_rows() -> None:
    session, transport = _wired_session()
    pending = asyncio.ensure_future(session.list_tasks())
    sent = await _exchange(
        transport,
        {"tasks": [{"taskId": "t-1", "kind": "tool", "status": "inProgress"}]},
    )
    assert sent["method"] == "task/list"
    assert sent_params(transport, 0)["sessionId"] == "s-1"
    result = await pending
    assert result["tasks"][0]["taskId"] == "t-1"


@pytest.mark.asyncio
async def test_list_skills_and_list_hooks_send_skill_list_and_hook_list() -> None:
    cases: list[tuple[Any, str, dict[str, Any]]] = [
        (lambda s: s.list_skills(), "skill/list", {"skills": []}),
        (lambda s: s.list_hooks(), "hook/list", {"hooks": []}),
    ]
    for call, method, result_payload in cases:
        session, transport = _wired_session()
        pending = asyncio.ensure_future(call(session))
        sent = await _exchange(transport, result_payload)
        assert sent["method"] == method
        await pending


@pytest.mark.asyncio
async def test_pause_workflow_resume_workflow_request_recap_submit_feedback_open_side_chat_send_their_wire_methods() -> (
    None
):
    cases: list[tuple[str, Any, dict[str, Any]]] = [
        (
            "workflow/pause",
            lambda s: s.pause_workflow("run-1"),
            {"commandId": "c", "status": "accepted"},
        ),
        (
            "workflow/resume",
            lambda s: s.resume_workflow("run-1"),
            {"commandId": "c", "status": "accepted", "turnId": "t-9"},
        ),
        (
            "recap/request",
            lambda s: s.request_recap(),
            {"commandId": "c", "status": "accepted"},
        ),
        (
            "feedback/submit",
            lambda s: s.submit_feedback(
                {"classification": "bug", "note": "n", "withFiles": False}
            ),
            {
                "bundlePath": "/b",
                "outcome": "recorded",
                "sessionRecordAttached": False,
                "sessionRecordTruncated": False,
            },
        ),
        (
            "session/sideChat",
            lambda s: s.open_side_chat(),
            {
                "session": {"sessionId": "side-1", "status": "idle"},
                "history": {"mode": "none", "items": []},
                "pendingRequests": [],
                "viewCursor": "v",
            },
        ),
    ]
    for method, call, result_payload in cases:
        session, transport = _wired_session()
        pending = asyncio.ensure_future(call(session))
        await wait_for_writes(transport, 1)
        sent = sent_frame(transport, 0)
        echoed = {**result_payload, "commandId": sent_params(transport, 0)["commandId"]}
        answer(transport, 0, echoed)
        assert sent["method"] == method
        assert sent_params(transport, 0)["sessionId"] == "s-1"
        await pending


@pytest.mark.asyncio
async def test_fold_only_session_refuses_wire_queries_without_a_connection() -> None:
    session: Session[Any] = Session(SESSION, _durability())
    with pytest.raises(RuntimeError, match="needs a connection"):
        await session.list_tasks()


@pytest.mark.asyncio
async def test_muse_client_list_sessions_sends_session_list_with_text_filter() -> None:
    transport = FakeDuplex()
    connection = Connection(transport)
    client: MuseClient[Any] = MuseClient(
        connection, MuseClientOptions(durability=_durability())
    )
    pending = asyncio.ensure_future(
        client.list_sessions(
            {"filter": {"text": {"allOf": ["check"], "fields": ["title"]}}}
        )
    )
    sent = await _exchange(transport, {"sessions": [], "nextCursor": None})
    assert sent["method"] == "session/list"
    assert sent_params(transport, 0)["filter"]["text"] == {
        "allOf": ["check"],
        "fields": ["title"],
    }
    assert await pending == {"sessions": [], "nextCursor": None}
    await client.close()


def test_fold_surfaces_agent_message_message_phase_verbatim() -> None:
    session: Session[Any] = Session(SESSION, _durability())

    def _item_event(
        item_id: str, kind: str, extra: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        extra = extra or {}
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

    session.apply(
        _item_event("m-1", "agentMessage", {"messagePhase": "commentary", "text": "working"})
    )
    session.apply(_item_event("tc-1", "toolCall"))
    session.apply(
        _item_event("m-2", "agentMessage", {"messagePhase": "finalAnswer", "text": "done"})
    )
    items = session.fold.items.list()
    commentary = next(i for i in items if i["itemId"] == "m-1")
    assert commentary["messagePhase"] == "commentary"
