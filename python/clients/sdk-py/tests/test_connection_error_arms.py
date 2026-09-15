"""PY-TEST-016 ``connection_error_arm_coverage`` + the UUIDv7 mint arm of
PY-TEST-010 (spec 638 FR-638-011/013/014/015, FM-007/FM-009, INV-012/013):
port of ``clients/sdk-ts/test/connection-error-arms.test.ts``.

Every fail-closed error arm of :class:`Connection` is reached by a
violating frame. The TS split-surrogate byte-drift arm has no Python twin
(Python strings are whole code points, spec 638 Edge Cases); its
chunk-split/empty-chunk/interleaved delivery shapes are ported against the
byte counter as-is. The TS ``unhandledRejection`` arms port as
loop-exception-handler + ``gc.collect()`` checks — CPython's refcounting
surfaces a never-retrieved task exception deterministically at collection.
"""

from __future__ import annotations

import asyncio
import gc
import json
import re
from typing import Any

import pytest

from muse_code.connection import Connection, MspError, ProtocolError

from helpers_connection import (
    AsyncChunks,
    BrokenWriteDuplex,
    FakeDuplex,
    frame,
    pump,
    settlement,
    wait_for_writes,
)

Params = dict[str, Any]


def utf8_bytes(text: str) -> int:
    return len(text.encode("utf-8", "surrogatepass"))


@pytest.mark.asyncio
async def test_line_shape_violations_each_surface_a_protocol_error_and_never_tear_down() -> None:
    transport = FakeDuplex()
    connection = Connection(transport)
    errors: list[ProtocolError] = []
    connection.on_protocol_error(errors.append)

    transport.chunks.push("not json\n")  # non-JSON line
    transport.chunks.push("[1,2]\n")  # JSON, not an object
    transport.chunks.push('{"jsonrpc":"1.0","id":1,"result":{}}\n')  # wrong jsonrpc
    transport.chunks.push('{"jsonrpc":"2.0","result":{}}\n')  # response, no usable id
    transport.chunks.push('{"jsonrpc":"2.0","id":99,"result":{}}\n')  # unknown id
    transport.chunks.push('{"jsonrpc":"2.0","id":"s-1","method":"m"}\n')  # string srv id
    transport.chunks.push('{"jsonrpc":"2.0","id":0,"method":"m"}\n')  # non-positive id

    alive = connection.request("still/works")
    await wait_for_writes(transport, 1)
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}}))
    assert await alive == {"ok": True}, (
        "one bad frame never tears the transport down (FM-007)"
    )

    messages = [error.message for error in errors]
    assert any("not valid JSON" in m for m in messages), "non-JSON line arm"
    assert (
        len([m for m in messages if "not a JSON-RPC 2.0 object" in m]) == 2
    ), "array and wrong-jsonrpc arms"
    assert any("no usable id" in m for m in messages), "no-usable-id arm"
    assert any("unknown request id 99" in m for m in messages), "unknown-id arm"
    assert (
        len(
            [
                m
                for m in messages
                if "server request id must be a positive integer" in m
            ]
        )
        == 2
    ), "string and non-positive server-request-id arms"
    await connection.close()


@pytest.mark.asyncio
async def test_a_matched_malformed_response_rejects_the_caller_never_hangs_it() -> None:
    # FR-638-013 (14990 FR-014).
    transport = FakeDuplex()
    connection = Connection(transport)
    errors: list[ProtocolError] = []
    connection.on_protocol_error(errors.append)

    # Arm 1: result AND error both set.
    both = connection.request("malformed/both")
    await wait_for_writes(transport, 1)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "result": {},
                "error": {"code": -32603, "message": "x", "data": {"kind": "internal"}},
            }
        )
    )
    both_state, both_value = await settlement(both)
    assert both_state == "rejected", "the matched caller must settle, not hang"
    assert isinstance(both_value, ProtocolError)
    assert "exactly one of result or error" in both_value.message

    # Arm 2: NEITHER result nor error.
    neither = connection.request("malformed/neither")
    await wait_for_writes(transport, 2)
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 2}))
    neither_state, neither_value = await settlement(neither)
    assert neither_state == "rejected", "the neither-member caller must settle too"
    assert isinstance(neither_value, ProtocolError)

    # The violation is still reported as a protocol error alongside the reject.
    assert any("exactly one of result or error" in e.message for e in errors)

    # The connection stays alive after both violations.
    alive = connection.request("still/works")
    await wait_for_writes(transport, 3)
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 3, "result": {}}))
    assert await alive == {}
    await connection.close()


@pytest.mark.asyncio
async def test_malformed_matched_response_payloads_reject_with_the_sibling_arms_errors() -> None:
    transport = FakeDuplex()
    connection = Connection(transport)

    non_object = connection.request("bad/result")
    await wait_for_writes(transport, 1)
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 1, "result": 5}))
    with pytest.raises(ProtocolError, match="result must be an object"):
        await non_object

    bad_error = connection.request("bad/error")
    await wait_for_writes(transport, 2)
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 2, "error": {"code": "nope"}}))
    with pytest.raises(ProtocolError, match="invalid error object"):
        await bad_error

    no_kind = connection.request("bad/kind")
    await wait_for_writes(transport, 3)
    transport.chunks.push(
        frame({"jsonrpc": "2.0", "id": 3, "error": {"code": -1, "message": "m"}})
    )
    with pytest.raises(ProtocolError, match="no data.kind"):
        await no_kind
    await connection.close()


@pytest.mark.asyncio
async def test_request_after_close_command_id_reuse_and_a_non_echoing_ack_all_fail_closed() -> None:
    transport = FakeDuplex()
    connection = Connection(
        transport, mint_command_id=lambda: "018f6a1e-9b3c-7c21-a54a-000000000001"
    )

    # A non-echoing ack rejects (FR-638-015 / 14990 FR-016).
    command = connection.command("turn/start", {"n": 1}, max_attempts=1)
    await wait_for_writes(transport, 1)
    sent = json.loads(transport.writes[0])
    transport.chunks.push(
        frame({"jsonrpc": "2.0", "id": sent["id"], "result": {"commandId": "different"}})
    )
    with pytest.raises(ProtocolError, match="did not echo"):
        await command

    # Reusing a commandId with a different payload rejects (INV-013).
    with pytest.raises(ProtocolError, match="reused with a different payload"):
        await connection.command(
            "turn/start",
            {"n": 2},
            command_id="018f6a1e-9b3c-7c21-a54a-000000000001",
            max_attempts=1,
        )

    # Requests after close reject immediately.
    await connection.close()
    with pytest.raises(ProtocolError, match="connection is closed"):
        await connection.request("late/call")


@pytest.mark.asyncio
async def test_the_no_handler_and_handler_failure_replies_are_written() -> None:
    # FR-638-014 (-32601 / -32603 arms).
    no_handler = FakeDuplex()
    bare = Connection(no_handler)
    no_handler.chunks.push(frame({"jsonrpc": "2.0", "id": 7, "method": "approval/request"}))
    await wait_for_writes(no_handler, 1)
    reply = json.loads(no_handler.writes[0])
    assert reply["id"] == 7
    assert reply["error"]["code"] == -32601
    assert reply["error"]["data"]["kind"] == "methodNotFound"
    await bare.close()

    throwing = FakeDuplex()
    handled = Connection(throwing)

    async def boom(_request: Params) -> Params:
        raise RuntimeError("boom")

    handled.on_server_request(boom)
    throwing.chunks.push(frame({"jsonrpc": "2.0", "id": 8, "method": "approval/request"}))
    await wait_for_writes(throwing, 1)
    failure = json.loads(throwing.writes[0])
    assert failure["id"] == 8
    assert failure["error"]["code"] == -32603
    assert failure["error"]["message"] == "boom"
    assert failure["error"]["data"]["kind"] == "internal"
    await handled.close()


@pytest.mark.asyncio
async def test_eof_mid_frame_surfaces_the_dangling_buffer_and_settles_closed() -> None:
    transport = FakeDuplex()
    connection = Connection(transport)
    errors: list[ProtocolError] = []
    connection.on_protocol_error(errors.append)
    pending = connection.request("never/answered")
    await wait_for_writes(transport, 1)
    transport.chunks.push('{"jsonrpc":"2.0","id":1,"resu')  # no newline, then EOF
    transport.chunks.end()
    await connection.closed
    assert any("ended without a newline" in e.message for e in errors)
    # Bounded: an unbounded await here would wedge the suite (not go RED)
    # under a mutation that settles closed without rejecting pending requests.
    state, value = await settlement(pending)
    assert state == "rejected", "EOF rejects the dangling request"
    assert isinstance(value, ProtocolError)
    assert re.search("EOF", value.message)


@pytest.mark.asyncio
async def test_the_oversized_drop_resume_path_drops_exactly_one_frame_and_bounds_the_evidence() -> None:
    # FM-007, both oversized arms, evidence bounded in UTF-8 bytes.
    transport = FakeDuplex()
    limit = 128
    connection = Connection(transport, frame_limit_bytes=limit)
    errors: list[ProtocolError] = []
    connection.on_protocol_error(errors.append)

    pending = connection.request("survives/oversize")
    await wait_for_writes(transport, 1)

    # Mid-buffer overflow: a multibyte >limit chunk, NO newline (60 x '€' = 180 bytes).
    transport.chunks.push("€" * 60)
    await pump(4)
    assert len(errors) == 1, "the mid-buffer overflow arm fired"
    assert f"exceeds {limit} bytes" in errors[0].message
    assert utf8_bytes(errors[0].line or "") <= limit, (
        f"mid-buffer evidence is byte-bounded (got {utf8_bytes(errors[0].line or '')})"
    )

    # The oversized frame's tail arrives as MANY newline-free chunks before
    # its terminating newline — exactly how the 64 KiB stdout reader delivers
    # a >10 MiB frame (spawn.py). The `if newline < 0: return` keep-dropping
    # arm of _ingest must swallow each without re-tripping the limit; without
    # it every chunk re-buffers and re-fires on_protocol_error (PR #30094
    # review, round 7).
    transport.chunks.push("x" * 200)
    transport.chunks.push("y" * 200)
    await pump(4)
    assert len(errors) == 1, "the keep-dropping arm swallows tail chunks silently"
    # The tail newline ends the dropped frame; the next frame parses (drop-flag cleanup).
    transport.chunks.push("tail-of-oversized-frame\n")
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 1, "result": {"revived": True}}))
    assert await pending == {"revived": True}, "the frame after the drop parses cleanly"
    assert len(errors) == 1, "the dropped tail itself raises no second error"

    # Complete oversized line arriving whole (with newline) in one chunk.
    transport.chunks.push("€" * 60 + "\n")
    await pump(4)
    assert len(errors) == 2, "the complete-oversized-line arm fired"
    assert utf8_bytes(errors[1].line or "") <= limit, (
        f"complete-line evidence is byte-bounded (got {utf8_bytes(errors[1].line or '')})"
    )
    await connection.close()


@pytest.mark.asyncio
async def test_a_failed_reply_write_finishes_the_connection_and_never_escapes_unhandled() -> None:
    # FM-009, RESULT-reply arm.
    loop = asyncio.get_running_loop()
    unhandled: list[object] = []
    previous_handler = loop.get_exception_handler()
    loop.set_exception_handler(lambda _l, context: unhandled.append(context))
    try:
        transport = BrokenWriteDuplex()
        connection = Connection(transport)

        async def approve(_request: Params) -> Params:
            return {"approved": True}

        connection.on_server_request(approve)
        transport.chunks.push(frame({"jsonrpc": "2.0", "id": 41, "method": "approval/request"}))
        state, _ = await settlement(connection.closed)
        assert state == "resolved", "the write failure finishes the connection"
        await connection.close()
        del connection, transport
        await pump(20)
        gc.collect()
        await pump(5)
        assert unhandled == [], "no unhandled task exception escapes the reply write"
    finally:
        loop.set_exception_handler(previous_handler)


@pytest.mark.asyncio
async def test_a_reply_write_failing_with_a_request_in_flight_settles_closed_and_rejects_pending() -> None:
    # FM-009, fifth-guard case: only server-response frames fail.
    class ResponseWriteBrokenDuplex(FakeDuplex):
        async def write(self, chunk: str) -> None:
            parsed = json.loads(chunk)
            if "result" in parsed or "error" in parsed:
                raise OSError("EPIPE: broken pipe")
            await super().write(chunk)

    loop = asyncio.get_running_loop()
    unhandled: list[object] = []
    previous_handler = loop.get_exception_handler()
    loop.set_exception_handler(lambda _l, context: unhandled.append(context))
    try:
        transport = ResponseWriteBrokenDuplex()
        connection = Connection(transport)

        async def approve(_request: Params) -> Params:
            return {"approved": True}

        connection.on_server_request(approve)

        # The outbound request write succeeds; only the reply write dies.
        pending = connection.request("client/inflight")
        await pump(4)
        assert len(transport.writes) == 1, "the client request reached the transport"

        transport.chunks.push(frame({"jsonrpc": "2.0", "id": 41, "method": "approval/request"}))
        closed_state, _ = await settlement(connection.closed)
        assert closed_state == "resolved", "the reply-write failure finishes the connection"
        state, value = await settlement(pending)
        assert state == "rejected", "the pending request rejects when the reply write dies"
        assert isinstance(value, Exception)
        assert "EPIPE" in str(value)
        await connection.close()
        del connection, transport
        await pump(20)
        gc.collect()
        await pump(5)
        assert unhandled == [], "no unhandled task exception escapes (FM-009)"
    finally:
        loop.set_exception_handler(previous_handler)


@pytest.mark.asyncio
async def test_a_failed_error_reply_write_finishes_the_connection_and_never_escapes_unhandled() -> None:
    # FM-009, ERROR-reply arm.
    loop = asyncio.get_running_loop()
    unhandled: list[object] = []
    previous_handler = loop.get_exception_handler()
    loop.set_exception_handler(lambda _l, context: unhandled.append(context))
    try:
        transport = BrokenWriteDuplex()
        connection = Connection(transport)

        async def boom(_request: Params) -> Params:
            raise RuntimeError("boom")

        connection.on_server_request(boom)
        transport.chunks.push(frame({"jsonrpc": "2.0", "id": 42, "method": "approval/request"}))
        state, _ = await settlement(connection.closed)
        assert state == "resolved", "the error-reply write failure finishes the connection"
        await connection.close()
        del connection, transport
        await pump(20)
        gc.collect()
        await pump(5)
        assert unhandled == [], "no unhandled task exception escapes the error reply"
    finally:
        loop.set_exception_handler(previous_handler)


@pytest.mark.asyncio
async def test_the_default_command_id_mint_produces_distinct_rfc9562_uuidv7_ids() -> None:
    # PY-TEST-010's INV-013 mint arm (TS TEST-016).
    transport = FakeDuplex()
    connection = Connection(transport)  # no mint_command_id injected
    v7 = re.compile(
        r"^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    )

    first = connection.command("turn/start", {"n": 1}, max_attempts=1)
    await wait_for_writes(transport, 1)
    first_sent = json.loads(transport.writes[0])
    first_id = first_sent["params"]["commandId"]
    assert v7.fullmatch(first_id), "the minted id is v7-shaped with the 10xx variant"
    transport.chunks.push(
        frame({"jsonrpc": "2.0", "id": first_sent["id"], "result": {"commandId": first_id}})
    )
    await first

    second = connection.command("turn/start", {"n": 2}, max_attempts=1)
    await wait_for_writes(transport, 2)
    second_sent = json.loads(transport.writes[1])
    second_id = second_sent["params"]["commandId"]
    assert v7.fullmatch(second_id)
    assert second_id != first_id, "two logical commands mint distinct ids"
    transport.chunks.push(
        frame({"jsonrpc": "2.0", "id": second_sent["id"], "result": {"commandId": second_id}})
    )
    await second
    await connection.close()


@pytest.mark.asyncio
async def test_chunk_split_multibyte_frames_never_drift_the_byte_counter() -> None:
    # The TS TEST-017 delivery shapes (split, empty-chunk-between, interleaved)
    # against the running byte counter; the surrogate-reconciliation arms have
    # no Python twin (module docstring).
    transport = FakeDuplex()
    limit = 64
    connection = Connection(transport, frame_limit_bytes=limit)
    errors: list[ProtocolError] = []
    connection.on_protocol_error(errors.append)

    async def ok(_request: Params) -> Params:
        return {"ok": True}

    connection.on_server_request(ok)

    frames = 40
    for k in range(1, frames + 1):
        line = frame({"jsonrpc": "2.0", "id": k, "method": "m\U0001f600"})
        split = line.index("\U0001f600") + 1  # cut right after the astral char
        transport.chunks.push(line[:split])
        if k % 2 == 0:
            # An empty chunk between the halves must not disturb accounting:
            # DuplexTransport is public, so '' chunks are legal.
            transport.chunks.push("")
        transport.chunks.push(line[split:])
        await pump(4)

    # Interleaved chunking: one chunk carries frame k's newline PLUS frame
    # k+1's prefix through the astral char; the newline rides the NEXT chunk.
    extra = 40
    carried = ""
    for k in range(1, extra + 1):
        line = frame({"jsonrpc": "2.0", "id": frames + k, "method": "m\U0001f600"})
        split = line.index("\U0001f600") + 1
        transport.chunks.push(carried + line[:split])
        rest = line[split:]
        transport.chunks.push(rest[:-1])  # body, NO newline
        carried = rest[-1]  # the newline rides the next chunk
        await pump(4)
    transport.chunks.push(carried)
    await pump(10)
    assert [e.message for e in errors] == [], "no legal frame ever trips the limit"
    assert len(transport.writes) == frames + extra, (
        "every split frame parsed and was replied to"
    )
    await connection.close()


@pytest.mark.asyncio
async def test_a_whitespace_only_inbound_line_is_ignored_like_an_empty_line() -> None:
    # The client-local tolerance beyond SS1.1 (DECISIONS #15).
    transport = FakeDuplex()
    connection = Connection(transport)
    errors: list[ProtocolError] = []
    connection.on_protocol_error(errors.append)

    async def ok(_request: Params) -> Params:
        return {"ok": True}

    connection.on_server_request(ok)

    transport.chunks.push("   \n")  # whitespace-only: a separator, not a frame
    transport.chunks.push("\t\r\n")  # tabs + CR count as whitespace too
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": 7, "method": "m"}))
    await pump(8)

    assert [e.message for e in errors] == [], "whitespace-only lines raise no error"
    assert len(transport.writes) == 1, "the frame after the separators still parses"
    await connection.close()


@pytest.mark.asyncio
async def test_a_request_whose_own_write_fails_rejects_the_caller() -> None:
    # PR #30094 review, thread 21 (FR-638-013): the request's OWN write
    # failing must reject the caller — with the rejection dropped or the
    # pending entry registered only after a successful write, a caller on a
    # dead pipe hangs forever while the whole suite stays green.
    transport = BrokenWriteDuplex()
    connection = Connection(transport)
    pending = connection.request("doomed/request")
    state, value = await settlement(pending)
    assert state == "rejected", "a dead-pipe request settles, never hangs"
    assert isinstance(value, Exception)
    assert "EPIPE" in str(value)
    await connection.close()


@pytest.mark.asyncio
async def test_a_close_less_transport_still_settles_pending_requests_on_close() -> None:
    # PR #30094 review, thread 10 (the TS twin's close-less arm): a transport
    # that declares no `close` supplies no shutdown budget, so close() must
    # finish the connection IMMEDIATELY — rejecting in-flight requests and
    # settling `closed` — rather than hanging on a peer that will never EOF.
    class CloseLessDuplex:
        def __init__(self) -> None:
            self.chunks = AsyncChunks()
            self.writes: list[str] = []

        @property
        def incoming(self) -> AsyncChunks:
            return self.chunks

        async def write(self, chunk: str) -> None:
            self.writes.append(chunk)

    transport = CloseLessDuplex()
    connection = Connection(transport)
    pending = connection.request("never/answered")
    for _ in range(400):
        if transport.writes:
            break
        await asyncio.sleep(0)
    assert len(transport.writes) == 1, "the request reached the transport"

    closer = asyncio.ensure_future(connection.close())
    state, value = await settlement(pending)
    assert state == "rejected", "close() settles the matched caller (FR-638-013)"
    assert isinstance(value, ProtocolError)
    assert "connection closed" in value.message
    closer_state, _ = await settlement(closer)
    assert closer_state == "resolved", "close() itself returns without a budget"
    transport.chunks.end()  # let the read loop task finish
    await pump(4)


@pytest.mark.asyncio
async def test_a_frame_queued_behind_a_dying_write_settles_its_submission() -> None:
    # PR #30094 review, round 7 (sechegaray): frame A's write is in flight and
    # frame B is queued behind it when the connection finishes; B's run() takes
    # the except path, which must settle `submitted` so `_submit_tail` (the
    # `flushed` a process-owning close awaits inside its budget) resolves
    # rather than pinning close() for the whole shutdown budget (FR-638-017).
    class HeldFirstWriteDuplex:
        def __init__(self) -> None:
            self.chunks = AsyncChunks()
            self.writes: list[str] = []
            self._release = asyncio.get_running_loop().create_future()

        @property
        def incoming(self) -> AsyncChunks:
            return self.chunks

        async def write(self, chunk: str) -> None:
            self.writes.append(chunk)
            await self._release  # frame A's write never completes until released

        def release(self) -> None:
            if not self._release.done():
                self._release.set_result(None)

    transport = HeldFirstWriteDuplex()
    connection = Connection(transport)
    connection.notify("first")  # A: its write task starts and blocks
    connection.notify("queued-behind-it")  # B: chained behind A
    await pump(4)

    tail = connection._submission_tail()  # captured before EOF finishes it
    transport.chunks.end()  # EOF finishes the connection while A is in flight
    await connection.closed

    transport.release()
    outcome = await settlement(asyncio.ensure_future(connection.close()))
    assert outcome[0] == "resolved", "close() settles without waiting on a budget"
    tail_state, _ = await settlement(tail)
    assert tail_state == "resolved", "the queued frame's submission was settled"


@pytest.mark.asyncio
async def test_a_cancelled_server_request_handler_is_silent() -> None:
    # PR #30094 review, round 11 (reviewkit): a Ctrl-C that cancels an
    # in-flight server-request handler task must NOT log a spurious
    # CancelledError traceback (the `on_done` cancelled-guard) and must not
    # finish the connection.
    loop = asyncio.get_running_loop()
    reports: list[object] = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _l, ctx: reports.append(ctx))
    try:
        transport = FakeDuplex()
        connection = Connection(transport)
        started: asyncio.Future[asyncio.Task[object]] = loop.create_future()

        async def never_finishes(_request: Params) -> Params:
            # Hand our own task out so the test cancels it WITHOUT scanning
            # all_tasks for the private `_server_request` coro name.
            task = asyncio.current_task()
            assert task is not None
            started.set_result(task)
            await loop.create_future()  # never settles
            return {}  # pragma: no cover

        connection.on_server_request(never_finishes)
        transport.chunks.push(
            frame({"jsonrpc": "2.0", "id": 61, "method": "approval/request"})
        )
        started_state, handler_task = await settlement(started)
        assert started_state == "resolved", "the handler started"
        handler_task.cancel()
        await pump(8)
        closed_state, _ = await settlement(connection.closed, turns=8)
        assert closed_state == "pending", "a cancelled handler never finishes the connection"
        assert reports == [], f"a cancelled handler must be silent: {reports}"
        await connection.close()
    finally:
        loop.set_exception_handler(previous)
