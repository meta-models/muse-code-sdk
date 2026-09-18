"""One owned ``muse serve`` host, plus the notification recorder the
streaming assertions wait on — the Python twin of
``clients/sdk-cookbook/src/kit/host.ts``.

Everything here goes through the shipped ``muse-code-sdk`` public surface —
:func:`muse_code.connection.spawn_msp_connection`,
``MspHandshake.initialize``, ``Connection.command``, ``Connection.request``,
``SpawnedMspConnection.close``. The journey never reaches into an SDK
internal, so what it proves is exactly what a consumer gets.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, List, Mapping, TypeVar

from muse_code.connection import Connection
from muse_code.connection.spawn import (
    MspHandshake,
    ProcessExit,
    SpawnedMspConnection,
    spawn_msp_connection,
)

_T = TypeVar("_T")

SDK_GATE_ENV = "MUSE_EXPERIMENTAL_SDK_ENABLED"
"""The ``sdk_enabled`` dev override, spelled out exactly as
``the host source`` does so a gate rename has to
be noticed here too. This is how the JOURNEY's own child is launched; it is
not reader guidance, and README.md says so."""

STUB_VIEW_CURSOR = "pending:seam-c-session-view-fold"
"""The pre-Seam-C placeholder cursor. A real session must never return it."""

HOST_DRAIN_WINDOW_MS = 30_000
"""The drain window every journey host runs under — OWNED, not restated from
the SDK's unexported default: every spawn passes
THIS constant as ``shutdown_timeout_ms``."""


def isolated_host_env(home: str) -> dict[str, str]:
    """The isolated child environment every journey-spawned host gets — the
    env-clear equivalent: nothing else is inherited, so a journey can never
    read the developer's credentials, telemetry settings, or real muse state.
    """
    return {
        "HOME": home,
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "TBH_CREDENTIAL_BACKEND": "file",
        "TBH_DISABLE_TELEMETRY": "1",
        SDK_GATE_ENV: "on",
    }


class TimeoutBudgetError(Exception):
    """A bounded journey wait that expired — a FAILURE cap, never pacing.

    Every budget in this harness is failure-only: the green path settles on a
    real receipt (an ack, a notification, an exit), and the budget exists so
    a wedged host reds the named step instead of hanging the journey.
    """

    def __init__(self, what: str, budget_ms: int) -> None:
        super().__init__(f"{what} did not happen within {budget_ms}ms")


async def within(what: str, budget_ms: int, work: Awaitable[_T]) -> _T:
    """A bounded wait; never leaves a dangling timer behind."""
    try:
        return await asyncio.wait_for(_pass(work), timeout=budget_ms / 1000)
    except asyncio.TimeoutError as expired:
        raise TimeoutBudgetError(what, budget_ms) from expired


async def _pass(work: Awaitable[_T]) -> _T:
    # ``wait_for`` wants a coroutine or future; the SDK's awaitable
    # PROPERTIES (``exited``, ``child.exit``) are neither.
    return await work


@dataclass(frozen=True)
class RecordedNotification:
    """A JSON-RPC notification the host pushed at us."""

    method: str
    params: Mapping[str, Any]


@dataclass(frozen=True)
class HostOptions:
    """What :meth:`Host.start` needs — the TS ``HostOptions`` twin.

    Attributes:
        muse_bin: Absolute path to the release-built binary.
        home: Isolated ``HOME``; every host in one journey shares it.
        workspace_root: The workspace a session is started in.
        client_info: The clientInfo the handshake announces. REQUIRED (the TS
            kit's T-24225-6 lesson): every caller names itself.
    """

    muse_bin: str
    home: str
    workspace_root: str
    client_info: Mapping[str, str]


@dataclass
class _Waiter:
    match: Callable[[RecordedNotification], bool]
    settle: "asyncio.Future[RecordedNotification]"


class Host:
    """The spawned host, its stderr evidence, and the notification recorder.

    Attributes:
        msp: The initialized :class:`SpawnedMspConnection`.
        stderr: Raw stderr chunks, drained from birth, never parsed.
    """

    def __init__(self, msp: SpawnedMspConnection, stderr: List[str]) -> None:
        """Internal; use :meth:`start`."""
        self.msp = msp
        self.stderr = stderr
        self._seen: List[RecordedNotification] = []
        self._waiters: List[_Waiter] = []
        msp.connection.on_notification(self._record)

    @staticmethod
    async def start(options: HostOptions, budget_ms: int) -> "Host":
        """Spawn the release binary and complete the MSP handshake."""
        stderr: List[str] = []
        handshake: MspHandshake = await spawn_msp_connection(
            options.muse_bin,
            args=("serve",),
            cwd=options.workspace_root,
            env=isolated_host_env(options.home),
            on_stderr=stderr.append,
            shutdown_timeout_ms=HOST_DRAIN_WINDOW_MS,
        )
        try:
            msp = await within(
                "the MSP handshake",
                budget_ms,
                handshake.initialize({"clientInfo": dict(options.client_info)}),
            )
        except BaseException as error:
            # BOUND this peek (the TS kit's rule): ``exited`` settles only
            # when the child exits, so a host that went silent would hang the
            # caller past the journey's own cleanup.
            try:
                exit_ = await within(
                    "the host's exit after a failed handshake", 2_000, handshake.exited
                )
                observed: str = f"{exit_}"
            except Exception:  # noqa: BLE001 - diagnostic only
                observed = "still running"
            raise RuntimeError(
                f"handshake failed (exit {observed}); stderr: {''.join(stderr)}"
            ) from error
        return Host(msp, stderr)

    def _record(self, notification: Mapping[str, Any]) -> None:
        params = notification.get("params")
        recorded = RecordedNotification(
            method=str(notification.get("method")),
            params=params if isinstance(params, dict) else {},
        )
        self._seen.append(recorded)
        for waiter in [w for w in self._waiters if w.match(recorded)]:
            self._waiters.remove(waiter)
            if not waiter.settle.done():
                waiter.settle.set_result(recorded)

    def notifications(self) -> tuple[RecordedNotification, ...]:
        """Every notification recorded so far, oldest first."""
        return tuple(self._seen)

    async def wait_for(
        self,
        what: str,
        budget_ms: int,
        match: Callable[[RecordedNotification], bool],
    ) -> RecordedNotification:
        """Wait for the first notification matching ``match``.

        Already-received notifications count, so there is no race between
        sending a command and subscribing to its stream; racing the process
        exit turns "the host died" into that sentence instead of an opaque
        timeout.
        """
        for already in self._seen:
            if match(already):
                return already
        arrival: asyncio.Future[RecordedNotification] = (
            asyncio.get_running_loop().create_future()
        )
        self._waiters.append(_Waiter(match=match, settle=arrival))

        async def died() -> RecordedNotification:
            exit_ = await self.msp.exited
            raise RuntimeError(
                f"the host exited ({exit_}) while waiting for {what}; "
                f"stderr: {''.join(self.stderr)}"
            )

        died_task = asyncio.ensure_future(died())
        try:
            done, _pending = await within(
                what,
                budget_ms,
                asyncio.wait(
                    {arrival, died_task}, return_when=asyncio.FIRST_COMPLETED
                ),
            )
            first = done.pop()
            return first.result()
        finally:
            died_task.cancel()
            if not arrival.done():
                arrival.cancel()

    @property
    def connection(self) -> Connection:
        """The SDK connection (``command``/``request`` — the public verbs)."""
        return self.msp.connection

    async def close(self, budget_ms: int) -> ProcessExit:
        """Close stdin and wait for the orderly drain."""
        return await within(
            "the host's orderly drain and exit", budget_ms, self.msp.close()
        )

    async def abandon(self, budget_ms: int) -> None:
        """Best-effort teardown for a failure path. Never raises: since the
        SDK owns termination, what an expiry means is that the drain was not
        CLEAN — the child is reclaimed either way."""
        try:
            await self.close(budget_ms + 10_000)
        except Exception as error:  # noqa: BLE001 - warned, never raised
            import sys

            sys.stderr.write(
                f"warning: the host did not drain cleanly ({error}); the SDK "
                "escalates to SIGTERM/SIGKILL, so the child is reclaimed even "
                "when the drain is not.\n"
            )
