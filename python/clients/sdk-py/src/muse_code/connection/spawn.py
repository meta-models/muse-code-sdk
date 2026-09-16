"""The owned-process stdio binding and type-state handshake (spec 638 S2).

Port of ``clients/sdk-ts/src/connection/spawn.ts``: ``MuseServeChild`` owns
one spawned MSP host with SS2.11 diagnostics (stderr ring from birth, total
exit mapping) and the bounded close ladder (14990 FR-017a/b semantics,
FR-638-016/017/018): stdin EOF first, one shared shutdown budget, ``SIGTERM``,
one ``SIGKILL`` escalation after a fixed grace, resolution on the observed
exit, POSIX process-group ownership with a direct-child fallback.

Python observation rule (spec 638 FR-638-017): asyncio exposes ONE
``returncode`` — ``>= 0`` is the exit-code row for that code, ``< 0`` is the
crash row carrying signal ``-returncode``.
"""

from __future__ import annotations

import asyncio
import codecs
import os
import signal as signal_module
import sys
from dataclasses import dataclass
from typing import (
    TYPE_CHECKING,
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Literal,
    Mapping,
    Sequence,
    TypedDict,
)

from ..errors import MuseHostMismatchError
from .connection import Connection, ProtocolError
from .validation import parse_initialize_result, parse_spawn_options

if TYPE_CHECKING:
    from muse_code_msp import InitializeParams, InitializeResult, RequestId

DEFAULT_STDERR_MAX_BYTES = 8 * 1024
DEFAULT_STDERR_MAX_LINES = 100
DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000
"""SS2.1.2's default host drain timeout: the whole EOF sequence's budget."""
SIGTERM_GRACE_MS = 2_000
"""SIGTERM -> SIGKILL grace. Not a knob: by the time it runs the host has had
its whole drain window, so this covers only a signal handler's final flush.
Also bounds ``_classified``'s post-exit stderr-drain wait (py3.10 settles
``wait()`` at the reap, before pipe EOF), so tuning it down also shrinks the
window for capturing a host's final stderr evidence."""
OnStderr = Callable[[str], None]


@dataclass(frozen=True)
class ProcessExit:
    """How the host process ended: exactly one of the two is non-``None``.

    Attributes:
        code: The exit code, for a voluntary exit.
        signal: The ending signal's name (e.g. ``"SIGTERM"``), for a killed
            host — Python's negative ``returncode`` decomposed.
    """

    code: int | None
    signal: str | None

    @staticmethod
    def from_returncode(returncode: int) -> "ProcessExit":
        """Decomposes asyncio's single ``returncode`` (spec 638 FR-638-017)."""
        if returncode >= 0:
            return ProcessExit(code=returncode, signal=None)
        number = -returncode
        try:
            name = signal_module.Signals(number).name
        except ValueError:
            # Real-time signals (SIGRTMIN..SIGRTMAX and beyond) have no
            # Signals member on this platform; the row must stay TOTAL
            # (INV-011 carry) — name the number rather than raise.
            name = f"signal {number}"
        return ProcessExit(code=None, signal=name)


@dataclass(frozen=True)
class ExitClassification:
    """The SDK's reading of a host exit (SS2.11; total per INV-011 carry).

    Branch on ``kind``. Every arm but ``cleanShutdown`` carries its exit
    evidence (code or signal plus the bounded stderr tail); the documented
    error exits also carry a stable retry posture. Exit 1 deliberately makes
    NO retry claim (SS2.11 marks no posture for it), so ``retry`` is ``None``
    there and on the crash row.

    Attributes:
        kind: The SS2.11 row.
        exit_code: The observed exit code, where one exists.
        exit_signal: The observed ending signal's name, crash row only.
        stderr_tail: The bounded evidence captured from birth (INV-010:
            evidence, never input).
        retry: The stable retry posture, where SS2.11 states one.
    """

    kind: Literal[
        "cleanShutdown",
        "unhandledError",
        "usageError",
        "configError",
        "leaseUnavailable",
        "sdkSurfaceUnavailable",
        "crash",
    ]
    exit_code: int | None = None
    exit_signal: str | None = None
    stderr_tail: tuple[str, ...] = ()
    retry: Literal["never", "fix-config", "after-lease-release"] | None = None


def classify_exit(
    process_exit: ProcessExit, stderr_tail: Sequence[str]
) -> ExitClassification:
    """Maps one observed exit onto its SS2.11 row (total: INV-011 carry).

    Args:
        process_exit: The observed ``(code, signal)`` decomposition.
        stderr_tail: The bounded evidence at classification time.

    Returns:
        Exactly one row; unrecognized non-zero codes are the crash row,
        never a guessed condition.
    """
    evidence = tuple(stderr_tail)
    code = process_exit.code
    if code == 0:
        return ExitClassification(kind="cleanShutdown")
    if code == 1:
        return ExitClassification(kind="unhandledError", exit_code=1, stderr_tail=evidence)
    if code == 2:
        return ExitClassification(
            kind="usageError", exit_code=2, stderr_tail=evidence, retry="never"
        )
    if code == 3:
        return ExitClassification(
            kind="configError", exit_code=3, stderr_tail=evidence, retry="fix-config"
        )
    if code == 4:
        # Exit 4 is `sessionInUse` arriving early: another live client holds
        # the lease, and it frees itself once that client exits (SS2.11).
        return ExitClassification(
            kind="leaseUnavailable",
            exit_code=4,
            stderr_tail=evidence,
            retry="after-lease-release",
        )
    if code == 5:
        return ExitClassification(
            kind="sdkSurfaceUnavailable",
            exit_code=5,
            stderr_tail=evidence,
            retry="never",
        )
    return ExitClassification(
        kind="crash",
        exit_code=code,
        exit_signal=process_exit.signal,
        stderr_tail=evidence,
    )


class StderrTail:
    """A client-local evidence budget; its contents never influence behavior.

    Bounded to the 8 KiB / 100-line defaults (a client budget, not a wire
    fact). The byte cut advances past UTF-8 continuation bytes rather than
    manufacturing replacement text.
    """

    def __init__(self) -> None:
        """Starts empty."""
        self._text = ""

    def push(self, chunk: str) -> None:
        """Appends one raw stderr chunk and re-trims both budgets."""
        self._text += chunk
        self._trim_lines()
        self._trim_bytes()

    def lines(self) -> tuple[str, ...]:
        """The retained evidence, split on newlines (no trailing empty)."""
        if not self._text:
            return ()
        lines = self._text.split("\n")
        if lines and lines[-1] == "":
            lines.pop()
        return tuple(lines)

    def _trim_lines(self) -> None:
        line_count = self._text.count("\n") + (0 if self._text.endswith("\n") else 1)
        if self._text.endswith("\n"):
            line_count = self._text.count("\n")
        while line_count > DEFAULT_STDERR_MAX_LINES:
            first_break = self._text.find("\n")
            if first_break < 0:
                break
            self._text = self._text[first_break + 1 :]
            line_count -= 1

    def _trim_bytes(self) -> None:
        data = self._text.encode("utf-8")
        if len(data) <= DEFAULT_STDERR_MAX_BYTES:
            return
        start = len(data) - DEFAULT_STDERR_MAX_BYTES
        while start < len(data) and (data[start] & 0xC0) == 0x80:
            start += 1
        self._text = data[start:].decode("utf-8")


class ShutdownDeadline:
    """One clearable deadline: ``expired`` settles once, ``clear`` disarms it."""

    def __init__(self, budget_ms: int) -> None:
        """Arms the deadline on the running loop."""
        self._event = asyncio.Event()
        self._handle = asyncio.get_running_loop().call_later(
            budget_ms / 1000, self._event.set
        )

    async def expired(self) -> None:
        """Settles when the budget elapses; never raises."""
        await self._event.wait()

    def clear(self) -> None:
        """Disarms the timer so nothing pins the event loop (FR-638-017)."""
        self._handle.cancel()


DeadlineFactory = Callable[[int], ShutdownDeadline]


class ConnectionOptions(TypedDict, total=False):
    """Typed tuning for the connection machine (spec 638 FR-638-011/013).

    Exactly :class:`Connection`'s three keyword options, as a ``TypedDict``
    so ``mypy --strict`` rejects a misspelled key or wrong value type at
    type-check time instead of after the host process was already spawned
    (PR #30094 review; the TS twin types this field as an interface).
    """

    frame_limit_bytes: int
    mint_command_id: Callable[[], str]
    mint_request_id: Callable[[], "RequestId"]


class ChildStdioTransport:
    """Duplex transport over an already-spawned child's stdio.

    Module-internal (never the package barrel), exactly like the TS twin:
    the deterministic close()-race tests construct it around stub children.

    Attributes:
        child: The owned ``asyncio.subprocess.Process``.
    """

    def __init__(
        self,
        child: asyncio.subprocess.Process,
        on_stderr: OnStderr | None = None,
        shutdown_timeout_ms: int = DEFAULT_SHUTDOWN_TIMEOUT_MS,
        owns_process_group: bool = False,
        deadline_factory: DeadlineFactory | None = None,
    ) -> None:
        """Wires the reader tasks and the exit future.

        Args:
            child: A process spawned with piped stdio.
            on_stderr: Raw stderr chunks, drained from birth, never parsed.
            shutdown_timeout_ms: The FR-017a drain budget. The C-638-2
                spawn seam (``validation.parse_spawn_options``) owns the
                range refusal on every public spawn surface; this
                module-internal ctor trusts its callers (PR #31707 review —
                a second downstream copy guarded nothing).
            owns_process_group: True ONLY when the boundary that spawned
                this child made it a group leader (never inferred).
            deadline_factory: Deterministic-test seam; production uses the
                real timer deadline. Deliberately NOT surfaced on any
                public spawn signature (PR #30094 review; TS keeps
                ``deadlineFactory`` on this module-internal ctor only).
        """
        self.child = child
        self._shutdown_timeout_ms = shutdown_timeout_ms
        self._owns_process_group = owns_process_group
        self._make_deadline: DeadlineFactory = deadline_factory or ShutdownDeadline
        self._closing: asyncio.Task[None] | None = None
        self._default_flushed: Callable[[], Awaitable[None]] | None = None
        self._stdout_consumed = False
        self._stderr_task: asyncio.Task[None] | None = None
        if child.stderr is not None and on_stderr is not None:
            self._stderr_task = asyncio.ensure_future(
                self._drain_stderr(on_stderr)
            )
        # Settled by the close ladder when the watcher has recorded a reap
        # but a held stdio pipe keeps Process.wait() from ever returning.
        self._reaped: asyncio.Future[int] = (
            asyncio.get_running_loop().create_future()
        )
        self._exited: asyncio.Task[ProcessExit] = asyncio.ensure_future(
            self._await_exit()
        )

    @property
    def exited(self) -> Awaitable[ProcessExit]:
        """Settles with the observed :class:`ProcessExit`.

        A fresh shield per access: a consumer's ``wait_for`` timeout must
        cancel only its own wait, never the SDK's one real exit watcher —
        a cancelled watcher would break ``close()`` and orphan the host
        (PR #30094 review; a TS Promise cannot be cancelled).
        """
        return asyncio.shield(self._exited)

    async def _await_exit(self) -> ProcessExit:
        # Process.wait() settles only once every stdio pipe hits EOF, so the
        # close ladder's forced-reap future (`_reaped`) races it. But a
        # consumer may just await `child.exit` WITHOUT ever calling close()
        # (nothing then sets `_reaped`), and a leaked helper holding a pipe
        # keeps wait() blocked after the host is already reaped — hanging
        # child.exit forever (FR-638-017; reproduced on py3.10 AND py3.12).
        # So also settle on the observed REAP: a slow returncode poll that
        # the fast wait() beats on every clean exit, and that only matters
        # in the held-pipe case (PR #30094 review, round 11 P0).
        wait_task = asyncio.ensure_future(self.child.wait())
        try:
            while True:
                done, _ = await asyncio.wait(
                    {wait_task, self._reaped},
                    timeout=SIGTERM_GRACE_MS / 1000,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if wait_task in done:
                    return ProcessExit.from_returncode(wait_task.result())
                if self._reaped.done() or self.child.returncode is not None:
                    break
        finally:
            if not wait_task.done():
                wait_task.cancel()
                try:
                    await wait_task
                except asyncio.CancelledError:
                    pass
        returncode = (
            self._reaped.result()
            if self._reaped.done()
            else self.child.returncode
        )
        assert returncode is not None
        return ProcessExit.from_returncode(returncode)

    async def _drain_stderr(self, on_stderr: OnStderr) -> None:
        stream = self.child.stderr
        if stream is None:  # pragma: no cover - guarded at construction
            return
        # One decoder across the loop (the _decoded_stdout twin): a
        # per-chunk decode turned a multi-byte character straddling two
        # reads into replacement characters in the evidence tail
        # (PR #30094 review).
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            chunk = await stream.read(8192)
            if not chunk:
                tail = decoder.decode(b"", final=True)
                if tail:
                    on_stderr(tail)
                return
            text = decoder.decode(chunk)
            if text:
                on_stderr(text)

    def _adopt_flush_source(self, source: Callable[[], Awaitable[None]]) -> None:
        """Module-private friend seam used by the handshake that owns both sides."""
        self._default_flushed = source

    @property
    def incoming(self) -> AsyncIterator[str]:
        """The host's stdout as decoded UTF-8 text chunks.

        An incremental decoder carries a multi-byte character split across
        byte chunks over to the next one (the transport contract's streaming
        rule) instead of decoding halves into replacement characters.
        """
        return self._decoded_stdout()

    async def _decoded_stdout(self) -> AsyncIterator[str]:
        # Mark the consumer here, when the generator is actually ITERATED —
        # not in the `incoming` getter, where a bare `hasattr`/`getattr`
        # discovery sweep (the transport Protocol documents that idiom) would
        # falsely flag a consumer and make every later close() wait the full
        # grace for a stdout EOF nobody drains (PR #30094 review).
        self._stdout_consumed = True
        stream = self.child.stdout
        if stream is None:  # pragma: no cover - guarded at construction
            return
        decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
        while True:
            chunk = await stream.read(65536)
            if not chunk:
                tail = decoder.decode(b"", final=True)
                if tail:
                    yield tail
                return
            yield decoder.decode(chunk)

    async def write(self, chunk: str) -> None:
        """One awaited stdin write (backpressure honored, never buffered unbounded).

        Raises:
            ProtocolError: The host's stdin is already closed.
        """
        stdin = self.child.stdin
        if stdin is None or stdin.is_closing():
            raise ProtocolError("spawned MSP host stdin is closed")
        stdin.write(chunk.encode("utf-8"))
        await stdin.drain()

    async def close(self, flushed: Awaitable[None] | None = None) -> None:
        """The single owner of shutdown; memoized so concurrent calls share it.

        EOF first, then bounded: SS2.1.2 gives the host a drain window and
        says the remainder past it has crash semantics, so past the window
        the SDK ends the process it owns rather than waiting on an EOF that
        may never come.

        Args:
            flushed: A submission-tail promise from the connection; awaited
                INSIDE the one shutdown budget so it cannot double the bound.
        """
        if self._closing is None:
            source = (
                flushed
                if flushed is not None
                else (self._default_flushed() if self._default_flushed else None)
            )
            self._closing = asyncio.ensure_future(self._shutdown(source))
        elif flushed is not None:
            # A losing concurrent close's submission promise must not be
            # dropped un-awaited; it shares the winner's ride best-effort.
            asyncio.ensure_future(_swallow(flushed))
        await asyncio.shield(self._closing)

    async def _shutdown(self, flushed: Awaitable[None] | None) -> None:
        deadline = self._make_deadline(self._shutdown_timeout_ms)
        flush_wait: asyncio.Task[None] | None = None
        try:
            if flushed is not None:
                flush_wait = asyncio.ensure_future(_swallow(flushed))
                await self._before_deadline(flush_wait, deadline)
            await self._shutdown_after_flush(deadline)
        finally:
            # If the shutdown is itself CANCELLED (Ctrl-C during asyncio.run
            # teardown) the awaits above unwind before any kill rung — from
            # the FLUSH WAIT as well as from inside the ladder, so the guard
            # lives here, the one finally every close passes through, not in
            # the ladder (whose own finally missed a cancel parked on the
            # flush wait — PR #30094 review, round 18). One SYNCHRONOUS
            # SIGKILL keeps never-orphan unconditional (FM-638-2): signalling
            # is safe under CancelledError and a no-op once the host is
            # reaped.
            self._kill_now()
            deadline.clear()
            if flush_wait is not None and not flush_wait.done():
                # The deadline won: nothing later awaits the flush half, so
                # settle its cancellation NOW — no pending task may remain
                # after close() settles (FR-638-017; PR #30094 review).
                flush_wait.cancel()
                try:
                    await flush_wait
                except asyncio.CancelledError:
                    pass

    async def _shutdown_after_flush(self, deadline: ShutdownDeadline) -> None:
        # EOF first, SYNCHRONOUSLY: with no drain() (see _end_stdin) the EOF
        # attempt cannot block, so it precedes the ladder outright instead of
        # riding a task a cancel could strand pending (FR-638-017
        # no-leftover-task; PR #30094 review, round 19).
        self._end_stdin()
        await self._await_exit_or_terminate(deadline)

    def _end_stdin(self) -> None:
        stdin = self.child.stdin
        if stdin is None or stdin.is_closing():
            return
        try:
            if stdin.can_write_eof():
                stdin.write_eof()
            # Deliberately NO drain() here: a wedged write() may already be
            # parked in stdin.drain(), and before the GH-74116 backport
            # (< 3.10.8) asyncio's _drain_helper allows one waiter — a second
            # dies with AssertionError that close() would re-raise after the
            # host is already dead. write_eof() already marks the transport
            # closing, every outcome here is swallowed, and _abort_stdin owns
            # the pinned pipe (PR #30094 review, round 18); dropping the
            # drain also made this whole method synchronous (round 19).
        except (BrokenPipeError, ConnectionResetError, RuntimeError):
            # RuntimeError: asyncio's own "socket transport closed" race —
            # the same benign teardown overlap one layer down.
            return

    async def _await_exit_or_terminate(self, deadline: ShutdownDeadline) -> None:
        # Every stage completes the moment the host is REAPED, not when its
        # pipes close: a detached helper that inherited a stdio pipe holds
        # asyncio's Process.wait() open forever after the child itself is
        # gone. Python 3.10 settles wait() at the reap, 3.12 only at pipe
        # EOF — so acting on `returncode is not None` here keeps close()
        # bounded on BOTH (PR #30094 review). `_settled` wins first on a
        # clean drain, so the reap poll adds no latency there. A cancel that
        # lands ANYWHERE in the shutdown (here or the flush wait) is backed
        # by `_shutdown`'s finally-SIGKILL, so this ladder carries no
        # kill-on-cancel guard of its own (round 18).
        await self._drain_window(deadline)
        if self._reaped_or_settled():
            await self._finalize_reaped()
            return
        self._signal(signal_module.SIGTERM)
        grace = ShutdownDeadline(SIGTERM_GRACE_MS)
        try:
            await self._drain_window(grace)
        finally:
            grace.clear()
        if self._reaped_or_settled():
            await self._finalize_reaped()
            return
        self._kill_now()
        await self._reaped_exit()

    def _kill_now(self) -> None:
        """One synchronous, reap-guarded kill — the never-orphan backstop
        FM-638-2 mandates wherever nothing can await (the shutdown's
        ``finally`` under a cancel, the ladder's last rung, a GC-finalized
        ``initialize()``). Windows has no ``SIGKILL`` attribute; ``SIGTERM``
        is ``TerminateProcess`` there, the same unconditional end
        (PR #30094 review, rounds 17–19)."""
        if self.child.returncode is None:
            self._signal(getattr(signal_module, "SIGKILL", signal_module.SIGTERM))

    def _reaped_or_settled(self) -> bool:
        return self.child.returncode is not None or self._exited.done()

    async def _reap_poll(self) -> None:
        # Teardown-only bound (never the green drain path, which `_settled`
        # wins): wakes the drain window once the watcher records the exit so
        # a 3.12 held-pipe host skips the rest of the budget.
        while self.child.returncode is None:
            await asyncio.sleep(0.02)

    async def _drain_window(self, deadline: ShutdownDeadline) -> None:
        """Waits until the host settles, is reaped, or the deadline expires.

        Owns and cleans up its own tasks so nothing outlives close()
        (FR-638-017). Mints no ``_make_deadline`` — the one shutdown budget
        stays a single injected deadline for the shared-budget contract.
        """
        settled = asyncio.ensure_future(_swallow(self._settled()))
        expiry = asyncio.ensure_future(deadline.expired())
        reap = asyncio.ensure_future(self._reap_poll())
        try:
            await asyncio.wait(
                {settled, expiry, reap}, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            for task in (settled, expiry, reap):
                if not task.done():
                    task.cancel()
            await asyncio.wait({settled, expiry, reap})
            for task in (settled, expiry, reap):
                if not task.cancelled():
                    task.exception()

    async def _finalize_reaped(self) -> None:
        """The single owner of post-reap teardown, reached by EVERY close
        path (both ladder stages and the SIGKILL rung).

        Settling `_reaped` makes `_exited` — and every close() awaiting it —
        return regardless of a pipe a leaked helper still holds. Then give
        both pipes a bounded grace to reach EOF on their own so a cleanly
        exited host's final stderr/stdout is captured, and only past that
        grace cut what a helper still holds: cancel the stderr drain, drop
        our stdin end, and close the subprocess transport (which ends the
        stdout read loop too, so a facade close never hangs on `_closed`).
        FR-638-017 sanctions dropping output only past this bounded window
        (PR #30094 review — zdwmeta's 3.10 facade-close gap).
        """
        if self.child.returncode is not None and not self._reaped.done():
            self._reaped.set_result(self.child.returncode)
        eof_wait = asyncio.ensure_future(self._await_pipes_eof())
        _, pending = await asyncio.wait({eof_wait}, timeout=SIGTERM_GRACE_MS / 1000)
        if pending:
            eof_wait.cancel()
            await asyncio.wait({eof_wait})
        drain = self._stderr_task
        if drain is not None and not drain.done():
            drain.cancel()
            await asyncio.wait({drain})
        if drain is not None and not drain.cancelled():
            # Retrieve a settled drain's exception (a raising on_stderr
            # callback) so GC never logs it as unretrieved.
            drain.exception()
        await self._abort_stdin()
        proc_transport = getattr(self.child, "_transport", None)
        if proc_transport is not None:
            try:
                proc_transport.close()
            except Exception:
                # Best-effort, like the signal rungs: a pipe already
                # mid-teardown must not rethrow out of close().
                pass
        await self._settled()

    async def _await_pipes_eof(self) -> None:
        # Wait for the host's final output to be consumed BEFORE the forced
        # close: the stderr drain to finish and stdout to hit EOF. On a clean
        # exit both happen at once (the host closed its write ends); a leaked
        # helper holding one keeps it open, and the caller's grace then bounds
        # the wait before the forced close (FR-638-017). `at_eof()` is a
        # non-consuming read of the StreamReader the connection drains.
        drain = self._stderr_task
        if drain is not None:
            await _swallow(drain)
        # Only a live stdout consumer (the connection's read loop) has a tail
        # worth preserving; with none, forcing the pipe shut drops nothing.
        if not self._stdout_consumed:
            return
        stdout = self.child.stdout
        while stdout is not None and not stdout.at_eof():
            await asyncio.sleep(0.02)

    async def _abort_stdin(self) -> None:
        # Drop our end of the stdin pipe outright: `stdin.close()` is a
        # no-op after `_end_stdin`'s `write_eof()` (the write transport
        # returns early once closing), so a wedged 2 MiB write a helper
        # inheriting fd 0 never drains still pins the pipe and hangs
        # `_end_stdin`'s `drain()`. abort() drops the buffer and fires
        # connection_lost (the TS twin's `stdin.destroy()`; PR #30094
        # review). Best-effort like the signal rungs.
        stdin = self.child.stdin
        if stdin is None or stdin.transport is None:
            return
        try:
            stdin.transport.abort()
        except Exception:
            pass
        # Retrieve the write pipe's close result so py3.10 does not log a
        # "Future exception was never retrieved" BrokenPipeError at teardown
        # (3.12 suppresses it; nothing else awaits wait_closed). Bounded and
        # swallowing — abort() has already fired connection_lost.
        try:
            await asyncio.wait_for(stdin.wait_closed(), SIGTERM_GRACE_MS / 1000)
        except Exception:
            pass

    async def _reaped_exit(self) -> None:
        # Past SIGKILL: wait for the REAP, not the pipes. 3.10 settles wait()
        # at the reap; 3.12 needs the returncode check because a held pipe
        # keeps wait() blocked. SIGKILL guarantees the reap, so this is
        # bounded (FR-638-017; PR #30094 review).
        while self.child.returncode is None:
            if await self._settled_within(SIGTERM_GRACE_MS):
                break
        await self._finalize_reaped()

    def _signal(self, sig: signal_module.Signals) -> None:
        """One signal per escalation stage, group-first where owned (FR-017b).

        A group signal that fails for ANY reason (expected: the group is
        already gone) falls through to the direct child; the ladder never
        rethrows out of a stage.
        """
        pid = self.child.pid
        if self._owns_process_group and sys.platform != "win32":
            try:
                os.killpg(pid, sig)
                return
            except OSError:
                pass  # fall through to the direct-child path
        try:
            self.child.send_signal(sig)
        except ProcessLookupError:
            pass  # already exited: the no-op the TS twin gets from Node

    async def _settled(self) -> None:
        try:
            await asyncio.shield(self._exited)
        except asyncio.CancelledError:  # pragma: no cover - teardown only
            raise
        except Exception:
            # A spawn/watch failure means no live child: shutdown complete.
            return

    async def _settled_within(self, budget_ms: int) -> bool:
        # Deliberately ambient (NOT the injected factory): the SIGTERM grace
        # is outside the one shared shutdown budget the seam models.
        deadline = ShutdownDeadline(budget_ms)
        try:
            return await self._before_deadline(self._settled(), deadline)
        finally:
            deadline.clear()

    @staticmethod
    async def _before_deadline(
        work: Awaitable[Any], deadline: ShutdownDeadline
    ) -> bool:
        # ensure_future returns a caller's own Task unchanged, so a caller
        # that must cancel an abandoned wait (the flush half) can hold it.
        # Work that can FAIL arrives pre-wrapped in _swallow; the settle
        # waits below never raise Exception.
        work_task = asyncio.ensure_future(work)
        expiry_task = asyncio.ensure_future(deadline.expired())
        done, _ = await asyncio.wait(
            {work_task, expiry_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if work_task in done:
            expiry_task.cancel()
            return True
        # Keep the work task alive: a later stage may await the same settle.
        return False


async def _swallow(work: Awaitable[Any]) -> None:
    try:
        await work
    except Exception:
        return


class MuseServeChild:
    """One owned MSP host process with SS2.11 diagnostics and total exit mapping."""

    def __init__(
        self,
        child: asyncio.subprocess.Process,
        on_stderr: OnStderr | None,
        shutdown_timeout_ms: int,
        owns_process_group: bool,
    ) -> None:
        """Internal: use :meth:`spawn`."""
        self._tail = StderrTail()

        def _tap(chunk: str) -> None:
            self._tail.push(chunk)
            if on_stderr is not None:
                on_stderr(chunk)

        self._transport = ChildStdioTransport(
            child,
            _tap,
            shutdown_timeout_ms,
            owns_process_group,
        )
        self._exit: asyncio.Task[ExitClassification] = asyncio.ensure_future(
            self._classified()
        )

    @property
    def exit(self) -> Awaitable[ExitClassification]:
        """Settles with the :class:`ExitClassification` of the observed exit
        (never a synthesized one, INV-006 carry).

        A fresh shield per access: a consumer's ``wait_for`` timeout must
        not cancel the SDK's own watcher and break ``close()``
        (PR #30094 review).
        """
        return asyncio.shield(self._exit)

    async def _classified(self) -> ExitClassification:
        status = await asyncio.shield(self._transport._exited)
        # Wait for the drain task to settle so the final chunks the pipe
        # delivered with the exit are in the tail — but BOUND it: on a
        # NATURAL exit with no close() (a consumer just awaiting child.exit),
        # a leaked helper holding stderr means the drain never sees EOF, and
        # an unbounded wait would hang child.exit forever. Past the grace,
        # cut the held pipe so classification proceeds with the tail so far
        # (PR #30094 review). A raising on_stderr's exception is retrieved so
        # GC never logs it as unretrieved.
        drain = self._transport._stderr_task
        if drain is not None:
            _, pending = await asyncio.wait(
                {drain}, timeout=SIGTERM_GRACE_MS / 1000
            )
            if pending:
                drain.cancel()
                await asyncio.wait({drain})
            if not drain.cancelled():
                drain.exception()
        return classify_exit(status, self._tail.lines())

    @staticmethod
    async def spawn(
        muse_bin: str,
        *,
        args: Sequence[str] = (),
        cwd: str | None = None,
        env: Mapping[str, str] | None = None,
        on_stderr: OnStderr | None = None,
        shutdown_timeout_ms: int = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ) -> "MuseServeChild":
        """Spawns one owned host (POSIX: as a process-group leader, FR-017b).

        Args:
            muse_bin: The host binary (see ``discovery.discover_muse_bin``).
            args: Passed through verbatim.
            cwd: Working directory for the host.
            env: The host's environment (inherited when ``None``).
            on_stderr: Raw evidence callback for consumers keeping a full
                diagnostic log; the bounded tail is kept regardless.
            shutdown_timeout_ms: The FR-017a drain budget; validated BEFORE
                the child exists so a refusal cannot orphan one.

        Raises:
            MuseValidationError: An option is malformed (the C-638-2 spawn
                seam, owner ruling #31276) — raised before any process is
                spawned. A ``ValueError`` by inheritance, preserving the
                boundary's pre-existing refusal contract.
        """
        options = parse_spawn_options(
            command=muse_bin,
            args=args,
            cwd=cwd,
            env=env,
            shutdown_timeout_ms=shutdown_timeout_ms,
        )
        owns_process_group = sys.platform != "win32"
        child = await asyncio.create_subprocess_exec(
            options.command,
            *options.args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=options.cwd,
            env=options.env,
            start_new_session=owns_process_group,
        )
        return MuseServeChild(
            child,
            on_stderr,
            options.shutdown_timeout_ms,
            owns_process_group,
        )

    @property
    def stderr_tail(self) -> tuple[str, ...]:
        """The bounded evidence captured so far (INV-010: never parsed)."""
        return self._tail.lines()

    async def close(self) -> ExitClassification:
        """Bounded shutdown (FR-017a), resolving on the observed exit's row."""
        await self._transport.close()
        return await asyncio.shield(self._exit)


class SpawnedMspConnection:
    """A fully initialized connection plus its owned process boundary.

    Attributes:
        connection: The ready :class:`Connection`.
        child: The owned host process.
        initialize_result: The typed handshake result.
    """

    def __init__(
        self,
        connection: "Connection",
        transport: ChildStdioTransport,
        child: MuseServeChild,
        initialize_result: "InitializeResult",
    ) -> None:
        """Binds the initialized surfaces; built only by ``MspHandshake``."""
        self.connection = connection
        self._transport = transport
        self.child = child
        self.initialize_result = initialize_result

    @property
    def exited(self) -> Awaitable[ProcessExit]:
        """Settles with the host's observed exit (shielded per access)."""
        return self._transport.exited

    async def close(self) -> ProcessExit:
        """Orderly SS2.1.2 shutdown through the connection, then the exit."""
        await self.connection.close()
        return await asyncio.shield(self._transport._exited)


class MspHandshake:
    """The only public state before ``initialized``: no traffic can be sent.

    Attributes:
        child: The owned host process (its ``stderr_tail`` and ``exit`` are
            live from birth).
    """

    def __init__(
        self,
        child: MuseServeChild,
        connection: "Connection",
    ) -> None:
        """Internal: use :func:`spawn_msp_connection`."""
        self.child = child
        self._transport = child._transport
        self._connection = connection
        self._started = False
        self._transport._adopt_flush_source(connection._submission_tail)

    @property
    def exited(self) -> Awaitable[ProcessExit]:
        """Settles with the host's observed exit (shielded per access)."""
        return self._transport.exited

    async def close(self) -> ProcessExit:
        """Bounded close without ever having initialized."""
        await self._connection.close()
        return await asyncio.shield(self._transport._exited)

    async def initialize(self, params: "InitializeParams") -> SpawnedMspConnection:
        """Runs the SS1.4 sequence exactly once and gates the fingerprint.

        Args:
            params: The typed ``initialize`` params.

        Returns:
            The ready connection.

        Raises:
            ProtocolError: A second ``initialize``.
            MuseValidationError: The result frame is malformed (the C-638-2
                frame seam, owner ruling #31276); pydantic's
                ``ValidationError`` rides as the cause.
            MuseHostMismatchError: The served fingerprint differs from this
                SDK's pin (spec 638 C-638-4 — exact failure, no bypass).

        Every failure PAST the send-once check ends the ``muse serve`` child
        this handshake spawned — it never orphans the host (spec 638
        FM-638-2). (The send-once ``ProtocolError`` raises before that and
        does NOT close: after a successful first ``initialize`` the host is
        live and owned by the returned connection.) A post-request failure —
        a mismatch, a malformed-frame rejection, or a CALLER cancel/
        ``KeyboardInterrupt``/``SystemExit`` — awaits the bounded close
        before the exception propagates, so the host is already dead and
        ``child.stderr_tail`` is all that remains. A caller cancel is
        therefore held for the bounded close (``shutdown_timeout_ms`` plus
        the SIGTERM grace): never-orphan outweighs a prompt return, and the
        close is bounded.
        """
        from .. import EXPECTED_SCHEMA_FINGERPRINT  # circular-at-import-time otherwise

        # The pin is read at CALL time through the module attribute, so the
        # conformance suites drive recorded bundles by setting
        # muse_code.EXPECTED_SCHEMA_FINGERPRINT for the test's scope — there
        # is deliberately NO parameter: a public expected-fingerprint knob
        # would let a caller pass the served value and switch the C-638-4
        # strict gate off (PR #30094 review, thread 1).
        expected = EXPECTED_SCHEMA_FINGERPRINT
        if self._started:
            raise ProtocolError("initialize may be sent only once per connection")
        self._started = True
        # Every post-latch failure below ends the host this handshake owns:
        # the natural `await spawn_msp_connection(...).initialize(p)` drops
        # the only handle, so a raise (malformed frame, mismatch) would orphan
        # the `muse serve` child — the same never-orphan rule the bad-option
        # path follows. close() is memoized, so an outer `finally: close()`
        # stays a no-op (PR #30094 review).
        try:
            raw: Any = await self._connection.request("initialize", dict(params))
            # The C-638-2 frame seam (owner ruling #31276): the members this
            # handshake reads validate through a pydantic model, so a
            # malformed frame is the typed MuseValidationError — the seam
            # rejects BEFORE the fingerprint gate. Connection._response
            # already rejected a non-object result with its own
            # ProtocolError (PR #30094 review, thread 6).
            frame = parse_initialize_result(raw)
            fingerprint = frame.schema_info.fingerprint
            if fingerprint != expected:
                # Hard import: the generated package is this SDK's runtime
                # dependency-by-construction (connection.py imports it at
                # module load), so a guarded import here was a dead arm that
                # could only DEGRADE the message below the C-638-4 contract
                # (PR #30094 review, thread 5).
                from muse_code_msp import REQUIRED_HOST_VERSION

                raise MuseHostMismatchError(
                    served=fingerprint,
                    pinned=expected,
                    host_version=frame.server_info.version,
                    required_host_version=REQUIRED_HOST_VERSION,
                )
            self._connection.notify("initialized")
            await self._connection.flush()
        except GeneratorExit:
            # A coroutine cannot await after GeneratorExit is thrown in (at
            # GC finalization of an abandoned initialize()); awaiting close()
            # here would log "coroutine ignored GeneratorExit". But never-
            # orphan stays unconditional (FM-638-2): send the one legal
            # SYNCHRONOUS signal — the same rung `_shutdown`'s finally uses —
            # so the host is dying before finalization proceeds (PR #30094
            # review, round 18). A real cancel/interrupt never arrives as
            # GeneratorExit — it is CancelledError/KeyboardInterrupt/
            # SystemExit, all caught below with the bounded inline close.
            self._transport._kill_now()
            raise
        except BaseException:
            # Never orphan (FM-638-2): close INLINE so the host is dead
            # before the exception propagates — for a mismatch, a
            # malformed-frame MuseValidationError, AND a caller cancel/
            # KeyboardInterrupt/SystemExit. A background fire-and-forget close
            # was tried and reverted: `asyncio.run` loop-teardown on the
            # natural wait_for-timeout path cancels an unsupervised task
            # before its SIGTERM rung, orphaning the child (PR #30094 review,
            # P0). The cost is that a caller cancel is held for the bounded
            # close (`shutdown_timeout_ms` + the SIGTERM grace) — never-orphan
            # outweighs prompt-return, and the close IS bounded. If the close
            # itself is cancelled mid-drain (Ctrl-C during teardown), the
            # ladder's finally still sends a synchronous SIGKILL.
            await self.close()
            raise
        result: "InitializeResult" = raw
        return SpawnedMspConnection(self._connection, self._transport, self.child, result)


async def spawn_msp_connection(
    command: str,
    *,
    args: Sequence[str] = (),
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
    on_stderr: OnStderr | None = None,
    shutdown_timeout_ms: int = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    connection_options: ConnectionOptions | None = None,
) -> MspHandshake:
    """Spawns one owned host and begins its SS1.4 handshake state machine.

    Args:
        command: The host binary to run.
        args: Passed through verbatim (a bare ``muse`` is the TUI — pass
            ``["serve"]`` for the MSP host).
        cwd: Working directory for the host.
        env: The host's environment (inherited when ``None``).
        on_stderr: Raw stderr chunks, drained from birth, never parsed.
        shutdown_timeout_ms: See :meth:`MuseServeChild.spawn`.
        connection_options: Tuning for the connection machine.

    Returns:
        The pre-``initialized`` handshake state.
    """
    child = await MuseServeChild.spawn(
        muse_bin=command,
        args=args,
        cwd=cwd,
        env=env,
        on_stderr=on_stderr,
        shutdown_timeout_ms=shutdown_timeout_ms,
    )
    try:
        connection = Connection(child._transport, **(connection_options or {}))
    except BaseException:
        # A bad option (a misspelled key, a wrong type) raises AFTER the host
        # exists; without this the child outlives the error with no handle to
        # end it — the same never-orphan rule the pre-spawn budget validation
        # follows (PR #30094 review, thread 8).
        await child.close()
        raise
    return MspHandshake(child, connection)
