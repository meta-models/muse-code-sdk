"""PY-the governing rule: the protocol classification and the bounded close ladder.

Port of ``clients/sdk-ts/test/muse-serve-child.test.ts``. The fixture-driven table arms run only when
a prebuilt ``muse-conformance`` binary is available (the Python CI lane
carries no Rust toolchain; the throwaway-child arms carry the ladder
coverage everywhere).
"""

from __future__ import annotations

import asyncio
import signal
import sys

import pydantic
import pytest

from muse_code.connection import MuseServeChild, ProtocolError
from muse_code.connection.spawn import ChildStdioTransport
from muse_code.errors import MuseValidationError

from helpers_host_lifetime import (
    COUNTS_SIGTERM,
    DETACHED_STDERR_HOLDER,
    DETACHED_STDOUT_HOLDER,
    ESCALATION_DRAIN_MS,
    EXITS_3_ON_SIGTERM,
    FAILURE_CAP_S,
    IGNORES_EOF,
    IGNORES_EOF_AND_SIGTERM,
    NEVER_READS_STDIN,
    STDIN_HOLDING_HELPER,
    UNFLUSHABLE_WRITE,
    WRAPPER_WITH_STDOUT_HOLDING_GRANDCHILD,
    PidProbe,
    ended_within,
    fixture_host_bin,
    is_alive,
    is_zombie,
    reap,
)

POSIX_ONLY = pytest.mark.skipif(sys.platform == "win32", reason="the governing rule is POSIX-only")
FIXTURE_BIN = fixture_host_bin()
NEEDS_FIXTURE = pytest.mark.skipif(
    FIXTURE_BIN is None,
    reason="no prebuilt muse-conformance (set MUSE_CONFORMANCE_BIN or CARGO_TARGET_DIR); "
    "the fixture-table arms run where the Rust toolchain lives",
)

CLASSIFICATIONS = {
    0: "cleanShutdown",
    1: "unhandledError",
    2: "usageError",
    3: "configError",
    4: "leaseUnavailable",
    5: "sdkSurfaceUnavailable",
    77: "crash",
}
RETRY = {2: "never", 3: "fix-config", 4: "after-lease-release", 5: "never"}


async def _exit_fixture(code: int, stderr_lines: int = 3) -> MuseServeChild:
    assert FIXTURE_BIN is not None
    return await MuseServeChild.spawn(
        muse_bin=FIXTURE_BIN,
        args=[
            "serve-fixture",
            "--exit-code",
            str(code),
            "--stderr-lines",
            str(stderr_lines),
        ],
    )


@NEEDS_FIXTURE
@pytest.mark.asyncio
@pytest.mark.parametrize("code", sorted(CLASSIFICATIONS))
async def test_stderr_tail_and_exit_code_table(code: int) -> None:
    # Identical opaque text drives every branch: classification can only come
    # from the exit status, never from parsing stderr.
    child = await _exit_fixture(code)
    classification = await asyncio.wait_for(asyncio.shield(child.exit), FAILURE_CAP_S)
    assert classification.kind == CLASSIFICATIONS[code], f"host exit-classification row for exit {code}"
    assert len(child.stderr_tail) == 3, f"exit {code} retains all short evidence"
    assert all(line for line in child.stderr_tail)
    if classification.kind != "cleanShutdown":
        assert classification.stderr_tail == child.stderr_tail
    if classification.kind == "unhandledError":
        assert classification.exit_code == code
        assert classification.retry is None, "exit 1 makes no retry claim"
    elif classification.kind not in ("cleanShutdown", "crash"):
        assert classification.exit_code == code
        assert classification.retry == RETRY[code]
    if classification.kind == "crash":
        assert classification.exit_code == 77
        assert classification.exit_signal is None


@pytest.mark.asyncio
async def test_a_signal_is_the_crash_row_with_stderr_evidence() -> None:
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=[
            "-c",
            "import os, signal, sys; sys.stderr.write('before signal\\n'); "
            "sys.stderr.flush(); os.kill(os.getpid(), signal.SIGTERM)",
        ],
    )
    classification = await asyncio.wait_for(asyncio.shield(child.exit), FAILURE_CAP_S)
    assert classification.kind == "crash"
    assert classification.exit_code is None
    assert classification.exit_signal == "SIGTERM"
    assert classification.stderr_tail == ("before signal",)


@pytest.mark.asyncio
async def test_byte_cap_trims_heavy_lines_before_the_line_cap() -> None:
    # 80 lines of 100 two-byte scalars (~16 KB) stay under the 100-line cap,
    # so only the byte budget can bound the tail; the cut must never
    # manufacture replacement characters (the TS #trimBytes arm).
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=[
            "-c",
            "import sys; sys.stderr.write(('\\u00e9' * 100 + '\\n') * 80); "
            "sys.stderr.flush(); sys.exit(3)",
        ],
    )
    classification = await asyncio.wait_for(asyncio.shield(child.exit), FAILURE_CAP_S)
    assert classification.kind == "configError"
    joined = "\n".join(child.stderr_tail)
    assert len(joined.encode("utf-8")) <= 8 * 1024
    assert len(child.stderr_tail) < 100, "the byte budget did the trimming"
    assert "�" not in child.stderr_tail[0], "no manufactured U+FFFD"


@pytest.mark.asyncio
async def test_close_sends_eof_and_resolves_on_the_observed_exit() -> None:
    # the governing rule CONTROL: a draining host is never signalled; close()
    # classifies the exit it observed (cleanShutdown), causally on EOF.
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=[
            "-c",
            "import sys; sys.stdin.buffer.read(); "
            "sys.stderr.write('drained\\n'); sys.stderr.flush(); sys.exit(0)",
        ],
        shutdown_timeout_ms=10_000,
    )
    classification = await asyncio.wait_for(child.close(), FAILURE_CAP_S)
    assert classification.kind == "cleanShutdown"
    assert child.stderr_tail == ("drained",)


@pytest.mark.asyncio
async def test_close_terminates_a_host_that_ignores_stdin_eof() -> None:
    probe = PidProbe()
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", IGNORES_EOF],
        shutdown_timeout_ms=ESCALATION_DRAIN_MS,
        on_stderr=probe.on_stderr,
    )
    pid = await probe.pid()
    try:
        classification = await asyncio.wait_for(child.close(), FAILURE_CAP_S)
        assert classification.kind == "crash"
        assert classification.exit_signal == "SIGTERM"
        assert classification.stderr_tail == (f"child_pid={pid}",)
        assert not is_alive(pid), "close() leaves no orphaned host process"
    finally:
        reap(pid)


@pytest.mark.asyncio
async def test_close_escalates_to_sigkill_when_sigterm_is_trapped() -> None:
    probe = PidProbe()
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", IGNORES_EOF_AND_SIGTERM],
        shutdown_timeout_ms=ESCALATION_DRAIN_MS,
        on_stderr=probe.on_stderr,
    )
    pid = await probe.pid()
    try:
        classification = await asyncio.wait_for(child.close(), FAILURE_CAP_S + 10)
        assert classification.kind == "crash"
        assert classification.exit_signal == "SIGKILL"
        assert not is_alive(pid), "close() leaves no orphaned host process"
    finally:
        reap(pid)


@pytest.mark.asyncio
async def test_a_late_but_voluntary_exit_keeps_its_own_classification() -> None:
    # Escalation is a way to REACH an exit, never a classification of its own
    #: a host that traps SIGTERM and exits 3 is configError.
    probe = PidProbe()
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", EXITS_3_ON_SIGTERM],
        shutdown_timeout_ms=0,
        on_stderr=probe.on_stderr,
    )
    pid = await probe.pid()
    try:
        classification = await asyncio.wait_for(child.close(), FAILURE_CAP_S)
        assert classification.kind == "configError"
        assert classification.exit_code == 3
        assert classification.retry == "fix-config"
        assert not is_alive(pid)
    finally:
        reap(pid)


@pytest.mark.asyncio
async def test_concurrent_close_calls_share_one_shutdown() -> None:
    # COUNTING the signals is the point: with the memoization deleted, equal
    # results are trivially true while the host takes TWO SIGTERMs.
    probe = PidProbe()
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", COUNTS_SIGTERM],
        shutdown_timeout_ms=ESCALATION_DRAIN_MS,
        on_stderr=probe.on_stderr,
    )
    pid = await probe.pid()
    try:
        first, second = await asyncio.wait_for(
            asyncio.gather(child.close(), child.close()), FAILURE_CAP_S + 10
        )
        assert first == second
        assert first.kind == "crash"
        deliveries = sum(
            line == "sigterm_seen"
            for chunk in probe.chunks
            for line in chunk.splitlines()
        )
        assert deliveries == 1, "two close() calls must not each run the ladder"
        again = await asyncio.wait_for(child.close(), FAILURE_CAP_S)
        assert again == first
        assert not is_alive(pid)
    finally:
        reap(pid)


@POSIX_ONLY
@pytest.mark.asyncio
async def test_close_terminates_the_spawned_host_process_group() -> None:
    probe = PidProbe()
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", WRAPPER_WITH_STDOUT_HOLDING_GRANDCHILD],
        shutdown_timeout_ms=ESCALATION_DRAIN_MS,
        on_stderr=probe.on_stderr,
    )
    pid = grandchild_pid = None
    try:
        pid = await probe.pid()
        grandchild_pid = await probe.grandchild_pid()
        assert is_alive(pid), "setup: the wrapper host is alive"
        assert is_alive(grandchild_pid), "setup: the stdout-holding grandchild is alive"
        classification = await asyncio.wait_for(child.close(), FAILURE_CAP_S + 10)
        assert classification.kind == "crash"
        assert classification.exit_signal == "SIGKILL"
        assert not is_alive(pid), "close() leaves no orphaned host process"
        assert await ended_within(grandchild_pid, 5.0), (
            "group escalation ends the stdout-holding grandchild too (a tracked issue:"
            "a zombie awaiting init's reap counts as ended)"
        )
    finally:
        reap(grandchild_pid)
        reap(pid)


@POSIX_ONLY
@pytest.mark.asyncio
async def test_a_failed_group_signal_falls_back_to_the_direct_child() -> None:
    # The bare except in the ladder is normative: group capability CLAIMED but
    # the child was spawned without a new session, so its pid is not a pgid
    # and every group signal fails deterministically — only the fallback can
    # end the child.
    probe = PidProbe()
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        IGNORES_EOF,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    transport = ChildStdioTransport(
        child,
        probe.on_stderr,
        shutdown_timeout_ms=ESCALATION_DRAIN_MS,
        owns_process_group=True,
    )
    pid = await probe.pid()
    try:
        await asyncio.wait_for(transport.close(), FAILURE_CAP_S)
        exit_status = await asyncio.wait_for(asyncio.shield(transport.exited), FAILURE_CAP_S)
        assert exit_status.code is None
        assert exit_status.signal == "SIGTERM"
        assert not is_alive(pid), "the direct-child fallback still ends the host"
    finally:
        reap(pid)


@pytest.mark.asyncio
async def test_close_terminates_a_host_that_never_reads_stdin() -> None:
    # The P0 leg: a filled pipe means EOF never completes; gating the ladder
    # on it reproduces the a tracked issue wedge inside the fix.
    probe = PidProbe()
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        NEVER_READS_STDIN,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    transport = ChildStdioTransport(child, probe.on_stderr, shutdown_timeout_ms=0)
    pid = await probe.pid()
    try:
        write_task = asyncio.ensure_future(transport.write(UNFLUSHABLE_WRITE))
        write_task.add_done_callback(lambda t: t.exception())
        await asyncio.wait_for(transport.close(), FAILURE_CAP_S)
        exit_status = await asyncio.wait_for(asyncio.shield(transport.exited), FAILURE_CAP_S)
        assert exit_status.signal == "SIGTERM"
        assert not is_alive(pid), "an unflushable stdin must not gate the ladder"
    finally:
        reap(pid)


@pytest.mark.asyncio
async def test_shutdown_timeout_zero_skips_the_drain_window() -> None:
    # `0` must stay 0: an `or DEFAULT` refactor silently makes it 30 s and
    # every other arm stays green — the failure-only cap catches it here.
    probe = PidProbe()
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", IGNORES_EOF],
        shutdown_timeout_ms=0,
        on_stderr=probe.on_stderr,
    )
    pid = await probe.pid()
    try:
        classification = await asyncio.wait_for(child.close(), FAILURE_CAP_S)
        assert classification.kind == "crash"
        assert not is_alive(pid)
    finally:
        reap(pid)


@pytest.mark.asyncio
async def test_out_of_range_shutdown_timeout_is_refused_before_spawn(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # WHERE the raise happens is the load-bearing half: a transport-level
    # throw leaves the child running with no owner. CAUSAL oracle (a tracked issue;
    # a prior review): create_subprocess_exec is stubbed to
    # fail the test if it is ever reached — no wall clock, no sentinel race.
    from muse_code.connection import spawn as spawn_module

    async def _must_not_spawn(*args: object, **kwargs: object) -> object:
        raise AssertionError("create_subprocess_exec must not be reached")

    monkeypatch.setattr(
        spawn_module.asyncio, "create_subprocess_exec", _must_not_spawn
    )
    for bad in (float("inf"), float("nan"), -1, 2_147_483_648, 1.5, True):
        with pytest.raises(ValueError):
            await MuseServeChild.spawn(
                muse_bin=sys.executable,
                args=["-c", "pass"],
                shutdown_timeout_ms=bad,  # type: ignore[arg-type]
            )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bad_options",
    [
        pytest.param({"muse_bin": 123}, id="command-not-a-string"),
        # The classic bare-string bug: iterating it would spawn with each
        # CHARACTER as an argument; the seam must refuse it as a sequence.
        pytest.param({"args": "serve"}, id="args-bare-string"),
        pytest.param({"args": ["-c", 5]}, id="args-non-string-element"),
        pytest.param({"cwd": 7}, id="cwd-not-a-string"),
        pytest.param({"env": {"KEY": 1}}, id="env-non-string-value"),
        # Strict on the budget: a numeric string is not a budget, exactly
        # like the pre-existing bool refusal above.
        pytest.param({"shutdown_timeout_ms": "5"}, id="budget-numeric-string"),
    ],
)
async def test_bad_spawn_options_reject_with_the_typed_error_before_spawn(
    monkeypatch: pytest.MonkeyPatch, bad_options: dict[str, object]
) -> None:
    # C-638-2 seam 2 (owner ruling a tracked issue, arm (a)): spawn options validate
    # through a pydantic model at construction, rejecting with the SDK's
    # typed error BEFORE any process exists. Same causal oracle as the
    # budget-range test above: reaching create_subprocess_exec is the fail.
    from muse_code.connection import spawn as spawn_module

    async def _must_not_spawn(*args: object, **kwargs: object) -> object:
        raise AssertionError("create_subprocess_exec must not be reached")

    monkeypatch.setattr(
        spawn_module.asyncio, "create_subprocess_exec", _must_not_spawn
    )
    options: dict[str, object] = {
        "muse_bin": sys.executable,
        "args": ["-c", "pass"],
        **bad_options,
    }
    with pytest.raises(MuseValidationError) as caught:
        await MuseServeChild.spawn(**options)  # type: ignore[arg-type]
    assert caught.value.seam == "spawnOptions"
    # The pre-existing ValueError contract holds (the budget-range test
    # above), and the wrapper carries pydantic's own error as the cause.
    assert isinstance(caught.value, ValueError)
    assert isinstance(caught.value.__cause__, pydantic.ValidationError)


@pytest.mark.skipif(
    not hasattr(signal, "SIGRTMIN"),
    reason="real-time signals are Linux-only; CI's Linux lane runs this arm",
)
@pytest.mark.asyncio
async def test_a_realtime_signal_still_maps_to_the_crash_row() -> None:
    # a prior review: signal.Signals(35) raises on Linux, so a
    # host killed by a real-time signal must still classify as the crash row
    #, never throw out of `exit` / `close()`. The pid is
    # known causally from spawn() — no pid file, no poll; the RT default
    # disposition terminates whenever the signal lands. Guarded ABOVE the
    # spawn so a non-Linux run never orphans the wedged child.
    import os

    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", "import time; time.sleep(3600)"],  # wedged on purpose
    )
    rt_signal = signal.SIGRTMIN + 1
    os.kill(child._transport.child.pid, rt_signal)
    outcome = await asyncio.wait_for(child.exit, FAILURE_CAP_S)
    assert outcome.kind == "crash", f"a real-time signal is the crash row: {outcome}"
    assert outcome.exit_signal is not None and str(int(rt_signal)) in outcome.exit_signal, (
        f"the row names the delivered signal: {outcome.exit_signal}"
    )


@pytest.mark.asyncio
async def test_flush_and_drain_share_one_deadline() -> None:
    # a prior review, threads 2/3/4:
    # ONE deadline is minted for the whole shutdown — flush wait AND drain
    # window — and expiring that single deadline advances the ladder. A
    # fresh-budget-per-half refactor mints two and fails the count. The seam
    # lives on the module-internal ChildStdioTransport ctor only (never the
    # public spawn signature), the mint IS the sync event (no sleep-poll),
    # and after close() settles no task may remain pending —
    # the deadline-abandoned flush wait must be cancelled, not leaked.
    minted_event = asyncio.Event()
    minted: list[FakeDeadline] = []

    class FakeDeadline:
        def __init__(self, budget_ms: int) -> None:
            self.budget_ms = budget_ms
            self.event = asyncio.Event()
            self.cleared = False
            minted.append(self)
            minted_event.set()

        async def expired(self) -> None:
            await self.event.wait()

        def clear(self) -> None:
            self.cleared = True

    proc = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        "import time; time.sleep(3600)",  # ignores EOF: only the ladder ends it
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    transport = ChildStdioTransport(proc, None, deadline_factory=FakeDeadline)
    # A flushed promise that never settles on its own: the shared deadline
    # must bound it rather than a second budget.
    never_flushed: asyncio.Future[None] = asyncio.get_running_loop().create_future()

    async def _flushed() -> None:
        await asyncio.shield(never_flushed)

    closer = asyncio.ensure_future(transport.close(_flushed()))
    await asyncio.wait_for(minted_event.wait(), FAILURE_CAP_S)
    assert len(minted) == 1, f"one shutdown mints ONE deadline, got {len(minted)}"
    minted[0].event.set()  # the single budget elapses: ladder runs to the kill
    outcome = await asyncio.wait_for(asyncio.shield(transport.exited), FAILURE_CAP_S)
    await asyncio.wait_for(closer, FAILURE_CAP_S)
    assert len(minted) == 1, "no second deadline appeared for the drain half"
    assert minted[0].cleared, "the governing rule: close() must disarm its deadline timer"
    assert outcome.signal is not None, f"the wedged host ends on a signal: {outcome}"
    # the governing rule: with the flush wait still pending when the deadline won,
    # close() settling must leave NO pending task behind.
    leftovers = {
        task for task in asyncio.all_tasks() if task is not asyncio.current_task()
    }
    assert leftovers == set(), f"tasks left pending after close(): {leftovers}"
    never_flushed.set_result(None)


class _ParkedDeadline:
    """A deadline that never expires on its own and reports when the
    shutdown is parked awaiting it — the causal sync for the teardown-cancel
    arms. ``release()`` lets any expiry task a cancel
    stranded finish before the loop closes."""

    def __init__(self, budget_ms: int) -> None:
        self.budget_ms = budget_ms
        self.entered = asyncio.Event()
        self._expiry = asyncio.Event()
        self.cleared = False

    async def expired(self) -> None:
        self.entered.set()
        await self._expiry.wait()

    def clear(self) -> None:
        self.cleared = True

    def release(self) -> None:
        self._expiry.set()


@pytest.mark.asyncio
async def test_a_cancelled_close_ladder_still_kills_the_host() -> None:
    # a prior review, round 18 (reviewkit P0 + zdwmeta, the PY-the governing rule
    # teardown-cancel arm): cancelling close() while the ladder is parked in
    # its FIRST drain window (Ctrl-C during asyncio.run teardown) must still
    # end the host — `_shutdown`'s finally sends one synchronous SIGKILL.
    # The stub ignores SIGTERM, so only that rung can end it: delete the
    # rung and this test reds with a live pid.
    probe = PidProbe()
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        IGNORES_EOF_AND_SIGTERM,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    minted: list[_ParkedDeadline] = []
    minted_event = asyncio.Event()

    def factory(budget_ms: int) -> _ParkedDeadline:
        deadline = _ParkedDeadline(budget_ms)
        minted.append(deadline)
        minted_event.set()
        return deadline

    transport = ChildStdioTransport(
        child, probe.on_stderr, shutdown_timeout_ms=3_600_000, deadline_factory=factory
    )
    pid = None
    try:
        pid = await probe.pid()
        closer = asyncio.ensure_future(transport.close())
        # No flushed promise: the first (and only) expired() await IS the
        # drain window, so `entered` proves the ladder is parked mid-drain.
        await asyncio.wait_for(minted_event.wait(), FAILURE_CAP_S)
        await asyncio.wait_for(minted[0].entered.wait(), FAILURE_CAP_S)
        # Cancel the SHUTDOWN task itself, as asyncio.run's loop-exit does:
        # cancelling the close() wrapper would only cancel its shield and
        # leave the memoized shutdown running (by design).
        assert transport._closing is not None
        transport._closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(closer, FAILURE_CAP_S)
        assert await ended_within(pid, FAILURE_CAP_S), (
            "a cancelled ladder never orphans the SIGTERM-ignoring host"
        )
        # The kill is SYNCHRONOUS under the cancel, so the deadline the
        # shutdown minted was still disarmed on the way out.
        assert minted[0].cleared, "the cancelled shutdown must disarm its deadline"
        await asyncio.wait_for(asyncio.shield(transport.exited), FAILURE_CAP_S)
        # Deterministic teardown the cancelled ladder never reached: settle
        # the stderr drain at pipe EOF and close the subprocess transport so
        # no GC-timed ResourceWarning leaks out of this test.
        drain = transport._stderr_task
        if drain is not None:
            await asyncio.wait_for(asyncio.shield(drain), FAILURE_CAP_S)
        proc_transport = getattr(child, "_transport", None)
        if proc_transport is not None:
            proc_transport.close()
    finally:
        for deadline in minted:
            deadline.release()
        reap(pid)


@pytest.mark.asyncio
async def test_a_cancel_parked_on_the_flush_wait_still_kills_the_host() -> None:
    # a prior review, round 18 (zdwmeta): `_shutdown` first parks on the
    # FLUSH wait, and that window is as long as shutdown_timeout_ms — a
    # ladder-local kill guard never fires for a cancel landing there (the
    # round-17 regression). The guard lives in `_shutdown`'s finally now, so
    # the SIGTERM-ignoring host still dies by synchronous SIGKILL.
    probe = PidProbe()
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        IGNORES_EOF_AND_SIGTERM,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    minted: list[_ParkedDeadline] = []
    minted_event = asyncio.Event()

    def factory(budget_ms: int) -> _ParkedDeadline:
        deadline = _ParkedDeadline(budget_ms)
        minted.append(deadline)
        minted_event.set()
        return deadline

    transport = ChildStdioTransport(
        child, probe.on_stderr, shutdown_timeout_ms=3_600_000, deadline_factory=factory
    )
    never_flushed: asyncio.Future[None] = asyncio.get_running_loop().create_future()

    async def _flushed() -> None:
        await asyncio.shield(never_flushed)

    pid = None
    try:
        pid = await probe.pid()
        closer = asyncio.ensure_future(transport.close(_flushed()))
        # With a flushed promise that never settles, the first expired()
        # await is `_before_deadline`'s flush-wait race: `entered` proves the
        # shutdown is parked BEFORE the ladder, in the missed window.
        await asyncio.wait_for(minted_event.wait(), FAILURE_CAP_S)
        await asyncio.wait_for(minted[0].entered.wait(), FAILURE_CAP_S)
        # Cancel the SHUTDOWN task itself (asyncio.run loop-exit shape), not
        # the close() wrapper whose shield deliberately absorbs a cancel.
        assert transport._closing is not None
        transport._closing.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(closer, FAILURE_CAP_S)
        assert await ended_within(pid, FAILURE_CAP_S), (
            "a cancel parked on the flush wait never orphans the host"
        )
        await asyncio.wait_for(asyncio.shield(transport.exited), FAILURE_CAP_S)
        # Same deterministic teardown as the mid-drain arm above.
        drain = transport._stderr_task
        if drain is not None:
            await asyncio.wait_for(asyncio.shield(drain), FAILURE_CAP_S)
        proc_transport = getattr(child, "_transport", None)
        if proc_transport is not None:
            proc_transport.close()
    finally:
        for deadline in minted:
            deadline.release()
        never_flushed.set_result(None)
        reap(pid)


@pytest.mark.asyncio
async def test_stderr_multibyte_split_across_read_chunks_never_garbles_evidence() -> None:
    # a prior review: the drain reads 8 KiB chunks, so a UTF-8
    # character straddling two reads must be carried by ONE incremental
    # decoder, never decoded into replacement characters in the tail.
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=[
            "-c",
            "import sys; sys.stderr.buffer.write("
            "b'a' * 8191 + '\\u00e9'.encode() + b' tail\\n'); "
            "sys.stderr.buffer.flush(); sys.exit(3)",
        ],
    )
    classification = await asyncio.wait_for(asyncio.shield(child.exit), FAILURE_CAP_S)
    assert classification.kind == "configError"
    joined = "".join(child.stderr_tail)
    assert "�" not in joined, "no manufactured U+FFFD at the read boundary"
    assert joined.endswith("é tail"), f"the split character survived: {joined[-16:]!r}"


@pytest.mark.asyncio
async def test_line_cap_bounds_the_tail_to_the_100_most_recent_lines() -> None:
    # a prior review (the TS twin's dedicated line-cap arm):
    # 400 short lines stay far under the byte budget, so only the 100-line
    # half of the governing rule bound can do the trimming.
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=[
            "-c",
            "import sys\n"
            "for n in range(1, 401):\n"
            "    sys.stderr.write('line %d\\n' % n)\n"
            "sys.stderr.flush()\n"
            "sys.exit(3)",
        ],
    )
    classification = await asyncio.wait_for(asyncio.shield(child.exit), FAILURE_CAP_S)
    assert classification.kind == "configError"
    assert len(child.stderr_tail) == 100, "the line cap did the trimming"
    assert child.stderr_tail[0] == "line 301", "oldest lines fall off the front"
    assert child.stderr_tail[-1] == "line 400", "the most recent line is retained"


@pytest.mark.asyncio
async def test_write_after_close_raises_the_typed_stdin_closed_error() -> None:
    # a prior review: a request issued after close() has begun
    # must reject immediately with the typed error, never silently drop the
    # frame into a closed pipe.
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", "import sys; sys.stdin.buffer.read()"],
        shutdown_timeout_ms=ESCALATION_DRAIN_MS,
    )
    await asyncio.wait_for(child.close(), FAILURE_CAP_S)
    with pytest.raises(ProtocolError, match="stdin is closed"):
        await child._transport.write('{"jsonrpc":"2.0","method":"x"}\n')


@pytest.mark.asyncio
async def test_a_consumer_timeout_on_exit_never_breaks_close() -> None:
    # a prior review: `exit` hands out a shield, so a consumer's
    # own wait_for timeout cancels only its wait — with the raw watcher task
    # exposed, that cancellation broke close() and orphaned the host.
    probe = PidProbe()
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", IGNORES_EOF],
        shutdown_timeout_ms=ESCALATION_DRAIN_MS,
        on_stderr=probe.on_stderr,
    )
    pid = await probe.pid()
    try:
        with pytest.raises(asyncio.TimeoutError):
            # The host is wedged on purpose, so this timeout ALWAYS fires;
            # the small value only bounds how long the failure arm waits.
            await asyncio.wait_for(child.exit, 0.05)
        classification = await asyncio.wait_for(child.close(), FAILURE_CAP_S)
        assert classification.kind == "crash"
        assert not is_alive(pid), "close() still ends the host after the timeout"
    finally:
        reap(pid)


@pytest.mark.asyncio
async def test_close_stays_bounded_when_a_detached_grandchild_holds_stderr() -> None:
    # a prior review: asyncio's Process.wait() settles only when
    # every stdio pipe hits EOF, so a detached helper holding the inherited
    # stderr pipe kept close() waiting forever after the host itself was
    # reaped. The ladder must resolve on the REAP (returncode), bounded.
    probe = PidProbe()
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", DETACHED_STDERR_HOLDER],
        shutdown_timeout_ms=ESCALATION_DRAIN_MS,
        on_stderr=probe.on_stderr,
    )
    pid = grandchild_pid = None
    try:
        pid = await probe.pid()
        grandchild_pid = await probe.grandchild_pid()
        classification = await asyncio.wait_for(child.close(), FAILURE_CAP_S + 10)
        assert classification.kind == "cleanShutdown", (
            f"the voluntary exit keeps its own row: {classification}"
        )
        assert not is_alive(pid) or is_zombie(pid), "the host itself has ended"
        assert is_alive(grandchild_pid), (
            "setup soundness: the detached helper held the pipe past close()"
        )
    finally:
        reap(grandchild_pid)
        reap(pid)


@pytest.mark.asyncio
async def test_stdout_multibyte_split_across_chunks_decodes_whole(tmp_path) -> None:
    # a prior review: only the stdout
    # incremental decoder can see a code point straddling two READS — the
    # str-slicing arm cannot cut one. The stub flushes half the character,
    # then blocks on stdin, so the boundary is causal, not scheduled.
    stub = tmp_path / "split_stdout_host.py"
    stub.write_text(
        "import sys\n"
        "payload = ('{\"jsonrpc\":\"2.0\",\"method\":\"note/\\U0001f600\"}\\n').encode()\n"
        "cut = payload.index(b'\\xf0\\x9f') + 2\n"
        "sys.stdout.buffer.write(payload[:cut])\n"
        "sys.stdout.buffer.flush()\n"
        "sys.stdin.readline()\n"
        "sys.stdout.buffer.write(payload[cut:])\n"
        "sys.stdout.buffer.flush()\n"
        "sys.stdin.read()\n"
    )
    child = await MuseServeChild.spawn(muse_bin=sys.executable, args=[str(stub)])
    transport = child._transport
    chunks: list[str] = []
    iterator = transport.incoming.__aiter__()
    chunks.append(await asyncio.wait_for(iterator.__anext__(), FAILURE_CAP_S))
    await transport.write("go\n")
    while "\n" not in "".join(chunks):
        chunks.append(await asyncio.wait_for(iterator.__anext__(), FAILURE_CAP_S))
    joined = "".join(chunks)
    assert "note/\U0001f600" in joined, f"the split character decoded whole: {joined!r}"
    assert "�" not in joined, "no replacement characters at the read boundary"
    await asyncio.wait_for(child.close(), FAILURE_CAP_S)


@pytest.mark.asyncio
@pytest.mark.parametrize("holder", [DETACHED_STDERR_HOLDER, DETACHED_STDOUT_HOLDER])
async def test_facade_close_is_bounded_and_leaks_nothing_with_a_held_pipe(
    holder: str,
) -> None:
    # a prior review, round 8 (zdwmeta): the PUBLIC facade close —
    # Connection.close() -> transport.close(), NOT MuseServeChild.close() —
    # must be bounded and leave no task/pipe behind on the 3.10 CI lane, for
    # a helper holding EITHER fd 2 (else _classified + drain leak and the
    # transport stays open -> "Event loop is closed" at teardown) or fd 1
    # (else the read loop never EOFs and _closed hangs). The shutdown owner
    # cuts once for both.
    from muse_code.connection import Connection
    from muse_code.connection.spawn import MspHandshake

    probe = PidProbe()
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", holder],
        # A long budget on purpose: the host exits voluntarily, so a bounded
        # close can only come from the REAP-driven path — a regression that
        # gated close() on pipe EOF would ride this whole budget and blow the
        # cap, where 150 ms would let a stale escalate-to-SIGKILL sneak in
        #.
        shutdown_timeout_ms=60_000,
        on_stderr=probe.on_stderr,
    )
    handshake = MspHandshake(child, Connection(child._transport))
    pid = grandchild_pid = None
    try:
        pid = await probe.pid()
        grandchild_pid = await probe.grandchild_pid()
        exit_status = await asyncio.wait_for(handshake.close(), FAILURE_CAP_S + 10)
        assert exit_status.code == 0, f"the voluntary exit is preserved: {exit_status}"
        assert not is_alive(pid) or is_zombie(pid), "the host itself has ended"
        assert is_alive(grandchild_pid), (
            "setup soundness: the detached helper held its pipe past close()"
        )
        leftovers = {
            task for task in asyncio.all_tasks() if task is not asyncio.current_task()
        }
        assert leftovers == set(), f"tasks left pending after facade close(): {leftovers}"
    finally:
        reap(grandchild_pid)
        reap(pid)


@pytest.mark.asyncio
async def test_end_stdin_never_joins_a_wedged_drain_as_a_second_waiter() -> None:
    # a prior review, round 18 (sechegaray): before the GH-74116 backport
    # (< 3.10.8) asyncio's _drain_helper allows ONE waiter — close() calling
    # drain() while a wedged write() is parked in it died with
    # AssertionError, which _end_stdin's except does not catch and
    # _shutdown_after_flush's `await eof` re-raised out of close() after the
    # host was already dead. _end_stdin no longer drains (write_eof() marks
    # the transport closing; _abort_stdin owns the pinned pipe). The 3.10 CI
    # lane runs the newest patch, so the old single-waiter gate is emulated
    # here: a second concurrent drain raises the same AssertionError on
    # EVERY lane, and close() must still settle cleanly.
    probe = PidProbe()
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        STDIN_HOLDING_HELPER,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    transport = ChildStdioTransport(child, probe.on_stderr, shutdown_timeout_ms=0)
    stdin = child.stdin
    assert stdin is not None
    real_drain = stdin.drain
    waiters = 0
    drain_parked = asyncio.Event()

    async def single_waiter_drain() -> None:
        # The pre-3.10.8 _drain_helper shape: a second concurrent waiter
        # dies (`assert waiter is None or waiter.cancelled()`).
        nonlocal waiters
        assert waiters == 0, "second concurrent drain() waiter (GH-74116)"
        waiters += 1
        drain_parked.set()
        try:
            await real_drain()
        finally:
            waiters -= 1

    stdin.drain = single_waiter_drain  # type: ignore[method-assign]
    pid = grandchild_pid = None
    try:
        pid = await probe.pid()
        grandchild_pid = await probe.grandchild_pid()
        write_task = asyncio.ensure_future(transport.write(UNFLUSHABLE_WRITE))
        write_task.add_done_callback(
            lambda t: None if t.cancelled() else t.exception()
        )
        # Causal: close() begins only once the wedged write is PARKED in
        # drain(), so _end_stdin runs with the single waiter slot taken.
        await asyncio.wait_for(drain_parked.wait(), FAILURE_CAP_S)
        await asyncio.wait_for(transport.close(), FAILURE_CAP_S)
        exit_status = await asyncio.wait_for(asyncio.shield(transport.exited), FAILURE_CAP_S)
        assert exit_status.signal is not None, "the ladder ended the wedged host"
        assert not is_alive(pid), "close() settled cleanly and ended the host"
    finally:
        reap(grandchild_pid)
        reap(pid)


@pytest.mark.asyncio
async def test_close_stays_bounded_when_a_wedged_write_and_a_helper_hold_stdin() -> None:
    # a prior review, round 4 (sechegaray): stdin.close() is a no-op after
    # _end_stdin's write_eof(), so a wedged 2 MiB write plus a helper holding
    # fd 0 kept close() waiting on the drain forever. The ladder now aborts
    # our end of the pipe outright.
    probe = PidProbe()
    child = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        STDIN_HOLDING_HELPER,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    transport = ChildStdioTransport(child, probe.on_stderr, shutdown_timeout_ms=0)
    # Acquire the pids INSIDE the try so a probe timeout (marker never
    # arrives) still reaps whatever did spawn — the sleeper + its detached
    # grandchild otherwise survive an hour.
    pid = grandchild_pid = None
    try:
        pid = await probe.pid()
        grandchild_pid = await probe.grandchild_pid()
        write_task = asyncio.ensure_future(transport.write(UNFLUSHABLE_WRITE))
        # The abort drops the pipe, so the pinned write settles cancelled or
        # errored; retrieve either so it is never flagged unretrieved.
        write_task.add_done_callback(
            lambda t: None if t.cancelled() else t.exception()
        )
        await asyncio.wait_for(transport.close(), FAILURE_CAP_S)
        exit_status = await asyncio.wait_for(asyncio.shield(transport.exited), FAILURE_CAP_S)
        assert exit_status.signal is not None, "the ladder ended the wedged host"
        assert not is_alive(pid), "a pinned stdin write must not gate the ladder"
    finally:
        reap(grandchild_pid)  # the detached fd-0 holder survives the host
        reap(pid)


@pytest.mark.asyncio
async def test_a_raising_on_stderr_callback_never_logs_an_unretrieved_exception() -> None:
    # a prior review, round 7 (reviewkit): an on_stderr callback that raises
    # settles the drain task with an exception; close()/classify must retrieve
    # it (both drain-wait sites) so asyncio never logs "exception was never
    # retrieved" at GC into the consumer's process.
    import gc

    loop = asyncio.get_running_loop()
    unretrieved: list[object] = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _l, ctx: unretrieved.append(ctx))
    child = None
    try:
        def boom(_chunk: str) -> None:
            raise RuntimeError("on_stderr blew up")

        child = await MuseServeChild.spawn(
            muse_bin=sys.executable,
            args=[
                "-c",
                "import sys; sys.stderr.write('x\\n'); sys.stderr.flush(); "
                "sys.stdin.buffer.read()",
            ],
            shutdown_timeout_ms=ESCALATION_DRAIN_MS,
            on_stderr=boom,
        )
        classification = await asyncio.wait_for(child.close(), FAILURE_CAP_S)
        assert classification.kind in ("crash", "cleanShutdown")
        child = None
        for _ in range(5):
            gc.collect()
            await asyncio.sleep(0)
        assert unretrieved == [], f"drain exception left unretrieved: {unretrieved}"
    finally:
        loop.set_exception_handler(previous)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "holder",
    [
        pytest.param(DETACHED_STDERR_HOLDER, id="held-stderr"),
        pytest.param(DETACHED_STDOUT_HOLDER, id="held-stdout"),
    ],
)
async def test_child_exit_is_bounded_after_a_natural_exit_with_a_held_pipe(
    holder: str,
) -> None:
    # a prior review, round 11 P0 / round 15: a host that exits on its OWN
    # (nobody calls close()) while a leaked helper holds a stdio pipe must not
    # hang a consumer passively awaiting child.exit. Held stderr exercises
    # `_classified`'s bounded drain wait; held stdout isolates `_await_exit`'s
    # returncode-poll (the stderr drain EOFs fine there, but Process.wait()
    # stays blocked on the held stdout). Reverting either bound hangs the
    # matching arm.
    probe = PidProbe()
    grandchild_pid = None
    try:
        child = await MuseServeChild.spawn(
            muse_bin=sys.executable,
            args=["-c", holder],  # exits 0, leaks a detached pipe holder
            on_stderr=probe.on_stderr,
        )
        grandchild_pid = await probe.grandchild_pid()
        classification = await asyncio.wait_for(
            asyncio.shield(child.exit), FAILURE_CAP_S
        )
        assert classification.kind == "cleanShutdown", (
            f"the natural exit classifies without close(): {classification}"
        )
    finally:
        reap(grandchild_pid)


@pytest.mark.asyncio
async def test_facade_close_delivers_a_hosts_full_stdout_then_settles() -> None:
    # a prior review, round 11 (reviewkit): the round-8 stdout-preservation
    # half. `_finalize_reaped` waits (bounded) for a live consumer's stdout to
    # reach EOF before force-closing, so a cleanly-exited host's full output
    # is delivered and the facade close still settles. Note: this cannot
    # deterministically RED the eof-wait's removal — asyncio's StreamReader
    # read-ahead pulls the pipe into the reader before any force-close, so a
    # truncation assertion would be a race. It guards the delivered
    # output + bounded settle; the held-pipe force-close is pinned by
    # test_facade_close_is_bounded_and_leaks_nothing_with_a_held_pipe.
    from muse_code.connection import Connection
    from muse_code.connection.spawn import MspHandshake

    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=[
            "-c",
            "import sys, json\n"
            "sys.stdin.buffer.read()\n"  # blocks until close() sends EOF
            "for i in range(50):\n"
            "    sys.stdout.write(json.dumps({'jsonrpc': '2.0', "
            "'method': 'note/%d' % i}) + '\\n')\n"
            "sys.stdout.flush()\n"
            "sys.exit(0)\n",
        ],
        shutdown_timeout_ms=10_000,
    )
    connection = Connection(child._transport)
    notes: list[str] = []
    connection.on_notification(lambda n: notes.append(str(n.get("method"))))
    handshake = MspHandshake(child, connection)
    exit_status = await asyncio.wait_for(handshake.close(), FAILURE_CAP_S)
    assert exit_status.code == 0, "the host drained EOF and exited cleanly"
    assert notes == [f"note/{i}" for i in range(50)], (
        f"the host's full post-EOF stdout reached the consumer: {notes[:3]}...{notes[-3:]}"
    )


def test_fixture_host_bin_fails_closed_on_a_missing_explicit_path(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # a prior review, round 15: an explicit MUSE_CONFORMANCE_BIN that is
    # not a file must RAISE, not fall through to a silent skip — restoring
    # the old `if explicit and Path(explicit).is_file()` shape would bring
    # back the "11 host arms silently skipped, lane green" incident.
    monkeypatch.setenv("MUSE_CONFORMANCE_BIN", str(tmp_path / "absent"))
    with pytest.raises(RuntimeError, match="is not a file"):
        fixture_host_bin()


@pytest.mark.asyncio
async def test_a_bare_incoming_attribute_probe_does_not_arm_the_close_penalty() -> None:
    # a prior review, round 15: `_stdout_consumed` must be set on generator
    # ITERATION, not by the `incoming` getter — else a `getattr`/`hasattr`
    # discovery sweep (the DuplexTransport Protocol documents that idiom)
    # would make every later close() wait the full stdout-EOF grace for a
    # reader that never runs. The direct oracle is the flag: a bare attribute
    # probe must leave it False, and a single iteration must flip it True.
    # (A timing assert on close() would be the public oracle but is a
    # wall-clock green-path assert a tracked issue forbids; the flag pins it
    # deterministically.)
    child = await MuseServeChild.spawn(
        muse_bin=sys.executable,
        args=["-c", "import sys, time; sys.stdout.write('x\\n'); "
              "sys.stdout.flush(); time.sleep(3600)"],
    )
    transport = child._transport
    pid = transport.child.pid
    try:
        getattr(transport, "incoming")  # bare probe: the getter must not arm
        _ = transport.incoming  # a second bare access, still no iteration
        assert transport._stdout_consumed is False, (
            "a bare attribute probe must not register a consumer"
        )
        chunk = await asyncio.wait_for(
            transport.incoming.__aiter__().__anext__(), FAILURE_CAP_S
        )
        assert chunk == "x\n"
        assert transport._stdout_consumed is True, (
            "iterating the stdout generator registers the consumer"
        )
    finally:
        reap(pid)
