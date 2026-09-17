"""``TurnHandle`` — one turn's view of the fold. Port of the TypeScript SDK's
turn-handle module.

A handle owns two things: the turn-wait, and the async iterators that
ride the fold for this turn. It authors no wire traffic and holds no durable
state — :class:`~muse_code.facade.session.Session` feeds it folded events and
it fans them out.

One rule governs the wait: the SDK never locally times out, fails, or completes
a turn. Every settlement below traces to a server-authored fact, with one
sanctioned exception that is not a terminal at all — terminal-unknown after an
ephemeral host death, which the protocol makes a client MUST ("stop waiting for
a terminal") and which stays an annotation rather than a synthesized event.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import (
    AsyncIterator,
    Awaitable,
    Callable,
    Generic,
    List,
    Literal,
    Protocol,
    Set,
    TypeVar,
    Union,
    runtime_checkable,
)

from muse_code_msp import (
    TURN_ERROR_KIND_KNOWN_VALUES,
    TURN_TERMINAL_KNOWN_VALUES,
    Item,
    ItemDeltaParams,
    TurnCompletedParams,
    TurnUnqueuedParams,
)

_T = TypeVar("_T")

FoldedItem = Item
"""What the iterators yield: the fold's stored item.

The TS twin seals this with ``DeepReadonly<Item>`` so a consumer cannot write
``item["revision"] = 0`` through the read surface. Python has no structural
readonly; the fold's own read views already refuse mutation, and the items
yielded here are the same generated dicts the fold holds (INV-638-02).
"""

# Read from the generated KNOWN_VALUES so a typo is caught by the codegen
# contract rather than compiling green against an open ``str`` enum — the
# runtime twin of the TS closed-vocabulary ``Extract<…>`` bind.
_TERMINAL_FAILED = "failed"
_LAUNCH_ERROR = "launchError"
assert _TERMINAL_FAILED in TURN_TERMINAL_KNOWN_VALUES
assert _LAUNCH_ERROR in TURN_ERROR_KIND_KNOWN_VALUES


@dataclass(frozen=True)
class _Completed:
    """The ordinary terminal, AND the launch-failure exit.

    ``deferred_start_failed`` is terminal ``failed``, ``error.kind:
    launchError``, no preceding ``turn/started`` — :func:`is_launch_failure`
    reads that WIRE marker; ``observed_start`` does not discriminate them,
    because a terminal-first fold is legitimate for turns that really ran.
    """

    params: TurnCompletedParams
    observed_start: bool
    kind: Literal["completed"] = "completed"


@dataclass(frozen=True)
class _Unqueued:
    """The reclaim (SS3.6). No ``turn/completed`` will ever carry this
    ``turnId``, so a wait folding only ``turn/completed`` hangs forever."""

    params: TurnUnqueuedParams
    kind: Literal["unqueued"] = "unqueued"


@dataclass(frozen=True)
class _TerminalUnknown:
    """SS2.13.3b: an ephemeral host died, so the client stops waiting.

    Carries no ``reason``: the arm has exactly one cause, so a single-valued
    field would add nothing ``kind`` does not already say.
    """

    kind: Literal["terminalUnknown"] = "terminalUnknown"


TurnOutcome = Union[_Completed, _Unqueued, _TerminalUnknown]
"""How a turn ended, from a waiter's point of view (SS3.1.4's two resolutions,
plus the ephemeral-death annotation). ``turn/retracted`` and
``turn/retryScheduled`` are deliberately absent: a retracted turn still
reaches its own terminal, and a scheduled retry is explicitly non-terminal
(SS4.5.1)."""


def is_launch_failure(outcome: TurnOutcome) -> bool:
    """The ``deferred_start_failed`` exit (SS3.1.4/SS3.2).

    A pre-minted turn whose launch errored at the terminal boundary, so the
    runtime wrote its terminal directly and no ``turn/started`` was ever
    emitted BY THE HOST. Read off the wire, never off local observation: a
    client that had not been listening when the turn started is not looking at
    a launch failure.

    Args:
        outcome: The settled turn outcome.

    Returns:
        ``True`` iff the terminal is ``failed`` with ``error.kind ==
        launchError``.
    """
    if not isinstance(outcome, _Completed):
        return False
    if outcome.params.get("terminal") != _TERMINAL_FAILED:
        return False
    error = outcome.params.get("error")
    return isinstance(error, dict) and error.get("kind") == _LAUNCH_ERROR


class _PushStream(Generic[_T]):
    """A single-consumer push stream (async iterator).

    Buffers when nobody is awaiting and hands the buffer over before reporting
    an end or a failure, so a consumer never loses events it was already owed.
    """

    def __init__(self, on_finished: Callable[[], None]) -> None:
        self._buffer: List[_T] = []
        # FIFO, not a single slot: ``items()``/``deltas()`` hand out a plain
        # async iterator, so a consumer prefetching with two concurrent
        # ``__anext__`` calls is reasonable, and a single slot would leave the
        # first waiter never settled. A silently never-settling future is the
        # hang class this file exists to prevent.
        self._waiters: List[asyncio.Future[_T]] = []
        self._on_finished = on_finished
        self._ended = False
        self._failure: BaseException | None = None

    def push(self, value: _T) -> None:
        """Delivers one value (to the oldest waiter, else the buffer)."""
        if self._ended:
            return
        while self._waiters:
            waiter = self._waiters.pop(0)
            if not waiter.done():
                waiter.set_result(value)
                return
        self._buffer.append(value)

    def end(self) -> None:
        """Reports end-of-stream to every queued waiter, not just the oldest."""
        if self._ended:
            return
        self._ended = True
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_exception(StopAsyncIteration())
        self._waiters.clear()

    def fail(self, error: BaseException) -> None:
        """Reports a failure to every queued waiter."""
        if self._ended:
            return
        self._ended = True
        self._failure = error
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_exception(error)
        self._waiters.clear()

    def __aiter__(self) -> AsyncIterator[_T]:
        return self

    async def __anext__(self) -> _T:
        # Buffered values come out first even after an end or a failure: the
        # consumer was already owed them, and swallowing them here would be
        # the silent hole the iterators exist to prevent.
        if self._buffer:
            return self._buffer.pop(0)
        if self._failure is not None:
            raise self._failure
        if self._ended:
            raise StopAsyncIteration()
        waiter: asyncio.Future[_T] = asyncio.get_running_loop().create_future()
        self._waiters.append(waiter)
        return await waiter

    async def aclose(self) -> None:
        """Drop the backlog and deregister this stream.

        The TS twin deregisters on ``for await ... break`` via the iterator's
        ``return()``. Python's ``async for ... break`` does NOT call ``aclose``
        on a manual async iterator, so a consumer that wants deterministic
        deregistration wraps the iterator in ``contextlib.aclosing(...)`` (the
        Python idiom) — this is the method it drives. Without it a dropped
        iterator is reclaimed only when the turn settles (``end``/``fail``
        clears every stream) or on GC; either way the fan-out never yields to a
        stream nobody reads, because ``end`` and ``fail`` clear the sets.
        """
        self._buffer.clear()
        self.end()
        self._on_finished()


ItemReplay = Callable[[], "tuple[FoldedItem, ...]"]
"""The turn's replayable backlog, supplied by ``Session`` from the fold."""


class TurnHandle:
    """One turn's SS7.1 surface, and the Session-fed mutators behind it.

    ``Session.turn()`` returns this typed as :class:`Turn` (the consumer view)
    so the ``settle_*``/``push_*``/``fail`` mutators are not public: an
    embedder calling ``settle_completed`` would fabricate a terminal the
    server never authored, which is exactly what INV-006 forbids. They stay
    reachable only through ``Session.apply``, i.e. only from a server-authored
    event.

    Attributes:
        turn_id: The wire turn id.
    """

    def __init__(self, turn_id: str, replay_items: ItemReplay) -> None:
        """Builds the handle; ``replay_items`` reads this turn's folded items."""
        self.turn_id = turn_id
        self._replay_items = replay_items
        self._item_streams: Set[_PushStream[FoldedItem]] = set()
        self._delta_streams: Set[_PushStream[ItemDeltaParams]] = set()
        self._observed_start = False
        self._settled = False
        self._outcome: TurnOutcome | None = None
        # Retained so an iterator opened AFTER the failure reports it too:
        # without it a late ``items()`` would end cleanly, handing a partial
        # replay plus a tidy done — an unfinished turn rendered as finished,
        # the invented completion INV-006 forbids.
        self._failure: BaseException | None = None
        self._waiters: List[asyncio.Future[TurnOutcome]] = []

    @property
    def completed(self) -> Awaitable[TurnOutcome]:
        """Settles on ``turn/completed``, ``turn/unqueued``, or the ephemeral
        discard.

        Each access returns a fresh awaitable resolved from the handle's
        settled state (or a pending one that the next settlement resolves), so
        any number of callers may await it and a late awaiter still learns the
        outcome. It never settles on a local timeout (INV-006).
        """
        future: asyncio.Future[TurnOutcome] = asyncio.get_running_loop().create_future()
        if self._failure is not None:
            future.set_exception(self._failure)
        elif self._settled and self._outcome is not None:
            future.set_result(self._outcome)
        else:
            self._waiters.append(future)
        return future

    @property
    def live_stream_count(self) -> int:
        """How many iterators this handle is still fanning out to.

        Exposed so the deregistration contract is assertable: an iterator a
        consumer broke out of, or dropped, must leave this set rather than
        accumulate for the rest of the turn.
        """
        return len(self._item_streams) + len(self._delta_streams)

    @property
    def observed_start(self) -> bool:
        """Did a ``turn/started`` ever fold for this turn?

        A session-local observation, NOT a launch-failure marker — the fold
        accepts a terminal-first ``turn/completed`` for turns that really ran
        (single-shot turns, gap fills, mid-stream attach). Branch on
        :func:`is_launch_failure` for the launch failure.
        """
        return self._observed_start

    def items(self) -> AsyncIterator[FoldedItem]:
        """This turn's items: everything the fold already holds, at its
        current revision and in first-opened order, then the live tail — one
        yield per fold-observed revision CHANGE. A stale re-emission mutates
        nothing (INV-003) and yields nothing.

        The iterator ends when the turn settles; it never ends on a local
        timeout.
        """
        stream: _PushStream[FoldedItem] = _PushStream(
            lambda: self._item_streams.discard(stream)
        )
        for item in self._replay_items():
            stream.push(item)
        self._admit(stream, self._item_streams)
        return stream

    def deltas(self) -> AsyncIterator[ItemDeltaParams]:
        """This turn's ``item/delta`` frames, live only.

        Deliberately NOT replayed, and the asymmetry with :meth:`items` is a
        fact about the fold: the store holds each item at its latest revision
        plus the ACCUMULATED delta text per field path, never the delta event
        sequence. A consumer attaching mid-turn reads the accumulated value
        from the fold; there is no retained event list to replay, and
        inventing one would be a second copy of state INV-002 must defend.
        """
        stream: _PushStream[ItemDeltaParams] = _PushStream(
            lambda: self._delta_streams.discard(stream)
        )
        self._admit(stream, self._delta_streams)
        return stream

    def _admit(
        self, stream: _PushStream[_T], into: Set[_PushStream[_T]]
    ) -> None:
        # The failure branch comes FIRST: a turn that failed is not a turn that
        # ended. ``_PushStream`` drains the replay before reporting either, so
        # a late consumer still receives everything it was owed.
        if self._failure is not None:
            stream.fail(self._failure)
        elif self._settled:
            stream.end()
        else:
            into.add(stream)

    # ---- fed by Session -----------------------------------------------------

    def mark_started(self) -> None:
        """A ``turn/started`` folded for this turn."""
        self._observed_start = True

    def push_item(self, item: FoldedItem) -> None:
        """Fan one item out to every live ``items()`` iterator."""
        for stream in self._item_streams:
            stream.push(item)

    def push_delta(self, params: ItemDeltaParams) -> None:
        """Fan one delta out to every live ``deltas()`` iterator."""
        for stream in self._delta_streams:
            stream.push(params)

    def settle_completed(self, params: TurnCompletedParams) -> None:
        """Settle on a ``turn/completed`` terminal."""
        self._finish(_Completed(params=params, observed_start=self._observed_start))

    def settle_unqueued(self, params: TurnUnqueuedParams) -> None:
        """Settle on a ``turn/unqueued`` reclaim."""
        self._finish(_Unqueued(params=params))

    def settle_terminal_unknown(self) -> None:
        """SS2.13.3b: an ephemeral host died; stop waiting for a terminal."""
        self._finish(_TerminalUnknown())

    def fail(self, error: BaseException) -> None:
        """A DURABLE host died abnormally.

        The waiter gets no answer here — FM-001 puts the terminals on resume —
        so it is rejected rather than resolved: a resolution would be the
        invented terminal INV-006 forbids, and silence would be the SS3.1.4
        hang.
        """
        if self._settled:
            return
        self._settled = True
        self._failure = error
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_exception(error)
        self._waiters.clear()
        for item_stream in list(self._item_streams):
            item_stream.fail(error)
        for delta_stream in list(self._delta_streams):
            delta_stream.fail(error)
        self._item_streams.clear()
        self._delta_streams.clear()

    def _finish(self, outcome: TurnOutcome) -> None:
        # First settlement wins: a duplicate terminal is a losing racer's echo.
        if self._settled:
            return
        self._settled = True
        self._outcome = outcome
        for waiter in self._waiters:
            if not waiter.done():
                waiter.set_result(outcome)
        self._waiters.clear()
        for item_stream in list(self._item_streams):
            item_stream.end()
        for delta_stream in list(self._delta_streams):
            delta_stream.end()
        self._item_streams.clear()
        self._delta_streams.clear()


@runtime_checkable
class Turn(Protocol):
    """A turn, as a CONSUMER sees it — the SS7.1 turn surface and nothing else.

    ``Session.turn()`` and ``send_user_turn()`` advertise THIS rather than the
    concrete :class:`TurnHandle` so the "fed by Session" mutators
    (``settle_completed``, ``push_item``, ``fail``, …) are not part of the
    consumer contract: an embedder calling one would fabricate a terminal the
    server never authored (INV-006). Python cannot hide them at runtime the
    way the TS ``Turn`` interface does, so the seal is the return annotation
    plus this documented surface — the same convention the fold's read views
    use.
    """

    @property
    def turn_id(self) -> str:
        """The wire turn id."""
        ...

    @property
    def observed_start(self) -> bool:
        """Did THIS session observe a ``turn/started``? Not a launch marker."""
        ...

    @property
    def completed(self) -> Awaitable[TurnOutcome]:
        """The SS3.1.4 turn-wait; settles on a server-authored fact."""
        ...

    def items(self) -> AsyncIterator[FoldedItem]:
        """This turn's items: folded backlog, then the live tail."""
        ...

    def deltas(self) -> AsyncIterator[ItemDeltaParams]:
        """This turn's ``item/delta`` frames, live only."""
        ...
