"""Shared probes for the bounded-shutdown arms.

The misbehaving hosts are throwaway ``python3 -c`` children for the reason
the TS twins are ``node -e`` children: ``serve-fixture`` always drains stdin
and always exits, so it structurally cannot ignore EOF or trap ``SIGTERM``.
It stays the CONTROL — the real host whose graceful drain must classify
``cleanShutdown`` with no signal.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path

PID_MARKER = "child_pid="
GRANDCHILD_PID_MARKER = "grandchild_pid="

FAILURE_CAP_S = 20.0
"""Failure-only cap on every real-process await: a green run never spends
it, a wedged one fails with its own diagnosis instead of hanging the suite."""

ESCALATION_DRAIN_MS = 150
"""The deliberately small drain window escalation arms let expire."""


def _host(body: list[str], announce_first: bool = True) -> str:
    """A child that announces its pid on stderr and runs ``body``."""
    announce = (
        f'sys.stderr.write("{PID_MARKER}" + str(os.getpid()) + "\\n"); '
        "sys.stderr.flush()"
    )
    lines = ["import os, signal, sys, time"]
    if announce_first:
        lines.append(announce)
    lines.extend(body)
    if not announce_first:
        lines.append(announce)
    lines.append("time.sleep(3600)")
    return "; ".join(lines)


IGNORES_EOF = _host(["sys.stdin.buffer.read()"])
"""Sees stdin EOF and keeps running; exits on SIGTERM (default disposition)."""

IGNORES_EOF_AND_SIGTERM = _host(
    ["signal.signal(signal.SIGTERM, signal.SIG_IGN)", "sys.stdin.buffer.read()"]
)
"""The same host with SIGTERM ignored: only SIGKILL can end it."""

COUNTS_SIGTERM = _host(
    [
        "signal.signal(signal.SIGTERM, lambda *_: "
        '(sys.stderr.write("sigterm_seen\\n"), sys.stderr.flush()))',
        "sys.stdin.buffer.read()",
    ]
)
"""Traps SIGTERM and reports EVERY delivery, so tests count signals."""

EXITS_3_ON_SIGTERM = _host(
    [
        "signal.signal(signal.SIGTERM, lambda *_: sys.exit(3))",
    ],
    announce_first=False,
)
"""Traps SIGTERM and exits 3 under it — the voluntary-exit classification arm.
The pid marker goes LAST so the handler is installed before the parent can
signal (the TS suite's descheduled-child flake, avoided the same way)."""

NEVER_READS_STDIN = "; ".join(
    [
        "import os, sys, time",
        f'sys.stderr.write("{PID_MARKER}" + str(os.getpid()) + "\\nstdin_wedged\\n")',
        "sys.stderr.flush()",
        "time.sleep(3600)",
    ]
)
"""Never reads stdin: a filled pipe never drains and EOF never completes."""

WRAPPER_WITH_STDOUT_HOLDING_GRANDCHILD = "; ".join(
    [
        "import os, signal, subprocess, sys, time",
        f'sys.stderr.write("{PID_MARKER}" + str(os.getpid()) + "\\n"); sys.stderr.flush()',
        "g = subprocess.Popen([sys.executable, '-c', "
        "'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); "
        "time.sleep(3600)'], stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
        f'sys.stderr.write("{GRANDCHILD_PID_MARKER}" + str(g.pid) + "\\n"); sys.stderr.flush()',
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        "sys.stdin.buffer.read()",
        "time.sleep(3600)",
    ]
)
"""The a tracked issue shape: a SIGTERM-trapping wrapper whose grandchild inherits the
wrapper's stdout (fd 1 is inherited by default) and traps SIGTERM itself, so
only a group-delivered SIGKILL ends the subtree."""

DETACHED_STDERR_HOLDER = "; ".join(
    [
        "import os, subprocess, sys",
        f'sys.stderr.write("{PID_MARKER}" + str(os.getpid()) + "\\n"); sys.stderr.flush()',
        "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(3600)'], "
        "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, start_new_session=True)",
        f'sys.stderr.write("{GRANDCHILD_PID_MARKER}" + str(g.pid) + "\\n"); sys.stderr.flush()',
        "sys.exit(0)",
    ]
)
"""A host that exits 0 VOLUNTARILY after leaking a new-session helper that
inherits its stderr pipe (fd 2 is inherited by default): the child is reaped
promptly but the pipe never hits EOF, so ``Process.wait()`` never settles —
the a prior review's bounded-close hang shape. ``start_new_session`` keeps
the helper outside the host's process group so no ladder signal ends it."""

DETACHED_STDOUT_HOLDER = "; ".join(
    [
        "import os, subprocess, sys",
        f'sys.stderr.write("{PID_MARKER}" + str(os.getpid()) + "\\n"); sys.stderr.flush()',
        "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(3600)'], "
        "stdin=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)",
        f'sys.stderr.write("{GRANDCHILD_PID_MARKER}" + str(g.pid) + "\\n"); sys.stderr.flush()',
        "sys.exit(0)",
    ]
)
"""Twin of ``DETACHED_STDERR_HOLDER`` for STDOUT (fd 1): the leaked helper
inherits the host's stdout pipe, so after the host exits 0 the read loop
never sees EOF and ``Process.wait()`` never settles on Python 3.10 — the
shape that hangs ``spawn_msp_connection(...).close()`` until the ladder
drops the pipe at reap."""

STDIN_HOLDING_HELPER = "; ".join(
    [
        "import os, subprocess, sys, time",
        f'sys.stderr.write("{PID_MARKER}" + str(os.getpid()) + "\\n"); sys.stderr.flush()',
        "g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(3600)'], "
        "stdin=sys.stdin.fileno(), stdout=subprocess.DEVNULL, "
        "stderr=subprocess.DEVNULL, start_new_session=True)",
        f'sys.stderr.write("{GRANDCHILD_PID_MARKER}" + str(g.pid) + "\\n"); sys.stderr.flush()',
        "time.sleep(3600)",  # never reads stdin; a leaked helper inherits fd 0
    ]
)
"""Never reads stdin AND leaks a new-session helper inheriting fd 0, so an
unflushable write stays pinned even after ``write_eof`` — only aborting our
own end of the pipe (not ``close()``) lets the ladder proceed. Announces the
detached helper's pid so the test can reap it (it survives the host's death)."""

UNFLUSHABLE_WRITE = "x" * (2 * 1024 * 1024)
"""Bytes that comfortably exceed a pipe buffer, so a write cannot flush."""


def sentinel_host(sentinel: Path) -> str:
    """A child that records its own birth in ``sentinel`` (must never run)."""
    return (
        "import os, pathlib, time; "
        f"pathlib.Path({str(sentinel)!r}).write_text(str(os.getpid())); "
        "time.sleep(3600)"
    )


class PidProbe:
    """Captures stderr chunks and resolves the announced pid causally."""

    def __init__(self) -> None:
        self.chunks: list[str] = []
        self._pid: asyncio.Future[int] = asyncio.get_running_loop().create_future()
        self._grandchild: asyncio.Future[int] = (
            asyncio.get_running_loop().create_future()
        )
        self._buffered = ""

    def on_stderr(self, chunk: str) -> None:
        """The ``on_stderr`` tap to hand the spawn call."""
        self.chunks.append(chunk)
        self._buffered += chunk
        for marker, future in (
            (PID_MARKER, self._pid),
            (GRANDCHILD_PID_MARKER, self._grandchild),
        ):
            if future.done():
                continue
            start = self._buffered.find(marker)
            if start < 0:
                continue
            end = self._buffered.find("\n", start)
            if end < 0:
                continue
            future.set_result(int(self._buffered[start + len(marker) : end]))

    async def pid(self) -> int:
        """The announced child pid (failure-only capped)."""
        return await asyncio.wait_for(asyncio.shield(self._pid), FAILURE_CAP_S)

    async def grandchild_pid(self) -> int:
        """The announced grandchild pid (failure-only capped)."""
        return await asyncio.wait_for(asyncio.shield(self._grandchild), FAILURE_CAP_S)


def is_alive(pid: int) -> bool:
    """Can this pid still be signalled? (A zombie answers yes.)"""
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def is_zombie(pid: int) -> bool:
    """Is the pid a zombie awaiting a reap? (Linux/macOS process table read.)"""
    try:
        with open(f"/proc/{pid}/stat", encoding="ascii") as f:
            return f.read().split(")")[-1].split()[0] == "Z"
    except OSError:
        return False


async def ended_within(pid: int, budget_s: float) -> bool:
    """Has the pid ENDED (unprobeable, or a zombie awaiting init's reap)?

    The a tracked issue rule: a reparented grandchild's reaping is asynchronous to
    ``close()``, so poll until ended rather than sampling one racy instant.
    """
    deadline = asyncio.get_running_loop().time() + budget_s
    while asyncio.get_running_loop().time() < deadline:
        if not is_alive(pid) or is_zombie(pid):
            return True
        await asyncio.sleep(0.05)
    return False


def reap(pid: int | None) -> None:
    """Best-effort cleanup of a test child by SAVED pid (never a pattern)."""
    if pid is None:
        return
    try:
        os.kill(pid, 9)
    except OSError:
        pass


def fixture_host_bin() -> str | None:
    """The prebuilt ``muse-conformance`` binary, when one is available.

    Resolution: ``MUSE_CONFORMANCE_BIN``, then the ambient cargo target dir,
    then the workspace-default ``target/debug``. ``None`` skips the
    fixture-driven arms with a loud reason (the Python CI lane carries no
    Rust toolchain; the required Rust path owns those builds).

    An explicit ``MUSE_CONFORMANCE_BIN`` is AUTHORITATIVE: a set-but-missing
    path fails closed rather than silently skipping every host arm — that
    silent-skip-with-green is exactly the incident the CI build step exists
    to end.

    Raises:
        RuntimeError: ``MUSE_CONFORMANCE_BIN`` is set but not a file.
    """
    explicit = os.environ.get("MUSE_CONFORMANCE_BIN")
    if explicit:
        if not Path(explicit).is_file():
            raise RuntimeError(f"MUSE_CONFORMANCE_BIN={explicit!r} is not a file")
        return explicit
    candidates = []
    target_dir = os.environ.get("CARGO_TARGET_DIR")
    if target_dir:
        candidates.append(Path(target_dir) / "debug" / "muse-conformance")
    project_root = Path(__file__).resolve().parents[3]
    candidates.append(project_root / "target" / "debug" / "muse-conformance")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("muse-conformance")
    return found
