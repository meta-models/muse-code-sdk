"""PY-the governing rule halves of the connection contract: port of ``clients/sdk-ts/test/connection.test.ts``
— every runtime case, transport-less over the in-memory duplex harness.
"""

from __future__ import annotations

import asyncio
import json
import pathlib
from typing import Any

import pytest

from muse_code.connection import Connection, MspError, ProtocolError

from helpers_connection import (
    FakeDuplex,
    frame,
    pump,
    settlement,
    wait_for_writes,
)

Params = dict[str, Any]


@pytest.mark.asyncio
async def test_requests_are_newline_framed_awaited_and_correlated_by_typed_id() -> None:
    transport = FakeDuplex()
    connection = Connection(transport)
    first = connection.request("first/method", {"n": 1})
    second = connection.request("second/method", {"n": 2})
    await wait_for_writes(transport, 2)

    sent = [json.loads(line) for line in transport.writes]
    assert all(
        line.endswith("\n") and not line.endswith("\r\n") for line in transport.writes
    )
    assert sent[0]["id"] != sent[1]["id"], "in-flight request ids are unique"

    # Responses may arrive in either order, split across arbitrary chunks;
    # a preceding CR is tolerated on input.
    transport.chunks.push('{"jsonrpc":"2.0","id":2,"result":{"value":"two"}}\r')
    transport.chunks.push('\n{"jsonrpc":"2.0","id":1,"result":{"value":"one"}}\n')
    assert await second == {"value": "two"}
    assert await first == {"value": "one"}
    await connection.close()


@pytest.mark.asyncio
async def test_typed_errors_expose_data_kind_and_preserve_the_payload_verbatim() -> None:
    # the governing rule
    transport = FakeDuplex()
    connection = Connection(transport)
    pending = connection.request("session/userShell", {})
    await wait_for_writes(transport, 1)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "error": {
                    "code": -32010,
                    "message": "wording is not an API",
                    "data": {
                        "kind": "capabilityRequired",
                        "capability": "userShell",
                        "retryable": False,
                    },
                },
            }
        )
    )
    with pytest.raises(MspError) as observed:
        await pending
    assert observed.value.code == -32010
    assert observed.value.kind == "capabilityRequired"
    assert observed.value.retryable is False
    assert observed.value.data == {
        "kind": "capabilityRequired",
        "capability": "userShell",
        "retryable": False,
    }
    await connection.close()


@pytest.mark.asyncio
async def test_server_requests_use_their_own_id_space_and_notifications_reach_their_handler() -> None:
    transport = FakeDuplex()
    connection = Connection(transport)
    notifications: list[str] = []
    connection.on_notification(lambda n: notifications.append(str(n["method"])))

    async def handler(request: Params) -> Params:
        return {"echoed": request["method"]}

    connection.on_server_request(handler)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 41,
                "method": "approval/request",
                "params": {"approvalId": "a"},
            }
        )
        + frame(
            {
                "jsonrpc": "2.0",
                "method": "item/delta",
                "params": {"delta": "x"},
                "emittedAtMs": 1,
            }
        )
    )
    await wait_for_writes(transport, 1)
    assert json.loads(transport.writes[0]) == {
        "jsonrpc": "2.0",
        "id": 41,
        "result": {"echoed": "approval/request"},
    }
    assert notifications == ["item/delta"]
    await connection.close()


@pytest.mark.asyncio
async def test_nothing_admitted_retry_reuses_command_id_and_replay_ack_must_be_value_identical() -> None:
    # the governing rule / PY-the governing rule
    transport = FakeDuplex()
    minted = 0

    def mint() -> str:
        nonlocal minted
        minted += 1
        return f"018f6a1e-9b3c-7c21-a54a-{minted:012d}"

    connection = Connection(transport, mint_command_id=mint)
    params = {"sessionId": "s-1", "input": [{"type": "text", "text": "hello"}]}

    async def no_delay(_attempt: int, _error: MspError) -> None:
        return None

    command = connection.command(
        "turn/start", params, max_attempts=2, retry_delay=no_delay
    )
    await wait_for_writes(transport, 1)
    first = json.loads(transport.writes[0])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": first["id"],
                "error": {
                    "code": -32031,
                    "message": "full",
                    "data": {"kind": "backpressured", "capacity": 4},
                },
            }
        )
    )
    await wait_for_writes(transport, 2)
    retry = json.loads(transport.writes[1])
    assert retry["params"]["commandId"] == first["params"]["commandId"], (
        "one logical command, one id"
    )
    ack = {
        "commandId": retry["params"]["commandId"],
        "status": "accepted",
        "turnId": retry["params"]["commandId"],
    }
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": retry["id"], "result": ack}))
    assert await command == ack

    # An explicit reconnect-style replay uses the same id and must receive a
    # recursively value-identical ack (member order is irrelevant).
    replay = connection.command(
        "turn/start",
        params,
        command_id=str(retry["params"]["commandId"]),
        max_attempts=1,
    )
    await wait_for_writes(transport, 3)
    replay_frame = json.loads(transport.writes[2])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": replay_frame["id"],
                "result": {
                    "turnId": ack["turnId"],
                    "status": ack["status"],
                    "commandId": ack["commandId"],
                },
            }
        )
    )
    assert await replay == ack

    bad_replay = connection.command(
        "turn/start",
        params,
        command_id=str(retry["params"]["commandId"]),
        max_attempts=1,
    )
    await wait_for_writes(transport, 4)
    bad_frame = json.loads(transport.writes[3])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": bad_frame["id"],
                "result": {
                    "commandId": ack["commandId"],
                    "status": "accepted",
                    "turnId": "different",
                },
            }
        )
    )
    with pytest.raises(ProtocolError, match="value-identical"):
        await bad_replay
    await connection.close()


@pytest.mark.asyncio
async def test_a_session_start_result_may_omit_the_redundant_command_id_echo() -> None:
    # the governing rule omit arm 1.
    transport = FakeDuplex()
    connection = Connection(transport)
    pending = connection.command(
        "session/start",
        {"workspaceRoot": "/workspace"},
        command_id="018f6a1e-9b3c-7c21-a54a-000000000099",
    )
    await wait_for_writes(transport, 1)
    sent = json.loads(transport.writes[0])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": sent["id"],
                "result": {"session": {"sessionId": "s-1"}, "viewCursor": "v:s-1:1"},
            }
        )
    )
    assert await pending == {
        "session": {"sessionId": "s-1"},
        "viewCursor": "v:s-1:1",
    }
    await connection.close()


@pytest.mark.asyncio
async def test_a_session_resume_result_may_omit_the_redundant_command_id_echo() -> None:
    # the governing rule omit arm 2.
    transport = FakeDuplex()
    connection = Connection(transport)
    pending = connection.command(
        "session/resume",
        {"sessionId": "s-1"},
        command_id="018f6a1e-9b3c-7c21-a54a-00000000009a",
    )
    await wait_for_writes(transport, 1)
    sent = json.loads(transport.writes[0])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": sent["id"],
                "result": {"session": {"sessionId": "s-1"}, "viewCursor": "v:s-1:5"},
            }
        )
    )
    assert await pending == {
        "session": {"sessionId": "s-1"},
        "viewCursor": "v:s-1:5",
    }
    await connection.close()


@pytest.mark.asyncio
async def test_a_result_that_does_carry_command_id_must_still_echo_it_exactly() -> None:
    # the governing rule mismatch twin.
    transport = FakeDuplex()
    connection = Connection(transport)
    pending = connection.command(
        "session/start",
        {"workspaceRoot": "/workspace"},
        command_id="018f6a1e-9b3c-7c21-a54a-000000000099",
        max_attempts=1,
    )
    await wait_for_writes(transport, 1)
    sent = json.loads(transport.writes[0])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": sent["id"],
                "result": {"commandId": "different", "session": {"sessionId": "s-1"}},
            }
        )
    )
    with pytest.raises(ProtocolError, match="did not echo"):
        await pending
    await connection.close()


@pytest.mark.asyncio
async def test_a_contradictory_command_error_is_terminal_not_retryable() -> None:
    # the governing rule / the governing rule boundary: -32030 with a retryable-pair kind.
    transport = FakeDuplex()
    connection = Connection(
        transport, mint_command_id=lambda: "018f6a1e-9b3c-7c21-a54a-000000000099"
    )

    async def must_not_retry(_attempt: int, _error: MspError) -> None:
        pytest.fail("contradictory errors must not retry")

    command = connection.command(
        "turn/start", {"sessionId": "s-1"}, max_attempts=2, retry_delay=must_not_retry
    )
    await wait_for_writes(transport, 1)
    request = json.loads(transport.writes[0])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": request["id"],
                "error": {
                    "code": -32030,
                    "message": "durable rejection",
                    "data": {"kind": "overloaded", "reason": "command_id_conflict"},
                },
            }
        )
    )
    with pytest.raises(MspError) as observed:
        await command
    assert observed.value.code == -32030
    assert len(transport.writes) == 1
    await connection.close()


@pytest.mark.asyncio
async def test_a_malformed_or_oversized_inbound_line_is_reported_and_later_frames_still_work() -> None:
    # the governing rule
    transport = FakeDuplex()
    connection = Connection(transport, frame_limit_bytes=128)
    errors: list[ProtocolError] = []
    connection.on_protocol_error(errors.append)
    transport.chunks.push("not json\n")
    transport.chunks.push("x" * 129 + "\n")
    request = connection.request("still/works")
    await wait_for_writes(transport, 1)
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 1, "result": {}}))
    assert await request == {}
    assert len(errors) == 2
    assert errors[0].line == "not json", "the offending line is preserved as evidence"
    await connection.close()


@pytest.mark.asyncio
async def test_a_duplicate_injected_request_id_is_rejected_while_the_first_is_in_flight() -> None:
    transport = FakeDuplex()
    connection = Connection(transport, mint_request_id=lambda: 1)
    first = connection.request("first/method")
    await wait_for_writes(transport, 1)
    with pytest.raises(ProtocolError, match="already in flight"):
        await connection.request("second/method")
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 1, "result": {}}))
    assert await first == {}
    await connection.close()


@pytest.mark.asyncio
async def test_a_non_integer_injected_request_id_is_rejected_before_any_write() -> None:
    transport = FakeDuplex()
    connection = Connection(transport, mint_request_id=lambda: 1.5)  # type: ignore[arg-type,return-value]
    with pytest.raises(ProtocolError, match="string or integer"):
        await connection.request("bad/id")
    assert transport.writes == [], "the malformed frame never reaches the wire"
    await connection.close()


@pytest.mark.asyncio
async def test_flush_rethrows_a_transport_write_failure_instead_of_swallowing_it() -> None:
    class OnceFailingDuplex(FakeDuplex):
        def __init__(self) -> None:
            super().__init__()
            self._failed = False

        async def write(self, chunk: str) -> None:
            if not self._failed:
                self._failed = True
                raise OSError("synthetic write failure")
            await super().write(chunk)

    transport = OnceFailingDuplex()
    connection = Connection(transport)
    connection.notify("doomed/notification")
    with pytest.raises(OSError, match="synthetic write failure"):
        await connection.flush()


@pytest.mark.asyncio
async def test_a_cancelled_requests_late_reply_is_dropped_not_fatal() -> None:
    # a prior review: cancelling a request (asyncio.wait_for
    # timeout included) then receiving the host's late reply must drop the
    # reply and keep the connection healthy — settling the done future used
    # to raise InvalidStateError inside the read loop and finish the
    # connection, rejecting every other in-flight request.
    transport = FakeDuplex()
    connection = Connection(transport)
    first = connection.request("session/read", {"a": 1})
    second = connection.request("session/read", {"b": 2})
    await wait_for_writes(transport, 2)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    first_id = json.loads(transport.writes[0])["id"]
    second_id = json.loads(transport.writes[1])["id"]
    # The late reply to the cancelled request: dropped, not fatal.
    transport.chunks.push(
        json.dumps({"jsonrpc": "2.0", "id": first_id, "result": {"late": True}})
        + "\n"
    )
    await pump()
    assert not connection.closed.done(), "the connection must survive a late reply"
    # The OTHER in-flight request still settles normally.
    transport.chunks.push(
        json.dumps({"jsonrpc": "2.0", "id": second_id, "result": {"ok": True}})
        + "\n"
    )
    await pump()
    assert (await second) == {"ok": True}
    await connection.close()


@pytest.mark.asyncio
async def test_command_stops_after_max_attempts_of_backpressure() -> None:
    # a prior review: the retry loop is BOUNDED —
    # a host that answers `backpressured` on every attempt gets exactly
    # max_attempts frames, all under one commandId, then the typed error.
    transport = FakeDuplex()
    connection = Connection(transport)
    waits: list[int] = []

    async def no_sleep(attempt: int, _error: MspError) -> None:
        if attempt >= 2:
            # Bounded RED for the loop-unbounded mutant: a third attempt
            # would first schedule this delay — fail here, never hang.
            pytest.fail("retry past max_attempts=2")
        waits.append(attempt)

    command = connection.command(
        "turn/start", {"n": 1}, max_attempts=2, retry_delay=no_sleep
    )
    await wait_for_writes(transport, 1)
    first = json.loads(transport.writes[0])
    backpressured = {
        "code": -32031,
        "message": "busy",
        "data": {"kind": "backpressured", "retryable": True},
    }
    transport.chunks.push(
        frame({"jsonrpc": "2.0", "id": first["id"], "error": backpressured})
    )
    await wait_for_writes(transport, 2)
    second = json.loads(transport.writes[1])
    assert second["params"]["commandId"] == first["params"]["commandId"], (
        "the retry reuses the SAME commandId"
    )
    transport.chunks.push(
        frame({"jsonrpc": "2.0", "id": second["id"], "error": backpressured})
    )
    with pytest.raises(MspError) as excinfo:
        await command
    assert excinfo.value.kind == "backpressured"
    assert len(transport.writes) == 2, "exactly max_attempts frames were sent"
    assert waits == [1], "one delay between the two attempts, none after the last"
    await connection.close()


@pytest.mark.asyncio
async def test_input_too_large_is_never_auto_retried() -> None:
    # a prior review: `inputTooLarge` is not in the
    # retryable pair — the delay hook firing at all is the failure.
    transport = FakeDuplex()
    connection = Connection(transport)

    async def must_not_wait(_attempt: int, _error: MspError) -> None:
        pytest.fail("inputTooLarge must never schedule a retry")

    command = connection.command(
        "turn/start", {"n": 1}, max_attempts=3, retry_delay=must_not_wait
    )
    await wait_for_writes(transport, 1)
    sent = json.loads(transport.writes[0])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": sent["id"],
                "error": {
                    "code": -32002,
                    "message": "too big",
                    "data": {"kind": "inputTooLarge", "retryable": False},
                },
            }
        )
    )
    with pytest.raises(MspError) as excinfo:
        await command
    assert excinfo.value.kind == "inputTooLarge"
    assert len(transport.writes) == 1, "no second frame was ever sent"
    await connection.close()


@pytest.mark.asyncio
async def test_command_immediately_followed_by_close_still_writes_the_frame() -> None:
    # a prior review: command() is EAGER — the first attempt
    # joins the submit tail before it returns, so a close() on the very next
    # line still delivers the frame instead of silently dropping it.
    transport = FakeDuplex()
    connection = Connection(transport)
    command = connection.command("turn/start", {"n": 1}, max_attempts=1)
    await connection.close()
    methods = [json.loads(line).get("method") for line in transport.writes]
    assert "turn/start" in methods, (
        f"the first attempt was in flight before close captured the tail: {methods}"
    )
    state, value = await settlement(command)
    assert state == "rejected", "close() then settles the pending ack wait"
    assert isinstance(value, Exception)


@pytest.mark.asyncio
async def test_a_non_encodable_frame_rejects_only_itself_never_the_connection() -> None:
    # a prior review: a lone surrogate (an os.fsdecode filename)
    # survives json.dumps but fails the transport's UTF-8 encode. That is the
    # CALLER's defect: the one frame rejects typed, the connection and every
    # sibling in flight stay alive.
    transport = FakeDuplex()
    connection = Connection(transport)
    innocent = connection.request("innocent/sibling")
    await wait_for_writes(transport, 1)

    bad = connection.request("bad/frame", {"path": "\udcff"})
    state, value = await settlement(bad)
    assert state == "rejected", "the bad frame settles, never hangs"
    assert isinstance(value, ProtocolError)
    assert "not JSON/UTF-8 encodable" in value.message

    # notify() detects the same defect synchronously: an immediate typed
    # raise, never a silent drop and never a finished connection.
    with pytest.raises(ProtocolError, match="not JSON/UTF-8 encodable"):
        connection.notify("bad/notify", {"path": "\udcff"})
    await pump(4)

    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}))
    assert await innocent == {"ok": True}, "the sibling request still resolves"
    closed_state, _ = await settlement(connection.closed, turns=8)
    assert closed_state == "pending", "one bad frame never finishes the connection"
    await connection.close()


@pytest.mark.asyncio
async def test_a_non_encodable_handler_reply_answers_the_peer_and_survives() -> None:
    # a prior review, round 4 (zdwmeta + reviewkit): the THIRD writer —
    # server-request replies — must not treat a handler's lone surrogate as
    # transport death either: the peer is still waiting on that id, so it
    # gets a fixed-ASCII -32603 instead, and the connection plus every
    # sibling in flight stays alive.
    transport = FakeDuplex()
    connection = Connection(transport)
    innocent = connection.request("innocent/sibling")
    await wait_for_writes(transport, 1)

    async def surrogate_reply(_request: dict[str, Any]) -> dict[str, Any]:
        return {"path": "\udcff"}

    connection.on_server_request(surrogate_reply)
    transport.chunks.push(
        frame({"jsonrpc": "2.0", "id": 41, "method": "approval/request"})
    )
    await wait_for_writes(transport, 2)
    reply = json.loads(transport.writes[1])
    assert reply["id"] == 41, "the peer's id is answered, never left waiting"
    assert reply["error"]["code"] == -32603
    assert reply["error"]["data"]["kind"] == "internal"
    assert "non-encodable" in reply["error"]["message"]

    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}))
    assert await innocent == {"ok": True}, "the sibling request still resolves"
    closed_state, _ = await settlement(connection.closed, turns=8)
    assert closed_state == "pending", "the handler defect never finishes the connection"
    await connection.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_value",
    [
        pytest.param(pathlib.Path("/x"), id="path-not-json"),
        pytest.param(float("nan"), id="nan-float"),
    ],
)
async def test_a_request_with_a_non_serializable_param_rejects_and_frees_the_id(
    bad_value: object,
) -> None:
    # a prior review: a param that cannot become valid JSON — a Path
    # (TypeError) or a NaN/Infinity float (ValueError under allow_nan=False,
    # else a bare `NaN` token the host can't parse) — must reject request()'s
    # own future AND pop the pending id, never strand it "in flight" nor hang
    # the caller until EOF, while the connection stays healthy.
    transport = FakeDuplex()
    # A fixed request id: the id-freed contract is oracled publicly — if the
    # doomed frame stranded its pending entry, REUSING the id would reject
    # with "already in flight" rather than write and correlate (Constitution
    # X: pin behavior through the public surface, not `_pending`).
    connection = Connection(transport, mint_request_id=lambda: 7)
    doomed = connection.request("m", {"p": bad_value})
    state, value = await settlement(doomed)
    assert state == "rejected", "the un-serializable frame settles, never hangs"
    assert isinstance(value, ProtocolError)

    # Reuse id 7: a stranded id would reject this; instead it writes and
    # correlates, proving the id was freed and the connection is healthy.
    alive = connection.request("still/works")
    await wait_for_writes(transport, 1)
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 7, "result": {"ok": True}}))
    assert await alive == {"ok": True}
    await connection.close()


@pytest.mark.asyncio
async def test_a_command_with_a_non_serializable_param_rejects_its_future() -> None:
    # a prior review, round 18 (sechegaray): command() promises a future,
    # but _canonical ran json.dumps before the frame reached _enqueue_write —
    # a non-JSON param (a Path) leaked a raw synchronous TypeError while the
    # same params through request() reject with ProtocolError. The signature
    # step now settles the same typed the governing rule rejection, nothing is
    # stranded, and the connection stays healthy.
    transport = FakeDuplex()
    connection = Connection(transport, mint_request_id=lambda: 7)
    doomed = connection.command("m", {"p": pathlib.Path("/x")})
    state, value = await settlement(doomed)
    assert state == "rejected", "the un-serializable command settles, never raises"
    assert isinstance(value, ProtocolError)

    # The connection is untouched: a request writes and correlates normally.
    alive = connection.request("still/works")
    await wait_for_writes(transport, 1)
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 7, "result": {"ok": True}}))
    assert await alive == {"ok": True}
    await connection.close()


@pytest.mark.asyncio
async def test_a_raised_msp_error_with_unserializable_data_answers_the_peer() -> None:
    # a prior review, round 7 (reviewkit): a handler that RAISES MspError
    # whose data is not JSON-serializable (a set) must not kill the
    # connection — the error reply itself is unencodable, so the peer's id is
    # answered with the fixed-ASCII -32603 fallback.
    transport = FakeDuplex()
    connection = Connection(transport)
    innocent = connection.request("innocent/sibling")
    await wait_for_writes(transport, 1)

    async def boom(_request: dict[str, Any]) -> dict[str, Any]:
        raise MspError(
            {
                "code": -32010,
                "message": "nope",
                "data": {"kind": "capabilityRequired", "extra": {1, 2, 3}},
            }
        )

    connection.on_server_request(boom)
    transport.chunks.push(
        frame({"jsonrpc": "2.0", "id": 51, "method": "approval/request"})
    )
    await wait_for_writes(transport, 2)
    reply = json.loads(transport.writes[1])
    assert reply["id"] == 51, "the peer's id is answered, never left waiting"
    assert reply["error"]["code"] == -32603
    assert reply["error"]["data"]["kind"] == "internal"

    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}))
    assert await innocent == {"ok": True}, "the sibling request still resolves"
    closed_state, _ = await settlement(connection.closed, turns=8)
    assert closed_state == "pending", "the handler defect never finishes the connection"
    await connection.close()


@pytest.mark.asyncio
async def test_command_retries_overloaded_on_the_same_command_id() -> None:
    # a prior review, round 10 (sechegaray): the governing rule retries BOTH
    # `-32001 overloaded` and `-32031 backpressured` on the same commandId;
    # every other retry arm only exercises backpressured, so the overloaded
    # half can regress with its task still ticked. This is its twin.
    transport = FakeDuplex()
    connection = Connection(transport)

    async def no_sleep(_attempt: int, _error: MspError) -> None:
        return None

    command = connection.command(
        "turn/start", {"n": 1}, max_attempts=2, retry_delay=no_sleep
    )
    await wait_for_writes(transport, 1)
    first = json.loads(transport.writes[0])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": first["id"],
                "error": {
                    "code": -32001,
                    "message": "overloaded",
                    "data": {"kind": "overloaded", "retryable": True},
                },
            }
        )
    )
    await wait_for_writes(transport, 2)
    retry = json.loads(transport.writes[1])
    assert retry["params"]["commandId"] == first["params"]["commandId"], (
        "overloaded retries reuse the SAME commandId"
    )
    ack = {"commandId": retry["params"]["commandId"], "status": "accepted"}
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": retry["id"], "result": ack}))
    assert await command == ack
    await connection.close()
