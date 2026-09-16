"""The sync wrapper: a loop-runner over the asyncio facade (spec 638
FR-638-021 / T034, INV-638-07; Scenario 7).

All protocol machinery lives once, in the async facade. This surface owns a
PRIVATE event loop and delegates: every blocking verb runs its async twin to
completion on that loop, and the two turn iterators are the async iterators
pumped one element per call. It re-implements nothing — the wire frames, the
fold, and the typed errors are the async facade's own.

The one machine this module introduces is the sync boundary (spec 638 "The
close ladder and the sync boundary"): a verb called from a thread whose event
loop is RUNNING is refused with an exact error naming the async facade
(FM-638-4) — running the private loop there would nest loops or deadlock the
caller's. A second concurrent VERB from another thread serializes on the
private loop instead (Scenario 7 Edge Cases); ``close()`` is the one
exception — it refuses rather than queue behind a verb still pumping the
loop (FM-638-8), because the queue-behind can be unbounded and the shutdown
it carries is the only thing that would end it.

This is the plain-script surface. Jupyter/IPython cells already run inside an
event loop, so use :class:`~muse_code.facade.MuseClient` with top-level
``await`` there — this wrapper refuses from async contexts (FM-638-4), as do
long-lived programs already inside ``asyncio``.
"""

from __future__ import annotations

import asyncio
import threading
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Generic,
    Iterator,
    Literal,
    TypeVar,
)

from muse_code_msp import InitializeResult, ItemDeltaParams

from .connection.spawn import ExitClassification
from .facade.approval import ApprovalFailureHandler, ApprovalHandler
from .facade.client import (
    MuseClient,
    MuseClientSpawnOptions,
    ResumeSessionOptions,
    StartSessionOptions,
)
from .facade.gap_fill import GapFillFailureHandler
from .facade.host_death import SessionDurabilityProfile
from .facade.session import PendingCommandView, Session, SessionFoldView, SessionOpening
from .facade.turn_handle import FoldedItem, Turn, TurnOutcome
from .facade.turn_submit import SendUserTurnOptions
from .pending.pending_command_set import (
    PendingRetirement,
    ReplayAnswer,
    SnapshotJoinFacts,
)

_T = TypeVar("_T")
_I = TypeVar("_I")


def _refuse_running_loop() -> None:
    # FM-638-4: never a deadlock, never a nested-loop hack. Raised BEFORE the
    # private loop (or its lock) is touched, so the caller's own loop keeps
    # running — this also refuses a consumer HANDLER (which runs on the
    # private loop during a blocking verb) calling back into the sync surface,
    # which would otherwise deadlock on the runner's own lock.
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    raise RuntimeError(
        "a SyncMuseClient verb was called from inside a running event loop; "
        "this wrapper blocks its calling thread, so async code must use the "
        "async facade (muse_code.MuseClient / Session / Turn) instead"
    )


class _LoopRunner:
    """The wrapper's private loop plus the ONE lock every member that touches
    loop-owned state goes through.

    Two entry shapes, one mutual exclusion: :meth:`run` pumps the loop for a
    blocking verb, and :meth:`call` executes a SYNCHRONOUS delegate (stream
    registration, handle minting, SS4.13 retirement verbs) that reads or
    mutates structures the loop's own tasks also touch — unlocked, a thread
    calling ``turn.items()`` while another thread's verb is pumping the loop
    mutates the turn's stream set mid-iteration (PR #32315 review round 1).
    Both re-check ``closed`` UNDER the lock: ``close()`` flips it while
    holding the same lock, so a verb racing a close gets this class's own
    refusal, never "Event loop is closed" off a dead loop.
    """

    def __init__(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop
        self._lock = threading.Lock()
        self._closed = False

    def _refuse_closed(self) -> None:
        if self._closed:
            raise RuntimeError(
                "this SyncMuseClient is closed; spawn or create a new one"
            )

    def run(self, awaitable: Awaitable[_T]) -> _T:
        """Run one awaitable to completion on the private loop (blocking)."""
        try:
            _refuse_running_loop()
        except BaseException:
            # The refused verb's coroutine was already built; close it so the
            # refusal is not followed by a "never awaited" warning.
            if asyncio.iscoroutine(awaitable):
                awaitable.close()
            raise
        with self._lock:
            try:
                self._refuse_closed()
            except BaseException:
                if asyncio.iscoroutine(awaitable):
                    awaitable.close()
                raise
            return self._loop.run_until_complete(_shield_none(awaitable))

    def call(self, fn: Callable[[], _T]) -> _T:
        """Run one synchronous delegate under the loop's mutual exclusion."""
        _refuse_running_loop()
        with self._lock:
            self._refuse_closed()
            return fn()

    def close(self, shutdown: Callable[[], Awaitable[None]]) -> None:
        """Run ``shutdown`` on the loop, then retire it.

        The check-and-set and the whole teardown run under the one lock, so a
        close racing a SETTLING verb (or a second ``close()``) serializes and
        then no-ops or gets the refusal — never a dead loop. A close while
        another thread is PUMPING the loop in ANY verb — this method cannot
        tell a bounded ack wait from an unbounded ``wait_exit()`` — is
        REFUSED with an exact error instead of joining a possibly-unbounded
        wait: for the unbounded verbs the shutdown that would let the verb
        settle needs the loop this method cannot have until the verb settles
        (PR #32315 review rounds 2 and 5). The repair is to let the verb
        settle (or close from the thread that drives the verbs), then close.

        The teardown is a ``finally``: a shutdown that RAISES (a failing
        transport close on the ``create()`` path) still cancels the watcher
        tasks and closes the loop, so one fault cannot leak the loop and its
        pending tasks forever (Constitution XIII; PR #32315 review round 2) —
        the exception then propagates from an already-retired wrapper.
        """
        _refuse_running_loop()
        # NEVER commit to a blocking acquire (PR #32315 review round 3, P0):
        # `run()` takes the lock a few bytecodes before `run_until_complete`
        # marks the loop running, so a single is_running() read can see a
        # pre-pump holder as "between runs" and then block forever behind the
        # very verb this close's shutdown would settle. Re-check on every
        # bounded miss instead: a pre-pump holder is observed the moment it
        # pumps and refused; a SETTLING holder (or a closing peer — `_closed`
        # is set under the lock before its shutdown ever pumps, so a running
        # loop with `_closed` set is a bounded FR-638-017 shutdown, not a
        # stuck verb) is waited out and this close then no-ops.
        while not self._lock.acquire(timeout=0.05):
            if self._loop.is_running() and not self._closed:
                raise RuntimeError(
                    "close() was called while another thread is blocked in a "
                    "SyncMuseClient verb on this client's private loop; let "
                    "that verb settle first (or close from the thread that "
                    "drives the verbs) — close() cannot interrupt a pumping "
                    "loop"
                )
        try:
            if self._closed:
                return
            self._closed = True
            try:
                self._loop.run_until_complete(_shield_none(shutdown()))
            finally:
                # Cancel the client's own watcher tasks and let the
                # cancellations settle, so a closed wrapper leaks no pending
                # task onto a dead loop — shutdown failure included.
                pending = asyncio.all_tasks(self._loop)
                for task in pending:
                    task.cancel()
                if pending:
                    self._loop.run_until_complete(
                        asyncio.gather(*pending, return_exceptions=True)
                    )
                self._loop.close()
        finally:
            self._lock.release()


class SyncMuseClient(Generic[_I]):
    """The blocking twin of :class:`~muse_code.facade.MuseClient` for plain
    scripts (FR-638-021); async contexts — Jupyter cells included, since a
    cell already runs inside a live loop — use ``MuseClient`` directly
    (FM-638-4).

    Get one from :meth:`spawn` (an owned host) or :meth:`create` (a client you
    compose yourself); every verb then blocks the calling thread while the
    private loop runs the async facade. Call :meth:`close` to shut the host
    down and release the loop.
    """

    def __init__(self, client: MuseClient[_I], loop: asyncio.AbstractEventLoop) -> None:
        """Wraps an async client that ALREADY lives on ``loop``.

        Consumers use :meth:`spawn` or :meth:`create`; this constructor exists
        for them (the async client must be constructed INSIDE the private
        loop, which only those factories can arrange).
        """
        self._client = client
        self._runner = _LoopRunner(loop)

    # ---- construction --------------------------------------------------------

    @staticmethod
    def spawn(options: MuseClientSpawnOptions) -> "SyncMuseClient[Any]":
        """Spawn an owned host and hand back a blocking client — the sync twin
        of :meth:`MuseClient.spawn`.

        Args:
            options: The host binary and handshake identity, unchanged.

        Returns:
            A wired blocking client, its connection already initialized.
        """
        _refuse_running_loop()
        loop = asyncio.new_event_loop()
        try:
            client = loop.run_until_complete(MuseClient.spawn(options))
        except BaseException:
            loop.close()
            raise
        return SyncMuseClient(client, loop)

    @staticmethod
    def create(
        factory: Callable[[], Awaitable[MuseClient[_I]]],
    ) -> "SyncMuseClient[_I]":
        """Build a blocking client around an async client you compose yourself
        — the sync twin of the :class:`MuseClient` constructor.

        A factory rather than a ready client, necessarily: ``MuseClient`` (and
        the ``Connection`` under it) must be constructed inside a running
        event loop, and the whole point of this wrapper is that the caller has
        none — so the construction runs on the wrapper's private loop.

        Args:
            factory: Builds the async client; awaited on the private loop.

        Returns:
            The wrapped blocking client.
        """
        _refuse_running_loop()
        loop = asyncio.new_event_loop()
        try:
            client = loop.run_until_complete(factory())
        except BaseException:
            loop.close()
            raise
        return SyncMuseClient(client, loop)

    # ---- blocking client verbs ------------------------------------------------

    @property
    def initialize_result(self) -> InitializeResult:
        """The handshake result, when built by :meth:`spawn` (no loop needed)."""
        return self._client.initialize_result

    @property
    def durability(self) -> SessionDurabilityProfile:
        """The durability profile every session this client opens inherits."""
        return self._client.durability

    def start_session(
        self, options: StartSessionOptions | None = None
    ) -> "SyncSession[_I]":
        """Open a new root session (blocking twin of ``start_session``)."""
        return SyncSession(
            self._runner.run(self._client.start_session(options)), self._runner
        )

    def resume_session(self, options: ResumeSessionOptions) -> "SyncSession[_I]":
        """Load an existing session (blocking twin of ``resume_session``)."""
        return SyncSession(
            self._runner.run(self._client.resume_session(options)), self._runner
        )

    def wait_exit(self) -> ExitClassification:
        """Block until the owned host exits; its SS2.11 row (twin of ``exit``)."""

        async def wait() -> ExitClassification:
            # The awaitable PROPERTY is read inside the loop: accessing it may
            # mint a loop-bound future, which has no loop out here.
            return await self._client.exit

        return self._runner.run(wait())

    def close(self) -> None:
        """Shut the host down (SS2.1.2), then retire the private loop.

        Idempotent. A close racing a SETTLING verb serializes behind it; a
        close while another thread is still PUMPING the loop in ANY verb is
        refused with an exact error — let that verb settle (or close from the
        thread that drives the verbs) first (FM-638-8; see
        ``_LoopRunner.close``).
        """
        self._runner.close(self._client.close)


async def _shield_none(awaitable: Awaitable[_T]) -> _T:
    # ``run_until_complete`` wants a coroutine or future; the facade's
    # awaitable PROPERTIES (``exit``, ``completed``) are neither, so every
    # verb rides through this adapter.
    return await awaitable


class SyncSession(Generic[_I]):
    """One conversation, on the blocking surface — the sync twin of
    :class:`~muse_code.facade.Session`.

    The read views (``fold``, ``pending``) are the async session's own
    objects: they are plain synchronous reads already, and a wrapped copy
    would be a second surface to keep honest. The handler registrations
    (``on_approval`` …) delegate unchanged — the handlers run on the private
    loop while a blocking verb is pumping it. The synchronous MUTATORS
    (``turn``, ``stop_retrying``, ``replay_answered``) route through the
    runner's lock: they touch structures the loop's own tasks touch, and an
    unlocked ``turn()`` racing a pumping verb can double-mint a handle.
    """

    def __init__(self, session: Session[_I], runner: _LoopRunner) -> None:
        """Wraps ``session``; ``runner`` is the owning client's loop-runner."""
        self._session = session
        self._runner = runner

    @property
    def session_id(self) -> str:
        """The server-named session id."""
        return self._session.session_id

    @property
    def opening(self) -> SessionOpening | None:
        """Which verb opened this session, and what it answered."""
        return self._session.opening

    @property
    def durability(self) -> SessionDurabilityProfile:
        """The profile this session discharges a host death under."""
        return self._session.durability

    @property
    def fold(self) -> SessionFoldView:
        """The fold's read view (the async session's own object).

        NOT serialized against another thread's verb: the loop thread mutates
        these structures whenever a verb pumps, so read them from the thread
        driving the verbs, or after that verb returns — a concurrent reader
        can see a mid-fold mutation (PR #32315 review round 5).
        """
        return self._session.fold

    @property
    def pending(self) -> PendingCommandView[_I]:
        """The SS4.13 set's read/safe-drive view; same threading caveat as
        :attr:`fold` — read from the verb-driving thread."""
        return self._session.pending

    def send_user_turn(self, options: SendUserTurnOptions[_I]) -> "SyncTurn":
        """Submit a user turn and block for its ack (twin of
        ``send_user_turn``)."""
        return SyncTurn(
            self._runner.run(self._session.send_user_turn(options)), self._runner
        )

    def turn(self, turn_id: str) -> "SyncTurn":
        """The handle for a turn, created on first mention from either side."""
        return SyncTurn(
            self._runner.call(lambda: self._session.turn(turn_id)), self._runner
        )

    def on_approval(self, handler: ApprovalHandler) -> None:
        """Answer approvals with ``handler`` (FR-638-019b), unchanged."""
        self._session.on_approval(handler)

    def on_approval_error(self, handler: ApprovalFailureHandler) -> None:
        """Observe approval round trips that did not complete."""
        self._session.on_approval_error(handler)

    def on_gap_error(self, handler: GapFillFailureHandler) -> None:
        """Observe SS4.8 fills that did not complete."""
        self._session.on_gap_error(handler)

    def stop_retrying(self, command_id: str) -> PendingRetirement[_I] | None:
        """SS4.13 "Abandoned": stop one entry's retry loop (sync, locked)."""
        return self._runner.call(lambda: self._session.stop_retrying(command_id))

    def replay_answered(
        self, command_id: str, answer: ReplayAnswer[_I]
    ) -> PendingRetirement[_I] | Literal["held"]:
        """Feed a consumer-driven replay's answer through the SS4.13 rules."""
        return self._runner.call(
            lambda: self._session.replay_answered(command_id, answer)
        )

    def resolve_snapshot_join(
        self, facts: SnapshotJoinFacts
    ) -> tuple[PendingRetirement[_I], ...]:
        """Blocking twin of ``resolve_snapshot_join``."""
        return self._runner.run(self._session.resolve_snapshot_join(facts))

    def resolve_reconnect(self) -> tuple[PendingRetirement[_I], ...]:
        """Blocking twin of ``resolve_reconnect``."""
        return self._runner.run(self._session.resolve_reconnect())


class SyncTurn:
    """One turn, on the blocking surface — the sync twin of
    :class:`~muse_code.facade.Turn`."""

    def __init__(self, turn: Turn, runner: _LoopRunner) -> None:
        """Wraps the async turn view; ``runner`` is the owning loop-runner."""
        self._turn = turn
        self._runner = runner

    @property
    def turn_id(self) -> str:
        """The wire turn id."""
        return self._turn.turn_id

    @property
    def observed_start(self) -> bool:
        """Did THIS session observe a ``turn/started``? Not a launch marker."""
        return self._turn.observed_start

    def completed(self) -> TurnOutcome:
        """Block for the SS3.1.4 turn-wait; settles on a server-authored fact
        (a method where the async twin is an awaitable property — a blocking
        property read would hide an unbounded wait behind attribute access).
        """

        async def wait() -> TurnOutcome:
            # Read inside the loop: the property mints a loop-bound future.
            return await self._turn.completed

        return self._runner.run(wait())

    def items(self) -> Iterator[FoldedItem]:
        """This turn's items, iterated synchronously: the folded backlog, then
        the live tail, ending when the turn settles.

        Once iteration has STARTED, breaking out (or closing the generator)
        releases the underlying stream — the sync twin of the async surface's
        ``aclosing`` deregistration. A never-advanced iterator holds its
        registration (Python runs no ``finally`` in a generator that never
        started) and is reclaimed when the turn settles — the same bound the
        async surface has for a dropped, never-read stream. Registration stays
        AT CALL TIME so the replay snapshot point matches the async twin
        (PR #32315 review round 2)."""
        return self._drain(self._runner.call(self._turn.items))

    def deltas(self) -> Iterator[ItemDeltaParams]:
        """This turn's ``item/delta`` frames, live only, iterated
        synchronously; released on break/close (and bounded on a never-started
        iterator) exactly like :meth:`items`."""
        return self._drain(self._runner.call(self._turn.deltas))

    def _drain(self, source: AsyncIterator[_T]) -> Iterator[_T]:
        # A plain generator: `for … break` (or an explicit .close()) runs the
        # finally and deregisters the stream, so a consumer that stops early
        # does not leave the fan-out buffering into a stream nobody reads —
        # the sync twin of `contextlib.aclosing` (PR #32315 review round 1).
        try:
            while True:
                try:
                    yield self._runner.run(source.__anext__())
                except StopAsyncIteration:
                    return
        finally:
            aclose = getattr(source, "aclose", None)
            if callable(aclose):
                try:
                    self._runner.run(aclose())
                except RuntimeError:
                    # A closed wrapper (or a close racing this release) has
                    # already torn every stream down with the loop; there is
                    # nothing left to deregister.
                    pass
