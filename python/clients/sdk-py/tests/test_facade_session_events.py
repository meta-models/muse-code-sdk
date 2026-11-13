"""``session.events()``: an async stream of what each folded event changed, so
an incremental renderer reads each event's effect instead of re-folding frames
or diffing the fold.

The contract under test: live from the moment the iterator is created, so
"read ``session.fold``, then subscribe" in one step misses nothing (the frames
held while start/resume was in flight are already in the fold); each folded
event is yielded once, in wire order, including what a gap fill splices in;
each event is self-contained; ``aclose()`` (``contextlib.aclosing``)
unsubscribes; the stream finishes as a turn's ``items()`` does when the host
dies; and a reclaim held for an in-flight ``unqueue()`` rides no event.

Port of ``clients/sdk-ts/test/facade-session-events.test.ts``. Causal, never
time-based: every wait is a bounded loop-turn pump.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any, AsyncIterator, List

import pytest

from muse_code import (
    MuseClient,
    MuseClientOptions,
    MuseHostDiedError,
    ResumeSessionOptions,
    SendUserTurnOptions,
    Session,
    SessionEvent,
    StartSessionOptions,
    read_session_durability,
)
from muse_code.connection import Connection
from muse_code.pending import ReclaimedRetirement

from helpers_connection import FakeDuplex, answer, frame, pump, sent_frame, sent_params, wait_for_writes

Params = dict[str, Any]

SESSION = "s-1"
TURN = "t-1"
SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}
DURABLE = read_session_durability({"sessionDurability": "durable"})
EPHEMERAL = read_session_durability({"sessionDurability": "ephemeral"})


def _client(durability: Any = DURABLE) -> "tuple[MuseClient[str], FakeDuplex]":
    transport = FakeDuplex()
    minted = iter(f"mint-{n}" for n in range(1000))
    client: MuseClient[str] = MuseClient(
        Connection(transport, mint_command_id=lambda: next(minted)), MuseClientOptions(durability=durability)
    )
    return client, transport


def _ack(transport: FakeDuplex, index: int, result: Params) -> str:
    return frame({"jsonrpc": "2.0", "id": sent_frame(transport, index)["id"], "result": result})


def _view(method: str, params: Params, session_id: str = SESSION) -> str:
    return frame(
        {"jsonrpc": "2.0", "method": method, "params": {"sessionId": session_id, "sourceRange": SOURCE, **params}}
    )


def _item(revision: int, status: str = "inProgress") -> Params:
    return {"itemId": "i-1", "kind": "agentMessage", "revision": revision, "sessionId": SESSION, "status": status, "turnId": TURN}


def _turn_started(turn_id: str = TURN, session_id: str = SESSION) -> str:
    return _view("turn/started", {"commandId": f"c-{turn_id}", "turnId": turn_id, "viewCursor": f"v:{turn_id}"}, session_id)


def _item_started() -> str:
    return _view("item/started", {"viewCursor": "v:2", "item": _item(1)})


def _item_updated(revision: int, cursor: str, status: str = "inProgress") -> str:
    return _view("item/updated", {"viewCursor": cursor, "item": _item(revision, status)})


def _item_delta(text: str, cursor: str) -> str:
    return _view("item/delta", {"viewCursor": cursor, "itemId": "i-1", "delta": text, "field": "text"})


def _gap(after: str, nxt: str) -> str:
    return frame({"jsonrpc": "2.0", "method": "view/gap", "params": {"after": after, "next": nxt, "sessionId": SESSION}})


def _paged(method: str, params: Params) -> Params:
    return {"method": method, "params": {"sessionId": SESSION, "sourceRange": SOURCE, **params}}


async def _started(client: "MuseClient[str]", transport: FakeDuplex, before_reply: str = "") -> "Session[str]":
    """Open ``SESSION``; ``before_reply`` is read in the same chunk, ahead of the reply."""
    index = len(transport.writes)
    opening = asyncio.ensure_future(client.start_session(StartSessionOptions()))
    await wait_for_writes(transport, index + 1)
    transport.incoming.push(
        before_reply + _ack(transport, index, {"session": {"sessionId": SESSION, "status": "idle"}, "viewCursor": "v:1"})
    )
    return await opening


async def _take(events: AsyncIterator[SessionEvent[str]], count: int) -> List[SessionEvent[str]]:
    """The next ``count`` events, each of which must arrive within a bounded pump."""
    out: List[SessionEvent[str]] = []
    for index in range(count):
        step = asyncio.ensure_future(events.__anext__())
        await pump(50)
        assert step.done(), f"event {index} of {count} was not available"
        out.append(step.result())
    return out


async def _pending(events: AsyncIterator[SessionEvent[str]]) -> "asyncio.Future[SessionEvent[str]]":
    """Start a ``__anext__`` and assert it is still waiting after a bounded pump."""
    step = asyncio.ensure_future(events.__anext__())
    await pump(50)
    assert not step.done(), "the stream yielded something it should not have"
    return step


async def _finished(events: AsyncIterator[SessionEvent[str]]) -> BaseException:
    """How the stream finished within a bounded pump: the exception ``__anext__``
    raised (``StopAsyncIteration`` for an end). A stream that neither ends nor
    fails fails the arm instead of wedging the file."""
    step = asyncio.ensure_future(events.__anext__())
    await pump(50)
    assert step.done(), "the stream neither ended nor failed"
    error = step.exception()
    assert error is not None, f"the stream yielded {step.result()!r}"
    return error


def _methods(events: List[SessionEvent[str]]) -> List[str]:
    return [str(event.frame.get("method")) for event in events]


@pytest.mark.asyncio
async def test_read_the_fold_then_subscribe_misses_nothing_including_frames_folded_during_start() -> None:
    client, transport = _client()
    # The replay a host flushes ahead of the reply folds inside start_session.
    session = await _started(client, transport, _turn_started() + _item_started())
    # Same step: the state, then the stream.
    assert [turn.turn_id for turn in session.fold.turns()] == [TURN]
    assert session.fold.items.get("i-1") is not None, "the held frames are in the fold"
    events = session.events()
    waiting = await _pending(events)  # live only: the held frames are not repeated

    transport.incoming.push(_item_delta("hel", "v:3") + _item_delta("lo", "v:4"))
    await pump(50)
    assert waiting.done()
    live = [waiting.result(), *(await _take(events, 1))]
    assert _methods(live) == ["item/delta", "item/delta"]
    assert session.fold.items.accumulated("i-1") == "hello"
    await client.close()


@pytest.mark.asyncio
async def test_each_event_carries_the_very_frame_and_outcome_session_apply_returned(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    applied: List[tuple[Any, Any]] = []
    original = Session.apply

    def spy(self: "Session[Any]", event: Any) -> Any:
        outcome = original(self, event)
        applied.append((event, outcome))
        return outcome

    monkeypatch.setattr(Session, "apply", spy)
    client, transport = _client()
    session = await _started(client, transport)
    before = len(applied)
    events = session.events()
    transport.incoming.push(_turn_started() + _item_started() + _item_delta("hi", "v:3"))
    seen = await _take(events, 3)
    live = applied[before:]
    assert len(live) == 3
    for event, (frame_applied, outcome_applied) in zip(seen, live):
        assert event.frame is frame_applied, "the frame apply folded"
        assert event.outcome is outcome_applied, "the outcome apply returned"
    await client.close()


@pytest.mark.asyncio
async def test_re_sent_requests_arrive_as_the_frames_the_session_folded() -> None:
    client, transport = _client()
    opening = asyncio.ensure_future(client.resume_session(ResumeSessionOptions(session_id=SESSION)))
    await wait_for_writes(transport, 1)
    transport.incoming.push(
        _ack(
            transport,
            0,
            {
                "session": {"sessionId": SESSION, "status": "idle"},
                "history": {"mode": "none", "items": []},
                "pendingRequests": [],
                "viewCursor": "v:2",
            },
        )
    )
    session = await opening
    events = session.events()
    approval = {
        "approvalId": "a-1",
        "availableChoices": [{"choiceId": "deny", "decision": "denied", "label": "Deny", "scope": "once"}],
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
        "turnId": TURN,
        "viewCursor": "v:0",
    }
    question = {
        "itemId": "i-2",
        "questions": [],
        "sessionId": SESSION,
        "toolCallId": "call-2",
        "toolName": "ask",
        "turnId": TURN,
        "userInputId": "input-1",
        "viewCursor": "v:0",
    }
    transport.incoming.push(
        frame({"jsonrpc": "2.0", "id": 7, "method": "approval/request", "params": approval})
        + frame({"jsonrpc": "2.0", "id": 8, "method": "userInput/request", "params": question})
    )
    seen = await _take(events, 2)
    assert _methods(seen) == ["approval/request", "userInput/requested"]
    assert [entry["userInputId"] for entry in session.fold.pending_user_inputs()] == ["input-1"]
    await client.close()


@pytest.mark.asyncio
async def test_an_item_event_carries_the_item_as_of_that_event_when_later_revisions_folded_first() -> None:
    client, transport = _client()
    session = await _started(client, transport)
    events = session.events()
    transport.incoming.push(_item_started() + _item_updated(2, "v:3") + _item_updated(3, "v:4", "completed"))
    await pump(50)
    held = session.fold.items.get("i-1")
    assert held is not None and held["revision"] == 3, "the fold is already at the last revision"
    seen = await _take(events, 3)
    assert [event.item["revision"] if event.item else None for event in seen] == [1, 2, 3]
    assert [event.item["status"] if event.item else None for event in seen] == ["inProgress", "inProgress", "completed"]
    await client.close()


@pytest.mark.asyncio
async def test_a_gap_fills_paged_and_buffered_frames_are_yielded_once_each_in_order_when_spliced_in() -> None:
    client, transport = _client()
    session = await _started(client, transport, _turn_started())
    events = session.events()
    transport.incoming.push(_gap("v:1", "v:2"))
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "view/page"
    # A live frame behind the hole: held while the fill runs, not yielded yet.
    transport.incoming.push(_item_delta("hi", "v:3"))
    (gap_event,) = await _take(events, 1)
    assert type(gap_event.outcome.fold).__name__ == "DeliveryGap"
    waiting = await _pending(events)
    answer(transport, 1, {"events": [_paged("item/started", {"viewCursor": "v:2", "item": _item(1)})], "nextCursor": "v:2"})
    await pump(50)
    assert waiting.done()
    spliced = [waiting.result(), *(await _take(events, 1))]
    assert _methods(spliced) == ["item/started", "item/delta"]
    assert spliced[0].item is not None and spliced[0].item["itemId"] == "i-1"
    assert spliced[0].outcome.retirements == (), "a spliced event's retirements ride the gap event's io"
    await _pending(events)  # each frame once
    assert session.fold.items.accumulated("i-1") == "hi"
    await client.close()


@pytest.mark.asyncio
async def test_aclose_unsubscribes_and_other_streams_are_unaffected() -> None:
    client, transport = _client()
    session = await _started(client, transport)
    async with contextlib.aclosing(session.events()) as closing:
        transport.incoming.push(_turn_started())
        async for event in closing:
            assert event.frame["method"] == "turn/started"
            break
    assert isinstance(await _finished(closing), StopAsyncIteration)

    closed = session.events()
    kept = session.events()
    await closed.aclose()  # type: ignore[attr-defined]
    transport.incoming.push(_item_started())
    await pump(50)
    assert isinstance(await _finished(closed), StopAsyncIteration)
    assert _methods(await _take(kept, 1)) == ["item/started"]
    await client.close()


@pytest.mark.asyncio
async def test_each_stream_hears_its_own_session_only_and_an_unread_stream_holds_nothing_up() -> None:
    client, transport = _client()
    one = await _started(client, transport)
    opening = asyncio.ensure_future(client.start_session(StartSessionOptions()))
    await wait_for_writes(transport, 2)
    transport.incoming.push(_ack(transport, 1, {"session": {"sessionId": "s-2", "status": "idle"}, "viewCursor": "v:0"}))
    two = await opening
    unread = one.events()
    first = one.events()
    other = two.events()
    transport.incoming.push(_turn_started("a") + _turn_started("b", "s-2") + _turn_started("c"))

    def turn_ids(events: List[SessionEvent[str]]) -> List[str]:
        return [str(event.frame["params"]["turnId"]) for event in events]

    assert turn_ids(await _take(first, 2)) == ["a", "c"]
    assert turn_ids(await _take(other, 1)) == ["b"]
    assert [turn.turn_id for turn in one.fold.turns()] == ["a", "c"], "folding never waits on a reader"
    assert turn_ids(await _take(unread, 2)) == ["a", "c"], "an unread stream buffers"
    await client.close()


@pytest.mark.asyncio
async def test_an_ephemeral_host_death_ends_the_stream_after_its_buffer_and_a_later_stream_at_once() -> None:
    client, transport = _client(EPHEMERAL)
    session = await _started(client, transport)
    events = session.events()
    transport.incoming.push(_turn_started())
    await pump(50)
    transport.incoming.end()
    await pump(50)
    assert _methods(await _take(events, 1)) == ["turn/started"], "buffered events come first"
    assert isinstance(await _finished(events), StopAsyncIteration)
    assert isinstance(await _finished(session.events()), StopAsyncIteration)


@pytest.mark.asyncio
async def test_a_durable_host_death_raises_muse_host_died_error_as_a_turns_items_does() -> None:
    client, transport = _client(DURABLE)
    session = await _started(client, transport)
    events = session.events()
    transport.incoming.push(_turn_started())
    await pump(50)
    transport.incoming.end()
    await pump(50)
    assert _methods(await _take(events, 1)) == ["turn/started"], "buffered events come first"
    assert isinstance(await _finished(events), MuseHostDiedError)
    assert isinstance(await _finished(session.events()), MuseHostDiedError)


async def _queued_turn() -> Any:
    """A started session holding one acked queued submit for turn ``t-2``."""
    client, transport = _client()
    session = await _started(client, transport)
    events = session.events()
    submitting = asyncio.ensure_future(
        session.send_user_turn(SendUserTurnOptions(input=[{"type": "text", "text": "q"}], composer_input="draft"))
    )
    await wait_for_writes(transport, 2)
    queued = sent_params(transport, 1)["commandId"]
    transport.incoming.push(
        _ack(
            transport,
            1,
            {"commandId": queued, "disposition": "queued", "startedNewTurn": True, "status": "accepted", "turnId": "t-2"},
        )
    )
    return client, events, queued, transport, await submitting


def _unqueued(queued: str) -> str:
    return _view("turn/unqueued", {"commandId": queued, "turnId": "t-2", "viewCursor": "v:9"})


def _unqueue_ack(transport: FakeDuplex, index: int) -> str:
    return _ack(transport, index, {"commandId": sent_params(transport, index)["commandId"], "status": "accepted", "turnId": "t-2"})


@pytest.mark.asyncio
async def test_events_change_nothing_else_a_reclaim_folded_first_still_comes_back_from_unqueue_once() -> None:
    client, events, queued, transport, turn = await _queued_turn()
    unqueuing = asyncio.ensure_future(turn.unqueue())
    await wait_for_writes(transport, 3)
    transport.incoming.push(_unqueued(queued) + _unqueue_ack(transport, 2))
    outcome = await unqueuing
    assert outcome.retirement == ReclaimedRetirement(command_id=queued, input="draft"), "unqueue() returns the reclaim"
    (event,) = await _take(events, 1)
    assert event.frame["method"] == "turn/unqueued", "the event is still yielded"
    assert event.outcome.retirements == (), "without the reclaim unqueue() returns"
    await client.close()


@pytest.mark.asyncio
async def test_a_reclaim_spliced_in_by_a_gap_fill_while_unqueue_is_in_flight_rides_no_event_or_io() -> None:
    client, events, queued, transport, turn = await _queued_turn()
    unqueuing = asyncio.ensure_future(turn.unqueue())
    await wait_for_writes(transport, 3)
    transport.incoming.push(_gap("v:1", "v:9"))
    await wait_for_writes(transport, 4)
    answer(
        transport,
        3,
        {"events": [_paged("turn/unqueued", {"commandId": queued, "turnId": "t-2", "viewCursor": "v:9"})], "nextCursor": "v:9"},
    )
    await pump(50)
    transport.incoming.push(_unqueue_ack(transport, 2))
    assert (await unqueuing).retirement == ReclaimedRetirement(command_id=queued, input="draft")
    seen = await _take(events, 2)
    assert _methods(seen) == ["view/gap", "turn/unqueued"]
    assert [r for event in seen for r in event.outcome.retirements] == []
    settled = [r for event in seen for r in await event.outcome.io]
    assert settled == [], "no io carries it either"
    await client.close()


@pytest.mark.asyncio
async def test_a_reclaim_no_unqueue_waits_for_rides_its_event() -> None:
    client, events, queued, transport, _turn = await _queued_turn()
    transport.incoming.push(_unqueued(queued))
    (event,) = await _take(events, 1)
    assert event.frame["method"] == "turn/unqueued"
    assert event.outcome.retirements == (ReclaimedRetirement(command_id=queued, input="draft"),)
    await client.close()
