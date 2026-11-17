"""``session.events(subagents=True)`` also yields each sub-agent's step-by-step
events, in wire order with the parent's, tagged with the sub-agent they belong
to. The SDK follows the child sessions itself while such a stream is
open: ``view/subscribe`` when a ``subagent`` item carries a running child
session, ``view/unsubscribe`` when the item ends or no stream needs it.
Approvals stay on the parent.

Port of ``clients/sdk-ts/test/facade-session-subagents.test.ts``. Causal,
never time-based: every wait is a bounded loop-turn pump.
"""

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import Any, AsyncIterator, List, cast

import pytest

from muse_code import (
    ApprovalDecisionInput,
    MuseClient,
    MuseClientOptions,
    MuseHostDiedError,
    ResumeSessionOptions,
    Session,
    SessionEvent,
    SessionEventSubagent,
    StartSessionOptions,
    read_session_durability,
)
from muse_code.connection import Connection
from muse_code.connection.spawn import ExitClassification, SpawnedMspConnection

from helpers_connection import FakeDuplex, answer, answer_error, frame, pump, sent_frame, wait_for_writes

Params = dict[str, Any]

PARENT = "s-parent"
CHILD = "s-child"
TAG = SessionEventSubagent(item_id="it-sub", subagent_id="sa-1", child_session_id=CHILD)
SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}
DURABLE = read_session_durability({"sessionDurability": "durable"})


def _view(session_id: str, method: str, params: Params) -> str:
    return frame({"jsonrpc": "2.0", "method": method, "params": {"sessionId": session_id, "sourceRange": SOURCE, **params}})


def _subagent(method: str, revision: int, cursor: str, **extra: Any) -> str:
    """The parent's ``subagent`` item; ``childSessionId`` once the child's start is attested."""
    done = method == "item/completed"
    item = {
        "itemId": TAG.item_id,
        "kind": "subagent",
        "turnId": "t-1",
        "revision": revision,
        "status": "completed" if done else "inProgress",
        "subagentId": TAG.subagent_id,
        "agentPath": "researcher",
        "depth": 1,
        "controlStatus": "closed" if done else "running",
        **extra,
    }
    return _view(PARENT, method, {"viewCursor": cursor, "item": item})


def _message(session_id: str, item_id: str, cursor: str) -> str:
    item = {"itemId": item_id, "kind": "agentMessage", "revision": 1, "sessionId": session_id, "status": "inProgress", "turnId": "t-1"}
    return _view(session_id, "item/started", {"viewCursor": cursor, "item": item})


async def _opened() -> "tuple[MuseClient[str], Session[str], FakeDuplex]":
    transport = FakeDuplex()
    client: MuseClient[str] = MuseClient(Connection(transport), MuseClientOptions(durability=DURABLE))
    opening = asyncio.ensure_future(client.start_session(StartSessionOptions()))
    await wait_for_writes(transport, 1)
    answer(transport, 0, {
        "commandId": sent_frame(transport, 0)["params"]["commandId"],
        "session": {"sessionId": PARENT, "status": "idle"},
        "viewCursor": "v:0",
    })
    return client, await opening, transport


async def _buffered(events: AsyncIterator[SessionEvent[str]]) -> List[SessionEvent[str]]:
    """Every event the stream has buffered, without waiting for more."""
    out: List[SessionEvent[str]] = []
    while True:
        step = asyncio.ensure_future(events.__anext__())
        await pump(50)
        if not step.done():
            step.cancel()
            return out
        out.append(step.result())


async def _take(events: AsyncIterator[SessionEvent[str]], count: int) -> List[SessionEvent[str]]:
    """The next ``count`` events, each of which must arrive within a bounded pump."""
    out: List[SessionEvent[str]] = []
    for index in range(count):
        step = asyncio.ensure_future(events.__anext__())
        await pump(50)
        assert step.done(), f"event {index} of {count} was not available"
        out.append(step.result())
    return out


def _shape(events: List[SessionEvent[str]]) -> List[Any]:
    return [(event.frame["params"].get("sessionId"), event.frame["method"], event.subagent) for event in events]


def _methods(transport: FakeDuplex) -> List[str]:
    return [json.loads(line).get("method", "reply") for line in transport.writes]


@pytest.mark.asyncio
async def test_without_the_opt_in_events_yields_the_parents_events_only_and_follows_nothing() -> None:
    client, session, transport = await _opened()
    events = session.events()
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD) + _message(CHILD, "c-1", "c:1"))
    await pump(50)
    assert _methods(transport) == ["session/start"], "no view/subscribe"
    assert _shape(await _buffered(events)) == [(PARENT, "item/started", None)]
    await client.close()


@pytest.mark.asyncio
async def test_with_subagents_a_sub_agents_events_stream_in_wire_order_with_the_parents_tagged() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)

    transport.incoming.push(_subagent("item/started", 1, "v:1", controlStatus="accepted"))
    await pump(50)
    assert _methods(transport) == ["session/start"], "no child session yet: nothing to follow"

    transport.incoming.push(_subagent("item/updated", 2, "v:2", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "view/subscribe"
    assert sent_frame(transport, 1)["params"] == {"sessionId": CHILD}
    answer(transport, 1, {"viewCursor": "c:0"})

    transport.incoming.push(_message(CHILD, "c-1", "c:1") + _message(PARENT, "p-2", "v:3") + _message(CHILD, "c-2", "c:2"))
    await pump(50)
    # A later revision of the running item follows nothing twice.
    transport.incoming.push(_subagent("item/updated", 3, "v:4", childSessionId=CHILD))
    await pump(50)
    assert _methods(transport) == ["session/start", "view/subscribe"]

    seen = await _buffered(events)
    assert _shape(seen) == [
        (PARENT, "item/started", None),
        (PARENT, "item/updated", None),
        (CHILD, "item/started", TAG),
        (PARENT, "item/started", None),
        (CHILD, "item/started", TAG),
        (PARENT, "item/updated", None),
    ]
    assert seen[2].item is not None and seen[2].item["itemId"] == "c-1", "a sub-agent event carries its item"
    assert session.fold.items.get("c-1") is None, "the parent's own state holds none of it"
    await client.close()


@pytest.mark.asyncio
async def test_two_sub_agents_are_followed_side_by_side_and_one_ending_stops_only_that_one() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    a = SessionEventSubagent(item_id="it-a", subagent_id="sa-a", child_session_id="s-a")
    b = SessionEventSubagent(item_id="it-b", subagent_id="sa-b", child_session_id="s-b")
    transport.incoming.push(
        _subagent("item/started", 1, "v:1", itemId="it-a", subagentId="sa-a", childSessionId="s-a")
        + _subagent("item/started", 1, "v:2", itemId="it-b", subagentId="sa-b", childSessionId="s-b")
    )
    await wait_for_writes(transport, 3)
    assert [sent_frame(transport, 1)["params"], sent_frame(transport, 2)["params"]] == [{"sessionId": "s-a"}, {"sessionId": "s-b"}]
    answer(transport, 1, {"viewCursor": "a:0"})
    answer(transport, 2, {"viewCursor": "b:0"})
    transport.incoming.push(_message("s-a", "a-1", "a:1") + _message("s-b", "b-1", "b:1"))
    await pump(50)

    # A's turn ends with its item, so its follow finishes; B's turn runs on.
    transport.incoming.push(
        _view("s-a", "turn/completed", {"terminal": "completed", "turnId": "t-1", "viewCursor": "a:2"})
        + _subagent("item/completed", 2, "v:3", itemId="it-a", subagentId="sa-a", childSessionId="s-a")
    )
    await wait_for_writes(transport, 4)
    assert sent_frame(transport, 3)["params"] == {"sessionId": "s-a"}
    transport.incoming.push(_message("s-b", "b-2", "b:2") + _message("s-a", "a-late", "a:9"))
    await pump(50)
    assert _methods(transport) == ["session/start", "view/subscribe", "view/subscribe", "view/unsubscribe"]
    children = [shape for shape in _shape(await _buffered(events)) if shape[0] != PARENT]
    assert children == [
        ("s-a", "item/started", a),
        ("s-b", "item/started", b),
        ("s-a", "turn/completed", a),
        ("s-b", "item/started", b),
    ]
    await client.close()


@pytest.mark.asyncio
async def test_a_sub_agent_already_running_when_the_stream_opens_is_followed_at_once() -> None:
    client, session, transport = await _opened()
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await pump(50)
    assert _methods(transport) == ["session/start"]

    events = session.events(subagents=True)
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "view/subscribe"
    answer(transport, 1, {"viewCursor": "c:5"})
    transport.incoming.push(_message(CHILD, "c-6", "c:6"))
    await pump(50)
    assert _shape(await _buffered(events)) == [(CHILD, "item/started", TAG)]
    await client.close()


@pytest.mark.asyncio
async def test_the_sub_agents_item_ending_unsubscribes_and_its_later_events_are_not_yielded() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})

    transport.incoming.push(_subagent("item/completed", 2, "v:2", childSessionId=CHILD))
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "view/unsubscribe"
    assert sent_frame(transport, 2)["params"] == {"sessionId": CHILD}
    answer(transport, 2, {})
    transport.incoming.push(_message(CHILD, "c-late", "c:9"))
    await pump(50)
    assert _shape(await _buffered(events)) == [(PARENT, "item/started", None), (PARENT, "item/completed", None)]
    await client.close()


@pytest.mark.asyncio
async def test_a_sub_agents_last_steps_after_its_item_ended_still_stream_then_the_follow_stops() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})
    transport.incoming.push(_view(CHILD, "turn/started", {"commandId": "c-x", "turnId": "t-1", "viewCursor": "c:1"}))
    await pump(50)

    # Each session drains to the connection on its own, so the parent's item
    # can end before the child's final steps arrive.
    transport.incoming.push(_subagent("item/completed", 2, "v:2", childSessionId=CHILD))
    await pump(50)
    assert _methods(transport) == ["session/start", "view/subscribe"], "the child's turn is still running"
    transport.incoming.push(
        _message(CHILD, "c-last", "c:2")
        + _view(CHILD, "turn/completed", {"terminal": "completed", "turnId": "t-1", "viewCursor": "c:3"})
    )
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "view/unsubscribe"
    transport.incoming.push(_message(CHILD, "c-after", "c:4"))
    await pump(50)
    children = [shape for shape in _shape(await _buffered(events)) if shape[0] == CHILD]
    assert children == [(CHILD, "turn/started", TAG), (CHILD, "item/started", TAG), (CHILD, "turn/completed", TAG)]
    await client.close()


@pytest.mark.asyncio
async def test_a_sub_agent_followed_mid_turn_still_streams_its_last_steps() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:5"})
    # The child's turn started before the subscribe: only its later frames come.
    transport.incoming.push(_message(CHILD, "c-mid", "c:6"))
    await pump(50)
    transport.incoming.push(_subagent("item/completed", 2, "v:2", childSessionId=CHILD))
    await pump(50)
    assert _methods(transport) == ["session/start", "view/subscribe"], "the child's turn is still running"
    transport.incoming.push(
        _message(CHILD, "c-last", "c:7")
        + _view(CHILD, "turn/completed", {"terminal": "completed", "turnId": "t-1", "viewCursor": "c:8"})
    )
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "view/unsubscribe"
    children = [shape for shape in _shape(await _buffered(events)) if shape[0] == CHILD]
    assert children == [(CHILD, "item/started", TAG), (CHILD, "item/started", TAG), (CHILD, "turn/completed", TAG)]
    # Observability only: a finished follow keeps nothing (its child fold) alive.
    assert getattr(session, "_followed_subagents") == {}
    await client.close()


@pytest.mark.asyncio
async def test_a_follow_that_joined_mid_message_still_streams_the_messages_end_and_its_turns() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:5"})
    # The message opened before the subscribe: its deltas carry no turnId.
    transport.incoming.push(_view(CHILD, "item/delta", {"viewCursor": "c:6", "itemId": "c-msg", "delta": "hel", "field": "text"}))
    await pump(50)
    transport.incoming.push(_subagent("item/completed", 2, "v:2", childSessionId=CHILD))
    await pump(50)
    assert _methods(transport) == ["session/start", "view/subscribe"], "the child is mid-message"
    done = {"itemId": "c-msg", "kind": "agentMessage", "revision": 2, "sessionId": CHILD, "status": "completed", "turnId": "t-1", "text": "hello"}
    transport.incoming.push(
        _view(CHILD, "item/completed", {"viewCursor": "c:7", "item": done})
        + _view(CHILD, "turn/completed", {"terminal": "completed", "turnId": "t-1", "viewCursor": "c:8"})
    )
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "view/unsubscribe"
    children = [shape for shape in _shape(await _buffered(events)) if shape[0] == CHILD]
    assert children == [(CHILD, "item/delta", TAG), (CHILD, "item/completed", TAG), (CHILD, "turn/completed", TAG)]
    await client.close()


@pytest.mark.asyncio
async def test_closing_the_last_stream_while_a_follow_is_finishing_unsubscribes_at_once() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:5"})
    transport.incoming.push(_message(CHILD, "c-mid", "c:6") + _subagent("item/completed", 2, "v:2", childSessionId=CHILD))
    await pump(50)
    assert _methods(transport) == ["session/start", "view/subscribe"], "finishing: the child's turn runs"
    await events.aclose()  # type: ignore[attr-defined]
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "view/unsubscribe"
    await client.close()


@pytest.mark.asyncio
async def test_a_sub_agent_ending_while_the_callers_resume_of_it_is_in_flight_does_not_unsubscribe() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})
    resuming = asyncio.ensure_future(client.resume_session(ResumeSessionOptions(session_id=CHILD)))
    await wait_for_writes(transport, 3)
    # The follow stops before the resume replies: the subscription is per
    # connection and session, so an unsubscribe now would starve the resume.
    transport.incoming.push(_subagent("item/completed", 2, "v:2", childSessionId=CHILD))
    await pump(50)
    assert getattr(session, "_followed_subagents") == {}, "the follow stopped"
    assert _methods(transport) == ["session/start", "view/subscribe", "session/resume"], "no view/unsubscribe"
    answer(transport, 2, {
        "commandId": sent_frame(transport, 2)["params"]["commandId"],
        "session": {"sessionId": CHILD, "status": "running"},
        "history": {"mode": "none", "items": None, "snapshot": None, "noneReason": "cursorSuffix"},
        "pendingRequests": [],
        "viewCursor": "c:0",
    })
    own = await resuming
    transport.incoming.push(_message(CHILD, "c-1", "c:1"))
    await pump(50)
    assert own.fold.items.get("c-1") is not None, "the resumed session keeps folding"
    del events
    await client.close()


@pytest.mark.asyncio
async def test_close_reporting_a_crashed_spawned_host_while_following_raises_nothing() -> None:
    # A host that ignores EOF is killed by close(); only close() then reports
    # the death, and stopping a follow changes the client's session set.
    class _CrashedChild:
        async def close(self) -> ExitClassification:
            return ExitClassification(kind="crash", exit_code=77, exit_signal=None, stderr_tail=())

    transport = FakeDuplex()
    host = cast(SpawnedMspConnection, SimpleNamespace(child=_CrashedChild(), initialize_result=None))
    client: MuseClient[str] = MuseClient(Connection(transport), MuseClientOptions(durability=DURABLE, host=host))
    opening = asyncio.ensure_future(client.start_session(StartSessionOptions()))
    await wait_for_writes(transport, 1)
    answer(transport, 0, {
        "commandId": sent_frame(transport, 0)["params"]["commandId"],
        "session": {"sessionId": PARENT, "status": "idle"},
        "viewCursor": "v:0",
    })
    session = await opening
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})
    await pump(50)

    await client.close()  # raises nothing
    await _take(events, 1)  # the parent's subagent item
    step = asyncio.ensure_future(events.__anext__())
    await pump(50)
    assert step.done() and isinstance(step.exception(), MuseHostDiedError), "a durable death rejects the stream"


@pytest.mark.asyncio
async def test_a_caller_resuming_a_followed_child_still_gets_the_frames_sent_before_the_reply() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})
    resuming = asyncio.ensure_future(client.resume_session(ResumeSessionOptions(session_id=CHILD)))
    await wait_for_writes(transport, 3)
    reply = {
        "commandId": sent_frame(transport, 2)["params"]["commandId"],
        "session": {"sessionId": CHILD, "status": "running"},
        "history": {"mode": "none", "items": None, "snapshot": None, "noneReason": "cursorSuffix"},
        "pendingRequests": [],
        "viewCursor": "c:1",
    }
    transport.incoming.push(
        _message(CHILD, "c-early", "c:1") + frame({"jsonrpc": "2.0", "id": sent_frame(transport, 2)["id"], "result": reply})
    )
    own = await resuming
    assert own.fold.items.get("c-early") is not None, "the caller's fold holds the frame read with the reply"
    del events
    await client.close()


@pytest.mark.asyncio
async def test_the_last_opted_in_stream_closing_unsubscribes_and_one_still_open_keeps_it_followed() -> None:
    client, session, transport = await _opened()
    first = session.events(subagents=True)
    second = session.events(subagents=True)
    plain = session.events()
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})

    await first.aclose()  # type: ignore[attr-defined]
    await pump(50)
    assert _methods(transport) == ["session/start", "view/subscribe"], "the other stream still needs it"
    transport.incoming.push(_message(CHILD, "c-1", "c:1"))
    await pump(50)
    assert _shape(await _buffered(second))[-1] == (CHILD, "item/started", TAG)

    await second.aclose()  # type: ignore[attr-defined]
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "view/unsubscribe"
    assert _shape(await _buffered(plain)) == [(PARENT, "item/started", None)], "the plain stream never saw the child"
    answer(transport, 2, {})

    # Reopening while the sub-agent still runs follows it again.
    third = session.events(subagents=True)
    await wait_for_writes(transport, 4)
    assert sent_frame(transport, 3)["method"] == "view/subscribe"
    answer(transport, 3, {"viewCursor": "c:1"})
    transport.incoming.push(_message(CHILD, "c-2", "c:2"))
    await pump(50)
    assert _shape(await _buffered(third)) == [(CHILD, "item/started", TAG)]
    await client.close()


@pytest.mark.asyncio
async def test_a_child_gap_fill_that_lands_after_the_follow_stopped_is_not_yielded() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})
    # A delivery gap on the child starts a fill: its view/page is in flight.
    transport.incoming.push(frame({"jsonrpc": "2.0", "method": "view/gap", "params": {"after": "c:1", "next": "c:3", "sessionId": CHILD}}))
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "view/page"

    transport.incoming.push(_subagent("item/completed", 2, "v:2", childSessionId=CHILD))
    await wait_for_writes(transport, 4)
    assert sent_frame(transport, 3)["method"] == "view/unsubscribe"
    # The page answers after the follow stopped: nothing of it reaches the stream.
    paged = {"itemId": "c-paged", "kind": "agentMessage", "revision": 1, "sessionId": CHILD, "status": "inProgress", "turnId": "t-1"}
    answer(transport, 2, {
        "events": [{"method": "item/started", "params": {"sessionId": CHILD, "sourceRange": SOURCE, "viewCursor": "c:2", "item": paged}}],
        "nextCursor": None,
    })
    await pump(50)
    child = [shape for shape in _shape(await _buffered(events)) if shape[0] == CHILD]
    assert child == [(CHILD, "view/gap", TAG)]
    await client.close()


@pytest.mark.asyncio
async def test_the_unsubscribe_is_skipped_while_a_session_the_caller_opened_routes_the_child() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})
    resuming = asyncio.ensure_future(client.resume_session(ResumeSessionOptions(session_id=CHILD)))
    await wait_for_writes(transport, 3)
    answer(transport, 2, {
        "commandId": sent_frame(transport, 2)["params"]["commandId"],
        "session": {"sessionId": CHILD, "status": "running"},
        "history": {"mode": "none", "items": None, "snapshot": None, "noneReason": "cursorSuffix"},
        "pendingRequests": [],
        "viewCursor": "c:0",
    })
    own = await resuming

    transport.incoming.push(_subagent("item/completed", 2, "v:2", childSessionId=CHILD))
    await pump(50)
    assert getattr(session, "_followed_subagents") == {}, "the follow stopped"
    assert _methods(transport) == ["session/start", "view/subscribe", "session/resume"], "no view/unsubscribe"
    transport.incoming.push(_message(CHILD, "c-1", "c:1"))
    await pump(50)
    assert own.fold.items.get("c-1") is not None, "the caller's own session keeps folding"
    del events
    await client.close()


@pytest.mark.asyncio
async def test_a_child_the_caller_already_resumed_is_followed_on_its_subscription_not_subscribed_again() -> None:
    client, session, transport = await _opened()
    resuming = asyncio.ensure_future(client.resume_session(ResumeSessionOptions(session_id=CHILD)))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {
        "commandId": sent_frame(transport, 1)["params"]["commandId"],
        "session": {"sessionId": CHILD, "status": "running"},
        "history": {"mode": "none", "items": None, "snapshot": None, "noneReason": "cursorSuffix"},
        "pendingRequests": [],
        "viewCursor": "c:0",
    })
    own = await resuming
    events = session.events(subagents=True)
    # A second subscribe would replace the connection's subscription with an
    # empty one at head: the child frames queued for the caller would be lost.
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await pump(50)
    assert _methods(transport) == ["session/start", "session/resume"], "no second view/subscribe"
    assert len(getattr(session, "_followed_subagents")) == 1
    transport.incoming.push(
        _message(CHILD, "c-1", "c:1")
        + _view(CHILD, "turn/completed", {"terminal": "completed", "turnId": "t-1", "viewCursor": "c:2"})
    )
    await pump(50)
    transport.incoming.push(_subagent("item/completed", 2, "v:2", childSessionId=CHILD))
    await pump(50)
    assert _shape(await _buffered(events)) == [
        (PARENT, "item/started", None),
        (CHILD, "item/started", TAG),
        (CHILD, "turn/completed", TAG),
        (PARENT, "item/completed", None),
    ]
    assert own.fold.items.get("c-1") is not None, "the caller's session folds the same frame"
    assert getattr(session, "_followed_subagents") == {}, "the follow stopped"
    assert _methods(transport) == ["session/start", "session/resume"], "no view/unsubscribe"
    await client.close()


@pytest.mark.asyncio
async def test_a_refused_caller_resume_of_a_followed_child_does_not_keep_the_follows_unsubscribe_back() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})
    resuming = asyncio.ensure_future(client.resume_session(ResumeSessionOptions(session_id=CHILD)))
    await wait_for_writes(transport, 3)
    answer_error(transport, 2, {"code": -32020, "message": "not running", "data": {"kind": "sessionNotFound"}})
    await asyncio.gather(resuming, return_exceptions=True)
    transport.incoming.push(_subagent("item/completed", 2, "v:2", childSessionId=CHILD))
    await wait_for_writes(transport, 4)
    assert sent_frame(transport, 3)["method"] == "view/unsubscribe"
    del events
    await client.close()


@pytest.mark.asyncio
async def test_a_stream_closed_while_the_subscribe_is_pending_unsubscribes_once_it_settles() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    await events.aclose()  # type: ignore[attr-defined]
    await pump(50)
    assert _methods(transport) == ["session/start", "view/subscribe"], "nothing to unsubscribe yet"
    answer(transport, 1, {"viewCursor": "c:0"})
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "view/unsubscribe"
    await client.close()


class _Visits:
    """Elements iterated out of the client's session set and id index: the
    seam a scan of every session would walk."""

    count = 0


class _CountingSet(set):  # type: ignore[type-arg]
    def __iter__(self) -> Any:
        for element in super().__iter__():
            _Visits.count += 1
            yield element


class _CountingDict(dict):  # type: ignore[type-arg]
    def __iter__(self) -> Any:
        for key in super().__iter__():
            _Visits.count += 1
            yield key

    def values(self) -> Any:
        return [value for key, value in self.items()]

    def keys(self) -> Any:
        return [key for key, _ in self.items()]

    def items(self) -> Any:
        out = list(super().items())
        _Visits.count += len(out)
        return out


@pytest.mark.asyncio
async def test_routing_one_sub_agents_frames_costs_the_same_however_many_sub_agents_are_followed() -> None:
    frames = 16

    async def routed(followed: int) -> int:
        client, session, transport = await _opened()
        setattr(client, "_sessions", _CountingSet(getattr(client, "_sessions")))
        setattr(client, "_sessions_by_id", _CountingDict(getattr(client, "_sessions_by_id")))
        events = session.events(subagents=True)
        for index in range(followed):
            transport.incoming.push(_subagent(
                "item/started", 1, f"v:{index + 1}",
                itemId=f"it-{index}", subagentId=f"sa-{index}", childSessionId=f"s-{index}",
            ))
        await wait_for_writes(transport, 1 + followed)
        for index in range(followed):
            answer(transport, 1 + index, {"viewCursor": f"c{index}:0"})
        await pump(50)
        assert len(getattr(session, "_followed_subagents")) == followed
        _Visits.count = 0
        for index in range(frames):
            transport.incoming.push(_message("s-0", f"m-{index}", f"c0:{index + 1}"))
        await pump(80)
        visits = _Visits.count
        assert len(await _buffered(events)) == followed + frames, "every frame reached the stream"
        await client.close()
        return visits

    # A scan of every session would add frames x (K - 1) visits at K = 8.
    assert await routed(8) == await routed(1)


@pytest.mark.asyncio
async def test_a_sub_agents_approval_is_answered_once_on_the_parent() -> None:
    client, session, transport = await _opened()
    asked: List[str] = []

    def handler(request: Any) -> ApprovalDecisionInput:
        asked.append(request["approvalId"])
        return ApprovalDecisionInput(choice_id="deny")

    session.on_approval(handler)
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})

    # The host presents a child's approval on the parent, and re-issues it once
    # to a connection that subscribes to the child.
    params: Params = {
        "approvalId": "a-1",
        "availableChoices": [{"choiceId": "deny", "decision": "denied", "label": "Deny", "scope": "once"}],
        "currentRequirementId": {"approvalId": "a-1", "sourceIndex": 0},
        "itemId": "i-1",
        "judgeEscalated": False,
        "protectedWrite": False,
        "rawArgs": "{}",
        "sessionId": PARENT,
        "sourceRange": SOURCE,
        "subagentOrigin": {"childRunId": "r-1", "childSessionId": CHILD, "subagentId": TAG.subagent_id},
        "subject": {"kind": "shell", "command": "ls"},
        "taskId": "task-1",
        "toolCallId": "call-1",
        "toolName": "shell",
        "turnId": "t-1",
        "viewCursor": "v:2",
    }
    transport.incoming.push(
        frame({"jsonrpc": "2.0", "method": "approval/requested", "params": params})
        + frame({"jsonrpc": "2.0", "id": 70, "method": "approval/request", "params": params})
    )
    await pump(80)
    # The copy the child subscription gets names the child: the follow's
    # internal session holds no handler and asks no one.
    on_child = {**{k: v for k, v in params.items() if k != "subagentOrigin"}, "sessionId": CHILD, "viewCursor": "c:1"}
    transport.incoming.push(
        frame({"jsonrpc": "2.0", "method": "approval/requested", "params": on_child})
        + frame({"jsonrpc": "2.0", "id": 71, "method": "approval/request", "params": on_child})
    )
    await pump(80)
    assert asked == ["a-1"]
    decides = [json.loads(line) for line in transport.writes if '"approval/decide"' in line]
    assert len(decides) == 1
    assert decides[0]["params"]["sessionId"] == PARENT
    del events
    await client.close()


@pytest.mark.asyncio
async def test_a_refused_child_subscribe_leaves_the_parents_stream_running() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer_error(transport, 1, {"code": -32020, "message": "not running", "data": {"kind": "sessionNotFound"}})
    await pump(50)
    transport.incoming.push(_message(PARENT, "p-2", "v:2") + _subagent("item/completed", 2, "v:3", childSessionId=CHILD))
    await pump(50)
    assert _shape(await _buffered(events)) == [
        (PARENT, "item/started", None),
        (PARENT, "item/started", None),
        (PARENT, "item/completed", None),
    ]
    assert _methods(transport) == ["session/start", "view/subscribe"], "nothing to unsubscribe"
    await client.close()


@pytest.mark.asyncio
async def test_a_host_death_while_following_ends_the_stream_as_events_does() -> None:
    client, session, transport = await _opened()
    events = session.events(subagents=True)
    transport.incoming.push(_subagent("item/started", 1, "v:1", childSessionId=CHILD))
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"viewCursor": "c:0"})
    transport.incoming.push(_message(CHILD, "c-1", "c:1"))
    await pump(50)
    transport.incoming.end()
    await pump(50)
    assert _shape(await _take(events, 2)) == [(PARENT, "item/started", None), (CHILD, "item/started", TAG)]
    step = asyncio.ensure_future(events.__anext__())
    await pump(50)
    assert step.done() and isinstance(step.exception(), MuseHostDiedError), "a durable death rejects the stream"
    # Observability only: the death reached every session without the report
    # itself failing (stopping a follow changes the client's session set).
    watch = getattr(client, "_closed_watch")
    assert watch.done() and watch.exception() is None
    assert getattr(session, "_followed_subagents") == {}, "a death drops every follow"
    await client.close()


@pytest.mark.asyncio
async def test_a_session_no_muse_client_opened_refuses_the_sub_agent_opt_in() -> None:
    session: Session[str] = Session(PARENT, DURABLE)
    with pytest.raises(RuntimeError, match="MuseClient") as raised:
        session.events(subagents=True)
    assert type(raised.value) is RuntimeError
    # The refusal covers only the opt-in: a plain stream still opens and closes.
    await session.events().aclose()  # type: ignore[attr-defined]
