"""PY-TEST-026 ``asyncio_cancellation_is_nondestructive`` — spec 638
INV-638-04 carrying spec 14990 INV-006, at the Edge Cases' cancellation arms
(T035, moved from S1 on PR #29277 review — the awaited surfaces are S3's).

Cancelling a task awaiting ``turn.completed`` or an iterator MUST NOT corrupt
the fold or the connection; the wait detaches, state keeps folding.
Cancellation is a consumer-side act — it never fabricates a terminal.
"""

from __future__ import annotations

import asyncio
from typing import Any, List

import pytest

from muse_code import (
    SendUserTurnOptions,
    Session,
    read_session_durability,
)
from muse_code.connection import Connection

from helpers_connection import (
    FakeDuplex,
    answer,
    pump,
    sent_frame,
    wait_for_writes,
)

Params = dict[str, Any]

SESSION = "s-1"
SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}


def fold_only() -> "Session[str]":
    return Session(SESSION, read_session_durability({"sessionDurability": "durable"}))


def turn_started(turn_id: str, view_cursor: str) -> Params:
    return {
        "method": "turn/started",
        "params": {
            "commandId": turn_id,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "turnId": turn_id,
            "viewCursor": view_cursor,
        },
    }


def turn_completed(turn_id: str, view_cursor: str) -> Params:
    return {
        "method": "turn/completed",
        "params": {
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "terminal": "completed",
            "turnId": turn_id,
            "viewCursor": view_cursor,
        },
    }


def item_started(item_id: str, turn_id: str, revision: int, view_cursor: str) -> Params:
    return {
        "method": "item/started",
        "params": {
            "item": {
                "itemId": item_id,
                "kind": "agentMessage",
                "revision": revision,
                "sessionId": SESSION,
                "status": "inProgress",
                "text": "",
                "turnId": turn_id,
            },
            "sessionId": SESSION,
            "viewCursor": view_cursor,
        },
    }


async def cancelled(task: "asyncio.Task[Any]") -> None:
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


@pytest.mark.asyncio
async def test_cancelling_a_turn_wait_fabricates_no_terminal_and_detaches() -> None:
    s = fold_only()
    turn = s.turn("t-1")
    s.apply(turn_started("t-1", "v:1"))

    waiter = asyncio.ensure_future(turn.completed)
    await pump()
    await cancelled(waiter)

    # No terminal was fabricated: a fresh wait is still PENDING, not settled.
    fresh = asyncio.ensure_future(turn.completed)
    await pump()
    assert not fresh.done(), "cancellation must not settle the turn"

    # State keeps folding, and the real server-authored terminal wins.
    s.apply(item_started("i-1", "t-1", 1, "v:2"))
    s.apply(turn_completed("t-1", "v:3"))
    outcome = await fresh
    assert outcome.kind == "completed"
    held = s.fold.items.get("i-1")
    assert held is not None, "the fold kept folding after the cancel"


@pytest.mark.asyncio
async def test_cancelling_an_items_iterator_wait_loses_no_later_item() -> None:
    s = fold_only()
    turn = s.turn("t-1")
    s.apply(turn_started("t-1", "v:1"))
    stream = turn.items()

    pending = asyncio.ensure_future(stream.__anext__())
    await pump()
    await cancelled(pending)

    # An item folding AFTER the cancel is buffered for the stream, not lost
    # to the dead waiter.
    s.apply(item_started("i-1", "t-1", 1, "v:2"))
    fresh = asyncio.ensure_future(stream.__anext__())
    first = await fresh
    assert first["itemId"] == "i-1"

    # The stream still ends on the real terminal.
    s.apply(turn_completed("t-1", "v:3"))
    with pytest.raises(StopAsyncIteration):
        await stream.__anext__()


@pytest.mark.asyncio
async def test_cancelling_a_deltas_iterator_keeps_the_fold_accumulating() -> None:
    s = fold_only()
    turn = s.turn("t-1")
    s.apply(turn_started("t-1", "v:1"))
    s.apply(item_started("i-1", "t-1", 1, "v:2"))
    stream = turn.deltas()
    pending = asyncio.ensure_future(stream.__anext__())
    await pump()
    await cancelled(pending)

    # The fold's accumulated delta text is unaffected by the consumer-side
    # cancel (the store keeps the per-field accumulator, INV-004).
    s.apply(
        {
            "method": "item/delta",
            "params": {
                "delta": "hello",
                "field": "text",
                "itemId": "i-1",
                "sessionId": SESSION,
                "viewCursor": "v:3",
            },
        }
    )
    assert s.fold.items.accumulated("i-1") == "hello"
    # And the delta that folded after the cancel is still delivered to the
    # stream's next consumer.
    delta = await stream.__anext__()
    assert delta["delta"] == "hello"
    s.apply(turn_completed("t-1", "v:4"))


@pytest.mark.asyncio
async def test_cancelling_a_wait_on_a_wired_session_leaves_the_connection_alive() -> None:
    transport = FakeDuplex()
    connection = Connection(transport, mint_command_id=lambda: "mint-0")
    s: Session[str] = Session(
        SESSION,
        read_session_durability({"sessionDurability": "durable"}),
        connection=connection,
    )
    submit = asyncio.ensure_future(
        s.send_user_turn(
            SendUserTurnOptions(input=[{"text": "hi", "type": "text"}], composer_input="hi")
        )
    )
    await wait_for_writes(transport, 1)
    answer(
        transport,
        0,
        {
            "commandId": "mint-0",
            "disposition": "started",
            "startedNewTurn": True,
            "status": "accepted",
            "turnId": "t-1",
        },
    )
    turn = await submit

    waiter = asyncio.ensure_future(turn.completed)
    await pump()
    await cancelled(waiter)

    # The connection is not corrupted: a later request round-trips, and the
    # pending set was not touched by the consumer-side cancel.
    probe = connection.request("session/userShell", {"sessionId": SESSION})
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "session/userShell"
    answer(transport, 1, {"ok": True})
    assert await probe == {"ok": True}

    # The real terminal still settles a fresh wait.
    s.apply(turn_completed("t-1", "v:2"))
    outcome = await turn.completed
    assert outcome.kind == "completed"
    await connection.close()


@pytest.mark.asyncio
async def test_a_cancelled_iterator_via_aclosing_deregisters_without_settling_the_turn() -> None:
    # The `contextlib.aclosing` path the iterator docstring names: breaking
    # out deregisters the stream, and the turn itself stays unsettled — no
    # invented completion (INV-638-04 carrying INV-006).
    from contextlib import aclosing

    s = fold_only()
    turn = s.turn("t-1")
    s.apply(turn_started("t-1", "v:1"))
    s.apply(item_started("i-1", "t-1", 1, "v:2"))

    async with aclosing(turn.items()) as stream:
        async for held in stream:
            assert held["itemId"] == "i-1"
            break

    # Reaches the concrete handle deliberately: live_stream_count is
    # test-only observability, and without this the arm's "deregisters" claim
    # holds nothing (PR #32315 review round 5).
    assert turn.live_stream_count == 0, (  # type: ignore[attr-defined]
        "aclosing must deregister the stream"
    )

    fresh = asyncio.ensure_future(turn.completed)
    await pump()
    assert not fresh.done(), "closing an iterator must not settle the turn"
    s.apply(turn_completed("t-1", "v:3"))
    assert (await fresh).kind == "completed"
