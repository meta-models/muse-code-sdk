"""``Session`` — the facade's composition of the transport-less core. Port of
the session half of the TypeScript SDK's facade.

It owns a :class:`~muse_code.fold.SessionFold` and a
:class:`~muse_code.pending.PendingCommandSet`, routes folded view events to
per-turn handles, and discharges the ephemeral host-death obligation. Like
everything else in this SDK it holds no durable state: every fact
it reports came from a server event or from the two stores it composes.

The approval round trip lives in ``approval.py`` and the gap
splice-fill in ``gap_fill.py``; this layer composes
both because the round trips need client->server I/O and the buffer the fill
splices is the same routing path the iterators read.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import (
    Any,
    Awaitable,
    Generic,
    Iterable,
    List,
    Literal,
    Mapping,
    Protocol,
    TypeVar,
    Union,
    cast,
)

from muse_code_msp import (
    ITEM_KIND_KNOWN_VALUES,
    ApprovalRequestParams,
    Item,
    ItemDeltaParams,
    TurnCompletedParams,
    TurnUnqueuedParams,
)

from ..connection.connection import Connection
from ..fold.item_store import IgnoredStaleRevision
from ..fold.session_fold import (
    ApprovalPending,
    DeliveryGap,
    FoldItems,
    FoldOutcome,
    FoldSessionState,
    ItemFold,
    Params,
    PendingApproval,
    SessionFold,
    TurnEntry,
)
from ..pending.pending_command_set import (
    CommandErrorResponse,
    Held,
    PendingCommandAck,
    PendingCommandEntry,
    PendingCommandSet,
    PendingJoinPlan,
    PendingRetirement,
    ReplayAnswer,
    SnapshotJoinFacts,
)
from .approval import (
    ApprovalFailureHandler,
    ApprovalHandler,
    ApprovalRouter,
)
from .discarded import DiscardedSessions
from .gap_fill import (
    DrainSink,
    GapFillFailureHandler,
    GapFiller,
    GapFillerOptions,
    ResolvedIo,
    WireFrame,
)
from .host_death import (
    HostDeathDischarge,
    HostDeathNotification,
    MuseHostDiedError,
    SessionDurabilityProfile,
    _Discharged,
    _DurableDeath,
    _NotADeath,
    is_abnormal_host_death,
    is_item_in_progress,
    survives_host_death,
)
from .turn_handle import Turn, TurnHandle
from .turn_submit import SendUserTurnOptions, TurnSubmitter

_I = TypeVar("_I")

_USER_MESSAGE = "userMessage"
assert _USER_MESSAGE in ITEM_KIND_KNOWN_VALUES


class SessionFoldView(Protocol):
    """The fold as a consumer may READ it — the TS ``SessionFoldView`` allowlist.

    ``Session.fold`` returns the concrete :class:`SessionFold`, but this narrow
    type is what the consumer contract advertises: the fold's own mutators
    (``apply``, ``mark_ephemeral_host_death``, ``gap_filled``) are hazardous in
    a consumer's hands — ``apply`` would fold an event while skipping turn
    routing and the discard latch, and ``gap_filled`` would report a hole
    closed that nothing filled — so they stay off the read surface. The same
    seal ``turn()`` gets from the :class:`Turn` protocol.
    """

    @property
    def items(self) -> FoldItems:
        """Items, snapshot-only: the mutators are ``apply()``'s, not yours."""
        ...

    @property
    def session_state(self) -> FoldSessionState:
        """The session-state families, keyed by notification method name."""
        ...

    @property
    def active_turn_id(self) -> str | None:
        """The turn currently running, if one is."""
        ...

    @property
    def pending_gap(self) -> Mapping[str, str] | None:
        """The outstanding delivery hole, or ``None``."""
        ...

    @property
    def current(self) -> bool:
        """Is this fold current with the session view?"""
        ...

    def turns(self) -> list[TurnEntry]:
        """Turns in first-observed order."""
        ...

    def turn(self, turn_id: str) -> TurnEntry | None:
        """One turn's entry, or ``None`` if the fold never observed it."""
        ...

    def pending_approvals(self) -> list[PendingApproval]:
        """Approvals awaiting a durable terminal, in first-observed order."""
        ...

    def resolved_approvals(self) -> list[Params]:
        """The winning durable terminal per approval, in first-observed order."""
        ...

    def pending_user_inputs(self) -> list[Params]:
        """Prompts awaiting a durable settlement, in first-observed order."""
        ...

    def settled_user_inputs(self) -> list[Params]:
        """The winning durable settlement per prompt, in first-observed order."""
        ...


class PendingCommandView(Protocol[_I]):
    """The pending set as a consumer may READ and safely DRIVE — the TS
    ``PendingCommandView`` allowlist.

    ``Session.pending`` returns the concrete :class:`PendingCommandSet`, but
    this narrow type hides the three mutators ``Session`` drives itself
    (``discard_ephemeral``, ``observed_reclaim``, ``observed_user_message``)
    and the two re-exposed as ``Session`` methods (``stop_retrying``,
    ``replay_answered``): a consumer calling ``discard_ephemeral`` directly
    drains and latches the set so the later real ``host_exited`` reports empty
    retirements, and a bare ``stop_retrying``/``replay_answered`` skips
    ``TurnSubmitter.forget_retired`` and leaks the command's ``turn/start``
    params in replay memory. The rest (a fold-only consumer performing its own
    I/O) stays available.
    """

    @property
    def discarded(self) -> bool:
        """Whether the ephemeral discard has closed this set."""
        ...

    @property
    def size(self) -> int:
        """The number of pending entries."""
        ...

    def submitted(
        self,
        command_id: str,
        input: _I,
        *,
        display_text: str | None = ...,
        anchor_after_item_id: str | None = ...,
    ) -> None:
        """Records a submission."""
        ...

    def acked(self, command_id: str, ack: PendingCommandAck) -> None:
        """Records that the submit (or a replay) was acked."""
        ...

    def ack_errored(
        self, command_id: str, error: CommandErrorResponse
    ) -> PendingRetirement[_I] | Held:
        """The submit (or a replay) answered with an error."""
        ...

    def observed_queue_movement(self, turn_id: str) -> tuple[str, ...]:
        """Queue movement: a turn event for a turn that is NOT the entry's own."""
        ...

    def reconnected_without_snapshot(self) -> PendingJoinPlan[_I]:
        """Reconnect with NO snapshot (the default cursor-resume path)."""
        ...

    def join_snapshot(self, facts: SnapshotJoinFacts) -> PendingJoinPlan[_I]:
        """Joins local entries against an authoritative snapshot."""
        ...

    def resolve_replay_at_join(
        self,
        command_id: str,
        answer: ReplayAnswer[_I],
        snapshot_queued_command_ids: Iterable[str],
    ) -> PendingRetirement[_I] | Held:
        """Resolves a ``must_replay`` answer with the snapshot in hand."""
        ...

    def list(self) -> tuple[PendingCommandEntry[_I], ...]:
        """Entries in render order."""
        ...

    def get(self, command_id: str) -> PendingCommandEntry[_I] | None:
        """The entry snapshot for ``command_id``, or ``None``."""
        ...

    def has(self, command_id: str) -> bool:
        """Whether an entry with ``command_id`` is pending."""
        ...


@dataclass(frozen=True)
class _StartOpening:
    result: Mapping[str, Any]
    verb: Literal["session/start"] = "session/start"


@dataclass(frozen=True)
class _ResumeOpening:
    result: Mapping[str, Any]
    verb: Literal["session/resume"] = "session/resume"


SessionOpening = Union[_StartOpening, _ResumeOpening]
"""Which verb opened this session, and what it answered.

``MuseClient.start_session``/``resume_session`` resolve to a ``Session``, so
without this the typed wire result (``viewCursor``, the resume history, the
server's own ``sessionId``) would be swallowed by the wrapper. Discriminated by
the verb so a consumer that only handles resume cannot silently read a start
result's absent members.
"""


@dataclass(frozen=True)
class SessionApplyRefusal:
    """``Session.apply``'s own refusal.

    NOT a ``FoldOutcome``: the fold can never emit it, and putting it there
    would promise a direct ``SessionFold`` consumer a refusal that seam does
    not produce.
    """

    kind: Literal["refusedSessionDiscarded"] = "refusedSessionDiscarded"


@dataclass(frozen=True)
class SessionGapBuffered:
    """``Session.apply``'s other own verdict: a frame held while an SS4.8 fill
    is in flight (FR-638-019c / T032).

    NOT a ``FoldOutcome`` — the fold has not seen this frame yet and reporting
    one would state a fold move that has not happened. The frame is not lost:
    it is re-fed through this same path, in cursor order behind the paged
    prefix, when the fill splices. The pause a consumer sees is exactly this.

    Attributes:
        method: The held frame's notification method name.
        kind: The verdict discriminator, always ``"bufferedDuringGap"``.
    """

    method: str
    kind: Literal["bufferedDuringGap"] = "bufferedDuringGap"


@dataclass(frozen=True)
class SessionGapOverlap:
    """A live frame the SS4.8 fill already applied from a page — the other
    half of the recipe's overlap discard.

    The wire promises no order between a ``view/gap`` and the frame at its
    ``next``, so the live twin of an event the page served can arrive after
    the fill finished, when the buffer is gone. Refused once, by cursor
    equality, because folding it again would re-run its routing — a duplicate
    SS4.13 queue-movement replay on the wire, which is exactly what the
    discard exists to prevent.

    Attributes:
        method: The refused frame's notification method name.
        view_cursor: The cursor the page already applied this event at.
        kind: The verdict discriminator, always ``"ignoredGapOverlap"``.
    """

    method: str
    view_cursor: str
    kind: Literal["ignoredGapOverlap"] = "ignoredGapOverlap"


@dataclass(frozen=True)
class SessionApplyOutcome(Generic[_I]):
    """What one ``Session.apply`` did.

    Attributes:
        fold: The fold's own outcome, or this layer's own verdict (the
            discard refusal, the mid-fill buffering, the overlap refusal).
        retirements: The SS4.13 pending-command retirements the event
            triggered synchronously. ONE stated exception (FR-638-019c): a
            frame HELD during an SS4.8 fill reports ``bufferedDuringGap`` with
            no retirements, because at that moment nothing has folded — its
            real effects surface on the ``io`` of the EARLIER ``view/gap``
            apply that started the fill, never on the buffered frame's own
            return. A second ``view/gap`` landing mid-fill rides the same
            channel: it extends the running walk, so its own ``io`` is empty.
        io: The client->server I/O this event triggered, settled — resolves to
            the retirements that I/O produced (the SS4.13 replays queue
            movement demands, FR-638-019b's ``approval/decide`` submission,
            and the FR-638-019c fill). A SEPARATE channel from
            ``retirements`` because ``apply`` is synchronous by contract: a
            consumer's notification pump must not await a round trip before it
            can fold the next frame. IT NEVER REJECTS — a replay whose
            transport failed proves nothing about the intake, so its entry
            holds and the authoritative report is the host-death notification
            already on its way; an approval failure reports to
            ``on_approval_error`` and a fill failure to ``on_gap_error``.
    """

    fold: Union[FoldOutcome, SessionApplyRefusal, SessionGapBuffered, SessionGapOverlap]
    retirements: tuple[PendingRetirement[_I], ...]
    io: Awaitable[tuple[PendingRetirement[_I], ...]]


class Session(Generic[_I]):
    """One conversation with the agent.

    A session folds every server event into readable state — items, turns,
    session facts, pending approvals — and submits your side of the exchange.
    Get one from :meth:`MuseClient.start_session` or ``resume_session``, then
    ``send_user_turn`` to talk, ``turn`` to follow a turn's items to its
    outcome, and (from slice T031) ``on_approval`` to answer permission
    requests.
    """

    def __init__(
        self,
        session_id: str,
        durability: SessionDurabilityProfile,
        *,
        connection: Connection | None = None,
        discarded: DiscardedSessions | None = None,
        opening: SessionOpening | None = None,
    ) -> None:
        """Builds a session over the transport-less core.

        Args:
            session_id: The server-named session id every event must carry.
            durability: Whether this session survives its host (SS2.13.3b).
                Required, not defaulted: it decides what happens to every
                in-flight item and command when the host dies, and a default
                would let a caller skip reading the handshake and silently
                inherit the wrong obligation. ``read_session_durability`` turns
                an ``InitializeResult`` into it.
            connection: The wire seam the submit verbs author through. OPTIONAL
                because fold-only construction is a real current use: every
                transport-less arm in this package builds a ``Session`` with no
                host at all.
            discarded: What an ephemeral host death already discarded, shared
                across the sessions ONE client opened (T030 obligation (c)).
                Omitted, this session remembers only its own discards.
            opening: Set by ``MuseClient``; see :data:`SessionOpening`.
        """
        self.session_id = session_id
        self.opening = opening
        self._durability = durability
        self._discarded = discarded
        self._connection = connection
        self._fold: SessionFold = SessionFold()
        self._pending: PendingCommandSet[_I] = PendingCommandSet(
            discarded_command_ids=(
                discarded.command_ids if discarded is not None else set()
            )
        )
        self._submit: TurnSubmitter[_I] = TurnSubmitter(
            session_id, connection, self._pending
        )
        # The FR-638-019b round trip (``approval.py``).
        self._approvals = ApprovalRouter(session_id, connection)
        # The FR-638-019c splice-fill (``gap_fill.py``).
        self._gaps: GapFiller[_I] = GapFiller(
            GapFillerOptions(
                session_id=session_id,
                connection=connection,
                fold=self._fold,
                apply=self._fold_and_route,
                discarded=lambda: (
                    self._discharge is not None
                    and self._discharge.kind == "discharged"
                ),
            )
        )
        self._turns: dict[str, TurnHandle] = {}
        # ``item/delta`` frames whose item the fold does not hold yet: the
        # store buffers the delta TEXT (SS4.7.3) but a delta's TURN is equally
        # unknowable until the item lands, so the frames wait here and are
        # attributed when it does. Bounded by the durable ``item/completed``
        # that always lands the item.
        self._unattributed_deltas: dict[str, List[ItemDeltaParams]] = {}
        # The first discharge, replayed verbatim on every later call.
        self._discharge: HostDeathDischarge[_I] | None = None
        # Set on a durable abnormal death, so late handles inherit the failure.
        self._death_error: MuseHostDiedError | None = None

    @property
    def durability(self) -> SessionDurabilityProfile:
        """The profile this session discharges a host death under."""
        return self._durability

    @property
    def fold(self) -> SessionFoldView:
        """The read view of the fold; events enter through :meth:`apply` so
        turn routing cannot be skipped (the mutators are off this surface)."""
        return self._fold

    @property
    def pending(self) -> PendingCommandView[_I]:
        """The SS4.13 set's read/safe-drive view. The three mutators ``Session``
        drives itself and the two re-exposed as session methods are hidden;
        drive those through this session's verbs, which keep the submitter's
        replay memory in step."""
        return self._pending

    @property
    def known_turn_count(self) -> int:
        """How many turns this session has minted a handle for.

        Distinct from ``fold.turns()``, which counts turns the WIRE named: a
        handle is also minted by ``turn()`` and by item routing, so this
        reveals a phantom turn minted from a bad key (a ``userShell`` item's
        null ``turnId``). Observation-only.
        """
        return len(self._turns)

    def apply(self, event: Mapping[str, Any]) -> SessionApplyOutcome[_I]:
        """Fold one view event, then fan it out to the turn handles that want it.

        Raises on an event for another session: every view-event params type
        carries a required ``sessionId``, so on a multiplexed feed one
        misrouted frame would silently corrupt this transcript.

        Args:
            event: A wire notification mapping (``method`` + ``params``).

        Returns:
            The fold outcome, the synchronous retirements, and the awaitable
            ``io`` channel.

        Raises:
            MuseForeignSessionError: The frame names a different session.
        """
        # Only enforce when the frame actually NAMES a session: a newer host's
        # unknown notification reaches this at runtime and SS1.5.4 tolerates it
        # losslessly, so an unconditional read would throw on it.
        params = event.get("params")
        named = params.get("sessionId") if isinstance(params, dict) else None
        if isinstance(named, str) and named != self.session_id:
            from ..errors import MuseForeignSessionError

            raise MuseForeignSessionError(
                f"event {event.get('method')} belongs to session {named}, "
                f"not {self.session_id}"
            )

        # AFTER the foreign check: a discarded session must still not fold
        # (ItemStore's own guard covers only ITEM events, so a post-discharge
        # ``turn/completed`` once settled a fresh turn on a discarded session).
        # REFUSED, not thrown — throwing killed the consumer's pump on a single
        # trailing drain frame. SS2.13.3b requires that nothing fold; it does
        # not require an exception.
        if self._discharge is not None and self._discharge.kind == "discharged":
            return SessionApplyOutcome(
                fold=SessionApplyRefusal(),
                retirements=(),
                io=_settled_io([]),
            )

        # An SS4.8 fill is in flight, so the live tail waits for the paged
        # prefix (tdd SS4.8's "buffer live events … splice the buffer after
        # the paged prefix"). Folding it now would run the fold backwards when
        # the older paged events land, and would hand the iterators the tail
        # before the hole they follow. The MARKER itself is exempt: a second
        # overflow has to reach the fold to extend the outstanding hole, or
        # the walk stops short of it and reports current with a hole still
        # open.
        method = str(event.get("method"))
        if self._gaps.filling and method != "view/gap":
            self._gaps.hold(event)
            return SessionApplyOutcome(
                fold=SessionGapBuffered(method=method),
                retirements=(),
                io=_settled_io([]),
            )

        # The overlap's late half: a frame a completed fill already applied
        # from a page, whose live twin the wire delivered afterwards. Reached
        # only when NO fill is running — during one the buffer takes the frame
        # first, and the drain refuses it there against both its own paged
        # cursors and the persistent set.
        twin = self._gaps.claim_served_twin(event)
        if twin is not None:
            return SessionApplyOutcome(
                fold=SessionGapOverlap(method=method, view_cursor=twin),
                retirements=(),
                io=_settled_io([]),
            )

        sink: DrainSink[_I] = DrainSink(retirements=[], tasks=[])
        outcome = self._fold_and_route(event, sink)
        # FR-638-019c: recover before this fold may call itself current again.
        # Started HERE rather than inside the routing arms because it is the
        # one arm besides approvals that authors client→server I/O off a
        # notification, and ``io`` is the channel that carries it. ``None``
        # means no walk started (mid-fill coalesce, or the fold-only failure
        # already reported synchronously) — appending an already-settled stub
        # instead would force ``_settled_io``'s gather arm, which needs a
        # running loop a fold-only ``apply`` may not have.
        if isinstance(outcome, DeliveryGap):
            fill = self._gaps.start()
            if fill is not None:
                sink.tasks.append(fill)
        return SessionApplyOutcome(
            fold=outcome,
            retirements=tuple(sink.retirements),
            io=_settled_io(sink.tasks),
        )

    def on_gap_error(self, handler: GapFillFailureHandler) -> None:
        """Observe SS4.8 fills that did not complete. See
        :class:`~muse_code.errors.MuseGapFillError`."""
        self._gaps.on_error(handler)

    def _fold_and_route(
        self, event: WireFrame, sink: DrainSink[_I]
    ) -> FoldOutcome:
        # The shared path: ``apply`` uses it for a live frame, and ``GapFiller``
        # uses it to re-feed the paged prefix and the buffered tail. One path
        # is what makes a spliced frame indistinguishable from a live one to
        # everything downstream — the fold, the iterators, and the SS4.13
        # retirements.
        retirements: List[PendingRetirement[_I]] = []
        outcome = self._fold.apply(event)
        # The fold drops a params-less frame as IgnoredMissingParams (SS1.5.4);
        # the arms below read ``params`` on the turn/item arms, so return early.
        method = str(event.get("method"))
        params = event.get("params")
        if not isinstance(params, dict):
            return outcome

        if method in ("item/started", "item/updated", "item/completed"):
            # A stale re-emission changed nothing (INV-003), so it yields none.
            if isinstance(outcome, ItemFold) and not isinstance(
                outcome.outcome, IgnoredStaleRevision
            ):
                self._item_folded(params["item"], retirements)
        elif method == "item/delta":
            self._delta_folded(cast(ItemDeltaParams, params))
        elif method == "turn/started":
            self._handle(str(params["turnId"])).mark_started()
            self._queue_moved(str(params["turnId"]), sink.tasks)
        elif method == "turn/completed":
            self._handle(str(params["turnId"])).settle_completed(
                cast(TurnCompletedParams, params)
            )
            self._queue_moved(str(params["turnId"]), sink.tasks)
        elif method == "turn/unqueued":
            self._handle(str(params["turnId"])).settle_unqueued(
                cast(TurnUnqueuedParams, params)
            )
            # SS4.13 "Reclaimed": the reclaim this client just observed retires
            # the entry NOW, with its input restored to the composer.
            command_id = params.get("commandId")
            if isinstance(command_id, str):
                reclaimed = self._pending.observed_reclaim(command_id)
                if reclaimed is not None:
                    retirements.append(reclaimed)
        elif method == "approval/requested":
            # FR-638-019b's outbound half. Gated on the fold's own verdict: a
            # request the fold IGNORED (a redelivery for an approval already
            # durably resolved) must author no decision — no second resolution
            # is coming, so a decide against it can only bounce.
            if isinstance(outcome, ApprovalPending):
                self._approval_requested(
                    cast(ApprovalRequestParams, params), sink.tasks
                )
        # ``view/gap`` deliberately routes to no turn: it names a hole in
        # DELIVERY, so what it moves is the fold's currency, and the recovery
        # it triggers is started by ``apply`` off the ``DeliveryGap`` verdict
        # rather than from here (FR-638-019c). Every other method is folded
        # but routed to no turn.

        # The retired entries are gone from the set, so their replay memory
        # goes with them.
        if retirements:
            self._submit.forget_retired(retirements)
            sink.retirements.extend(retirements)
        return outcome

    def turn(self, turn_id: str) -> Turn:
        """The handle for a turn, created on first mention from either side.

        A turn the fold has already settled returns its settled handle, so a
        wait registered late resolves instead of hanging on an event that has
        passed. A CONSUMER asking about a turn this session has no news of,
        after the host died, must not hang: no answer is coming on this
        connection (the SS3.1.4 trap SS2.13.3b's "stop waiting" forbids).
        Server-minted handles deliberately skip this — see :meth:`_handle`.
        """
        held = self._turns.get(turn_id)
        if held is not None:
            return held
        fresh = self._mint(turn_id)
        if self._discharge is not None and self._discharge.kind == "discharged":
            fresh.settle_terminal_unknown()
        elif self._death_error is not None:
            fresh.fail(self._death_error)
        return fresh

    def _handle(self, turn_id: str) -> TurnHandle:
        # A handle minted because a SERVER FRAME named this turn. Never
        # pre-failed, and that is what makes the post-death behaviour
        # order-independent (a durable death does not stop the fold, FM-001, so
        # frames still arrive for a turn with no handle yet). A frame arriving
        # IS the connection still speaking; ``turn()`` keeps the latch for the
        # case that genuinely is a waiter with no answer coming.
        held = self._turns.get(turn_id)
        return held if held is not None else self._mint(turn_id)

    def _mint(self, turn_id: str) -> TurnHandle:
        fresh = TurnHandle(turn_id, lambda: self._items_of_turn(turn_id))
        self._turns[turn_id] = fresh
        return fresh

    def host_exited(
        self, exit_notification: HostDeathNotification
    ) -> HostDeathDischarge[_I]:
        """A host process exited or the transport reached EOF; classify it, and
        discharge SS2.13.3b if the profile demands it (T033, FR-638-019d).

        REPORT EVERY NOTIFICATION OF THE DEATH — the exit AND transport EOF. A
        repeat report of an already-latched death is not a no-op: it marks END
        OF DRAIN and settles waits the drain minted after the first report. A
        consumer that dedupes and reports the death once leaves those waits
        pending forever (FM-001).

        Args:
            exit_notification: The SS2.11 exit classification, or the
                transport EOF.

        Returns:
            The discharge: ``notADeath`` (still usable), ``durableDeath`` (dead
            until resume, waits rejected), or ``discharged`` (ephemeral
            obligation paid in full). The FIRST is latched and replayed.
        """
        if self._discharge is not None:
            # END-OF-DRAIN SWEEP: between the first notification and this one a
            # durable death's still-running fold can mint handles from
            # ``turn/started`` frames whose terminals never arrive. Those are
            # left pending by ``_handle`` on purpose — a delivered terminal
            # must be able to win — but a SECOND notification means the drain
            # is over, so anything still unsettled would hang forever.
            self._sweep_unsettled_after_drain()
            return self._discharge

        profile = self._durability
        if not is_abnormal_host_death(exit_notification):
            self._discharge = _NotADeath(profile=profile, exit=exit_notification)
            return self._discharge

        if survives_host_death(profile):
            # FM-001: the stores are left exactly as observed — the terminals
            # arrive on resume — so only the waiters are told.
            died = MuseHostDiedError(exit_notification)
            self._death_error = died
            for handle in self._turns.values():
                handle.fail(died)
            self._discharge = _DurableDeath(profile=profile, exit=exit_notification)
            return self._discharge

        retired_commands = self._pending.discard_ephemeral()
        terminal_unknown_items = self._fold.mark_ephemeral_host_death(
            lambda item: is_item_in_progress(cast(Item, item))
        )
        for handle in self._turns.values():
            handle.settle_terminal_unknown()
        # SS2.13.3b "do not attempt to reattach". ``discard_ephemeral`` already
        # wrote the commandIds into the shared set (it holds it by reference);
        # the sessionId is this layer's to record, because the pending set does
        # not know one. ``MuseClient.resume_session`` is the reader.
        if self._discarded is not None:
            self._discarded.session_ids.add(self.session_id)
        self._submit.forget_retired(retired_commands)
        self._discharge = _Discharged(
            profile=profile,
            exit=exit_notification,
            terminal_unknown_items=tuple(terminal_unknown_items),
            retired_commands=tuple(retired_commands),
        )
        return self._discharge

    def _sweep_unsettled_after_drain(self) -> None:
        # DURABLE ONLY, and ``_death_error`` is set iff a durable death
        # latched, so the condition is the discriminator. There is deliberately
        # no ephemeral arm: after a discharge the first notification settled
        # every held handle, ``apply()`` refuses before a frame can mint one,
        # and ``turn()`` settles a fresh mint on the spot.
        if self._death_error is None:
            return
        for handle in self._turns.values():
            handle.fail(self._death_error)

    # ---- FR-638-019a submit verb (T030 obligation a) ------------------------

    async def send_user_turn(self, options: SendUserTurnOptions[_I]) -> Turn:
        """Submit a user turn (tdd SS3.2) and hand back THIS session's handle
        for the turn the ack named.

        The returned handle is the one ``apply`` already routes events to — not
        a second one minted beside it, which would compare equal on every field
        and then never receive an item, a delta, or a terminal.

        Args:
            options: The turn's input and optional composer/display members.

        Returns:
            The turn handle the ack named.
        """
        ack = await self._submit.submit(options, self._last_folded_item_id())
        return self._handle(ack["turnId"])

    # ---- FR-638-019b approval round trip (T031) ------------------------------

    def on_approval(self, handler: ApprovalHandler) -> None:
        """Answer approvals with ``handler`` (FR-638-019b). See
        :class:`~muse_code.facade.approval.ApprovalRouter`."""
        self._approvals.on_approval(handler)

    def on_approval_error(self, handler: ApprovalFailureHandler) -> None:
        """Observe round trips that did not complete. See
        :data:`~muse_code.facade.approval.ApprovalFailure`."""
        self._approvals.on_approval_error(handler)

    # ---- consumer-driven SS4.13 retirement verbs ----------------------------

    def stop_retrying(self, command_id: str) -> PendingRetirement[_I] | None:
        """Stop the SS3.1.1 retry loop for one entry and take its input back
        (SS4.13 "Abandoned").

        A session method rather than a ``pending`` view member: the retirement
        must also prune the submitter's replay memory, or the abandoned
        command's ``turn/start`` params live for the session's lifetime.
        """
        retired = self._pending.stop_retrying(command_id)
        if retired is not None:
            self._submit.forget_retired([retired])
        return retired

    def replay_answered(
        self, command_id: str, answer: ReplayAnswer[_I]
    ) -> PendingRetirement[_I] | Literal["held"]:
        """Feed a consumer-driven replay's answer through the live SS4.13
        settlement rules. ``"held"`` means the answer settled nothing."""
        settled = self._pending.replay_answered(command_id, answer)
        if settled != "held":
            self._submit.forget_retired([settled])
        return settled

    # ---- SS4.13 drivers that need client->server I/O (T030 obligation d) ----

    async def resolve_snapshot_join(
        self, facts: SnapshotJoinFacts
    ) -> tuple[PendingRetirement[_I], ...]:
        """Resolve a snapshot join by performing the I/O its plan demands
        (SS4.13, SS4.9): same-``commandId`` resubmits FIRST, then the replays,
        then the reclaimed-signature verdict.

        The order is normative: SS4.13 requires an unacked entry be resubmitted
        before any retire-to-composer, because a join miss does not prove the
        intake was never written.
        """
        self._submit.require_connection("resolve_snapshot_join")
        plan = self._pending.join_snapshot(facts)
        out: List[PendingRetirement[_I]] = list(plan.retirements)
        for command_id in plan.must_resubmit:
            await self._submit.drive_replay(command_id, out)
        queued_command_ids = [queued.command_id for queued in facts.queued_turns]
        for command_id in plan.must_replay:
            answer = await self._submit.replay(command_id)
            if answer is None:
                continue
            settled = self._pending.resolve_replay_at_join(
                command_id, answer, queued_command_ids
            )
            if settled != "held":
                out.append(settled)
        self._submit.forget_retired(out)
        return tuple(out)

    async def resolve_reconnect(self) -> tuple[PendingRetirement[_I], ...]:
        """Resolve a reconnect with NO snapshot (the default cursor-resume
        path): replay each acked entry once, resubmit each unacked entry's
        same ``commandId`` once."""
        self._submit.require_connection("resolve_reconnect")
        plan = self._pending.reconnected_without_snapshot()
        out: List[PendingRetirement[_I]] = []
        for command_id in plan.must_resubmit:
            await self._submit.drive_replay(command_id, out)
        for command_id in plan.must_replay:
            await self._submit.drive_replay(command_id, out)
        self._submit.forget_retired(out)
        return tuple(out)

    # ---- event-driven I/O ---------------------------------------------------

    def _last_folded_item_id(self) -> str | None:
        items = self._fold.items.list()
        if not items:
            return None
        last = items[-1]
        item_id = last.get("itemId")
        return item_id if isinstance(item_id, str) else None

    def _queue_moved(
        self,
        turn_id: str,
        tasks: List[Awaitable[tuple[PendingRetirement[_I], ...]]],
    ) -> None:
        # SS4.13 "Queue movement": a ``turn/started``/``turn/completed`` for a
        # turn that is not an entry's own decides that entry's fate at a launch
        # boundary, and SS4.3 carries no view event for a command-intake
        # settlement — so the only way to learn it is to replay.
        if not self._submit.wired:
            return
        command_ids = self._pending.observed_queue_movement(turn_id)
        if not command_ids:
            return
        tasks.append(self._drive_queue_replays(command_ids))

    async def _drive_queue_replays(
        self, command_ids: tuple[str, ...]
    ) -> tuple[PendingRetirement[_I], ...]:
        out: List[PendingRetirement[_I]] = []
        for command_id in command_ids:
            try:
                await self._submit.drive_replay(command_id, out)
            except Exception:
                # Swallowed narrowly: ``replay`` already converts a
                # server-authored MSP error into an answer, so reaching here
                # means the TRANSPORT failed. That proves nothing about the
                # intake, so the entry holds — the authoritative report is the
                # host-death notification already on its way. Re-raising would
                # reject an ``io`` most consumers never await.
                pass
        self._submit.forget_retired(out)
        return tuple(out)

    def _approval_requested(
        self,
        params: ApprovalRequestParams,
        tasks: List[Awaitable[tuple[PendingRetirement[_I], ...]]],
    ) -> None:
        decided = self._approvals.requested(params)
        # An approval decision retires no pending command — it is not an
        # SS4.13 entry — but it still has to be awaitable through the same
        # ``io``, or a consumer has no barrier for the round trip it just
        # triggered.
        if decided is not None:
            tasks.append(_decided_io(decided))

    def _items_of_turn(self, turn_id: str) -> tuple[Item, ...]:
        return tuple(
            cast(Item, item)
            for item in self._fold.items.list()
            if item.get("turnId") == turn_id
        )

    def _item_folded(
        self, item: Item, retirements: List[PendingRetirement[_I]]
    ) -> None:
        # SS4.13 "Materialized": the commandId-bearing ``userMessage`` landed,
        # so the optimistic entry is replaced by the real item at the item's
        # own position (item ids and command ids are separate namespaces).
        command_id = item.get("commandId")
        if item.get("kind") == _USER_MESSAGE and isinstance(command_id, str):
            materialized = self._pending.observed_user_message(
                command_id, str(item["itemId"])
            )
            if materialized is not None:
                retirements.append(materialized)
        # ``userShell`` items carry ``turnId: null`` on the wire — guard on
        # "is a str", never "is not None": a null turnId minted a phantom turn.
        turn_id = item.get("turnId")
        if isinstance(turn_id, str):
            self._handle(turn_id).push_item(item)
        buffered = self._unattributed_deltas.pop(str(item["itemId"]), None)
        if buffered is None:
            return
        if not isinstance(turn_id, str):
            return  # ``userShell`` is not turn-scoped
        handle = self._handle(turn_id)
        for delta_params in buffered:
            handle.push_delta(delta_params)

    def _delta_folded(self, params: ItemDeltaParams) -> None:
        item_id = str(params["itemId"])
        held = self._fold.items.get(item_id)
        if held is None:
            self._unattributed_deltas.setdefault(item_id, []).append(params)
            return
        turn_id = held.get("turnId")
        if isinstance(turn_id, str):
            self._handle(turn_id).push_delta(params)


async def _decided_io(
    decided: Awaitable[None],
) -> tuple[PendingRetirement[_I], ...]:
    await decided
    return ()


def _settled_io(
    tasks: List[Awaitable[tuple[PendingRetirement[_I], ...]]],
) -> Awaitable[tuple[PendingRetirement[_I], ...]]:
    """Flatten the event's I/O tasks, or hand back an already-settled empty.

    Returns something that NEVER rejects (SessionApplyOutcome.io's contract):
    every task producer here — ``_drive_queue_replays``, the approval decide,
    the gap fill — contains its own failures, so the gather cannot fail.
    Tasks only exist on a WIRED session inside a running loop (the fold-only
    arms of the approval router and the gap filler report synchronously and
    schedule nothing), so ``ensure_future`` is safe there; the empty case is
    loop-free.
    """
    if not tasks:
        return ResolvedIo(())

    async def run() -> tuple[PendingRetirement[_I], ...]:
        batches = await asyncio.gather(*tasks)
        out: List[PendingRetirement[_I]] = []
        for batch in batches:
            out.extend(batch)
        return tuple(out)

    return asyncio.ensure_future(run())
