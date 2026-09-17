"""Gap recovery by splice-fill. Port of the TypeScript SDK's gap-fill module.

Split out of ``session.py`` for the same reason ``approval.py`` and
``turn_submit.py`` were: this is a delivery-plane concern with its own buffer,
page walk, and failure vocabulary, and ``Session`` was already the package's
largest module.

THE RECIPE, verbatim from the protocol's gap-recovery rule and unchanged
here: buffer live events at cursors at or after ``next`` as they arrive;
page forward from ``after`` with ``view/page`` until the walk reaches
``next``; discard the paged events the buffer already holds; splice the
buffer after the paged prefix. The protocol's second sanctioned path (drop
state and re-anchor at the latest compaction snapshot) is NOT built here —
building both would be a second concrete path for one current use.

CURSORS STAY OPAQUE. Nothing below orders two cursors: "at or
after ``next``" is delivery ORDER, not a comparison — every live frame that
arrives after the gap marker is, by the server's own delivery contract, at or
after ``next``. The walk stops on cursor EQUALITY with the target or on the
server's own end-of-view, and the overlap is discarded by set membership.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import (
    Any,
    Awaitable,
    Callable,
    Generator,
    Generic,
    List,
    Mapping,
    TypeVar,
)

from muse_code_msp import ViewPageParams

from ..connection.connection import Connection
from ..errors import GapFillFailureReason, MuseForeignSessionError, MuseGapFillError
from ..fold.session_fold import SessionFold
from ..pending.pending_command_set import PendingRetirement

_I = TypeVar("_I")

PAGE_LIMIT = 200
"""How many events one ``view/page`` asks for.

Any value in the published 1–1000 bound (``ViewPageParams.limit``) is correct
— the server MAY serve fewer and the walk follows ``nextCursor`` either way —
so this trades round trips against frame size and is deliberately not a knob:
a per-session page size would be a public option with no current consumer
asking for one (Constitution XI).
"""

WireFrame = Mapping[str, Any]
"""One wire frame, exactly as ``Session.apply`` accepts it (``method`` +
``params``)."""


@dataclass
class DrainSink(Generic[_I]):
    """Where a drained frame's side effects go.

    The filler re-feeds frames through ``Session``'s own fold-and-route path,
    so the retirements and the client→server I/O they trigger belong to
    ``Session``, not here.
    """

    retirements: List[PendingRetirement[_I]]
    tasks: List[Awaitable[tuple[PendingRetirement[_I], ...]]]


class ResolvedIo(Generic[_I]):
    """An already-settled ``io`` that needs no event loop.

    ``Session.apply`` runs synchronously and is called off a fold with no host
    at all (every fold-only arm in this package), so the
    overwhelming-majority no-I/O case must not require a running loop to build
    its ``io`` — and a bare coroutine would warn "never awaited" for the
    consumers (most of them) that do not await it. This awaitable can be
    awaited any number of times or never, allocates nothing on the loop, and
    always yields its held tuple.
    """

    __slots__ = ("_value",)

    def __init__(self, value: tuple[PendingRetirement[_I], ...]) -> None:
        self._value = value

    def __await__(
        self,
    ) -> Generator[Any, None, tuple[PendingRetirement[_I], ...]]:
        return self._value
        yield  # pragma: no cover - unreachable; marks this a generator


GapFillFailureHandler = Callable[[MuseGapFillError], None]
"""Reported, never raised — see :class:`~muse_code.errors.MuseGapFillError`."""


@dataclass
class GapFillerOptions(Generic[_I]):
    """What the filler composes over.

    Attributes:
        session_id: The owning session's id, named in every ``view/page``.
        connection: Absent on a fold-only ``Session``: nothing to page through.
        fold: The fold whose ``pending_gap``/``gap_filled`` the walk drives.
        apply: Fold and route ONE frame, collecting what it produced.
        discarded: SS2.13.3b — a discharged session folds nothing, fill or no
            fill.
    """

    session_id: str
    connection: Connection | None
    fold: SessionFold
    apply: Callable[[WireFrame, DrainSink[_I]], object]
    discarded: Callable[[], bool]


class GapFiller(Generic[_I]):
    """Drives the SS4.8 splice-fill for one session (spec 638 FR-638-019c)."""

    def __init__(self, options: GapFillerOptions[_I]) -> None:
        """Builds the filler over its session's seams."""
        self._options = options
        # Live frames held while a fill is in flight, in arrival order.
        self._buffer: List[WireFrame] = []
        self._filling = False
        self._cursor = ""
        self._on_failure: GapFillFailureHandler | None = None
        # Cursors the page served at or after a target — the events whose LIVE
        # twin the wire has yet to deliver.
        #
        # THE LATE HALF of the recipe's overlap discard, and only that half. A
        # twin that has already arrived is in the buffer, and ``_drain``
        # discards those against its own local set of EVERY paged cursor. This
        # set covers the other window: the wire promises no order between the
        # marker and the frame at ``next``, so a twin can legally arrive after
        # the fill completed, when the buffer is gone. Folding it then re-runs
        # its routing — for a ``turn/started``, a duplicate SS4.13
        # queue-movement replay on the wire.
        #
        # SELF-DRAINING: an entry is removed the moment its twin arrives, and
        # only cursors at or after a target ever enter (the walk stops at the
        # page that carries it, so at most one page's worth per target).
        #
        # RESIDUAL, stated rather than hidden: an entry whose twin the wire
        # never delivers — because a LATER hole swallowed it — has no arrival
        # to retire it and stays, a short string each, bounded by one page's
        # worth per TARGET.
        #
        # Two prunes were tried on the TS twin and both were defects (PR
        # #24930 review rounds 2–4), so neither is here: clearing per fill
        # drops the refusal for a twin still on its way, and retiring inside
        # the WALK when it meets the cursor before its own target deletes a
        # buffered twin's only refusal (the walk cannot see the buffer).
        # Deciding staleness any other way means ordering two opaque cursors,
        # which tdd SS4.1 forbids.
        self._served_twins: set[str] = set()

    @property
    def filling(self) -> bool:
        """While ``True``, every live frame but the gap marker itself is held."""
        return self._filling

    def claim_served_twin(self, frame: WireFrame) -> str | None:
        """Was this frame already applied from a page, as part of the overlap
        the splice discards? Consuming: a twin is refused exactly once.

        Returns the matched CURSOR rather than a boolean so the caller can
        report which event it refused without re-reading (and re-defaulting) a
        field this method already proved is there.
        """
        cursor = _view_cursor_of(frame)
        if cursor is None or cursor not in self._served_twins:
            return None
        self._served_twins.discard(cursor)
        return cursor

    def on_error(self, handler: GapFillFailureHandler) -> None:
        """Observe fills that did not complete. See :class:`MuseGapFillError`."""
        self._on_failure = handler

    def hold(self, frame: WireFrame) -> None:
        """Hold one live frame until the paged prefix is in."""
        self._buffer.append(frame)

    def start(self) -> Awaitable[tuple[PendingRetirement[_I], ...]] | None:
        """Recover the fold's outstanding hole.

        Called on every ``view/gap``, including one that lands mid-fill: the
        running walk reads its target from ``fold.pending_gap`` on each pass,
        so a coalesced hole extends the walk in flight rather than starting a
        second one racing it for the same cursor stream.

        Returns ``None`` when this call starts no walk — nothing outstanding,
        a walk already in flight, or a fold-only session (whose
        ``noConnection`` failure is reported synchronously before returning).
        ``None`` rather than an already-settled awaitable, deliberately: the
        caller feeds the return into the ``io`` channel, and an entry there
        forces ``_settled_io`` onto its gather arm, which needs a running
        loop a fold-only ``apply`` may not have (PR #32249 review round 1 —
        the same shape as ``ApprovalRouter.requested``).
        """
        gap = self._options.fold.pending_gap
        # Only reachable if a caller invokes this with nothing outstanding; the
        # one production caller folds the marker first, which always sets it.
        if gap is None:
            return None
        if self._filling:
            return None
        connection = self._options.connection
        if connection is None:
            # Nothing is buffered on this path: no fill is coming to release
            # it, and holding the live tail forever would turn one reported
            # hole into a silent second one.
            self._report(MuseGapFillError("noConnection", gap["after"], gap["next"]))
            return None
        self._filling = True
        self._cursor = gap["after"]
        return asyncio.ensure_future(self._run(connection))

    async def _run(
        self, connection: Connection
    ) -> tuple[PendingRetirement[_I], ...]:
        paged: List[WireFrame] = []
        try:
            await self._walk(connection, paged)
        except Exception as error:  # noqa: BLE001 - reported, never escapes
            self._report_failure(error)
        # ALWAYS drained, success or failure: the buffered tail is made of
        # events this client really did receive, and swallowing them would add
        # a second hole to the one just reported.
        #
        # The TS twin re-checks ``pendingGap`` after this and restarts a walk
        # (its "clear window": TS ``#drain`` lowers the flag a microtask after
        # ``#walk`` cleared the hole, and a ``view/gap`` folding in between
        # would strand). That window CANNOT exist here: the walk's final
        # ``gap_filled`` and this ``_drain`` — which lowers ``_filling`` — run
        # in one synchronous task step with no await between them, so no frame
        # can fold inside it, and a ``view/gap`` arriving after this task step
        # finds ``_filling`` already false and starts its own walk from
        # ``apply``. A Python restart block would be unreachable defense
        # (PR #32249 review round 1 proved it dead by mutation).
        return await self._drain(paged)

    async def _walk(self, connection: Connection, paged: List[WireFrame]) -> None:
        """Page until the fold's outstanding hole is closed.

        The outer loop is what makes a mid-walk ``view/gap`` safe:
        ``gap_filled`` refuses to clear a target the fold has since extended,
        so the walk simply keeps going toward the newer ``next`` on the SAME
        cursor stream.
        """
        while True:
            # A session discharged mid-walk stops here, BEFORE ``gap_filled``:
            # there is nothing left to be current with, and clearing the hole
            # would have the fold report a discarded transcript complete. The
            # host is gone, so a further page would also wait on an answer
            # that is never coming — which is a hang, not a fill.
            if self._options.discarded():
                return
            gap = self._options.fold.pending_gap
            if gap is None:
                return
            target = gap["next"]
            await self._walk_to(connection, target, gap["after"], paged)
            if self._options.discarded():
                return
            if self._options.fold.gap_filled(target):
                return

    async def _walk_to(
        self,
        connection: Connection,
        target: str,
        after: str,
        paged: List[WireFrame],
    ) -> None:
        while True:
            if self._options.discarded():
                return
            result = await self._page(connection, self._cursor)
            reached = False
            events = result["events"]
            for event in events:
                self._require_own_session(event, after, target)
                cursor = str(event["params"]["viewCursor"])
                # An EARLIER fill already served — and applied — this durable
                # event. A later walk may legally page through the same range,
                # and re-applying it here is the same double fold the discard
                # exists to prevent.
                already_applied = cursor in self._served_twins
                # Equality, never a relational compare: ``next`` is a cursor,
                # and cursors are opaque (tdd SS4.1). Set BEFORE the skip
                # below, or a target the walk skips is a target the walk never
                # reaches, and it pages straight past its own stopping point.
                if cursor == target:
                    reached = True
                if already_applied:
                    # SKIPPED AND NOTHING ELSE. Retiring the entry here when
                    # the walk meets it before its own target deletes a
                    # buffered twin's only refusal — the walk cannot see the
                    # buffer, and a coalescing gap moves the target past a
                    # cursor whose twin is sitting in it.
                    continue
                paged.append(event)
                # At or after ``next`` — by page ORDER, not by comparing two
                # cursors. These are the events the live tail also delivers,
                # so their twins are the overlap the splice discards.
                if reached:
                    self._served_twins.add(cursor)
            # The server's own end of the view. ``next`` names a LIVE cursor
            # and ``view/page`` serves durable-sourced events only (tdd
            # SS4.7.3), so a hole whose tail was ephemeral ends here and never
            # at ``target``. An ABSENT ``nextCursor`` is a different fact — the
            # member is "never omitted", so it falls through to the stall arm.
            if "nextCursor" in result and result["nextCursor"] is None:
                return
            next_cursor = result.get("nextCursor")
            # PROGRESS is the only bound on this walk, and it has to be,
            # because a legitimate fill is unbounded in length: an attempt cap
            # would silently truncate one. A page that carries no event,
            # repeats the cursor it was given, or answers with no cursor at
            # all has not advanced, and paging again would ask the identical
            # question forever.
            if (
                len(events) == 0
                or not isinstance(next_cursor, str)
                or next_cursor == self._cursor
            ):
                raise MuseGapFillError("pageStalled", after, target)
            self._cursor = next_cursor
            if reached:
                return

    async def _page(
        self, connection: Connection, cursor: str
    ) -> Mapping[str, Any]:
        params: ViewPageParams = {
            "cursor": cursor,
            "limit": PAGE_LIMIT,
            "sessionId": self._options.session_id,
        }
        return await connection.request("view/page", dict(params))

    def _require_own_session(
        self, event: Mapping[str, Any], after: str, target: str
    ) -> None:
        """A page that serves another session's events aborts the fill.

        The same check ``Session.apply`` makes on a live frame, at the one
        other place a frame can enter the fold. Folding it would corrupt this
        transcript with another session's history, and the request that asked
        for it named this ``sessionId``, so there is no reading under which
        the answer is right.
        """
        params = event.get("params")
        named = params.get("sessionId") if isinstance(params, dict) else None
        if isinstance(named, str) and named != self._options.session_id:
            raise MuseGapFillError(
                "pageFailed",
                after,
                target,
                MuseForeignSessionError(
                    f"view/page for {self._options.session_id} served an event "
                    f"for session {named}"
                ),
            )

    def _drain(
        self, paged: List[WireFrame]
    ) -> Awaitable[tuple[PendingRetirement[_I], ...]]:
        """Splice: the paged prefix, then the buffered tail minus the overlap.

        Synchronous up to its return, deliberately. Clearing the buffer and
        the flag in the same run of code that re-feeds them is what makes the
        handover atomic — an await in the middle would let a live frame arrive
        after the flag dropped and fold ahead of the tail still waiting in the
        buffer.

        It is outside the walk's ``try`` because the buffered tail must be
        released on FAILURE too, and it needs no ``try`` of its own: every
        frame it re-feeds has already passed the one check ``Session.apply``
        can raise on — the live half at buffer time, the paged half in the
        walk — so this cannot be the rejection ``SessionApplyOutcome.io``
        promises never to be.
        """
        buffered = list(self._buffer)
        self._buffer.clear()
        self._filling = False
        # SS2.13.3b outranks the fill: a session discharged while the walk was
        # in flight folds nothing more, and neither half of the splice is
        # exempt.
        if self._options.discarded():
            return ResolvedIo(())
        sink: DrainSink[_I] = DrainSink(retirements=[], tasks=[])
        # EVERY paged cursor, not just the ones at or after a target. A
        # coalesced gap restarts the walk toward the NEW target with
        # ``reached`` false, so paged events between the two targets never
        # enter ``_served_twins`` — yet their twins ARE in this buffer,
        # because a cursor at or after the first target was delivered live
        # before the second hole opened. Claiming on the persistent set alone
        # folded those twice.
        served: set[str] = set()
        for frame in paged:
            cursor = _view_cursor_of(frame)
            if cursor is not None:
                served.add(cursor)
            self._options.apply(frame, sink)
        for frame in buffered:
            # The overlap the recipe discards: the page already served this
            # cursor, so folding the buffered copy would route the same event
            # twice. BOTH sets: ``served`` is what THIS fill applied;
            # ``_served_twins`` carries what EARLIER fills served, including
            # the cursors this walk declined to re-apply — nothing deletes
            # those inside the walk, precisely so this branch can still find
            # them. A twin of either can be sitting in this buffer, because
            # ``Session.apply`` buffers every live frame while a fill runs,
            # before the late-window claim can see it, so this branch is the
            # only thing left to refuse it.
            cursor = _view_cursor_of(frame)
            if cursor is not None and (
                cursor in served or cursor in self._served_twins
            ):
                # Consume the persistent entry too, so a twin refused here is
                # not refused a second time if the wire also delivers it later.
                self._served_twins.discard(cursor)
                continue
            self._options.apply(frame, sink)
        if not sink.tasks:
            return ResolvedIo(tuple(sink.retirements))

        async def run() -> tuple[PendingRetirement[_I], ...]:
            batches = await asyncio.gather(*sink.tasks)
            out: List[PendingRetirement[_I]] = list(sink.retirements)
            for batch in batches:
                out.extend(batch)
            return tuple(out)

        return asyncio.ensure_future(run())

    def _report_failure(self, error: BaseException) -> None:
        if isinstance(error, MuseGapFillError):
            self._report(error)
            return
        # Anything the round trip itself raised — an ``MspError`` the host
        # authored, a ``ProtocolError``, a dead transport — is the same fact
        # from a consumer's point of view: the hole is still there. The cause
        # is carried rather than flattened so the repair stays diagnosable.
        gap = self._options.fold.pending_gap
        reason: GapFillFailureReason = "pageFailed"
        self._report(
            MuseGapFillError(
                reason,
                gap["after"] if gap is not None else "",
                gap["next"] if gap is not None else "",
                error,
            )
        )

    def _report(self, failure: MuseGapFillError) -> None:
        handler = self._on_failure
        if handler is None:
            return
        try:
            handler(failure)
        except Exception:  # noqa: BLE001, S110
            # The consumer's failure OBSERVER raised. Swallowed for the reason
            # ``ApprovalRouter._report`` states: this rides
            # ``SessionApplyOutcome.io``, whose contract is "IT NEVER
            # REJECTS", and most consumers never await it.
            pass


def _view_cursor_of(frame: WireFrame) -> str | None:
    params = frame.get("params")
    cursor = params.get("viewCursor") if isinstance(params, dict) else None
    return cursor if isinstance(cursor, str) else None
