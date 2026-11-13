"""A call rejected because a spawned host died carries how it ended. The
error is unchanged (usually ``ProtocolError``; the transport's own error when
a write failed); the exit classification rides ``__cause__`` as a
``MuseHostDiedError``. The wait for the exit is bounded: a
host that closes stdout but stays alive gets today's bare error. A clean exit,
a bare-``Connection`` client and a call after the caller's own ``close()``
keep the bare error too.

Port of ``clients/sdk-ts/test/facade-host-exit-cause.test.ts`` against a
throwaway ``python -c`` host.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any

import pytest

from muse_code import (
    EXPECTED_SCHEMA_FINGERPRINT,
    MuseClient,
    MuseClientOptions,
    MuseClientSpawnOptions,
    MuseHostDiedError,
    read_session_durability,
)
from muse_code.connection import Connection, ProtocolError
from muse_code.connection.spawn import ExitClassification

from muse_code.facade.host_death import TransportEof

from helpers_connection import AsyncChunks, FakeDuplex, pump, wait_for_writes
from helpers_host_lifetime import FAILURE_CAP_S

STDERR_MARKER = "host-exit-cause: dying"

INITIALIZE_RESULT = {
    "experimentalApi": False,
    "grantedCapabilities": [],
    "museHome": "/nonexistent",
    "platformFamily": "unix",
    "platformOs": "linux",
    "schema": {"fingerprint": EXPECTED_SCHEMA_FINGERPRINT, "version": 1},
    "serverInfo": {"name": "inline", "version": "0.0.0"},
    "sessionDurability": "durable",
    "userAgent": "inline-host/0.0.0",
}

# Answers ``initialize``; on ``task/stop`` ends without answering, so that
# call is pending: ``exit3`` writes a stderr line and exits 3, ``exit0`` exits
# 0, and ``closeStdout`` closes stdout and keeps running until stdin closes.
# When stdin closes the host exits ``stdin_close_exit``.
STOP = {
    "exit3": f"sys.stderr.write({STDERR_MARKER + chr(10)!r}); sys.stderr.flush(); sys.exit(3)",
    "exit0": "sys.exit(0)",
    "closeStdout": "sys.stdout.flush(); os.close(1)",
}


def _host(on_stop: str, stdin_close_exit: int) -> str:
    return (
    "import json, os, sys\n"
    f"INIT = json.loads({json.dumps(INITIALIZE_RESULT)!r})\n"
    "for line in sys.stdin:\n"
    "    frame = json.loads(line)\n"
    "    if frame.get('method') == 'initialize':\n"
    "        sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': frame['id'], 'result': INIT}) + '\\n')\n"
    "        sys.stdout.flush()\n"
    "    elif frame.get('method') == 'task/stop':\n"
    f"        {STOP[on_stop]}\n"
    f"os._exit({stdin_close_exit})\n"
    )


async def _spawn(on_stop: str = "exit3", stdin_close_exit: int = 0) -> MuseClient[Any]:
    return await asyncio.wait_for(
        MuseClient.spawn(
            MuseClientSpawnOptions(
                muse_bin=sys.executable,
                args=["-c", _host(on_stop, stdin_close_exit)],
                client_info={"name": "sdk_test", "version": "0.0.0"},
            )
        ),
        FAILURE_CAP_S,
    )


def _assert_exit_3(error: BaseException, message: str) -> None:
    assert isinstance(error, ProtocolError), f"expected ProtocolError, got {error!r}"
    assert error.message == message, "only the cause is new: the message stays as before"
    cause = error.__cause__
    assert isinstance(cause, MuseHostDiedError), f"expected a MuseHostDiedError cause, got {cause!r}"
    exit_row = cause.exit
    assert isinstance(exit_row, ExitClassification)
    assert exit_row.kind == "configError"
    assert exit_row.exit_code == 3
    assert any(STDERR_MARKER in line for line in exit_row.stderr_tail), exit_row.stderr_tail


@pytest.mark.asyncio
async def test_a_pending_call_rejects_with_todays_error_and_the_exit_as_its_cause() -> None:
    client = await _spawn()
    with pytest.raises(ProtocolError) as excinfo:
        await asyncio.wait_for(
            client.command("task/stop", {"sessionId": "s-1", "taskId": "t-1"}), FAILURE_CAP_S
        )
    _assert_exit_3(excinfo.value, "connection reached EOF")


@pytest.mark.asyncio
async def test_a_call_made_after_the_host_died_rejects_the_same_way_even_after_close() -> None:
    client = await _spawn()
    with pytest.raises(ProtocolError):
        await asyncio.wait_for(
            client.command("task/stop", {"sessionId": "s-1", "taskId": "t-1"}), FAILURE_CAP_S
        )
    await asyncio.wait_for(client.exit, FAILURE_CAP_S)
    # The cause is read once, at the end of the stream: a close() after the
    # death keeps it.
    await asyncio.wait_for(client.close(), FAILURE_CAP_S)

    with pytest.raises(ProtocolError) as later:
        await asyncio.wait_for(
            client.command("task/stop", {"sessionId": "s-1", "taskId": "t-2"}), FAILURE_CAP_S
        )
    _assert_exit_3(later.value, "connection is closed")
    with pytest.raises(ProtocolError) as listing:
        await asyncio.wait_for(client.list_sessions(), FAILURE_CAP_S)
    _assert_exit_3(listing.value, "connection is closed")


@pytest.mark.asyncio
async def test_a_call_after_the_callers_own_close_keeps_todays_error_with_no_cause() -> None:
    # The host exits 3 on stdin EOF: an abnormal exit, so only the close()
    # guard keeps the cause off.
    client = await _spawn("exit3", 3)
    await asyncio.wait_for(client.close(), FAILURE_CAP_S)
    assert (await asyncio.wait_for(client.exit, FAILURE_CAP_S)).kind == "configError"

    with pytest.raises(ProtocolError) as excinfo:
        await asyncio.wait_for(
            client.command("task/stop", {"sessionId": "s-1", "taskId": "t-1"}), FAILURE_CAP_S
        )
    assert excinfo.value.message == "connection is closed"
    assert excinfo.value.__cause__ is None


@pytest.mark.asyncio
async def test_a_host_that_closes_stdout_but_stays_alive_gets_the_bare_error() -> None:
    # Settles only after the real SIGTERM_GRACE_MS wait: that bound is the
    # contract, not an incidental delay.
    client = await _spawn("closeStdout")
    exit_watch = asyncio.ensure_future(client.exit)
    try:
        with pytest.raises(ProtocolError) as excinfo:
            await asyncio.wait_for(
                client.command("task/stop", {"sessionId": "s-1", "taskId": "t-1"}),
                FAILURE_CAP_S,
            )
        assert excinfo.value.__cause__ is None
        assert not exit_watch.done(), "the call settled while the host was still running"
    finally:
        await asyncio.wait_for(client.close(), FAILURE_CAP_S)
        await asyncio.wait_for(exit_watch, FAILURE_CAP_S)


@pytest.mark.asyncio
async def test_a_host_that_exits_0_leaves_the_bare_error() -> None:
    client = await _spawn("exit0")
    with pytest.raises(ProtocolError) as excinfo:
        await asyncio.wait_for(
            client.command("task/stop", {"sessionId": "s-1", "taskId": "t-1"}), FAILURE_CAP_S
        )
    assert excinfo.value.__cause__ is None


@pytest.mark.asyncio
async def test_a_client_built_around_a_bare_connection_keeps_the_bare_error() -> None:
    transport = FakeDuplex()
    client: MuseClient[Any] = MuseClient(
        Connection(transport),
        MuseClientOptions(durability=read_session_durability({"sessionDurability": "durable"})),
    )
    pending = asyncio.ensure_future(
        client.command("task/stop", {"sessionId": "s-1", "taskId": "t-1"})
    )
    await wait_for_writes(transport, 1)
    transport.chunks.end()

    with pytest.raises(ProtocolError) as excinfo:
        await asyncio.wait_for(pending, FAILURE_CAP_S)
    assert excinfo.value.__cause__ is None


class _FailingWrite:
    """A transport whose every write fails, as a write to a dead host does."""

    def __init__(self, error: BaseException) -> None:
        self.chunks = AsyncChunks()
        self._error = error

    @property
    def incoming(self) -> AsyncChunks:
        return self.chunks

    async def write(self, chunk: str) -> None:
        raise self._error


@pytest.mark.asyncio
async def test_a_write_that_fails_as_the_host_dies_gets_the_end_cause_too() -> None:
    write_error = BrokenPipeError("write EPIPE")
    connection = Connection(_FailingWrite(write_error))  # type: ignore[arg-type]
    cause = MuseHostDiedError(TransportEof())
    end_cause: asyncio.Future[BaseException | None] = asyncio.get_running_loop().create_future()
    connection._peer_end_cause(lambda: end_cause)
    pending = asyncio.ensure_future(connection.request("task/list"))

    await pump()
    assert not pending.done(), "the call waits for the end cause"
    end_cause.set_result(cause)
    with pytest.raises(BrokenPipeError) as excinfo:
        await asyncio.wait_for(pending, FAILURE_CAP_S)
    assert excinfo.value is write_error, "the transport's own error, not a ProtocolError"
    assert excinfo.value.__cause__ is cause


@pytest.mark.asyncio
async def test_a_hook_registered_after_the_connection_ended_still_gives_the_cause() -> None:
    transport = FakeDuplex()
    connection = Connection(transport)
    transport.chunks.end()
    await asyncio.wait_for(connection.closed, FAILURE_CAP_S)
    cause = MuseHostDiedError(TransportEof())
    resolved: asyncio.Future[BaseException | None] = asyncio.get_running_loop().create_future()
    resolved.set_result(cause)
    connection._peer_end_cause(lambda: resolved)

    with pytest.raises(ProtocolError) as excinfo:
        await asyncio.wait_for(connection.request("task/list"), FAILURE_CAP_S)
    assert excinfo.value.message == "connection is closed"
    assert excinfo.value.__cause__ is cause
