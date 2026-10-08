"""View events that arrive in the same read chunk as the ``session/resume`` /
``session/start`` acknowledgement reach the ``Session``.

The host flushes the resume catch-up replay BEFORE the result, and a transport
hands over whatever is buffered as one chunk, so the frames a late-joiner needs
most routinely parse in the same ``_ingest`` pass as the acknowledgement that
names the session. ``MuseClient._route`` dropped a frame for a session not yet
in ``_sessions``, and the ``Session`` was registered only after the awaited
command returned — one loop turn too late. The fold then showed no turn, no
items and no gap, and reported current.

Port of ``clients/sdk-ts/test/facade-client-open-chunk.test.ts``. Causal,
never time-based: every wait is a bounded loop-turn pump.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from muse_code import (
    MuseClient,
    MuseClientOptions,
    ResumeSessionOptions,
    Session,
    StartSessionOptions,
    read_session_durability,
)
from muse_code.connection import Connection, MspError

from helpers_connection import FakeDuplex, frame, pump, sent_frame, wait_for_writes

Params = dict[str, Any]

SESSION = "s-1"
OTHER = "s-other"
TURN = "t-1"
SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}


def _client() -> "tuple[MuseClient[Any], FakeDuplex]":
    transport = FakeDuplex()
    client: MuseClient[Any] = MuseClient(
        Connection(transport),
        MuseClientOptions(
            durability=read_session_durability({"sessionDurability": "durable"})
        ),
    )
    return client, transport


def _ack(request_id: Any, result: Params) -> str:
    return frame({"jsonrpc": "2.0", "id": request_id, "result": result})


def _resume_result(session_id: str) -> Params:
    return {
        "session": {"sessionId": session_id, "status": "idle"},
        "history": {"mode": "none", "items": []},
        "pendingRequests": [],
        "viewCursor": "v:2",
    }


def _start_result(session_id: str) -> Params:
    return {"session": {"sessionId": session_id, "status": "idle"}, "viewCursor": "v:2"}


def _view(method: str, session_id: str, **params: Any) -> str:
    return frame(
        {
            "jsonrpc": "2.0",
            "method": method,
            "params": {"sessionId": session_id, "sourceRange": SOURCE, **params},
        }
    )


def _turn_started(session_id: str = SESSION, turn_id: str = TURN) -> str:
    return _view(
        "turn/started", session_id, commandId="c-1", turnId=turn_id, viewCursor="v:1"
    )


def _item_started(session_id: str = SESSION) -> str:
    return _view(
        "item/started",
        session_id,
        viewCursor="v:2",
        item={
            "itemId": "i-1",
            "kind": "agentMessage",
            "revision": 1,
            "sessionId": session_id,
            "status": "inProgress",
            "turnId": TURN,
        },
    )


def _item_delta(text: str, view_cursor: str, session_id: str = SESSION) -> str:
    return _view(
        "item/delta", session_id, viewCursor=view_cursor, itemId="i-1", delta=text, field="text"
    )


def _error(request_id: Any) -> str:
    return frame(
        {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32011, "message": "gone", "data": {"kind": "notFound"}},
        }
    )


def _assert_replay_folded(session: "Session[Any]") -> None:
    assert [turn.turn_id for turn in session.fold.turns()] == [TURN], (
        "the turn/started delivered with the ack must fold"
    )
    assert session.fold.items.get("i-1") is not None, (
        "the item/started delivered with the ack must fold"
    )
    # No hole was reported, so the fold rightly says current — which is
    # exactly why a drop here was silent.
    assert session.fold.pending_gap is None
    assert session.fold.current is True


@pytest.mark.asyncio
async def test_resume_folds_the_view_events_written_in_the_same_chunk_as_the_ack() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.resume_session(ResumeSessionOptions(session_id=SESSION))
    )
    await wait_for_writes(transport, 1)
    sent = sent_frame(transport, 0)
    assert sent["method"] == "session/resume"
    # ONE write: the ack, then the view frames behind it — two deltas last,
    # so a drain that folds the held frames backwards is caught by the text.
    transport.chunks.push(
        _ack(sent["id"], _resume_result(SESSION))
        + _turn_started()
        + _item_started()
        + _item_delta("hel", "v:3")
        + _item_delta("lo", "v:4")
    )
    session = await pending
    assert session.session_id == SESSION
    _assert_replay_folded(session)
    assert session.fold.items.accumulated("i-1") == "hello", "held frames fold in arrival order"
    await client.close()


@pytest.mark.asyncio
async def test_resume_folds_the_replay_the_host_flushes_ahead_of_the_result() -> None:
    # The shipped order: the `(cursor, head]` replay is flushed BEFORE the
    # result, so the frames precede the ack that names the session.
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.resume_session(ResumeSessionOptions(session_id=SESSION))
    )
    await wait_for_writes(transport, 1)
    sent = sent_frame(transport, 0)
    transport.chunks.push(
        _turn_started() + _item_started() + _ack(sent["id"], _resume_result(SESSION))
    )
    session = await pending
    _assert_replay_folded(session)
    await client.close()


@pytest.mark.asyncio
async def test_start_folds_same_chunk_events_for_the_server_named_session_only() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(client.start_session(StartSessionOptions()))
    await wait_for_writes(transport, 1)
    sent = sent_frame(transport, 0)
    assert sent["method"] == "session/start"
    # The SERVER names the session; its frames bracket the ack, and a frame
    # for an unrelated session rides the same chunk.
    transport.chunks.push(
        _turn_started()
        + _ack(sent["id"], _start_result(SESSION))
        + _item_started()
        + _turn_started(OTHER, "t-other")
    )
    session = await pending
    assert session.session_id == SESSION
    _assert_replay_folded(session)

    # The hold exists only while an open is in flight. The unrelated frame
    # above and one arriving now, with no open in flight, are both gone: a
    # later resume of that session starts from what ITS ack's chunk carries,
    # never from retained strays — the bound on what the client keeps.
    transport.chunks.push(_turn_started(OTHER, "t-stray"))
    await pump()
    pending_other = asyncio.ensure_future(
        client.resume_session(ResumeSessionOptions(session_id=OTHER))
    )
    await wait_for_writes(transport, 2)
    transport.chunks.push(_ack(sent_frame(transport, 1)["id"], _resume_result(OTHER)))
    other = await pending_other
    assert other.session_id == OTHER
    assert other.fold.turns() == [], "frames outside an open window are not retained"
    await client.close()


@pytest.mark.asyncio
async def test_an_open_that_errors_drops_what_it_held() -> None:
    # The hold clears when the LAST open settles, result OR error. A rejected
    # resume that left the window open would make the client hold every
    # unknown-session frame forever — the growth the counter exists to stop.
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.resume_session(ResumeSessionOptions(session_id=SESSION))
    )
    await wait_for_writes(transport, 1)
    transport.chunks.push(_turn_started() + _item_started() + _error(sent_frame(transport, 0)["id"]))
    with pytest.raises(MspError):
        await pending

    # With no open in flight this frame is dropped, as before the hold existed…
    transport.chunks.push(_turn_started(SESSION, "t-stray"))
    await pump()
    # …so the next open of the same session starts from its own ack's chunk.
    again = asyncio.ensure_future(
        client.resume_session(ResumeSessionOptions(session_id=SESSION))
    )
    await wait_for_writes(transport, 2)
    transport.chunks.push(_ack(sent_frame(transport, 1)["id"], _resume_result(SESSION)))
    session = await again
    assert session.fold.turns() == [], "nothing held across a failed open survives"
    await client.close()


@pytest.mark.asyncio
async def test_two_overlapping_opens_each_fold_only_their_own_frames() -> None:
    # The window is COUNTED, not flagged: while two opens are in flight, the
    # first to settle must not clear what the second is still owed.
    client, transport = _client()
    pending_a = asyncio.ensure_future(
        client.resume_session(ResumeSessionOptions(session_id="s-a"))
    )
    await wait_for_writes(transport, 1)
    pending_b = asyncio.ensure_future(
        client.resume_session(ResumeSessionOptions(session_id="s-b"))
    )
    await wait_for_writes(transport, 2)
    id_a = sent_frame(transport, 0)["id"]
    id_b = sent_frame(transport, 1)["id"]
    # b settles first, with a's replay already in: a flag would clear it here.
    transport.chunks.push(_turn_started("s-a", "t-a") + _ack(id_b, _resume_result("s-b")))
    b = await pending_b
    transport.chunks.push(_turn_started("s-b", "t-b") + _ack(id_a, _resume_result("s-a")))
    a = await pending_a
    assert [turn.turn_id for turn in a.fold.turns()] == ["t-a"]
    assert [turn.turn_id for turn in b.fold.turns()] == ["t-b"]
    await client.close()
