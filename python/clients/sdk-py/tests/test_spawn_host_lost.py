"""``MuseClient.spawn`` names the lost host when the handshake never completes.

Before the fix every lost-host arm below raised whatever the transport saw
first — a bare
``ProtocolError("connection reached EOF")`` — and the exit classification
row and the captured stderr tail, both already on the child the facade owns,
never reached the caller.

"Lost" is decided by whether the host ANSWERED ``initialize``, never by how
it ended. The CONTROLS keep their original error: a host that refuses with
its own error, a host whose answer this SDK rejects (malformed, broken or
serving another schema), a caller whose own ``initialize`` frame cannot be
encoded, a binary that never started (the operating system's own error,
raised before any handshake), and a caller cancellation.

The misbehaving hosts are throwaway ``python -c`` children. Causal, never
time-based: each await is capped only by the labelled failure bound.
"""

from __future__ import annotations

import asyncio
import re
import sys
from pathlib import Path
from typing import Any

import pytest

from muse_code import (
    EXPECTED_SCHEMA_FINGERPRINT,
    MuseClient,
    MuseClientSpawnOptions,
    MuseHostStartError,
)
from muse_code.connection import MspError, ProtocolError
from muse_code.errors import MuseHostMismatchError, MuseValidationError

from helpers_host_lifetime import FAILURE_CAP_S

CLIENT_INFO: Any = {"name": "sdk_test", "version": "0.0.0"}


def _options(body: str, **rest: Any) -> MuseClientSpawnOptions:
    return MuseClientSpawnOptions(
        muse_bin=sys.executable, args=["-c", body], client_info=CLIENT_INFO, **rest
    )


async def _spawn_error(options: MuseClientSpawnOptions) -> BaseException:
    """The exception of a ``spawn`` that MUST fail; a success is closed and reported."""
    try:
        client = await asyncio.wait_for(MuseClient.spawn(options), FAILURE_CAP_S)
    except BaseException as error:  # noqa: BLE001 - the arm inspects it
        return error
    await client.close()
    raise AssertionError("spawn resolved; this arm needs a host that never completes the handshake")


def _lost(error: BaseException) -> MuseHostStartError:
    assert isinstance(error, MuseHostStartError), (
        f"expected MuseHostStartError, got {type(error).__name__}: {error}"
    )
    return error


def _stderr_then_exit(text: str, code: int) -> str:
    return (
        "import sys; "
        f"sys.stderr.write({text!r}); sys.stderr.flush(); sys.exit({code})"
    )


@pytest.mark.asyncio
async def test_a_host_that_exits_3_before_its_first_frame_names_config_error_and_its_stderr() -> None:
    error = _lost(await _spawn_error(_options(_stderr_then_exit("oops: config is bad\n", 3))))

    assert error.answered_initialize is False, "it never answered initialize"
    assert str(error).startswith("muse host exited before answering initialize: "), str(error)
    assert error.exit.kind == "configError"
    assert error.exit.exit_code == 3
    assert error.exit.retry == "fix-config"
    assert error.exit.stderr_tail == ("oops: config is bad",)
    assert error.stderr_tail == ("oops: config is bad",)
    assert "configError" in str(error)
    assert "exit code 3" in str(error)
    assert "oops: config is bad" in str(error), str(error)
    assert isinstance(error.__cause__, ProtocolError), "the transport error rides as the cause"


@pytest.mark.asyncio
async def test_a_host_killed_by_a_signal_before_its_first_frame_names_the_crash_row_and_signal() -> None:
    error = _lost(
        await _spawn_error(_options("import os, signal; os.kill(os.getpid(), signal.SIGKILL)"))
    )

    assert error.answered_initialize is False
    assert str(error).startswith("muse host exited before answering initialize: "), str(error)
    assert error.exit.kind == "crash"
    assert error.exit.exit_signal == "SIGKILL"
    assert error.exit.exit_code is None
    assert "crash" in str(error)
    assert "SIGKILL" in str(error)


@pytest.mark.asyncio
async def test_the_tail_on_the_error_is_the_bounded_tail_and_the_message_quotes_only_the_newest() -> None:
    # Well past the 100-line budget: the error carries the bound, never the
    # whole stream, and the message quotes only the newest few lines.
    lines = 300
    text = "".join(f"line-{i}\n" for i in range(lines))
    error = _lost(await _spawn_error(_options(_stderr_then_exit(text, 1))))

    assert error.answered_initialize is False
    assert str(error).startswith("muse host exited before answering initialize: "), str(error)
    assert error.exit.kind == "unhandledError"
    assert 0 < len(error.stderr_tail) <= 100, len(error.stderr_tail)
    assert error.stderr_tail[-1] == f"line-{lines - 1}", "the newest line survives"
    message = str(error)
    assert re.search(r"stderr tail \(last 5 of \d+ lines\):", message), message
    assert f"line-{lines - 1}" in message
    # The sixth-newest line is held on the error but NOT quoted: a message
    # that quoted everything (or more than the newest five) fails here.
    assert f"line-{lines - 6}" in error.stderr_tail
    assert not re.search(rf"\bline-{lines - 6}\b", message), message


@pytest.mark.asyncio
async def test_a_host_that_complains_and_exits_0_without_answering_is_still_lost() -> None:
    # The clean row keeps no tail; the error does. Nothing answered, so the
    # caller gets the typed error with the stderr evidence, never a bare EOF.
    error = _lost(await _spawn_error(_options(_stderr_then_exit("nothing to serve here\n", 0))))

    assert error.answered_initialize is False
    assert str(error).startswith("muse host exited before answering initialize: "), str(error)
    assert error.exit.kind == "cleanShutdown"
    assert error.stderr_tail == ("nothing to serve here",)
    assert "cleanShutdown" in str(error)
    assert "nothing to serve here" in str(error)
    assert isinstance(error.__cause__, ProtocolError)


@pytest.mark.asyncio
async def test_a_host_that_answers_and_dies_before_initialized_is_lost_after_answering() -> None:
    # The host gives a usable answer, but closes its stdin first and exits,
    # so the SDK's `initialized` notification can only fail. The host is
    # lost, but not at startup: "before answering initialize" would send the
    # user hunting a startup problem that never happened.
    body = (
        "import json, os, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        "os.close(0)\n"
        "answer = {'jsonrpc': '2.0', 'id': request['id'], 'result': {"
        "'protocolVersion': '1', 'serverInfo': {'name': 'answer-then-die', 'version': '0'}, "
        f"'schema': {{'fingerprint': {EXPECTED_SCHEMA_FINGERPRINT!r}}}}}}}\n"
        "sys.stdout.write(json.dumps(answer) + '\\n'); sys.stdout.flush()\n"
        "sys.exit(7)\n"
    )
    error = _lost(await _spawn_error(_options(body)))

    message = str(error)
    assert "after answering initialize, before the handshake completed" in message, message
    assert "before answering initialize:" not in message, message
    assert error.answered_initialize is True
    assert error.exit.kind == "crash"
    assert error.exit.exit_code == 7
    assert isinstance(error.__cause__, ProtocolError), "the failed write rides as the cause"


def _answering_host(answer: str, exit_code: int) -> str:
    """A host that answers every request line with ``answer`` (JSON, ``ID`` replaced)."""
    return (
        "import json, sys\n"
        "for line in sys.stdin:\n"
        "    frame = json.loads(line)\n"
        f"    sys.stdout.write({answer!r}.replace('ID', json.dumps(frame['id'])) + '\\n')\n"
        "    sys.stdout.flush()\n"
        f"sys.exit({exit_code})\n"
    )


REFUSAL = (
    '{"jsonrpc": "2.0", "id": ID, "error": {"code": -32000, '
    '"message": "initialize refused (test)", "data": {"kind": "testRefusal"}}}'
)


@pytest.mark.asyncio
@pytest.mark.parametrize("exit_code", [0, 1])
async def test_control_a_host_that_refuses_initialize_keeps_its_error_however_it_then_exits(
    exit_code: int,
) -> None:
    # It answered, so it was not lost; neither the clean exit our close()
    # causes nor a non-clean one may dress the refusal up as a death.
    error = await _spawn_error(_options(_answering_host(REFUSAL, exit_code)))

    assert isinstance(error, MspError), f"expected MspError, got {type(error).__name__}: {error}"
    assert error.kind == "testRefusal"
    assert not isinstance(error, MuseHostStartError)


@pytest.mark.asyncio
async def test_control_a_host_whose_answer_is_malformed_keeps_the_validation_error() -> None:
    # A frame arrived — the host answered, badly. The actionable error is the
    # malformation (version skew), not the exit our own close() caused.
    error = await _spawn_error(
        _options(_answering_host('{"jsonrpc": "2.0", "id": ID, "result": {}}', 0))
    )

    assert isinstance(error, MuseValidationError), f"got {type(error).__name__}: {error}"
    assert error.seam == "initializeResult"


@pytest.mark.asyncio
async def test_control_a_host_whose_answer_breaks_the_protocol_keeps_that_protocol_error() -> None:
    # A result that is not an object is refused before any field is read,
    # as a protocol violation that carries the refused frame. That frame is
    # the host's answer, so the violation — not the exit — is the error.
    error = await _spawn_error(
        _options(_answering_host('{"jsonrpc": "2.0", "id": ID, "result": [1]}', 0))
    )

    assert isinstance(error, ProtocolError), f"got {type(error).__name__}: {error}"
    assert error.line is not None and '"result": [1]' in error.line
    assert not isinstance(error, MuseHostStartError)


@pytest.mark.asyncio
async def test_control_a_host_serving_another_schema_keeps_the_mismatch_error() -> None:
    # A well-formed answer with a foreign fingerprint: the host answered, and
    # the mismatch error names the host version to install — the exit our own
    # close() causes afterwards would tell the user nothing.
    answer = (
        '{"jsonrpc": "2.0", "id": ID, "result": {"schema": {"fingerprint": "sha256:deadbeef"}, '
        '"serverInfo": {"name": "muse", "version": "0.0.0-test"}}}'
    )
    error = await _spawn_error(_options(_answering_host(answer, 0)))

    assert isinstance(error, MuseHostMismatchError), f"got {type(error).__name__}: {error}"
    assert error.served == "sha256:deadbeef"


@pytest.mark.asyncio
async def test_control_a_client_info_that_cannot_be_encoded_keeps_the_callers_error() -> None:
    # The initialize frame cannot be encoded, so it never reaches the host:
    # that is the caller's own defect, and a healthy host must not be blamed
    # for the exit our close() then causes.
    options = MuseClientSpawnOptions(
        muse_bin=sys.executable,
        args=["-c", _answering_host(REFUSAL, 0)],
        client_info={"name": "bad\udc80", "version": "0.0.0"},
    )
    error = await _spawn_error(options)

    assert isinstance(error, ProtocolError), f"got {type(error).__name__}: {error}"
    assert not isinstance(error, MuseHostStartError)
    assert "encodable" in str(error), str(error)


@pytest.mark.asyncio
async def test_control_a_binary_that_does_not_exist_raises_the_os_error(tmp_path: Path) -> None:
    # No process ran, so there is no exit row or tail to attach: the
    # operating system's own error names the path before any handshake.
    missing = tmp_path / "muse-that-does-not-exist"
    error = await _spawn_error(
        MuseClientSpawnOptions(muse_bin=str(missing), client_info=CLIENT_INFO)
    )

    assert isinstance(error, FileNotFoundError), f"got {type(error).__name__}: {error}"
    assert str(missing) in str(error)


@pytest.mark.asyncio
async def test_control_a_caller_cancel_during_the_handshake_stays_a_cancellation() -> None:
    # A host that reads the initialize request, says so on stderr, and never
    # answers. Cancelling spawn() there is the caller's choice, not a lost
    # host: it must surface as CancelledError, never be wrapped.
    seen = asyncio.Event()

    def on_stderr(chunk: str) -> None:
        if "got-initialize" in chunk:
            seen.set()

    body = (
        "import sys\n"
        "sys.stdin.readline()\n"
        "sys.stderr.write('got-initialize\\n'); sys.stderr.flush()\n"
        "sys.stdin.read()\n"
    )
    task = asyncio.ensure_future(MuseClient.spawn(_options(body, on_stderr=on_stderr)))
    await asyncio.wait_for(seen.wait(), FAILURE_CAP_S)
    task.cancel()
    done, _ = await asyncio.wait({task}, timeout=FAILURE_CAP_S)
    assert task in done, "the cancelled spawn settled within the failure bound"
    assert task.cancelled(), f"expected a cancellation, got {task.exception()!r}"
