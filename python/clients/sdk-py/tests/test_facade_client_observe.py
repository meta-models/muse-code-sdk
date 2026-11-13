"""``MuseClient`` lets a caller observe the connection it owns — every
notification (after an opened session applies it, on arrival for one held
while its session's open is in flight), protocol errors, and the connection
closing for any reason — and no observer's failure ends the connection.

Port of ``clients/sdk-ts/test/facade-client-observe.test.ts``. Causal, never
time-based: every async wait is a bounded loop-turn pump; the sync arm's
``wait_closed()`` ends at the hang-up the arm itself pushes.
"""

from __future__ import annotations

import asyncio
import threading
from typing import Any

import pytest

from muse_code import (
    ApprovalDecisionInput,
    MuseClient,
    MuseClientOptions,
    ResumeSessionOptions,
    SyncMuseClient,
    read_session_durability,
)
from muse_code.connection import Connection, ProtocolError
from muse_code.facade import client as client_module

from helpers_connection import FakeDuplex, answer, frame, pump, sent_frame, wait_for_writes

Params = dict[str, Any]

DURABLE = read_session_durability({"sessionDurability": "durable"})
SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}


def _client() -> "tuple[MuseClient[Any], Connection, FakeDuplex]":
    transport = FakeDuplex()
    connection = Connection(transport)
    client: MuseClient[Any] = MuseClient(connection, MuseClientOptions(durability=DURABLE))
    return client, connection, transport


def _notification(method: str, params: Params) -> str:
    return frame({"jsonrpc": "2.0", "method": method, "params": params})


def _view(method: str, **params: Any) -> str:
    return _notification(method, {"sessionId": "s-1", "sourceRange": SOURCE, **params})


async def _open_s1(client: MuseClient[Any], transport: FakeDuplex, cursor: str = "c-0") -> Any:
    opening = asyncio.ensure_future(client.start_session())
    await wait_for_writes(transport, 1)
    answer(transport, 0, {"session": {"sessionId": "s-1", "status": "idle"}, "viewCursor": cursor})
    return await opening


async def _settled(awaitable: Any) -> bool:
    """Whether ``awaitable`` has settled once the loop is drained; never a timer."""
    future = asyncio.ensure_future(awaitable)
    await pump(20)
    done = future.done()
    if not done:
        future.cancel()
    return done


def _item(item_id: str = "i-1") -> Params:
    return {"itemId": item_id, "kind": "toolCall", "revision": 1, "status": "inProgress"}


@pytest.mark.asyncio
async def test_a_notification_naming_no_session_reaches_every_listener() -> None:
    client, _, transport = _client()
    first: list[str] = []
    second: list[str] = []
    client.on_notification(lambda n: first.append(n["method"]))
    client.on_notification(lambda n: second.append(n["method"]))

    transport.chunks.push(_notification("usage/changed", {"usage": {}}))
    transport.chunks.push(_notification("account/loginCompleted", {"success": True}))
    await pump()

    assert first == ["usage/changed", "account/loginCompleted"]
    assert second == ["usage/changed", "account/loginCompleted"]


@pytest.mark.asyncio
async def test_a_session_notification_reaches_the_listener_only_after_its_session_folded_it() -> None:
    client, _, transport = _client()
    session = await _open_s1(client, transport)
    seen: list[tuple[str, bool]] = []
    client.on_notification(
        lambda n: seen.append((n["method"], session.fold.items.get("i-1") is not None))
    )

    transport.chunks.push(
        _notification("item/started", {"sessionId": "s-1", "item": _item(), "viewCursor": "c-1"})
    )
    await pump()

    assert seen == [("item/started", True)]


@pytest.mark.asyncio
async def test_a_frame_arriving_while_its_session_fills_a_gap_reaches_the_listener_before_the_buffered_fold() -> None:
    client, _, transport = _client()
    session = await _open_s1(client, transport, cursor="v:0")
    seen: list[tuple[str, bool]] = []
    client.on_notification(
        lambda n: seen.append((n["method"], session.fold.items.get("i-1") is not None))
    )

    # The gap starts a `view/page` walk; leaving it unanswered keeps the fill open.
    transport.chunks.push(
        _notification("view/gap", {"after": "v:0", "next": "v:5", "sessionId": "s-1"})
    )
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "view/page"
    transport.chunks.push(
        _notification("item/started", {"sessionId": "s-1", "item": _item(), "viewCursor": "v:6"})
    )
    await pump()

    assert seen == [("view/gap", False), ("item/started", False)]

    # Ending the view completes the fill: the buffered frame folds, and the
    # drain plays it to no listener a second time.
    answer(transport, 1, {"events": [], "nextCursor": None})
    await pump(20)
    assert session.fold.items.get("i-1") is not None
    assert len(seen) == 2


@pytest.mark.asyncio
async def test_a_frame_for_a_session_this_client_never_opens_reaches_the_listener() -> None:
    client, _, transport = _client()
    heard: list[str] = []

    def listener(n: Params) -> None:
        if (n.get("params") or {}).get("sessionId") == "s-2":
            heard.append(n["method"])

    client.on_notification(listener)
    # One `s-2` frame while `s-1`'s open is in flight (held, then cleared), one after.
    opening = asyncio.ensure_future(client.start_session())
    await wait_for_writes(transport, 1)
    transport.chunks.push(
        _notification(
            "turn/started", {"commandId": "c-1", "sessionId": "s-2", "turnId": "t-1", "viewCursor": "v:1"}
        )
    )
    await pump()
    answer(transport, 0, {"session": {"sessionId": "s-1", "status": "idle"}, "viewCursor": "c-0"})
    await opening
    transport.chunks.push(
        _notification(
            "turn/started", {"commandId": "c-2", "sessionId": "s-2", "turnId": "t-2", "viewCursor": "v:2"}
        )
    )
    await pump()

    assert heard == ["turn/started", "turn/started"]


@pytest.mark.asyncio
async def test_a_replay_in_the_resume_read_reaches_the_listener_once_in_wire_order_and_is_folded_on_return() -> None:
    client, _, transport = _client()
    heard: list[tuple[str, bool]] = []
    opened = False
    client.on_notification(lambda n: heard.append((n["method"], opened)))

    pending = asyncio.ensure_future(client.resume_session(ResumeSessionOptions(session_id="s-1")))
    await wait_for_writes(transport, 1)
    # The host flushes the replay before the result, all in one read; the
    # session-less frame between them pins wire order across the hold.
    transport.chunks.push(
        _view("turn/started", commandId="c-1", turnId="t-1", viewCursor="v:1")
        + _notification("usage/changed", {"usage": {}})
        + _view(
            "item/started",
            viewCursor="v:2",
            item={
                "itemId": "i-1",
                "kind": "agentMessage",
                "revision": 1,
                "sessionId": "s-1",
                "status": "inProgress",
                "turnId": "t-1",
            },
        )
        + frame(
            {
                "jsonrpc": "2.0",
                "id": sent_frame(transport, 0)["id"],
                "result": {
                    "session": {"sessionId": "s-1", "status": "idle"},
                    "history": {"mode": "none", "items": []},
                    "pendingRequests": [],
                    "viewCursor": "v:2",
                },
            }
        )
    )
    session = await pending
    opened = True
    await pump()

    assert heard == [("turn/started", False), ("usage/changed", False), ("item/started", False)]
    assert session.fold.items.get("i-1") is not None
    assert [turn.turn_id for turn in session.fold.turns()] == ["t-1"]


@pytest.mark.asyncio
async def test_a_resent_approval_or_user_input_request_reaches_its_session_never_the_listener() -> None:
    client, _, transport = _client()
    session = await _open_s1(client, transport)
    approvals: list[str] = []

    async def handler(request: Params) -> ApprovalDecisionInput:
        approvals.append(request["approvalId"])
        return ApprovalDecisionInput(choice_id="deny")

    session.on_approval(handler)
    heard: list[str] = []
    client.on_notification(lambda n: heard.append(n["method"]))

    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "approval/request",
                "params": {
                    "approvalId": "a-1",
                    "availableChoices": [
                        {"choiceId": "deny", "decision": "denied", "label": "Deny", "scope": "once"}
                    ],
                    "currentRequirementId": {"approvalId": "a-1", "sourceIndex": 0},
                    "itemId": "i-1",
                    "judgeEscalated": False,
                    "protectedWrite": False,
                    "rawArgs": "{}",
                    "sessionId": "s-1",
                    "sourceRange": SOURCE,
                    "subject": {"kind": "shell", "command": "ls"},
                    "taskId": "task-1",
                    "toolCallId": "call-1",
                    "toolName": "shell",
                    "turnId": "turn-1",
                    "viewCursor": "c-1",
                },
            }
        )
        + frame(
            {
                "jsonrpc": "2.0",
                "id": 8,
                "method": "userInput/request",
                "params": {
                    "itemId": "i-2",
                    "questions": [],
                    "sessionId": "s-1",
                    "toolCallId": "call-2",
                    "toolName": "ask",
                    "turnId": "turn-1",
                    "userInputId": "input-1",
                    "viewCursor": "c-2",
                },
            }
        )
    )
    await pump(30)

    import json

    receipts = [
        sent for sent in (json.loads(line) for line in transport.writes) if sent.get("id") in (7, 8)
    ]
    assert receipts == [
        {"jsonrpc": "2.0", "id": 7, "result": {}},
        {"jsonrpc": "2.0", "id": 8, "result": {}},
    ]
    assert approvals == ["a-1"]
    assert [entry["userInputId"] for entry in session.fold.pending_user_inputs()] == ["input-1"]
    assert heard == []


@pytest.mark.asyncio
async def test_unsubscribe_stops_one_listener_and_a_function_added_twice_is_two_subscriptions() -> None:
    client, _, transport = _client()
    dropped: list[str] = []
    twice: list[str] = []

    def listener(n: Params) -> None:
        twice.append(n["method"])

    unsubscribe = client.on_notification(lambda n: dropped.append(n["method"]))
    unsubscribe_first = client.on_notification(listener)
    client.on_notification(listener)

    transport.chunks.push(_notification("usage/changed", {"usage": {}}))
    await pump()
    unsubscribe()
    unsubscribe_first()
    transport.chunks.push(_notification("account/loginCompleted", {"success": True}))
    await pump()

    assert dropped == ["usage/changed"]
    assert twice == ["usage/changed", "usage/changed", "account/loginCompleted"]


@pytest.mark.asyncio
async def test_a_raising_listener_goes_to_every_error_observer_and_neither_starves_others_nor_closes() -> None:
    client, connection, transport = _client()
    first: list[tuple[BaseException, str]] = []
    second: list[str] = []
    kept: list[str] = []
    boom = RuntimeError("listener bug")
    client.on_notification_error(lambda error, n: first.append((error, n["method"])))
    unsubscribe_second = client.on_notification_error(lambda error, n: second.append(n["method"]))

    def raising(_: Params) -> None:
        raise boom

    client.on_notification(raising)
    client.on_notification(lambda n: kept.append(n["method"]))

    transport.chunks.push(_notification("usage/changed", {"usage": {}}))
    await pump()
    unsubscribe_second()
    transport.chunks.push(_notification("account/loginCompleted", {"success": True}))
    await pump()

    assert first == [(boom, "usage/changed"), (boom, "account/loginCompleted")]
    assert second == ["usage/changed"]
    assert kept == ["usage/changed", "account/loginCompleted"]
    assert not await _settled(connection.closed)


@pytest.mark.asyncio
async def test_an_async_listener_runs_and_its_exception_goes_to_the_error_observer() -> None:
    client, _, transport = _client()
    failures: list[tuple[BaseException, str]] = []
    ran: list[str] = []
    boom = RuntimeError("async listener bug")
    client.on_notification_error(lambda error, n: failures.append((error, n["method"])))

    async def listener(n: Params) -> None:
        await asyncio.sleep(0)
        ran.append(n["method"])
        raise boom

    client.on_notification(listener)
    transport.chunks.push(_notification("usage/changed", {"usage": {}}))
    await pump(20)

    assert ran == ["usage/changed"]
    assert failures == [(boom, "usage/changed")]


@pytest.mark.asyncio
async def test_no_error_observer_or_a_failing_one_keeps_the_pump_running() -> None:
    client, connection, transport = _client()
    kept: list[str] = []

    def raising(_: Params) -> None:
        raise RuntimeError("listener bug")

    client.on_notification(raising)
    client.on_notification(lambda n: kept.append(n["method"]))
    transport.chunks.push(_notification("usage/changed", {"usage": {}}))
    await pump()

    def failing_observer(error: BaseException, n: Params) -> None:
        raise RuntimeError("observer bug")

    async def async_failing_observer(error: BaseException, n: Params) -> None:
        raise RuntimeError("async observer bug")

    client.on_notification_error(failing_observer)
    client.on_notification_error(async_failing_observer)
    transport.chunks.push(_notification("account/loginCompleted", {"success": True}))
    await pump(20)

    assert kept == ["usage/changed", "account/loginCompleted"]
    assert not await _settled(connection.closed)


@pytest.mark.asyncio
async def test_a_client_nobody_observes_leaves_the_connections_own_protocol_error_handler() -> None:
    transport = FakeDuplex()
    connection = Connection(transport)
    own: list[ProtocolError] = []
    connection.on_protocol_error(own.append)
    MuseClient(connection, MuseClientOptions(durability=DURABLE))

    transport.chunks.push("not json\n")
    await pump()

    assert [error.line for error in own] == ["not json"]


@pytest.mark.asyncio
@pytest.mark.parametrize("interrupt", [KeyboardInterrupt, SystemExit, asyncio.CancelledError])
async def test_an_interrupt_from_a_listener_goes_back_to_the_loop_and_the_connection_stays_open(
    interrupt: type[BaseException], monkeypatch: pytest.MonkeyPatch
) -> None:
    client, connection, transport = _client()
    failures: list[BaseException] = []
    ran: list[str] = []
    reraised: list[BaseException] = []
    # The real hand-back raises out of the event loop; record it instead.
    monkeypatch.setattr(client_module, "_reraise", reraised.append)
    client.on_notification_error(lambda error, n: failures.append(error))

    def interrupted(n: Any) -> None:
        ran.append(n["method"])
        raise interrupt

    client.on_notification(interrupted)
    transport.chunks.push(_notification("usage/changed", {"usage": {}}))
    await pump()

    assert ran == ["usage/changed"]
    assert failures == [], "only Exception is routed to on_notification_error"
    assert [type(error) for error in reraised] == [interrupt]
    assert not await _settled(connection.closed), "the host is alive; the connection stays open"


class _Abort(BaseException):
    """A caller's own non-Exception signal."""


@pytest.mark.asyncio
async def test_an_async_listener_s_own_base_exception_goes_back_to_the_loop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, connection, transport = _client()
    failures: list[BaseException] = []
    reraised: list[BaseException] = []
    monkeypatch.setattr(client_module, "_reraise", reraised.append)
    client.on_notification_error(lambda error, n: failures.append(error))

    async def aborting(_: Any) -> None:
        await asyncio.sleep(0)
        raise _Abort

    client.on_notification(aborting)
    transport.chunks.push(_notification("usage/changed", {"usage": {}}))
    await pump(20)

    assert failures == []
    assert [type(error) for error in reraised] == [_Abort]
    assert not await _settled(connection.closed)


@pytest.mark.parametrize("interrupt", [KeyboardInterrupt, SystemExit])
def test_a_real_interrupt_from_a_listener_leaves_the_caller_s_run(interrupt: type[BaseException]) -> None:
    loop = asyncio.new_event_loop()
    try:

        async def build() -> "tuple[MuseClient[Any], FakeDuplex]":
            transport = FakeDuplex()
            return MuseClient(Connection(transport), MuseClientOptions(durability=DURABLE)), transport

        client, transport = loop.run_until_complete(build())

        def interrupted(_: Any) -> None:
            raise interrupt

        client.on_notification(interrupted)
        transport.chunks.push(_notification("usage/changed", {"usage": {}}))
        with pytest.raises(interrupt):
            loop.run_until_complete(pump(20))
        assert not loop.run_until_complete(_settled(client.closed)), "the connection stays open"
        loop.run_until_complete(client.close())
    finally:
        loop.close()


@pytest.mark.asyncio
async def test_a_refused_frame_reaches_every_protocol_error_handler_until_unsubscribed() -> None:
    client, _, transport = _client()
    first: list[ProtocolError] = []
    second: list[ProtocolError] = []
    client.on_protocol_error(first.append)
    unsubscribe_second = client.on_protocol_error(second.append)

    transport.chunks.push("not json\n")
    await pump()
    unsubscribe_second()
    transport.chunks.push("still not json\n")
    await pump()

    assert [error.line for error in first] == ["not json", "still not json"]
    assert [error.line for error in second] == ["not json"]


@pytest.mark.asyncio
async def test_a_failing_protocol_error_handler_neither_closes_the_connection_nor_stops_the_pump() -> None:
    client, _, transport = _client()
    calls: list[str] = []
    heard: list[str] = []
    client.on_notification(lambda n: heard.append(n["method"]))

    def raising(_: ProtocolError) -> None:
        calls.append("sync")
        raise RuntimeError("handler bug")

    async def async_raising(_: ProtocolError) -> None:
        calls.append("async")
        raise RuntimeError("async handler bug")

    client.on_protocol_error(raising)
    client.on_protocol_error(async_raising)
    transport.chunks.push("not json\n")
    await pump(20)
    transport.chunks.push(_notification("usage/changed", {"usage": {}}))
    await pump()

    assert calls == ["sync", "async"]
    assert heard == ["usage/changed"]
    assert not await _settled(client.closed)


@pytest.mark.asyncio
async def test_closed_stays_pending_while_live_then_settles_on_close() -> None:
    client, _, _ = _client()
    assert not await _settled(client.closed)
    await client.close()
    assert await _settled(client.closed)


@pytest.mark.asyncio
async def test_closed_stays_pending_while_live_then_settles_when_the_host_hangs_up() -> None:
    client, _, transport = _client()
    assert not await _settled(client.closed)
    transport.chunks.end()
    assert await _settled(client.closed)


def test_the_sync_twin_hears_notifications_while_a_verb_pumps_and_waits_for_the_close() -> None:
    transport = FakeDuplex()

    async def factory() -> MuseClient[Any]:
        return MuseClient(Connection(transport), MuseClientOptions(durability=DURABLE))

    client: SyncMuseClient[Any] = SyncMuseClient.create(factory)
    heard: list[str] = []
    refused: list[ProtocolError] = []
    failed: list[str] = []
    client.on_notification(lambda n: heard.append(n["method"]))
    unsubscribe = client.on_notification(lambda n: heard.append("unsubscribed listener"))
    unsubscribe()

    def raising(_: Any) -> None:
        raise RuntimeError("listener bug")

    client.on_notification(raising)
    client.on_notification_error(lambda error, n: failed.append(n["method"]))
    client.on_protocol_error(refused.append)
    try:
        # Nothing pumps the private loop until `wait_closed` does, so the frames
        # below are heard only if it blocks until the hang-up.
        transport.chunks.push(_notification("usage/changed", {"usage": {}}) + "not json\n")
        transport.chunks.end()
        assert heard == []
        waiter = threading.Thread(target=client.wait_closed, daemon=True)
        waiter.start()
        waiter.join(timeout=30)  # deadlock cap only; the green path is causal
        assert not waiter.is_alive()
        assert heard == ["usage/changed"]
        assert failed == ["usage/changed"]
        assert [error.line for error in refused] == ["not json"]
    finally:
        client.close()


def test_the_sync_twin_wait_closed_returns_after_its_own_close() -> None:
    transport = FakeDuplex()

    async def factory() -> MuseClient[Any]:
        return MuseClient(Connection(transport), MuseClientOptions(durability=DURABLE))

    client: SyncMuseClient[Any] = SyncMuseClient.create(factory)
    client.close()
    client.wait_closed()
