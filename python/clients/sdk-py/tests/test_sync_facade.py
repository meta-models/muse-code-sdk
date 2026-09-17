"""PY-the governing rule ``sync_wrapper_journey_and_loop_refusal`` — the owning spec
the governing rule, the governing rule; its acceptance scenario both arms.

The sync wrapper is a LOOP-RUNNER, not a second SDK: it owns a private event
loop, exposes blocking equivalents of the facade verbs, and iterates turn
streams synchronously. It contains no protocol logic of its own — every arm
below observes the SAME wire frames and fold state the async facade produces,
through the blocking surface.

The journey arm drives the quickstart SHAPE (start the agent, run a turn,
follow its items, reach the verdict, shut down) over a deterministic scripted
host; the S4 quickstart program re-runs the same narrative against the
release-built host. The spawn/close blocking path is additionally proven
against the real ``serve-fixture`` host (skipped, never failed, when no
binary is available — the same posture as the async spawn suites).
"""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path
from typing import Any, AsyncIterator, List

import pytest

import muse_code
from muse_code import (
    MuseClient,
    MuseClientOptions,
    MuseClientSpawnOptions,
    SendUserTurnOptions,
    StartSessionOptions,
    SyncMuseClient,
    read_session_durability,
)
from muse_code.connection import Connection
from muse_code.replay import load_transcript

from helpers_host_lifetime import fixture_host_bin

Params = dict[str, Any]

PROJECT_ROOT = Path(__file__).resolve().parents[3]
CORPUS = PROJECT_ROOT / "schema" / "msp" / "transcripts"

SESSION = "s-sync"
TURN = "t-sync"
SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}


def _frame(value: Params) -> str:
    return json.dumps(value, ensure_ascii=False) + "\n"


class ScriptedHost:
    """A deterministic in-memory host: every inbound request is answered
    synchronously from a script, so the private loop never waits on anything
    outside itself.

    The sync wrapper blocks its calling thread while its loop runs, so a test
    cannot feed frames from outside the way the async suites do — the script
    answers from inside ``write``, which runs on the wrapper's own loop.
    """

    def __init__(
        self,
        auto_stream: bool = True,
        hold_first_turn: "threading.Event | None" = None,
    ) -> None:
        from helpers_connection import AsyncChunks

        self.chunks = AsyncChunks()
        self.writes: List[str] = []
        # ``auto_stream`` pushes the turn's view events the moment the
        # ``turn/start`` ack is written; the journey arm stages them by hand
        # instead (``stream_turn``) so the iterator's in-order assertion is
        # not at the mercy of how far the ack's loop run read ahead.
        self._auto_stream = auto_stream
        # The serialization arm's causal overlap: the FIRST turn's reply is
        # held until this event is set (from another thread), so the holding
        # verb is provably parked inside `run_until_complete` when the second
        # thread's verb arrives.
        self._hold_first_turn = hold_first_turn
        self.first_turn_holding = threading.Event()
        self._held_once = False

    @property
    def incoming(self) -> "Any":
        return self.chunks

    async def write(self, chunk: str) -> None:
        self.writes.append(chunk)
        frame = json.loads(chunk)
        method = frame.get("method")
        if method == "session/start":
            self.chunks.push(
                _frame(
                    {
                        "jsonrpc": "2.0",
                        "id": frame["id"],
                        "result": {
                            "session": {
                                "sessionId": SESSION,
                                "status": "idle",
                                "turnCount": 0,
                            },
                            "viewCursor": "v:0",
                        },
                    }
                )
            )
        elif method == "turn/start":
            if self._hold_first_turn is not None and not self._held_once:
                self._held_once = True
                self.first_turn_holding.set()
                await asyncio.get_running_loop().run_in_executor(
                    None, self._hold_first_turn.wait
                )
            command_id = frame["params"]["commandId"]
            self.chunks.push(
                _frame(
                    {
                        "jsonrpc": "2.0",
                        "id": frame["id"],
                        "result": {
                            "commandId": command_id,
                            "disposition": "started",
                            "startedNewTurn": True,
                            "status": "accepted",
                            "turnId": TURN,
                        },
                    }
                )
            )
            if self._auto_stream:
                self.stream_turn()

    def stream_turn(self) -> None:
        """Push the scripted turn's view events (safe between blocking verbs:
        the wrapper's loop is parked, so a push just queues the chunks)."""
        self.stream(_turn_events())

    def stream(self, events: List[Params]) -> None:
        """Push an explicit event slice, for arms that stage the turn's
        lifecycle in pieces."""
        for event in events:
            self.chunks.push(_frame({"jsonrpc": "2.0", **event}))

    async def close(self, flushed: object = None) -> None:
        if flushed is not None and hasattr(flushed, "__await__"):
            await flushed
        self.chunks.end()


def _turn_events() -> List[Params]:
    item = {
        "itemId": "i-1",
        "kind": "agentMessage",
        "revision": 1,
        "sessionId": SESSION,
        "status": "inProgress",
        "turnId": TURN,
        "text": "",
    }
    completed = {**item, "revision": 2, "status": "completed", "text": "All tests pass"}
    return [
        {
            "method": "turn/started",
            "params": {
                "commandId": "c-1",
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "turnId": TURN,
                "viewCursor": "v:1",
            },
        },
        {
            "method": "item/started",
            "params": {"item": item, "sessionId": SESSION, "viewCursor": "v:2"},
        },
        {
            "method": "item/delta",
            "params": {
                "delta": "All tests",
                "field": "text",
                "itemId": "i-1",
                "sessionId": SESSION,
                "viewCursor": "v:3",
            },
        },
        {
            "method": "item/delta",
            "params": {
                "delta": " pass",
                "field": "text",
                "itemId": "i-1",
                "sessionId": SESSION,
                "viewCursor": "v:4",
            },
        },
        {
            "method": "item/completed",
            "params": {
                "item": completed,
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "viewCursor": "v:5",
            },
        },
        {
            "method": "turn/completed",
            "params": {
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "terminal": "completed",
                "turnId": TURN,
                "viewCursor": "v:6",
            },
        },
    ]


def scripted_client(
    auto_stream: bool = True,
    hold_first_turn: "threading.Event | None" = None,
) -> tuple[ScriptedHost, "SyncMuseClient[str]"]:
    host = ScriptedHost(auto_stream, hold_first_turn)

    async def factory() -> "MuseClient[str]":
        connection = Connection(host)
        return MuseClient(
            connection,
            MuseClientOptions(
                durability=read_session_durability({"sessionDurability": "durable"})
            ),
        )

    return host, SyncMuseClient.create(factory)


# ---- its acceptance scenario: the journey shape, on the blocking surface ---------------


def test_the_sync_wrapper_runs_the_journey_shape_with_the_same_verdicts() -> None:
    # Deliberately NO asyncio marker and NO running loop: this test IS the
    # synchronous script the governing rule promises the surface to.
    host, client = scripted_client(auto_stream=False)

    session = client.start_session(StartSessionOptions(workspace_root="/tmp/w"))
    assert session.session_id == SESSION

    turn = session.send_user_turn(
        SendUserTurnOptions(
            input=[{"text": "run the tests", "type": "text"}],
            composer_input="run the tests",
        )
    )
    assert turn.turn_id == TURN
    # Staged AFTER the submit ack, while the private loop is parked: the
    # iterator below must see the live sequence in order from its first pump.
    host.stream_turn()

    # Sync iteration of the turn stream — the item at each folded revision.
    seen = [f"{item['itemId']}@{item['revision']}" for item in turn.items()]
    assert seen == ["i-1@1", "i-1@2"]

    # The blocking wait reports the same server-authored verdict the async
    # facade's `completed` awaitable resolves with.
    outcome = turn.completed()
    assert outcome.kind == "completed"
    assert outcome.kind == "completed" and outcome.params["terminal"] == "completed"

    # The fold read surface is the async facade's own object, unwrapped.
    held = session.fold.items.get("i-1")
    assert held is not None and held["text"] == "All tests pass"

    # The wire saw exactly the facade's frames: one session/start, one
    # turn/start — no wrapper-authored traffic (the governing rule: it re-implements
    # nothing).
    methods = [json.loads(line).get("method") for line in host.writes]
    assert methods == ["session/start", "turn/start"]

    client.close()


def test_sync_iteration_ends_when_the_turn_settles_and_a_late_iterator_replays() -> None:
    host, client = scripted_client()
    session = client.start_session()
    turn = session.send_user_turn(
        SendUserTurnOptions(input=[{"text": "hi", "type": "text"}], composer_input="hi")
    )
    assert turn.completed().kind == "completed"
    # A late items() still replays the folded backlog, then ends — the async
    # replay/live asymmetry carried onto the sync surface.
    assert [item["itemId"] for item in turn.items()] == ["i-1"]
    # deltas() is live-only; the turn is settled, so it ends immediately.
    assert list(turn.deltas()) == []
    client.close()


def test_a_second_concurrent_sync_call_serializes_on_the_private_loop() -> None:
    # its acceptance scenario edge case: two threads, one client — the second call must
    # serialize on the private loop, never race it ("This event loop is
    # already running" is the crash an unlocked wrapper exhibits). The overlap
    # is CAUSAL, not lucky: the host holds thread
    # A's first turn/start reply on an event, so A is provably parked inside
    # `run_until_complete` when thread B's verb arrives — without the runner's
    # lock, B deterministically hits the running loop.
    release_first_turn = threading.Event()
    host, client = scripted_client(hold_first_turn=release_first_turn)
    session = client.start_session()
    outcomes: List[str] = []
    errors: List[BaseException] = []

    def send_and_wait() -> None:
        try:
            turn = session.send_user_turn(
                SendUserTurnOptions(
                    input=[{"text": "hi", "type": "text"}], composer_input="hi"
                )
            )
            # The stream verbs ride the same lock: iterating here while the
            # other thread pumps would mutate the turn's stream set mid-read.
            # The COUNT is interleaving-dependent (replay-after-settle vs live
            # revisions), so only the item identity is asserted.
            # EXACT equality: the fold retains the turn's item and items()
            # always replays the folded backlog, so the identity set is
            # deterministic — and a subset assert would pass on an empty
            # yield, the exact regression this iteration guards.
            items = {held["itemId"] for held in turn.items()}
            assert items == {"i-1"}
            outcomes.append(turn.completed().kind)
        except BaseException as error:  # noqa: BLE001 - reported to the arm
            errors.append(error)

    def worker_b() -> None:
        # A is parked holding the loop; releasing the reply and immediately
        # submitting makes B contend with a genuinely RUNNING verb. The wait's
        # RETURN is checked: a discarded False would let the hold no-op and
        # this arm go green without the causal overlap it exists to prove.
        if not host.first_turn_holding.wait(timeout=30):
            errors.append(AssertionError("thread A never parked in the host"))
            release_first_turn.set()  # free A regardless, so the join settles
            return
        release_first_turn.set()
        send_and_wait()

    thread_a = threading.Thread(target=send_and_wait, daemon=True)
    thread_b = threading.Thread(target=worker_b, daemon=True)
    thread_a.start()
    thread_b.start()
    for thread in (thread_a, thread_b):
        thread.join(timeout=30)  # deadlock cap only; the green path is causal
        assert not thread.is_alive(), "worker deadlocked on the private loop"
    assert errors == []
    assert outcomes == ["completed", "completed"]
    client.close()


def test_the_call_lock_serializes_sync_delegates_with_a_pumping_verb() -> None:
    # `call()`'s own lock arm: while thread A is
    # parked inside a pumping verb (reply held), a locked sync delegate from
    # thread B must not run until A's verb settles — and A's verb settles only
    # after the release event fires, so "the release was set when the delegate
    # ran" is the causal oracle. Probed through the runner directly: a
    # public-verb probe would separate the probe from the lock acquisition and
    # could go green on an unlocked mutant.
    release_first_turn = threading.Event()
    host, client = scripted_client(hold_first_turn=release_first_turn)
    session = client.start_session()
    b_started = threading.Event()
    observed: List[bool] = []
    errors: List[BaseException] = []

    def worker_a() -> None:
        try:
            session.send_user_turn(
                SendUserTurnOptions(
                    input=[{"text": "hi", "type": "text"}], composer_input="hi"
                )
            )
        except BaseException as error:  # noqa: BLE001 - reported to the arm
            errors.append(error)

    def worker_b() -> None:
        if not host.first_turn_holding.wait(timeout=30):
            errors.append(AssertionError("thread A never parked in the host"))
            release_first_turn.set()
            return
        b_started.set()
        try:
            # Under the lock this cannot run until A's verb finished, and A's
            # verb finishes only after the hold released.
            observed.append(client._runner.call(release_first_turn.is_set))
        except BaseException as error:  # noqa: BLE001 - reported to the arm
            errors.append(error)

    thread_a = threading.Thread(target=worker_a, daemon=True)
    thread_b = threading.Thread(target=worker_b, daemon=True)
    thread_a.start()
    thread_b.start()
    assert host.first_turn_holding.wait(timeout=30), "thread A never parked"
    assert b_started.wait(timeout=30), "thread B never contended"
    release_first_turn.set()
    for thread in (thread_a, thread_b):
        thread.join(timeout=30)  # deadlock cap only; the green path is causal
        assert not thread.is_alive(), "worker deadlocked on the private loop"
    assert errors == []
    assert observed == [True], (
        "the sync delegate ran while another thread's verb was still pumping"
    )
    client.close()


def test_a_closed_generator_releases_its_stream_and_the_turn_still_settles() -> None:
    # The stream-release `finally` has its own guard (a prior review round
    # 2): take one item from an UNSETTLED turn, close the generator, and the
    # fan-out must stop feeding a stream nobody reads — then the real terminal
    # still wins. The handle's live_stream_count is the same observability the
    # async suites use; reached through the wrapper's private turn view
    # because the sync surface (deliberately) does not re-export it.
    host, client = scripted_client(auto_stream=False)
    session = client.start_session()
    turn = session.send_user_turn(
        SendUserTurnOptions(input=[{"text": "hi", "type": "text"}], composer_input="hi")
    )
    events = _turn_events()
    host.stream(events[:2])  # turn/started + item/started only; NOT settled

    stream = turn.items()
    first = next(stream)
    assert first["itemId"] == "i-1"
    getattr(stream, "close")()
    handle = turn._turn  # the concrete TurnHandle; observability only
    assert getattr(handle, "live_stream_count") == 0, (
        "a closed sync iterator must deregister its stream"
    )

    host.stream(events[2:])  # deltas + completed item + turn/completed
    assert turn.completed().kind == "completed"
    client.close()


def test_a_never_advanced_iterator_is_reclaimed_when_the_turn_settles() -> None:
    # The docstring's OTHER half, pinned: a
    # generator closed before its first next() runs no `finally`, so the
    # registration is reclaimed only when the turn settles — bounded, like the
    # async surface's dropped, never-read stream.
    host, client = scripted_client(auto_stream=False)
    session = client.start_session()
    turn = session.send_user_turn(
        SendUserTurnOptions(input=[{"text": "hi", "type": "text"}], composer_input="hi")
    )
    stream = turn.items()
    handle = turn._turn
    assert getattr(handle, "live_stream_count") == 1, "registration is eager"
    getattr(stream, "close")()  # closed BEFORE the first next(): no finally
    host.stream(_turn_events())
    assert turn.completed().kind == "completed"
    assert getattr(handle, "live_stream_count") == 0, "settle clears the stream"
    client.close()


def test_a_shutdown_that_raises_still_retires_the_loop() -> None:
    # Constitution XIII: one failing shutdown must
    # not leak the loop and its watcher tasks forever. Probed at the runner
    # seam, which owns the invariant.
    from muse_code.sync_facade import _LoopRunner

    loop = asyncio.new_event_loop()
    runner = _LoopRunner(loop)

    async def failing_shutdown() -> None:
        raise OSError("transport close failed")

    with pytest.raises(OSError, match="transport close failed"):
        runner.close(failing_shutdown)
    assert loop.is_closed(), "the teardown must run even when shutdown raises"
    # And the wrapper stays terminally closed: a second close no-ops, a verb
    # gets the designed refusal.
    runner.close(failing_shutdown)
    with pytest.raises(RuntimeError, match="spawn or create a new one"):
        runner.call(lambda: None)


def test_close_racing_a_pre_pump_verb_refuses_once_the_verb_pumps() -> None:
    # The P0 window: run() takes the lock a few
    # bytecodes before run_until_complete marks the loop running, so a close()
    # that reads is_running() ONCE can commit to a blocking acquire behind an
    # unbounded verb. The arm parks a verb holder inside that exact window
    # (instrumented run_until_complete), starts the closer, then lets the verb
    # pump — the closer must refuse, never block.
    from muse_code.sync_facade import _LoopRunner

    host, client = scripted_client(auto_stream=False)
    session = client.start_session()
    turn = session.send_user_turn(
        SendUserTurnOptions(input=[{"text": "hi", "type": "text"}], composer_input="hi")
    )
    runner: "_LoopRunner" = client._runner
    loop = runner._loop
    in_window = threading.Event()
    proceed = threading.Event()
    real_run_until_complete = loop.run_until_complete

    def windowed(future: Any) -> Any:
        # First entry parks INSIDE run()'s locked, not-yet-running window.
        loop.run_until_complete = real_run_until_complete  # type: ignore[method-assign]
        in_window.set()
        assert proceed.wait(timeout=30), "the window was never released"
        return real_run_until_complete(future)

    refusals: List[BaseException] = []
    unexpected: List[BaseException] = []

    def verb() -> None:
        try:
            turn.completed()
        except BaseException as error:  # noqa: BLE001 - reported to the arm
            unexpected.append(error)

    def closer() -> None:
        # ONE finally over the whole body: every exit — the window-expiry
        # early return included — must feed the terminal, or the verb thread
        # pumps forever and the arm reds 30s later with the wrong message
        # while the real cause sits unread in `unexpected` (a prior review
        # round 4).
        try:
            if not in_window.wait(timeout=30):
                unexpected.append(
                    AssertionError("the verb never entered the window")
                )
                return
            # The holder is in the pre-pump window NOW; a once-read close
            # commits to the blocking acquire here and never returns.
            proceed.set()
            try:
                client.close()
                unexpected.append(AssertionError("close() joined a pumping loop"))
            except RuntimeError as error:
                refusals.append(error)
        finally:
            proceed.set()
            loop.call_soon_threadsafe(host.stream_turn)

    loop.run_until_complete = windowed  # type: ignore[method-assign]
    verb_thread = threading.Thread(target=verb, daemon=True)
    closer_thread = threading.Thread(target=closer, daemon=True)
    verb_thread.start()
    closer_thread.start()
    for thread in (verb_thread, closer_thread):
        # Outlasts the closer's 30s inner wait: a tied cap could win the race
        # against the expiry fallback and red with the wrong message while
        # the real cause sits unread.
        thread.join(timeout=40)  # deadlock cap only; the green path is causal
        assert not thread.is_alive(), (
            f"pre-pump race deadlock; unexpected={unexpected!r} "
            f"refusals={refusals!r}"
        )
    assert unexpected == []
    assert len(refusals) == 1 and "cannot interrupt a pumping loop" in str(refusals[0])
    client.close()


class _ObservedLock:
    """A lock wrapper that signals every MISSED bounded acquire, so the
    carve-out arms can prove close() really reached its wait-it-out branch
    instead of winning the lock on the first try."""

    def __init__(self, inner: "threading.Lock", missed: "threading.Event") -> None:
        self._inner = inner
        self._missed = missed

    def acquire(self, blocking: bool = True, timeout: float = -1) -> bool:
        acquired = self._inner.acquire(blocking, timeout)
        if not acquired:
            self._missed.set()
        return acquired

    def release(self) -> None:
        self._inner.release()

    def __enter__(self) -> bool:
        return self._inner.__enter__()

    def __exit__(self, *exc: Any) -> None:
        self._inner.__exit__(*exc)


def test_two_concurrent_closes_serialize_into_one_shutdown() -> None:
    # A closing peer is a bounded the governing rule shutdown, not a stuck verb
    #: the second close must wait it out and no-op,
    # never bounce with the pumping-verb refusal. Probed at the runner seam so
    # the first shutdown can be held open causally — and held until the SECOND
    # close has provably MISSED an acquire while the first pumps, or the
    # refusal branch is never reached and its `not self._closed` gate is
    # unpinned.
    from muse_code.sync_facade import _LoopRunner

    loop = asyncio.new_event_loop()
    runner = _LoopRunner(loop)
    missed = threading.Event()
    runner._lock = _ObservedLock(runner._lock, missed)  # type: ignore[assignment]
    shutdowns = 0
    first_shutdown_pumping = threading.Event()
    release_shutdown = threading.Event()

    async def shutdown() -> None:
        nonlocal shutdowns
        shutdowns += 1
        first_shutdown_pumping.set()
        await asyncio.get_running_loop().run_in_executor(
            None, release_shutdown.wait
        )

    errors: List[BaseException] = []

    def close_a() -> None:
        try:
            runner.close(shutdown)
        except BaseException as error:  # noqa: BLE001 - reported to the arm
            errors.append(error)

    def close_b() -> None:
        if not first_shutdown_pumping.wait(timeout=30):
            errors.append(AssertionError("the first shutdown never pumped"))
            release_shutdown.set()
            return
        try:
            # A's shutdown is PUMPING now (loop running, lock held) — this
            # close must serialize behind it, not raise.
            runner.close(shutdown)
        except BaseException as error:  # noqa: BLE001 - reported to the arm
            errors.append(error)
        finally:
            pass

    thread_a = threading.Thread(target=close_a, daemon=True)
    thread_b = threading.Thread(target=close_b, daemon=True)
    thread_a.start()
    thread_b.start()
    # The release rides a finally: a red assert must still free A's parked
    # shutdown, or the default-executor worker blocks interpreter exit and the
    # red becomes a CI job-wall hang.
    try:
        assert first_shutdown_pumping.wait(timeout=30), "shutdown never pumped"
        # B must MISS at least one bounded acquire while A's shutdown pumps —
        # that is the branch whose `not self._closed` gate this arm pins —
        # before the first shutdown is allowed to finish.
        assert missed.wait(timeout=30), "the second close never contended"
    finally:
        release_shutdown.set()
    for thread in (thread_a, thread_b):
        thread.join(timeout=30)  # deadlock cap only; the green path is causal
        assert not thread.is_alive(), "a close deadlocked against its peer"
    assert errors == []
    assert shutdowns == 1, "the second close must no-op, not re-run the shutdown"
    assert loop.is_closed()


def test_close_waits_out_a_holder_between_loop_runs_instead_of_refusing() -> None:
    # The OTHER carve-out: a holder whose
    # loop is NOT running (a `call()` delegate, or a verb between loop runs)
    # releases promptly, so close() waits it out — deleting the
    # `is_running()` gate would turn this into a refusal.
    from muse_code.sync_facade import _LoopRunner

    loop = asyncio.new_event_loop()
    runner = _LoopRunner(loop)
    missed = threading.Event()
    runner._lock = _ObservedLock(runner._lock, missed)  # type: ignore[assignment]
    holder_in = threading.Event()
    release_holder = threading.Event()
    errors: List[BaseException] = []

    def holder() -> None:
        def parked() -> None:
            holder_in.set()
            assert release_holder.wait(timeout=30), "the holder was never freed"

        try:
            runner.call(parked)
        except BaseException as error:  # noqa: BLE001 - reported to the arm
            errors.append(error)

    async def shutdown() -> None:
        return None

    def closer() -> None:
        try:
            runner.close(shutdown)
        except BaseException as error:  # noqa: BLE001 - reported to the arm
            errors.append(error)

    holder_thread = threading.Thread(target=holder, daemon=True)
    holder_thread.start()
    assert holder_in.wait(timeout=30), "the holder never took the lock"
    closer_thread = threading.Thread(target=closer, daemon=True)
    closer_thread.start()
    # The closer must contend (a missed bounded acquire) BEFORE the holder is
    # freed — proving it chose to wait, not that it never met the holder. The
    # release rides a finally for the same reason as the sibling arm's.
    try:
        assert missed.wait(timeout=30), "close() never contended with the holder"
    finally:
        release_holder.set()
    for thread in (holder_thread, closer_thread):
        thread.join(timeout=30)  # deadlock cap only; the green path is causal
        assert not thread.is_alive(), "a thread deadlocked on the runner lock"
    assert errors == [], f"close must wait out a between-runs holder: {errors!r}"
    assert loop.is_closed()


def test_close_while_another_thread_pumps_an_unbounded_verb_is_refused() -> None:
    # The deadlock arm: the main thread parks in a
    # turn wait pumping the loop; close() from another thread must refuse with
    # the exact error, not join the deadlock — and a later close, after the
    # verb settles, succeeds.
    host, client = scripted_client(auto_stream=False)
    session = client.start_session()
    turn = session.send_user_turn(
        SendUserTurnOptions(input=[{"text": "hi", "type": "text"}], composer_input="hi")
    )
    refusals: List[BaseException] = []
    unexpected: List[BaseException] = []

    def closer() -> None:
        # Causal parking receipt: a threadsafe callback runs only when the
        # loop pumps, and the ONLY pump after this thread starts is the main
        # thread's completed() wait — which cannot settle until this thread
        # later feeds the terminal.
        parked = threading.Event()
        client._runner._loop.call_soon_threadsafe(parked.set)
        if not parked.wait(timeout=30):
            unexpected.append(AssertionError("the main thread never pumped"))
            client._runner._loop.call_soon_threadsafe(host.stream_turn)
            return
        try:
            client.close()
            unexpected.append(AssertionError("close() joined a pumping loop"))
        except RuntimeError as error:
            refusals.append(error)
        except BaseException as error:  # noqa: BLE001 - reported to the arm
            unexpected.append(error)
        finally:
            # Let the parked verb settle: the push must happen ON the loop,
            # which the blocked verb is pumping.
            client._runner._loop.call_soon_threadsafe(host.stream_turn)

    # The parked verb runs on a CAPPED daemon worker, not the main thread: if
    # close() ever regresses to a blocking acquire, the closer blocks before
    # its finally can feed the terminal, and a main-thread completed() would
    # pump forever — a silent CI job-wall hang instead of a red (a tracked issue;
    # a prior review).
    outcomes: List[Any] = []
    pump_thread = threading.Thread(
        target=lambda: outcomes.append(turn.completed()), daemon=True
    )
    closer_thread = threading.Thread(target=closer, daemon=True)
    pump_thread.start()
    closer_thread.start()
    for thread in (pump_thread, closer_thread):
        thread.join(timeout=30)  # deadlock cap only; the green path is causal
        assert not thread.is_alive(), "a worker deadlocked on the private loop"
    assert unexpected == []
    assert len(outcomes) == 1 and outcomes[0].kind == "completed"
    assert len(refusals) == 1 and "cannot interrupt a pumping loop" in str(refusals[0])
    client.close()  # the verb settled; the same close now succeeds


# ---- its acceptance scenario: the running-loop refusal ---------------------------------


def test_a_sync_verb_from_inside_a_running_loop_is_refused_not_deadlocked() -> None:
    # The wrapper is built where it belongs (no loop); the REFUSAL is what
    # must fire when one of its verbs is then called from async code.
    host, client = scripted_client()
    session = client.start_session()
    turn = session.send_user_turn(
        SendUserTurnOptions(input=[{"text": "hi", "type": "text"}], composer_input="hi")
    )

    async def from_inside_a_loop() -> str:
        with pytest.raises(RuntimeError) as refused:
            turn.completed()
        return str(refused.value)

    message = asyncio.run(from_inside_a_loop())
    # The exact the governing rule error: it names the async facade as the repair.
    assert "running event loop" in message
    assert "MuseClient" in message

    # Refused BEFORE the private loop was touched: the same wait still works
    # from the synchronous script afterwards — never a deadlock.
    assert turn.completed().kind == "completed"
    client.close()


@pytest.mark.asyncio
async def test_spawn_from_inside_a_running_loop_is_refused_before_any_process() -> None:
    with pytest.raises(RuntimeError) as refused:
        SyncMuseClient.spawn(
            MuseClientSpawnOptions(
                muse_bin="/nonexistent/muse",
                client_info={"name": "sync-tests", "version": "0.0.0"},
            )
        )
    assert "running event loop" in str(refused.value)
    assert "MuseClient" in str(refused.value)


def test_verbs_on_a_closed_wrapper_are_refused_with_a_plain_error() -> None:
    host, client = scripted_client()
    session = client.start_session()
    client.close()
    # The guard's OWN words: bare "closed" also matches the raw "Event loop is
    # closed" crash the guard exists to prevent.
    with pytest.raises(RuntimeError, match="spawn or create a new one"):
        session.send_user_turn(
            SendUserTurnOptions(input=[{"text": "hi", "type": "text"}], composer_input="hi")
        )


# ---- the real-host blocking spawn/close path --------------------------------


def test_sync_spawn_initialize_and_close_against_the_fixture_host(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    binary = fixture_host_bin()
    if binary is None:
        pytest.skip("no muse-conformance fixture host available (Rust build)")
    scenario = "handshake-usershell-granted"
    transcript = load_transcript(CORPUS / scenario)
    init = next(
        frame for frame in transcript.client_frames if frame.get("method") == "initialize"
    )
    recorded = next(
        frame
        for frame in transcript.server_frames
        if isinstance(frame.get("result"), dict) and "schema" in frame["result"]
    )
    monkeypatch.setattr(
        muse_code,
        "EXPECTED_SCHEMA_FINGERPRINT",
        str(recorded["result"]["schema"]["fingerprint"]),
    )

    client: "SyncMuseClient[str]" = SyncMuseClient.spawn(
        MuseClientSpawnOptions(
            muse_bin=binary,
            client_info=dict(init["params"]["clientInfo"]),
            # The RECORDED capability request too: serve-fixture matches our
            # initialize frame against the recorded one (identity excepted),
            # so an omitted `capabilities` is a frameDivergence exit, which
            # this arm then reads as an EOF mid-handshake.
            capabilities=dict(init["params"]["capabilities"]),
            args=["serve-fixture", "--transcript", str(CORPUS / scenario)],
        )
    )
    granted = client.initialize_result.get("grantedCapabilities")
    assert granted == ["userShell"]
    client.close()
