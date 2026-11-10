"""Real-host journey: cancelling ``Session.run`` while its turn is queued and
the session runtime takes no call keeps taking the turn back, under one
``commandId``, until the host takes it.

The Python twin of ``clients/sdk-ts/test/run-abort-busy-unqueue-real-binary.test.ts``.
It runs only when ``TBH_SDK_BUSY_UNQUEUE_E2E_BIN`` names a ``muse`` binary
built with the host's E2E lane hold and its ``runtime_busy`` answer for a
reclaim the runtime did not take; a skip is not acceptance. Linux only: the
wait for the host's ``held`` file uses inotify, the stdlib having no file
watch.
"""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import json
import os
import shutil
import sys
import tempfile
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Awaitable, Callable, TypeVar

import pytest

from muse_code import (
    MuseClient,
    MuseClientSpawnOptions,
    SendUserTurnOptions,
    StartSessionOptions,
)
from muse_code.connection import Connection, MspError

BINARY = os.environ.get("TBH_SDK_BUSY_UNQUEUE_E2E_BIN")
pytestmark = [
    pytest.mark.skipif(
        BINARY is None,
        reason="NOT RUN: set TBH_SDK_BUSY_UNQUEUE_E2E_BIN to a muse binary built with the host's"
        " E2E lane hold and its busy answer for an untaken reclaim; a skip is not acceptance",
    ),
    pytest.mark.skipif(
        sys.platform != "linux", reason="the wait for the host's held file uses inotify"
    ),
]

HOLD = "SDK_BUSY_UNQUEUE_HOLD"
QUEUED = "SDK_BUSY_UNQUEUE_QUEUED"
AFTER = "SDK_BUSY_UNQUEUE_AFTER"
BUSY_ROUNDS = 2
"""Busy answers to see before the lane frees; each one waits out the host's
30 s request timeout."""

_T = TypeVar("_T")


class _Changes:
    """Wakes waiters; each probe runs after the latest change it could miss."""

    def __init__(self) -> None:
        self._event = asyncio.Event()

    def notify(self) -> None:
        self._event.set()

    async def wait_for(
        self, description: str, probe: Callable[[], _T | None], cap_s: float = 60.0
    ) -> _T:
        async def observe() -> _T:
            while True:
                self._event.clear()
                result = probe()
                if result is not None:
                    return result
                await self._event.wait()

        # Failure-only cap; notifications, never elapsed time, advance the test.
        try:
            return await asyncio.wait_for(observe(), cap_s)
        except asyncio.TimeoutError:
            raise AssertionError(f"failure-only cap: {description}") from None


async def _capped(awaitable: Awaitable[_T], cap_s: float, description: str) -> _T:
    # Failure-only cap; the awaited outcome, never elapsed time, advances the test.
    try:
        return await asyncio.wait_for(awaitable, cap_s)
    except asyncio.TimeoutError:
        raise AssertionError(f"failure-only cap: {description}") from None


_IN_CLOSE_WRITE, _IN_MOVED_TO, _IN_CREATE = 0x8, 0x80, 0x100


class _DirectoryWatch:
    """Wakes ``changes`` when an entry of ``directory`` is created, written or
    renamed into it."""

    def __init__(self, directory: Path, changes: _Changes) -> None:
        libc = ctypes.CDLL(None, use_errno=True)
        self._fd = libc.inotify_init1(os.O_NONBLOCK | os.O_CLOEXEC)
        if self._fd < 0:
            raise OSError(ctypes.get_errno(), "inotify_init1 failed")
        mask = _IN_CLOSE_WRITE | _IN_MOVED_TO | _IN_CREATE
        if libc.inotify_add_watch(self._fd, os.fsencode(directory), mask) < 0:
            os.close(self._fd)
            raise OSError(ctypes.get_errno(), "inotify_add_watch failed")
        self._loop = asyncio.get_running_loop()
        self._loop.add_reader(self._fd, self._drain, changes)

    def _drain(self, changes: _Changes) -> None:
        with contextlib.suppress(BlockingIOError):
            while os.read(self._fd, 4096):
                pass
        changes.notify()

    def close(self) -> None:
        self._loop.remove_reader(self._fd)
        os.close(self._fd)


def _sse(value: Any) -> bytes:
    return f"data: {json.dumps(value)}\n\n".encode()


def _frame(frame_id: str, status: str, **extra: Any) -> dict[str, Any]:
    return {
        "id": frame_id,
        "object": "response",
        "model": "fixture-meta",
        "status": status,
        "output": [],
        **extra,
    }


def _latest_user(body: dict[str, Any]) -> str:
    users = [item for item in body.get("input", []) if isinstance(item, dict) and item.get("role") == "user"]
    return json.dumps(users[-1] if users else "")


class _HeldTurnProvider:
    """A loopback Responses endpoint that keeps open each stream whose latest
    user message carries HOLD (a retried stream too) until :meth:`release`, so
    turn 1 stays running with no live model. Every other request is answered
    at once."""

    def __init__(self, notify: Callable[[], None]) -> None:
        self.requests: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self._lock = threading.Lock()
        self._released = threading.Event()
        self._held = 0
        provider = self

        class _Handler(BaseHTTPRequestHandler):
            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return

            def _refuse(self, error: str) -> None:
                with provider._lock:
                    provider.errors.append(error)
                notify()
                self.send_response(500)
                self.end_headers()

            def do_GET(self) -> None:  # noqa: N802 - http.server's own name
                if not self.path.endswith("/muse-code/models"):
                    self._refuse(f"unexpected provider route GET {self.path}")
                    return
                row = {
                    "name": "SDK busy-unqueue fixture",
                    "release_date": "2026-01-01",
                    "is_hidden": False,
                    "tool_call": True,
                    "reasoning": True,
                    "limit": {"context": 1_000_000, "output": 4096},
                }
                body = json.dumps(
                    {
                        "object": "list",
                        "data": [{"id": "fixture-meta", "object": "model", "metadata": {"muse-code": row}}],
                    }
                ).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_POST(self) -> None:  # noqa: N802 - http.server's own name
                if not self.path.endswith("/responses"):
                    self._refuse(f"unexpected provider route POST {self.path}")
                    return
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
                with provider._lock:
                    provider.requests.append(body)
                    number = len(provider.requests)
                    hold = not provider._released.is_set() and HOLD in _latest_user(body)
                    provider._held += hold
                frame_id = f"busy-unqueue-{number}"
                try:
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                    self.end_headers()
                    self.wfile.write(
                        _sse({"type": "response.created", "sequence_number": 1, "response": _frame(frame_id, "in_progress")})
                        + _sse(
                            {
                                "type": "response.output_text.delta",
                                "sequence_number": 2,
                                "output_index": 0,
                                "item_id": f"{frame_id}-message",
                                "content_index": 0,
                                "delta": f"busy-unqueue reply {number}",
                            }
                        )
                    )
                    notify()
                    if hold:
                        # Teardown always releases, so no hold outlives the test.
                        provider._released.wait()
                    usage = {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}
                    self.wfile.write(
                        _sse({"type": "response.completed", "sequence_number": 3, "response": _frame(frame_id, "completed", usage=usage)})
                    )
                except OSError:
                    # The host dropped the stream; there is nothing left to answer.
                    return

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        self.base_url = f"http://127.0.0.1:{self._server.server_address[1]}"

    def held(self) -> int:
        """Model streams held open so far."""
        with self._lock:
            return self._held

    def release(self) -> None:
        """Answer every held stream, and every later one at once."""
        self._released.set()

    def close(self) -> None:
        self._released.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join()


@dataclass
class _Sent:
    method: str
    params: dict[str, Any]
    outcome: "asyncio.Future[dict[str, Any]]"


def _spy_requests(monkeypatch: pytest.MonkeyPatch, changes: _Changes) -> list[_Sent]:
    """Record every request the SDK sends, each resend included, with its outcome."""
    sent: list[_Sent] = []
    original = Connection.request

    def request(self: Connection, method: str, params: dict[str, Any] | None = None) -> "asyncio.Future[dict[str, Any]]":
        outcome = original(self, method, params)
        sent.append(_Sent(method, dict(params or {}), outcome))
        outcome.add_done_callback(lambda _: changes.notify())
        changes.notify()
        return outcome

    monkeypatch.setattr(Connection, "request", request)
    return sent


def _unqueues_of(sent: list[_Sent], turn_id: str) -> list[_Sent]:
    return [entry for entry in sent if entry.method == "turn/unqueue" and entry.params.get("turnId") == turn_id]


def _assert_no_stop_fallback(sent: list[_Sent]) -> None:
    stops = [entry.method for entry in sent if entry.method in ("turn/cancel", "turn/interrupt")]
    assert stops == [], f"the cancellation fell back to {stops}, so the SDK gave up the take-back"


@pytest.mark.asyncio
async def test_a_cancelled_run_keeps_taking_back_its_queued_turn_while_the_runtime_takes_no_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert BINARY is not None
    root = Path(tempfile.mkdtemp(prefix="sdk-busy-unqueue-py-"))
    home, workspace, hold_dir = root / "home", root / "workspace", root / "lane-hold"
    workspace.mkdir()
    hold_dir.mkdir()
    # The host's E2E lane hold: `arm` names the session, the host writes `held`, `release` frees the lane.
    arm, held, release = hold_dir / "arm", hold_dir / "held", hold_dir / "release"
    loop = asyncio.get_running_loop()
    changes = _Changes()

    def notify_from_provider_thread() -> None:
        loop.call_soon_threadsafe(changes.notify)

    provider = _HeldTurnProvider(notify_from_provider_thread)
    watch = _DirectoryWatch(hold_dir, changes)
    sent = _spy_requests(monkeypatch, changes)
    stderr: list[str] = []
    client: MuseClient[Any] | None = None
    closed = False
    try:
        env = {
            "HOME": str(home),
            "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
            "MUSE_EXPERIMENTAL_SDK_ENABLED": "on",
            "TBH_CREDENTIAL_BACKEND": "file",
            "TBH_DISABLE_TELEMETRY": "1",
            "TBH_DISABLE_FEATURE_CONFIG": "1",
            "XDG_CONFIG_HOME": str(home / "config"),
            "XDG_DATA_HOME": str(home / "data"),
            "META_API_KEY": "busy-unqueue-loopback-fixture-only",
            "TBH_IS_E2E_TEST": "1",
            "TBH_E2E_SESSION_NAME_ACCOUNT_HOME": str(home),
            "TBH_TMUX_ORDINARY_LANE_HOLD_ARM_FILE": str(arm),
            "TBH_TMUX_ORDINARY_LANE_HOLD_HELD_FILE": str(held),
            "TBH_TMUX_ORDINARY_LANE_HOLD_RELEASE_FILE": str(release),
        }
        config = home / "config" / "muse"
        config.mkdir(parents=True)
        (config / "settings.json").write_text(
            json.dumps(
                {
                    "schema_version": 1,
                    "endpoint_transport": {"base_url": provider.base_url, "auth": "bearer"},
                    "run": {"reminder_roster": {"agents": []}},
                }
            )
        )
        (config / "auth.json").write_text(
            json.dumps({"schema_version": 1, "providers": {"meta": {"api_key": env["META_API_KEY"]}}})
        )
        client = await MuseClient.spawn(
            MuseClientSpawnOptions(
                muse_bin=BINARY,
                client_info={"name": "sdk_busy_unqueue_py", "version": "1"},
                args=["serve", "--provider", "meta", "--model", "fixture-meta"],
                cwd=str(workspace),
                env=env,
                on_stderr=stderr.append,
                shutdown_timeout_ms=30_000,
            )
        )
        session = await client.start_session(
            StartSessionOptions(approval_mode="allowAll", workspace_root=str(workspace))
        )

        def check_provider() -> None:
            assert provider.errors == [], "the loopback endpoint must route every request"

        # Turn 1 runs and stays running: its model stream is held open.
        first = await session.send_user_turn(SendUserTurnOptions(input=[{"type": "text", "text": HOLD}]))
        first_outcome = asyncio.ensure_future(first.completed)

        def turn_one_held() -> bool | None:
            check_provider()
            return True if provider.held() > 0 else None

        await changes.wait_for("the provider holds turn 1's model stream", turn_one_held)

        # Turn 2 queues behind it.
        queued = asyncio.ensure_future(session.run(QUEUED, if_busy="queue"))

        def turn_two_queued() -> str | None:
            start = next(
                (
                    entry
                    for entry in sent
                    if entry.method == "turn/start" and QUEUED in json.dumps(entry.params.get("input"))
                ),
                None,
            )
            if start is None or not start.outcome.done():
                return None
            ack = start.outcome.result()
            assert ack["disposition"] == "queued", f"turn 2 did not queue: {ack}"
            return str(ack["turnId"])

        turn2 = await changes.wait_for("turn 2's turn/start is acked queued", turn_two_queued)

        # The host stops taking calls on the session's ordinary lane, as a stuck runtime does.
        staged = hold_dir / "arm.staged"
        staged.write_text(session.session_id)
        os.replace(staged, arm)

        def lane_held() -> str | None:
            with contextlib.suppress(FileNotFoundError):
                return held.read_text().strip() or None
            return None

        slots = await changes.wait_for(
            "the session host holds its whole ordinary lane (the binary lacks the lane hold,"
            " or the arm file did not name its session)",
            lane_held,
        )
        assert slots.isdigit() and int(slots) > 0, f"the host reports how many slots it holds: {slots!r}"

        queued.cancel()
        for round_ in range(1, BUSY_ROUNDS + 1):

            def answered_busy_and_resent(round_: int = round_) -> bool | None:
                _assert_no_stop_fallback(sent)
                unqueues = _unqueues_of(sent, turn2)
                if len(unqueues) < round_ or not unqueues[round_ - 1].outcome.done():
                    return None
                error = unqueues[round_ - 1].outcome.exception()
                assert isinstance(error, MspError) and error.data.get("reason") == "runtime_busy", (
                    f"unqueue #{round_} was not answered busy: {error!r}"
                )
                return True if len(unqueues) > round_ else None

            await changes.wait_for(
                f"the host answers unqueue #{round_} runtime_busy (the binary lacks the busy answer)"
                " and the SDK sends it again",
                answered_busy_and_resent,
                cap_s=120.0,
            )

        # The runtime takes calls again: the resend in flight takes the turn back.
        release.touch()
        done, _ = await asyncio.wait({queued}, timeout=120.0)
        assert queued in done, "failure-only cap: the cancelled run settles once the host takes the turn back"
        assert queued.cancelled(), "the cancelled run re-raises CancelledError"
        reclaimed = await _capped(session.turn(turn2).completed, 60.0, "turn 2's wait settles")
        assert reclaimed.kind == "unqueued", "the queued turn was taken back, not run"
        assert not session.turn(turn2).observed_start, "the queued turn never started"

        provider.release()
        first_end = await _capped(first_outcome, 60.0, "turn 1 completes once its model stream is answered")
        assert first_end.kind == "completed"
        # Barrier: a turn 2 still queued would launch before this one.
        after = await _capped(session.run(AFTER, if_busy="queue"), 60.0, "a later turn runs to completion")
        assert after.outcome.kind == "completed"
        check_provider()

        await client.close()
        exit_row = await client.exit
        closed = True
        assert exit_row.kind == "cleanShutdown", "healthy EOF must drain without escalation"

        _assert_no_stop_fallback(sent)
        unqueues = _unqueues_of(sent, turn2)
        assert len(unqueues) >= BUSY_ROUNDS + 1, (
            f"{BUSY_ROUNDS} busy answers, then the take-back; saw {len(unqueues)} unqueues"
        )
        command_id = unqueues[0].params["commandId"]
        for index, unqueue in enumerate(unqueues):
            label = f"unqueue #{index + 1}"
            assert unqueue.params["commandId"] == command_id, f"{label} keeps the first unqueue's commandId"
            if index < len(unqueues) - 1:
                error = unqueue.outcome.exception()
                assert isinstance(error, MspError), f"{label}: {error!r}"
                assert error.code == -32030
                assert error.kind == "commandRejected"
                assert error.data.get("reason") == "runtime_busy"
                assert error.retryable is True
                assert error.data.get("commandId") == command_id, f"{label}'s answer names its commandId"
                assert "reclaim" in str(error), f"{label}'s answer names the call not taken"
            else:
                ack = unqueue.outcome.result()
                assert ack["status"] == "accepted", f"the last unqueue takes the turn back: {ack}"
                assert ack["turnId"] == turn2
        assert not any(QUEUED in _latest_user(body) for body in provider.requests), (
            "the queued turn never reached the model"
        )
    finally:
        release.touch()
        provider.release()
        if client is not None and not closed:
            with contextlib.suppress(Exception):
                await client.close()
        watch.close()
        provider.close()
        (root / "provider.json").write_text(
            json.dumps({"requests": provider.requests, "errors": provider.errors}, indent=2)
        )
        (root / "host.stderr").write_text("".join(stderr))
        evidence = os.environ.get("TBH_SDK_BUSY_UNQUEUE_E2E_EVIDENCE")
        if evidence is not None:
            shutil.copytree(root, Path(evidence) / "run-abort-busy-unqueue-py", dirs_exist_ok=True)
        shutil.rmtree(root, ignore_errors=True)
