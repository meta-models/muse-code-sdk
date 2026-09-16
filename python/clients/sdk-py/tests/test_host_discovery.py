"""PY-TEST-017: host discovery tiers and the strict fingerprint gate.

Spec 638 FR-638-020 / INV-638-08 / C-638-4: exactly the two ruled tiers —
explicit ``muse_bin`` wins, else an installed ``muse`` on ``PATH``. The
LIBRARY reads no environment variable and takes no ``env`` knob (PR #29277
and #30094 review; the harnesses own ``MUSE_BIN`` and export ``PATH``), so
every arm here drives the process ``PATH`` via monkeypatch — a real
``MUSE_BIN`` in the environment is still ignored. No discoverable host fails
BEFORE any process is spawned with an exact error naming the parameter and
the compatibility page; a served fingerprint that differs from the SDK's pin
fails ``initialize`` with the exact page-citing error naming the generated
``REQUIRED_HOST_VERSION`` — no bypass arm exists to test.
"""

from __future__ import annotations

import asyncio
import stat
import sys
from pathlib import Path

import pydantic
import pytest

from muse_code import EXPECTED_SCHEMA_FINGERPRINT
from muse_code.connection import (
    ProtocolError,
    discover_muse_bin,
    spawn_msp_connection,
)
from muse_code.errors import (
    COMPATIBILITY_PAGE_URL,
    MuseHostDiscoveryError,
    MuseHostMismatchError,
    MuseValidationError,
)

from helpers_host_lifetime import (
    ESCALATION_DRAIN_MS,
    FAILURE_CAP_S,
    IGNORES_EOF,
    NEVER_READS_STDIN,
    PidProbe,
    ended_within,
    is_alive,
    reap,
)


def test_explicit_parameter_wins_over_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    on_path = tmp_path / "muse"
    on_path.write_text("#!/bin/sh\n")
    on_path.chmod(on_path.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", str(tmp_path))
    assert discover_muse_bin("/explicit/muse") == "/explicit/muse"


def test_the_library_reads_no_environment_variable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # The two-tier contract: a MUSE_BIN in the environment is a HARNESS knob,
    # never a library tier — discovery ignores it (FR-638-020; TS parity:
    # spawn.ts takes a required command and reads nothing).
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("MUSE_BIN", "/somewhere/else/muse")
    monkeypatch.setenv("PATH", str(empty))
    with pytest.raises(MuseHostDiscoveryError):
        discover_muse_bin()


def test_path_lookup_is_the_last_tier(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    on_path = tmp_path / "muse"
    on_path.write_text("#!/bin/sh\n")
    on_path.chmod(on_path.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", str(tmp_path))
    assert discover_muse_bin() == str(on_path)


def test_no_host_fails_exactly_and_pre_spawn(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    with pytest.raises(MuseHostDiscoveryError) as excinfo:
        discover_muse_bin()
    message = str(excinfo.value)
    assert "muse_bin=" in message, "names the override parameter"
    assert "MUSE_BIN" not in message, "the library owns no env contract to name"
    assert COMPATIBILITY_PAGE_URL in message, "cites the compatibility page"
    assert "does not bundle a host" in message, "states the #29216 posture"


@pytest.mark.asyncio
async def test_fingerprint_mismatch_fails_initialize_with_the_exact_error(
    tmp_path: Path,
) -> None:
    # A stub host that answers `initialize` with a WRONG fingerprint and a
    # self-reported version — the cheapest deterministic arm (C-638-4).
    stub = tmp_path / "stub_host.py"
    stub.write_text(
        "import json, sys\n"
        "line = sys.stdin.readline()\n"
        "request = json.loads(line)\n"
        "result = {\n"
        "    'schema': {'fingerprint': 'sha256:deadbeef', 'schemaVersion': 1},\n"
        "    'serverInfo': {'name': 'stub', 'version': '9.9.9'},\n"
        "    'grantedCapabilities': [],\n"
        "}\n"
        "sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], "
        "'result': result}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "sys.stdin.read()\n"
    )
    handshake = await spawn_msp_connection(sys.executable, args=[str(stub)])
    try:
        with pytest.raises(MuseHostMismatchError) as excinfo:
            await asyncio.wait_for(
                handshake.initialize(
                    {  # type: ignore[arg-type]
                        "clientInfo": {"name": "pytest", "version": "0"},
                        "requestedCapabilities": [],
                    }
                ),
                FAILURE_CAP_S,
            )
        error = excinfo.value
        message = str(error)
        assert error.served == "sha256:deadbeef"
        assert error.pinned == EXPECTED_SCHEMA_FINGERPRINT
        assert error.host_version == "9.9.9"
        assert "sha256:deadbeef" in message
        assert EXPECTED_SCHEMA_FINGERPRINT in message
        assert "host version 9.9.9" in message
        assert COMPATIBILITY_PAGE_URL in message, "cites the compatibility page"
    finally:
        await asyncio.wait_for(handshake.close(), FAILURE_CAP_S)


@pytest.mark.asyncio
async def test_matching_fingerprint_initializes_and_closes_cleanly(
    tmp_path: Path,
) -> None:
    # The control arm: the same stub serving the PINNED fingerprint completes
    # the SS1.4 sequence (initialize -> result -> initialized) and closes.
    stub = tmp_path / "stub_host.py"
    stub.write_text(
        "import json, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        f"fingerprint = {EXPECTED_SCHEMA_FINGERPRINT!r}\n"
        "result = {\n"
        "    'schema': {'fingerprint': fingerprint, 'schemaVersion': 1},\n"
        "    'serverInfo': {'name': 'stub', 'version': '0.0.0'},\n"
        "    'grantedCapabilities': [],\n"
        "}\n"
        "sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], "
        "'result': result}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "sys.stdin.read()\n"
    )
    handshake = await spawn_msp_connection(sys.executable, args=[str(stub)])
    spawned = await asyncio.wait_for(
        handshake.initialize(
            {  # type: ignore[arg-type]
                "clientInfo": {"name": "pytest", "version": "0"},
                "requestedCapabilities": [],
            }
        ),
        FAILURE_CAP_S,
    )
    assert spawned.initialize_result["serverInfo"]["name"] == "stub"
    exit_status = await asyncio.wait_for(spawned.close(), FAILURE_CAP_S)
    assert exit_status.code == 0, "the stub drains EOF and exits cleanly"


def test_muse_bin_in_the_real_process_env_is_ignored(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # PR #30094 review: re-adding a MUSE_BIN tier must FAIL this arm — the
    # variable is exported for real, and discovery still refuses.
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("MUSE_BIN", "/somewhere/else/muse")
    monkeypatch.setenv("PATH", str(empty))
    with pytest.raises(MuseHostDiscoveryError):
        discover_muse_bin()


@pytest.mark.asyncio
async def test_mismatch_error_names_the_generated_required_host_version(
    tmp_path: Path,
) -> None:
    # PR #30094 review, thread 5: dropping the version from the message must
    # FAIL here — the C-638-4 contract names the REQUIRED host version from
    # the generated constant, never a degraded fallback.
    from muse_code_msp import REQUIRED_HOST_VERSION

    stub = tmp_path / "stub_host.py"
    stub.write_text(
        "import json, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        "result = {'schema': {'fingerprint': 'sha256:deadbeef', 'schemaVersion': 1},\n"
        "          'serverInfo': {'name': 'stub', 'version': '9.9.9'},\n"
        "          'grantedCapabilities': []}\n"
        "sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], "
        "'result': result}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "sys.stdin.read()\n"
    )
    handshake = await spawn_msp_connection(sys.executable, args=[str(stub)])
    try:
        with pytest.raises(MuseHostMismatchError) as excinfo:
            await asyncio.wait_for(
                handshake.initialize(
                    {  # type: ignore[arg-type]
                        "clientInfo": {"name": "pytest", "version": "0"},
                        "requestedCapabilities": [],
                    }
                ),
                FAILURE_CAP_S,
            )
        assert excinfo.value.required_host_version == REQUIRED_HOST_VERSION
        assert f"install host version {REQUIRED_HOST_VERSION}" in str(excinfo.value)
    finally:
        await asyncio.wait_for(handshake.close(), FAILURE_CAP_S)


@pytest.mark.asyncio
async def test_a_bad_connection_option_never_orphans_the_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # PR #30094 review, threads 8 + P0 re-review: a misspelled connection
    # option raises AFTER the child exists; the spawn path must end that
    # child, not orphan it. The child handle is captured CAUSALLY off the
    # spawn call (a pid-file existence check raced the ~1 ms failure window
    # and asserted nothing — the arm stayed green with the fix deleted).
    from muse_code.connection import MuseServeChild
    from muse_code.connection import spawn as spawn_module

    spawned: list[MuseServeChild] = []
    real_spawn = MuseServeChild.spawn

    async def _capture(**kwargs: object) -> MuseServeChild:
        child = await real_spawn(**kwargs)  # type: ignore[arg-type]
        spawned.append(child)
        return child

    monkeypatch.setattr(spawn_module.MuseServeChild, "spawn", staticmethod(_capture))
    with pytest.raises(TypeError):
        await spawn_msp_connection(
            sys.executable,
            args=["-c", "import sys; sys.stdin.read()"],
            connection_options={"frame_limit": 1},  # type: ignore[arg-type]  # misspelled on purpose
        )
    assert len(spawned) == 1, "setup soundness: the host was spawned"
    assert spawned[0]._transport.child.returncode is not None, (
        "the failed spawn path ended the child it could not hand off"
    )


@pytest.mark.asyncio
async def test_initialize_is_send_once_and_a_result_without_fingerprint_rejects(
    tmp_path: Path,
) -> None:
    # PR #30094 review, thread 6: the only-once guard and the
    # missing-fingerprint arm each need a RED that reaches them. The
    # missing-fingerprint arm is the C-638-2 frame seam since the #31276
    # owner ruling: the typed MuseValidationError, not a hand-rolled
    # ProtocolError.
    stub = tmp_path / "stub_host.py"
    stub.write_text(
        "import json, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        "sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], "
        "'result': {'serverInfo': {'name': 'stub', 'version': '0'}}}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "sys.stdin.read()\n"
    )
    handshake = await spawn_msp_connection(sys.executable, args=[str(stub)])
    try:
        params = {"clientInfo": {"name": "pytest", "version": "0"}}
        with pytest.raises(MuseValidationError, match="initialize result frame"):
            await asyncio.wait_for(
                handshake.initialize(params),  # type: ignore[arg-type]
                FAILURE_CAP_S,
            )
        with pytest.raises(ProtocolError, match="only once"):
            await asyncio.wait_for(
                handshake.initialize(params),  # type: ignore[arg-type]
                FAILURE_CAP_S,
            )
    finally:
        await asyncio.wait_for(handshake.close(), FAILURE_CAP_S)


@pytest.mark.asyncio
async def test_child_close_waits_for_the_adopted_submission_tail(
    tmp_path: Path,
) -> None:
    # PR #30094 review, thread 10 (the TS twin's adopted-flush arm): a close
    # routed AROUND the Connection — the public `spawned.child.close()` —
    # must still wait for accepted frames' SUBMISSION via the adopted flush
    # seam before ending the host's stdin, so the notification tail reaches
    # the host rather than being cut off by the EOF.
    stub = tmp_path / "stub_host.py"
    stub.write_text(
        "import json, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        f"fingerprint = {EXPECTED_SCHEMA_FINGERPRINT!r}\n"
        "result = {\n"
        "    'schema': {'fingerprint': fingerprint, 'schemaVersion': 1},\n"
        "    'serverInfo': {'name': 'stub', 'version': '0.0.0'},\n"
        "    'grantedCapabilities': [],\n"
        "}\n"
        "sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], "
        "'result': result}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "for line in sys.stdin:\n"
        "    line = line.strip()\n"
        "    if not line:\n"
        "        continue\n"
        "    sys.stderr.write('saw ' + json.loads(line).get('method', '?') + '\\n')\n"
        "    sys.stderr.flush()\n"
        "sys.exit(0)\n"
    )
    handshake = await spawn_msp_connection(sys.executable, args=[str(stub)])
    spawned = await asyncio.wait_for(
        handshake.initialize(
            {  # type: ignore[arg-type]
                "clientInfo": {"name": "pytest", "version": "0"},
                "requestedCapabilities": [],
            }
        ),
        FAILURE_CAP_S,
    )
    # TWO frames back to back: the second's write task is still chained
    # behind the first when close() starts, so only the adopted submission
    # wait keeps the EOF from cutting it off (the TS twin's same-turn race).
    spawned.connection.notify("note/first")
    spawned.connection.notify("note/adopted-tail")
    classification = await asyncio.wait_for(spawned.child.close(), FAILURE_CAP_S)
    assert classification.kind == "cleanShutdown"
    for expected in ("saw note/first", "saw note/adopted-tail"):
        assert any(expected in line for line in spawned.child.stderr_tail), (
            f"{expected!r} must reach the host before EOF: {spawned.child.stderr_tail}"
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "served_result, expected_error",
    [
        pytest.param(
            "{'schema': {'fingerprint': 'sha256:deadbeef', 'schemaVersion': 1}, "
            "'serverInfo': {'name': 'stub', 'version': '9.9.9'}, "
            "'grantedCapabilities': []}",
            MuseHostMismatchError,
            id="wrong-fingerprint",
        ),
        pytest.param(
            "{'serverInfo': {'name': 'stub', 'version': '9.9.9'}}",
            MuseValidationError,
            id="no-fingerprint",
        ),
        # C-638-2 frame seam (owner ruling #31276, arm (a)): every malformed
        # shape of the members the facade reads is the typed validation
        # error — never an AttributeError/KeyError or a silent partial
        # object — and the seam rejects BEFORE the C-638-4 fingerprint gate
        # (the wrong fingerprints below never reach a mismatch).
        pytest.param(
            "{'schema': 'oops', 'serverInfo': {'name': 'stub', 'version': '9.9.9'}}",
            MuseValidationError,
            id="schema-not-an-object",
        ),
        pytest.param(
            "{'schema': {'fingerprint': 7}, "
            "'serverInfo': {'name': 'stub', 'version': '9.9.9'}}",
            MuseValidationError,
            id="fingerprint-not-a-string",
        ),
        pytest.param(
            "{'schema': {'fingerprint': 'sha256:deadbeef'}}",
            MuseValidationError,
            id="no-server-info",
        ),
        pytest.param(
            "{'schema': {'fingerprint': 'sha256:deadbeef'}, "
            "'serverInfo': {'name': 'stub', 'version': 9}}",
            MuseValidationError,
            id="server-version-not-a-string",
        ),
    ],
)
async def test_a_failed_initialize_never_orphans_the_spawned_host(
    tmp_path: Path, served_result: str, expected_error: type[Exception]
) -> None:
    # PR #30094 review: EVERY post-latch initialize() failure arm — the
    # headline C-638-4 mismatch AND the malformed-frame rejections — must
    # end the `muse serve` child this handshake owns. Observed through the
    # PUBLIC `handshake.exited` surface (no private monkeypatch); the stub
    # exits 0 on the stdin EOF the failed initialize's close() sends, so a
    # `code == 0` here fails (as TimeoutError on the raise line) if the close
    # were dropped — a vacuous `is not None` would not (Constitution X).
    stub = tmp_path / "stub_host.py"
    stub.write_text(
        "import json, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        f"result = {served_result}\n"
        "sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], "
        "'result': result}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "sys.stdin.read()\n"
    )
    handshake = await spawn_msp_connection(sys.executable, args=[str(stub)])
    with pytest.raises(expected_error):
        await asyncio.wait_for(
            handshake.initialize(
                {  # type: ignore[arg-type]
                    "clientInfo": {"name": "pytest", "version": "0"},
                    "requestedCapabilities": [],
                }
            ),
            FAILURE_CAP_S,
        )
    exit_status = await asyncio.wait_for(handshake.exited, FAILURE_CAP_S)
    assert exit_status.code == 0, "the failed initialize ended the host it owns, EOF-first"


@pytest.mark.asyncio
async def test_a_malformed_initialize_result_wraps_pydantics_error(
    tmp_path: Path,
) -> None:
    # C-638-2 frame seam, the wrapper's own contract (owner ruling #31276):
    # the SDK's typed error names the seam, keeps the pre-existing
    # ValueError family, and chains pydantic's ValidationError as the cause
    # so an embedder can read the field-level evidence.
    stub = tmp_path / "stub_host.py"
    stub.write_text(
        "import json, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        "sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], "
        "'result': {'serverInfo': {'name': 'stub', 'version': '0'}}}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "sys.stdin.read()\n"
    )
    handshake = await spawn_msp_connection(sys.executable, args=[str(stub)])
    with pytest.raises(MuseValidationError) as caught:
        await asyncio.wait_for(
            handshake.initialize(
                {"clientInfo": {"name": "pytest", "version": "0"}}  # type: ignore[arg-type]
            ),
            FAILURE_CAP_S,
        )
    assert caught.value.seam == "initializeResult"
    assert isinstance(caught.value, ValueError)
    assert isinstance(caught.value.__cause__, pydantic.ValidationError)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "host",
    [pytest.param(IGNORES_EOF, id="reads-stdin"), pytest.param(NEVER_READS_STDIN, id="never-reads")],
)
async def test_facade_close_is_bounded_even_when_the_host_never_reads_stdin(
    host: str,
) -> None:
    # PR #30094 review, round 10 (sechegaray): the SS2.1.2 close ordering
    # (EOF attempt must NOT gate the ladder) has no public-seam test — every
    # wedged-host arm closes the transport/child directly, and every facade
    # close in the suite talks to a draining host. Here a large pending write
    # to a host that never reads stdin must still let the FACADE close()
    # settle within the bound; IGNORES_EOF (reads stdin) is the control.
    from muse_code.connection import Connection, MuseServeChild
    from muse_code.connection.spawn import MspHandshake

    probe = PidProbe()
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", host],
        shutdown_timeout_ms=ESCALATION_DRAIN_MS,
        on_stderr=probe.on_stderr,
    )
    pid = await probe.pid()
    connection = Connection(child._transport)
    handshake = MspHandshake(child, connection)
    try:
        # A frame far bigger than the pipe buffer: on the never-reads host it
        # can never drain, so a close that awaited EOF/completion would hang.
        connection.notify("big", {"blob": "x" * (2 * 1024 * 1024)})
        exit_status = await asyncio.wait_for(handshake.close(), FAILURE_CAP_S)
        assert exit_status.signal is not None, "the wedged host was ended by the ladder"
        assert not is_alive(pid), "the facade close ended the host"
    finally:
        reap(pid)


@pytest.mark.asyncio
async def test_a_cancelled_initialize_closes_the_host_inline_never_orphans(
    tmp_path: Path,
) -> None:
    # PR #30094 review, round 15 P0 (reviewkit/sechegaray/Answeror): a caller
    # cancel of initialize() (a wait_for timeout) must still end the host —
    # a background fire-and-forget close is torn down by asyncio.run's loop
    # exit and orphans the child, so the close runs INLINE before the cancel
    # propagates (FM-638-2 never-orphan is unconditional). The host reads the
    # request but never answers, so initialize() is in flight when cancelled;
    # a short shutdown_timeout_ms keeps the inline close's ladder brief.
    stub = tmp_path / "silent_host.py"
    stub.write_text("import sys; sys.stdin.readline(); sys.stdin.read()\n")
    handshake = await spawn_msp_connection(
        sys.executable, args=[str(stub)], shutdown_timeout_ms=0
    )
    pid = handshake.child._transport.child.pid
    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            handshake.initialize({"clientInfo": {"name": "p", "version": "0"}}),  # type: ignore[arg-type]
            0.3,
        )
    # The cancel awaited the INLINE close, so the host is already dead the
    # moment the timeout surfaces — assert liveness FIRST, before any further
    # await hands the loop back (a round-12 background fire-and-forget close
    # would otherwise get its turn and kill the host before the assert, so
    # this must red on that mutant too — not only on `except Exception`).
    assert not is_alive(pid), "a cancelled initialize never orphans the host"
    # Terminal shape, not specifically SIGTERM: the stub can win the stdin-EOF
    # race and exit 0 (FM-638-2's contract is "the host is dead", not
    # "killed"). The liveness oracle is the is_alive check above plus this
    # bounded wait; the assert states the ProcessExit one-of-two invariant —
    # EXACTLY one of code/signal — which an either-or form could never fail
    # (PR #30094 review, round 18).
    exit_status = await asyncio.wait_for(handshake.exited, FAILURE_CAP_S)
    assert (exit_status.code is None) != (exit_status.signal is None), (
        f"the cancel ended the host: {exit_status}"
    )


@pytest.mark.asyncio
async def test_a_gc_finalized_initialize_kills_the_host_and_exits_quietly(
    tmp_path: Path,
) -> None:
    # PR #30094 review, round 18 (reviewkit/sechegaray/zdwmeta): closing a
    # SUSPENDED initialize() coroutine — what GC finalization of an abandoned
    # task does — throws GeneratorExit at its await. The arm cannot await the
    # bounded close there, but never-orphan is unconditional (FM-638-2): it
    # sends one synchronous SIGKILL and re-raises. Two mutants red here:
    # dropping the arm (BaseException's `await self.close()` swallows the
    # GeneratorExit -> coro.close() raises "coroutine ignored GeneratorExit"),
    # and keeping a bare passthrough (the host stays alive -> ended_within
    # fails).
    stub = tmp_path / "silent_host.py"
    stub.write_text("import sys; sys.stdin.readline(); sys.stdin.read()\n")
    handshake = await spawn_msp_connection(
        sys.executable, args=[str(stub)], shutdown_timeout_ms=0
    )
    pid = handshake.child._transport.child.pid
    try:
        coro = handshake.initialize({"clientInfo": {"name": "p", "version": "0"}})  # type: ignore[arg-type]
        parked = coro.send(None)  # drive to the first await: the initialize reply
        # The yielded future is the pending request; retrieve its eventual
        # rejection (set when close() finishes the connection) so GC never
        # logs it as unretrieved.
        if isinstance(parked, asyncio.Future):
            parked.add_done_callback(
                lambda f: None if f.cancelled() else f.exception()
            )
        coro.close()  # GeneratorExit must NOT surface as RuntimeError
        assert await ended_within(pid, FAILURE_CAP_S), (
            "a GC-finalized initialize never orphans the host"
        )
    finally:
        await asyncio.wait_for(handshake.close(), FAILURE_CAP_S)
        reap(pid)


@pytest.mark.asyncio
async def test_a_second_initialize_after_success_rejects_but_leaves_the_host_alive(
    tmp_path: Path,
) -> None:
    # PR #30094 review, round 15: the send-once carve-out — a repeat
    # initialize() raises the "only once" ProtocolError WITHOUT closing,
    # because after a successful first call the host is live and owned by the
    # returned connection. The existing send-once arm fires the second call
    # after a FAILED first (host already dead, close() memoized), so a change
    # that closed a LIVE host on the repeat would stay green there. This pins
    # the live host.
    stub = tmp_path / "stub_host.py"
    stub.write_text(
        "import json, sys\n"
        "request = json.loads(sys.stdin.readline())\n"
        f"fingerprint = {EXPECTED_SCHEMA_FINGERPRINT!r}\n"
        "result = {'schema': {'fingerprint': fingerprint, 'schemaVersion': 1},\n"
        "          'serverInfo': {'name': 'stub', 'version': '0.0.0'},\n"
        "          'grantedCapabilities': []}\n"
        "sys.stdout.write(json.dumps({'jsonrpc': '2.0', 'id': request['id'], "
        "'result': result}) + '\\n')\n"
        "sys.stdout.flush()\n"
        "sys.stdin.read()\n"
    )
    handshake = await spawn_msp_connection(sys.executable, args=[str(stub)])
    pid = handshake.child._transport.child.pid
    spawned = await asyncio.wait_for(
        handshake.initialize({"clientInfo": {"name": "p", "version": "0"}}),  # type: ignore[arg-type]
        FAILURE_CAP_S,
    )
    try:
        with pytest.raises(ProtocolError, match="only once"):
            await asyncio.wait_for(
                handshake.initialize({"clientInfo": {"name": "p", "version": "0"}}),  # type: ignore[arg-type]
                FAILURE_CAP_S,
            )
        assert is_alive(pid), "the send-once reject must NOT close the live host"
    finally:
        await asyncio.wait_for(spawned.close(), FAILURE_CAP_S)
