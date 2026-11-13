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
    AsyncIterator,
    Awaitable,
    Callable,
    Generic,
    Iterable,
    List,
    Literal,
    Mapping,
    Protocol,
    Sequence,
    TypeVar,
    Union,
    cast,
)

from muse_code_msp import (
    COMMAND_STATUS_KNOWN_VALUES,
    ITEM_KIND_KNOWN_VALUES,
    TURN_START_DISPOSITION_KNOWN_VALUES,
    ApprovalMode,
    ApprovalRequestParams,
    ApprovalUpdatedParams,
    CommandAcceptedResult,
    FeedbackSubmitParams,
    FeedbackSubmitResult,
    HookListResult,
    IfBusy,
    Item,
    ForkCutPoint,
    ItemDeltaParams,
    ModelSelection,
    PluginInstallResult,
    PluginInstallTarget,
    PluginListResult,
    ReasoningEffort,
    RecapRequestResult,
    SessionCompactResult,
    SessionForkResult,
    SessionLeaveResult,
    SessionRenameResult,
    SessionSetApprovalModeResult,
    SessionSetModelResult,
    SessionSetReasoningEffortResult,
    SessionSideChatResult,
    SkillActivationScope,
    SkillActivationState,
    SkillListResult,
    SkillSetActivationResult,
    TaskListResult,
    TurnCancelResult,
    TurnCompletedParams,
    TurnInterruptResult,
    TurnSteerResult,
    TurnUnqueuedParams,
    TurnUnqueueResult,
    TurnUserShell,
    UserInputAnswer,
    UserInputAnswerResult,
    WorkflowControlResult,
    WorkflowResumeResult,
)

from ..connection.connection import Connection, ProtocolError
from ..connection.connection import Params as WireParams
from ..fold.item_store import IgnoredStaleRevision
from ..fold.session_fold import (
    ApprovalPending,
    ApprovalResolvedFold,
    DeliveryGap,
    FoldItems,
    FoldOutcome,
    FoldSessionState,
    IgnoredStaleFrame,
    IgnoredUnrecognizedMethod,
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
from .run import RunInput, RunResult, input_parts, run_turn
from .turn_handle import FoldedItem, Turn, TurnHandle, TurnUnqueueOutcome, _PushStream
from .turn_submit import SendUserTurnOptions, SteerTurnOptions, TurnSubmitter

_I = TypeVar("_I")

_USER_MESSAGE = "userMessage"
assert _USER_MESSAGE in ITEM_KIND_KNOWN_VALUES
_ACCEPTED = "accepted"
assert _ACCEPTED in COMMAND_STATUS_KNOWN_VALUES
_QUEUED = "queued"
assert _QUEUED in TURN_START_DISPOSITION_KNOWN_VALUES


def _is_routable_approval_request(request: Mapping[str, Any]) -> bool:
    """True when a routed ``approval/request`` carries every member the approval
    router reads: its ``approvalId``, the requirement's ``approvalId`` and
    ``sourceIndex``, and each offered choice's ``choiceId``."""
    if not isinstance(request.get("approvalId"), str):
        return False
    requirement = request.get("currentRequirementId")
    choices = request.get("availableChoices")
    if not isinstance(requirement, dict) or not isinstance(choices, list):
        return False
    index = requirement.get("sourceIndex")
    return (
        isinstance(requirement.get("approvalId"), str)
        and isinstance(index, int)
        and not isinstance(index, bool)
        and all(
            isinstance(choice, dict) and isinstance(choice.get("choiceId"), str)
            for choice in choices
        )
    )


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
    """``Session.apply``'s other own verdict: a frame held while the protocol fill
    is in flight.

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
    """A live frame the protocol fill already applied from a page — the other
    half of the recipe's overlap discard.

    The wire promises no order between a ``view/gap`` and the frame at its
    ``next``, so the live twin of an event the page served can arrive after
    the fill finished, when the buffer is gone. Refused once, by cursor
    equality, because folding it again would re-run its routing — a duplicate
    queue-movement replay on the wire, which is exactly what the
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
        retirements: The pending-command retirements the event
            triggered synchronously. ONE stated exception: a
            frame HELD during the protocol fill reports ``bufferedDuringGap`` with
            no retirements, because at that moment nothing has folded — its
            real effects surface on the ``io`` of the EARLIER ``view/gap``
            apply that started the fill, never on the buffered frame's own
            return. A second ``view/gap`` landing mid-fill rides the same
            channel: it extends the running walk, so its own ``io`` is empty.
            A repeat of a ``next`` already named while the hole is open folds
            as ``IgnoredStaleFrame`` and extends nothing; after a failed fill
            it still restarts that fill, and the restarted walk's work
            settles on this frame's ``io``.
        io: The client->server I/O this event triggered, settled — resolves to
            the retirements that I/O produced. A SEPARATE channel from
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


ViewFrame = WireFrame
"""One inbound frame as a session applies it: a view notification, a frame a
gap fill spliced in from a page, or the frame a re-sent server request is
folded as (``approval/request`` as itself, ``userInput/request`` as its
``userInput/requested`` twin)."""


@dataclass(frozen=True)
class SessionEvent(Generic[_I]):
    """One event a session folded, as :meth:`Session.events` yields it: the
    event and what folding it changed, self-contained because the loop body
    may run after later events folded. Optional attributes
    may be added; a consumer reads the ones it knows.

    Attributes:
        frame: The protocol event, as the session applied it.
        outcome: What it changed: the value :meth:`Session.apply` returned for
            a live event. An event a gap fill spliced in carries its fold
            result and no retirements or I/O of its own: those settle on the
            ``view/gap`` event's ``io``.
        item: For an item event that changed the item, the item as it stood
            after this event; otherwise ``None``.
    """

    frame: ViewFrame
    outcome: SessionApplyOutcome[_I]
    item: FoldedItem | None = None



def _reason(reason: str | None) -> WireParams:
    # Optional means omitted, never null.
    return {} if reason is None else {"reason": reason}


class _SessionTurnControls(Generic[_I]):
    """The wire half of every turn handle's control verbs. Each refuses on a
    discarded or fold-only session before anything is sent; ``steer`` rides
    the pending submit path, and an accepted ``unqueue`` retires the queued
    entry at once (the client's own reclaim ack), so the later
    ``turn/unqueued`` finds nothing left to retire. When ``turn/unqueued``
    folds first under ``MuseClient``, the fold's retirement is held for the
    call instead."""

    def __init__(self, session: "Session[_I]") -> None:
        self._session = session

    async def cancel(self, turn_id: str) -> TurnCancelResult:
        """Sends ``turn/cancel``."""
        ack = await self._session._command("cancel", "turn/cancel", {"turnId": turn_id})
        return cast(TurnCancelResult, ack)

    async def interrupt(self, turn_id: str, retract: bool | None) -> TurnInterruptResult:
        """Sends ``turn/interrupt``."""
        params: WireParams = {"turnId": turn_id}
        if retract is not None:
            params["retract"] = retract
        ack = await self._session._command("interrupt", "turn/interrupt", params)
        return cast(TurnInterruptResult, ack)

    async def steer(self, turn_id: str, options: SteerTurnOptions[_I]) -> TurnSteerResult:
        """Sends ``turn/steer`` through the pending submit path."""
        session = self._session
        session._require_live_connection("steer")
        return await session._submit.steer(turn_id, options, session._last_folded_item_id())

    async def unqueue(
        self, turn_id: str, command_id: str | None = None
    ) -> TurnUnqueueOutcome[_I]:
        """Sends ``turn/unqueue``; an accepted ack retires this session's
        queued entry for the turn. ``command_id`` sends one reclaim again under
        its first id; ``None`` lets the connection mint one."""
        session = self._session
        in_flight = session._unqueues_in_flight
        in_flight[turn_id] = in_flight.get(turn_id, 0) + 1
        try:
            ack = cast(
                TurnUnqueueResult,
                await session._command(
                    "unqueue", "turn/unqueue", {"turnId": turn_id}, command_id=command_id
                ),
            )
            held = session._held_reclaims.pop(turn_id, None)
            if held is not None:
                return TurnUnqueueOutcome(ack=ack, retirement=held)
            if ack.get("status") != _ACCEPTED:
                return TurnUnqueueOutcome(ack=ack)
            return TurnUnqueueOutcome(ack=ack, retirement=session._reclaim_queued(turn_id))
        finally:
            left = in_flight[turn_id] - 1
            if left > 0:
                in_flight[turn_id] = left
            else:
                del in_flight[turn_id]
                session._held_reclaims.pop(turn_id, None)

class Session(Generic[_I]):
    """One conversation with the agent.

    A session folds every server event into readable state — items, turns,
    session facts, pending approvals — and submits your side of the exchange.
    Get one from :meth:`MuseClient.start_session` or ``resume_session``, then
    ``send_user_turn`` to talk, ``turn`` to follow a turn's items to its
    outcome, and ``on_approval`` to answer permission
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
            durability: Whether this session survives its host.
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
                across the sessions ONE client opened (its task obligation (c)).
                Omitted, this session remembers only its own discards.
            opening: Set by ``MuseClient``; see :data:`SessionOpening`.
        """
        self.session_id = session_id
        self.opening = opening
        self._durability = durability
        self._discarded = discarded
        self._connection = connection
        self._fold: SessionFold = SessionFold()
        # Approvals the fold holds a durable terminal for. Read by a re-sent
        # ``approval/request``, which skips the fold, so it authors nothing for
        # an approval already resolved; mirrors the fold's own record, keyed
        # for O(1).
        self._resolved_approval_ids: set[str] = set()
        self._pending: PendingCommandSet[_I] = PendingCommandSet(
            discarded_command_ids=(
                discarded.command_ids if discarded is not None else set()
            )
        )
        self._submit: TurnSubmitter[_I] = TurnSubmitter(
            session_id, connection, self._pending
        )
        # The approval round trip (``approval.py``).
        self._approvals = ApprovalRouter(session_id, connection)
        # The gap splice-fill (``gap_fill.py``).
        self._gaps: GapFiller[_I] = GapFiller(
            GapFillerOptions(
                session_id=session_id,
                connection=connection,
                fold=self._fold,
                apply=self._spliced,
                discarded=lambda: (
                    self._discharge is not None
                    and self._discharge.kind == "discharged"
                ),
            )
        )
        self._turns: dict[str, TurnHandle[_I]] = {}
        # The live ``events()`` streams, fed by every folded event.
        self._event_streams: set[_PushStream[SessionEvent[_I]]] = set()
        # The wire half of every turn handle's control verbs.
        self._turn_controls: _SessionTurnControls[_I] = _SessionTurnControls(self)
        # ``item/delta`` frames whose item the fold does not hold yet: the
        # store buffers the delta TEXT but a delta's TURN is equally
        # unknowable until the item lands, so the frames wait here and are
        # attributed when it does. Bounded by the durable ``item/completed``
        # that always lands the item.
        self._unattributed_deltas: dict[str, List[ItemDeltaParams]] = {}
        # Set by ``MuseClient``, whose pump drops what ``apply`` returns.
        self._apply_results_dropped = False
        # This session's own ``unqueue()`` calls awaiting their ack, per turn.
        self._unqueues_in_flight: dict[str, int] = {}
        # A reclaim the fold retired while its turn's own ``unqueue()`` was
        # in flight on a session whose pump drops ``apply``'s return. The
        # call hands it out; it goes when the last in-flight call for the
        # turn settles, so this holds at most one entry per in-flight call.
        self._held_reclaims: dict[str, PendingRetirement[_I]] = {}
        # ``Session.run``'s stops that outlive a second cancellation, held
        # until each settles or the client closes.
        self._held_stops: set[asyncio.Future[None]] = set()
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
        """The pending set's read/safe-drive view. The three mutators ``Session``
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
        outcome = self._apply_live(event)
        # A frame held for a fill is yielded when the fill splices it in.
        if not isinstance(outcome.fold, SessionGapBuffered):
            self._emit(event, outcome)
        return outcome

    def events(self) -> AsyncIterator[SessionEvent[_I]]:
        """Every event this session folds from now on, with what it changed.

        Live from the call, never replayed: read :attr:`fold`, then call this
        before the next ``await``, and nothing is missed, including the events
        folded while ``start_session``/``resume_session`` was in flight. Each
        folded event is yielded once, in arrival order; the events a gap fill
        splices in are yielded when applied, in order. Buffered like
        ``turn.items()``, so a slow reader never holds folding up.

        Close it with ``aclose()`` (``contextlib.aclosing`` around an
        ``async for`` that may ``break``). It finishes the way a turn's
        ``items()`` does when the host dies: it ends after an ephemeral host's
        death, and raises :class:`~muse_code.errors.MuseHostDiedError` after a
        durable one's, once the events it already buffered are read.
        """
        stream: _PushStream[SessionEvent[_I]] = _PushStream(
            lambda: self._event_streams.discard(stream)
        )
        if self._death_error is not None:
            stream.fail(self._death_error)
        elif self._discharge is not None and self._discharge.kind == "discharged":
            stream.end()
        else:
            self._event_streams.add(stream)
        return stream

    def _emit(self, frame: WireFrame, outcome: SessionApplyOutcome[_I]) -> None:
        # Yield one folded event to every live ``events()`` stream.
        if not self._event_streams:
            return
        fold = outcome.fold
        # The item as of THIS event: the store keeps one object per revision,
        # so a later revision folding before the consumer reads cannot change it.
        item = (
            cast(FoldedItem, self._fold.items.get(fold.outcome.item_id))
            if isinstance(fold, ItemFold) and not isinstance(fold.outcome, IgnoredStaleRevision)
            else None
        )
        event = SessionEvent(frame=frame, outcome=outcome, item=item)
        for stream in tuple(self._event_streams):
            stream.push(event)

    def _spliced(self, frame: WireFrame, sink: DrainSink[_I]) -> FoldOutcome:
        # Fold one frame a gap fill splices in, and yield it. Its retirements
        # and I/O settle on the gap frame's ``io``, so the event carries none.
        fold = self._fold_and_route(frame, sink)
        self._emit(frame, SessionApplyOutcome(fold=fold, retirements=(), io=_settled_io([])))
        return fold

    def _apply_live(self, event: Mapping[str, Any]) -> SessionApplyOutcome[_I]:
        # Only enforce when the frame actually NAMES a session: a newer host's
        # unknown notification reaches this at runtime and the protocol tolerates it
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
        # trailing drain frame. the protocol requires that nothing fold; it does
        # not require an exception.
        if self._discharge is not None and self._discharge.kind == "discharged":
            return SessionApplyOutcome(
                fold=SessionApplyRefusal(),
                retirements=(),
                io=_settled_io([]),
            )

        # A gap fill is in flight, so the live tail waits for the paged
        # prefix (the protocol spec's "buffer live events … splice the buffer after
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
        # The rule: recover before this fold may call itself current again.
        # Started HERE rather than inside the routing arms because it is the
        # one arm besides approvals that authors client→server I/O off a
        # notification, and ``io`` is the channel that carries it. ``None``
        # means no walk started (mid-fill coalesce, or the fold-only failure
        # already reported synchronously) — appending an already-settled stub
        # instead would force ``_settled_io``'s gather arm, which needs a
        # running loop a fold-only ``apply`` may not have.
        # A stale repeat of an earlier gap still restarts a failed fill, as
        # every folded ``view/gap`` (a ``DeliveryGap`` or a stale repeat)
        # reaches ``start()`` (a no-op while a fill runs).
        if isinstance(outcome, DeliveryGap) or (
            isinstance(outcome, IgnoredStaleFrame) and outcome.method == "view/gap"
        ):
            fill = self._gaps.start()
            if fill is not None:
                sink.tasks.append(fill)
        return SessionApplyOutcome(
            fold=outcome,
            retirements=tuple(sink.retirements),
            io=_settled_io(sink.tasks),
        )

    def on_gap_error(self, handler: GapFillFailureHandler) -> None:
        """Observe the protocol fills that did not complete. See
        :class:`~muse_code.errors.MuseGapFillError`."""
        self._gaps.on_error(handler)

    def _fold_and_route(
        self, event: WireFrame, sink: DrainSink[_I]
    ) -> FoldOutcome:
        # The shared path: ``apply`` uses it for a live frame, and ``GapFiller``
        # uses it to re-feed the paged prefix and the buffered tail. One path
        # is what makes a spliced frame indistinguishable from a live one to
        # everything downstream — the fold, the iterators, and the protocol
        # retirements.
        retirements: List[PendingRetirement[_I]] = []
        # A re-sent ``approval/request`` server request skips the fold, which
        # lists only the ``approval/requested`` notification, and reaches
        # approval routing like that notification: the per-stage latch decides
        # each stage once, and an approval already resolved authors nothing.
        # Its handler task can land after the ``approval/resolved`` read with
        # it, so in that case Python skips a request TypeScript would still
        # route in arrival order. A request missing the members the router
        # reads is dropped, never raised on, whichever path applies it: a held
        # frame replayed inside ``resume_session`` included. A routed or
        # dropped request reports ``IgnoredUnrecognizedMethod``, a sanctioned
        # interim like ``session/started``'s (a dedicated outcome is tracked);
        # one with no params dict falls through to the fold's
        # ``IgnoredMissingParams``, like every other frame.
        request = event.get("params")
        if event.get("method") == "approval/request" and isinstance(request, dict):
            if (
                _is_routable_approval_request(request)
                and request["approvalId"] not in self._resolved_approval_ids
            ):
                self._approval_requested(
                    cast(ApprovalRequestParams, request), sink.tasks
                )
            return IgnoredUnrecognizedMethod("approval/request")
        outcome = self._fold.apply(event)
        if isinstance(outcome, ApprovalResolvedFold):
            self._resolved_approval_ids.add(outcome.approval_id)
        # The fold drops a params-less frame as IgnoredMissingParams;
        # the arms below read ``params`` on the turn/item arms, so return early.
        method = str(event.get("method"))
        params = event.get("params")
        if not isinstance(params, dict):
            return outcome

        if method in ("item/started", "item/updated", "item/completed"):
            # A stale re-emission changed nothing, so it yields none.
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
            # the protocol "Reclaimed": the reclaim this client just observed retires
            # the entry NOW, with its input restored to the composer.
            command_id = params.get("commandId")
            if isinstance(command_id, str):
                reclaimed = self._pending.observed_reclaim(command_id)
                if reclaimed is not None:
                    # Under ``MuseClient`` this session's own in-flight unqueue
                    # for the turn is where it lands. Held INSTEAD of returned,
                    # so no outcome, live or spliced into a gap's ``io``,
                    # carries it a second time.
                    turn_id = str(params["turnId"])
                    if self._apply_results_dropped and turn_id in self._unqueues_in_flight:
                        self._submit.forget_retired([reclaimed])
                        self._held_reclaims[turn_id] = reclaimed
                    else:
                        retirements.append(reclaimed)
        elif method == "approval/requested":
            # The rule's outbound half. Gated on the fold's own verdict: a
            # request the fold IGNORED (a redelivery for an approval already
            # durably resolved) must author no decision — no second resolution
            # is coming, so a decide against it can only bounce.
            if isinstance(outcome, ApprovalPending):
                self._approval_requested(
                    cast(ApprovalRequestParams, params), sink.tasks
                )
        elif method == "approval/updated":
            # A stage advance arrives as this frame alone on the notification
            # plane, so it must drive the handler too (see
            # ``ApprovalRouter.updated``). The same fold verdict gates it: an
            # update the fold IGNORED (unknown or already-resolved approval)
            # authors nothing.
            if isinstance(outcome, ApprovalPending):
                self._approval_updated(
                    cast(ApprovalRequestParams, outcome.requested),
                    cast(ApprovalUpdatedParams, params),
                    sink.tasks,
                )
        # ``view/gap`` deliberately routes to no turn: it names a hole in
        # DELIVERY, so what it moves is the fold's currency, and the recovery
        # it triggers is started by ``apply`` off the ``DeliveryGap`` verdict,
        # or off a stale ``view/gap``'s ``IgnoredStaleFrame``, rather than from
        # here. Every other method is folded but routed to no turn.

        # The retired entries are gone from the set, so their replay memory
        # goes with them.
        if retirements:
            self._submit.forget_retired(retirements)
            sink.retirements.extend(retirements)
        return outcome

    def turn(self, turn_id: str) -> Turn[_I]:
        """The handle for a turn, created on first mention from either side.

        A turn the fold has already settled returns its settled handle, so a
        wait registered late resolves instead of hanging on an event that has
        passed. A CONSUMER asking about a turn this session has no news of,
        after the host died, must not hang: no answer is coming on this
        connection.
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

    def _handle(self, turn_id: str) -> TurnHandle[_I]:
        # A handle minted because a SERVER FRAME named this turn. Never
        # pre-failed, and that is what makes the post-death behaviour
        # order-independent (a durable death does not stop the fold, the governing rule, so
        # frames still arrive for a turn with no handle yet). A frame arriving
        # IS the connection still speaking; ``turn()`` keeps the latch for the
        # case that genuinely is a waiter with no answer coming.
        held = self._turns.get(turn_id)
        return held if held is not None else self._mint(turn_id)

    def _mint(self, turn_id: str) -> TurnHandle[_I]:
        fresh = TurnHandle(
            turn_id, lambda: self._items_of_turn(turn_id), self._turn_controls
        )
        self._turns[turn_id] = fresh
        return fresh

    def host_exited(
        self, exit_notification: HostDeathNotification
    ) -> HostDeathDischarge[_I]:
        """A host process exited or the transport reached EOF; classify it, and
        discharge the protocol if the profile demands it.

        REPORT EVERY NOTIFICATION OF THE DEATH — the exit AND transport EOF. A
        repeat report of an already-latched death is not a no-op: it marks END
        OF DRAIN and settles waits the drain minted after the first report. A
        consumer that dedupes and reports the death once leaves those waits
        pending forever.

        Args:
            exit_notification: The host exit classification, or the
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
            # The rule: the stores are left exactly as observed — the terminals
            # arrive on resume — so only the waiters are told.
            died = MuseHostDiedError(exit_notification)
            self._death_error = died
            for handle in self._turns.values():
                handle.fail(died)
            for stream in self._event_streams:
                stream.fail(died)
            self._event_streams.clear()
            self._discharge = _DurableDeath(profile=profile, exit=exit_notification)
            return self._discharge

        retired_commands = self._pending.discard_ephemeral()
        terminal_unknown_items = self._fold.mark_ephemeral_host_death(
            lambda item: is_item_in_progress(cast(Item, item))
        )
        for handle in self._turns.values():
            handle.settle_terminal_unknown()
        for stream in self._event_streams:
            stream.end()
        self._event_streams.clear()
        # the protocol "do not attempt to reattach". ``discard_ephemeral`` already
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

    # ---- the governing rule submit verb ------------------------

    async def send_user_turn(self, options: SendUserTurnOptions[_I]) -> Turn[_I]:
        """Submit a user turn and hand back THIS session's handle
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

    async def run(
        self,
        prompt: RunInput,
        *,
        display_text: str | None = None,
        if_busy: IfBusy | None = None,
        reasoning_effort: ReasoningEffort | None = None,
        workspace_roots: List[str] | None = None,
        user_shell: TurnUserShell | None = None,
    ) -> RunResult:
        """Run one turn to its end in a single call: submit ``prompt``, wait
        for the server to end the turn, and return its outcome, final answer
        text, items and usage. Use ``send_user_turn`` to stream items or
        deltas as they arrive.

        Cancelling the awaiting task stops the turn: while it is queued,
        ``turn/unqueue`` (then ``turn/cancel`` if it launched first); while it
        runs, ``turn/cancel``. A cancellation during the submit waits for its
        ack, which names the turn. ``run`` then waits for the server to end the
        turn and re-raises ``CancelledError``.

        Args:
            prompt: The input; a string is one text part.
            display_text: The wire ``displayText``.
            if_busy: The wire ``ifBusy``.
            reasoning_effort: The wire ``reasoningEffort``.
            workspace_roots: The wire ``workspaceRoots``.
            user_shell: The wire ``userShell``.

        Returns:
            The turn's result; a failed or cancelled turn still returns.
        """
        return await run_turn(
            self,
            SendUserTurnOptions(
                input=input_parts(prompt),
                display_text=display_text,
                if_busy=if_busy,
                reasoning_effort=reasoning_effort,
                workspace_roots=workspace_roots,
                user_shell=user_shell,
            ),
        )

    # ---- the governing rule approval round trip ------------------------------

    def on_approval(self, handler: ApprovalHandler) -> None:
        """Answer approvals with ``handler``. See
        :class:`~muse_code.facade.approval.ApprovalRouter`."""
        self._approvals.on_approval(handler)

    def on_approval_error(self, handler: ApprovalFailureHandler) -> None:
        """Observe round trips that did not complete. See
        :data:`~muse_code.facade.approval.ApprovalFailure`."""
        self._approvals.on_approval_error(handler)

    # ---- user-input answers ---------------------------------------------------

    async def answer_user_input(
        self, user_input_id: str, answers: Sequence[UserInputAnswer]
    ) -> UserInputAnswerResult:
        """Answer a question this session lists in ``fold.pending_user_inputs()``.

        Sends ``userInput/answer`` with one answer per question and returns
        the host's admission. The question leaves the pending list only when
        the server's ``userInput/settled`` arrives.

        Args:
            user_input_id: The question to answer.
            answers: One answer per question.

        Returns:
            The host's admission of the answer.

        Raises:
            MuseSessionDiscardedError: The session was discarded after an
                ephemeral host death; nothing is sent.
            RuntimeError: The session was constructed fold-only; nothing is sent.
            ProtocolError: The acknowledgement has no command id or names
                another question.
        """
        # Refused before anything is sent, as ``send_user_turn`` is: a
        # discarded session cannot be reattached.
        if self._discharge is not None and self._discharge.kind == "discharged":
            from ..errors import MuseSessionDiscardedError

            raise MuseSessionDiscardedError(
                f"session {self.session_id} was discarded after an ephemeral host "
                "death; it cannot answer a question"
            )
        connection = self._submit.require_connection("answer_user_input")
        # No explicit ``commandId``: ``Connection.command`` mints and stamps it,
        # and refuses an ack that echoes a different one. An ack with none is
        # refused here, with one naming another question.
        ack = await connection.command(
            "userInput/answer",
            {
                "sessionId": self.session_id,
                "userInputId": user_input_id,
                "answers": list(answers),
            },
        )
        if (
            not isinstance(ack.get("commandId"), str)
            or ack.get("userInputId") != user_input_id
        ):
            raise ProtocolError(
                f"userInput/answer acknowledged command {ack.get('commandId')} for "
                f"question {ack.get('userInputId')}, expected question {user_input_id}"
            )
        return cast(UserInputAnswerResult, ack)

    # ---- wire-present query and command facades -----------------------------------

    def _require_live_connection(self, verb: str) -> Connection:
        if self._discharge is not None and self._discharge.kind == "discharged":
            from ..errors import MuseSessionDiscardedError

            raise MuseSessionDiscardedError(
                f"session {self.session_id} was discarded after an ephemeral host "
                f"death; it cannot {verb}"
            )
        return self._submit.require_connection(verb)

    # The four read-only lists (here and ``MuseClient.list_sessions``)
    # ride ``request()``, not ``command()``: their wire params carry no
    # ``commandId``, and ``command()`` would retain one dedup entry per
    # call for the whole connection lifetime — a polling caller would
    # grow it without bound.

    async def list_tasks(self) -> TaskListResult:
        """List this session's live tasks (``task/list``)."""
        ack = await self._require_live_connection("list_tasks").request(
            "task/list", {"sessionId": self.session_id}
        )
        return cast(TaskListResult, ack)

    async def list_skills(self) -> SkillListResult:
        """List this session's user-invocable skills (``skill/list``)."""
        ack = await self._require_live_connection("list_skills").request(
            "skill/list", {"sessionId": self.session_id}
        )
        return cast(SkillListResult, ack)

    async def list_hooks(self) -> HookListResult:
        """List this session's installed hook rows (``hook/list``)."""
        ack = await self._require_live_connection("list_hooks").request(
            "hook/list", {"sessionId": self.session_id}
        )
        return cast(HookListResult, ack)

    async def pause_workflow(self, workflow_run_id: str) -> WorkflowControlResult:
        """Pause a live workflow run (``workflow/pause``)."""
        ack = await self._require_live_connection("pause_workflow").command(
            "workflow/pause",
            {"sessionId": self.session_id, "workflowRunId": workflow_run_id},
        )
        return cast(WorkflowControlResult, ack)

    async def resume_workflow(self, workflow_run_id: str) -> WorkflowResumeResult:
        """Resume a paused workflow run (``workflow/resume``)."""
        ack = await self._require_live_connection("resume_workflow").command(
            "workflow/resume",
            {"sessionId": self.session_id, "workflowRunId": workflow_run_id},
        )
        return cast(WorkflowResumeResult, ack)

    async def request_recap(self) -> RecapRequestResult:
        """Request a recap of this session (``recap/request``); admission only."""
        ack = await self._require_live_connection("request_recap").command(
            "recap/request", {"sessionId": self.session_id}
        )
        return cast(RecapRequestResult, ack)

    async def submit_feedback(
        self, input: FeedbackSubmitParams
    ) -> FeedbackSubmitResult:
        """Submit feedback about this session (``feedback/submit``).

        The session is facade-owned: ``input``'s ``sessionId`` member, if
        present, is always replaced with this session's id. The host
        serves the call only when the spawn requested the ``feedback``
        capability and install policy allows it; without that grant the
        host refuses it. Its wire params define no ``commandId`` (each call
        is one submit; the wire contract attaches no dedup), so it rides
        ``request()`` and mints none.
        """
        ack = await self._require_live_connection("submit_feedback").request(
            "feedback/submit", {**input, "sessionId": self.session_id}
        )
        return cast(FeedbackSubmitResult, ack)

    async def open_side_chat(self) -> SessionSideChatResult:
        """Open a side chat from this session (``session/sideChat``)."""
        ack = await self._require_live_connection("open_side_chat").command(
            "session/sideChat", {"sessionId": self.session_id}
        )
        return cast(SessionSideChatResult, ack)

    def _reclaim_queued(self, turn_id: str) -> PendingRetirement[_I] | None:
        # Retire this session's acked-queued entry for ``turn_id``, if any.
        for entry in self._pending.list():
            if (
                entry.ack is not None
                and entry.ack["turnId"] == turn_id
                and entry.ack["disposition"] == _QUEUED
            ):
                retired = self._pending.observed_reclaim(entry.command_id)
                if retired is not None:
                    self._submit.forget_retired([retired])
                return retired
        return None

    # ---- session control verbs ---------------------------------------------------

    async def _command(
        self, verb: str, method: str, params: WireParams, command_id: str | None = None
    ) -> WireParams:
        # One session-scoped command; the connection mints its ``commandId``
        # unless the caller resends one under its first id.
        return await self._require_live_connection(verb).command(
            method, {**params, "sessionId": self.session_id}, command_id=command_id
        )

    def _hold_stop(self, task: "asyncio.Future[None]") -> None:
        self._held_stops.add(task)
        task.add_done_callback(self._held_stops.discard)

    def _end_held_stops(self) -> "list[asyncio.Future[None]]":
        # The client's close ends the host these stops would send to, so it
        # cancels them and waits for them: no task outlives the close.
        held = list(self._held_stops)
        for task in held:
            task.cancel()
        return held

    def _resendable_unqueue(
        self, turn_id: str
    ) -> Callable[[], Awaitable[TurnUnqueueOutcome[_I]]]:
        # ``Session.run``'s abort: one reclaim under one ``commandId``, sent
        # again while the session runtime does not take it.
        command_id = self._require_live_connection("unqueue").mint_command_id()
        return lambda: self._turn_controls.unqueue(turn_id, command_id)

    async def fork(
        self,
        *,
        cut_point: ForkCutPoint | None = None,
        exclude_items: bool | None = None,
    ) -> SessionForkResult:
        """Fork this session into a new one (``session/fork``).

        Returns the wire result for the new session; opening a wired
        ``Session`` for it stays the caller's composition, as with
        :meth:`open_side_chat`.
        """
        params: WireParams = {}
        if cut_point is not None:
            params["cutPoint"] = cut_point
        if exclude_items is not None:
            params["excludeItems"] = exclude_items
        return cast(SessionForkResult, await self._command("fork", "session/fork", params))

    async def compact(self, *, turn_id: str | None = None) -> SessionCompactResult:
        """Compact this session's context (``session/compact``); admission
        only, or ``noop``."""
        params: WireParams = {} if turn_id is None else {"turnId": turn_id}
        return cast(
            SessionCompactResult, await self._command("compact", "session/compact", params)
        )

    async def set_model(self, model: ModelSelection) -> SessionSetModelResult:
        """Select the model for later model calls (``session/setModel``)."""
        return cast(
            SessionSetModelResult,
            await self._command("set_model", "session/setModel", {"model": model}),
        )

    async def set_reasoning_effort(
        self, reasoning_effort: ReasoningEffort
    ) -> SessionSetReasoningEffortResult:
        """Set this session's standing reasoning effort
        (``session/setReasoningEffort``)."""
        return cast(
            SessionSetReasoningEffortResult,
            await self._command(
                "set_reasoning_effort",
                "session/setReasoningEffort",
                {"reasoningEffort": reasoning_effort},
            ),
        )

    async def set_approval_mode(self, mode: ApprovalMode) -> SessionSetApprovalModeResult:
        """Select one of the host's preconfigured approval modes
        (``session/setApprovalMode``)."""
        return cast(
            SessionSetApprovalModeResult,
            await self._command("set_approval_mode", "session/setApprovalMode", {"mode": mode}),
        )

    async def rename(self, name: str) -> SessionRenameResult:
        """Set or change this session's stored name (``session/rename``)."""
        return cast(
            SessionRenameResult, await self._command("rename", "session/rename", {"name": name})
        )

    async def leave(self, *, stop: bool | None = None) -> SessionLeaveResult:
        """Release this session from the host (``session/leave``).

        ``stop=True`` also cancels unfinished work. Admission only: the host
        reports the release later as ``session/leaveCompleted``.
        """
        params: WireParams = {} if stop is None else {"stop": stop}
        return cast(SessionLeaveResult, await self._command("leave", "session/leave", params))

    async def _subagent(
        self, verb: str, method: str, subagent_id: str, extra: WireParams
    ) -> CommandAcceptedResult:
        return cast(
            CommandAcceptedResult,
            await self._command(verb, method, {**extra, "subagentId": subagent_id}),
        )

    async def send_subagent_message(self, subagent_id: str, body: str) -> CommandAcceptedResult:
        """Queue a note into a running subagent (``subagent/sendMessage``)."""
        return await self._subagent(
            "send_subagent_message", "subagent/sendMessage", subagent_id, {"body": body}
        )

    async def followup_subagent_task(self, subagent_id: str, body: str) -> CommandAcceptedResult:
        """Queue a follow-up task for a subagent (``subagent/followupTask``)."""
        return await self._subagent(
            "followup_subagent_task", "subagent/followupTask", subagent_id, {"body": body}
        )

    async def interrupt_subagent(
        self, subagent_id: str, *, reason: str | None = None
    ) -> CommandAcceptedResult:
        """Ask a subagent to yield at its next boundary (``subagent/interrupt``)."""
        return await self._subagent(
            "interrupt_subagent", "subagent/interrupt", subagent_id, _reason(reason)
        )

    async def stop_subagent(
        self, subagent_id: str, *, reason: str | None = None
    ) -> CommandAcceptedResult:
        """Stop a running subagent (``subagent/stop``)."""
        return await self._subagent("stop_subagent", "subagent/stop", subagent_id, _reason(reason))

    async def resume_subagent(self, subagent_id: str) -> CommandAcceptedResult:
        """Resume a paused or recoverable subagent (``subagent/resume``)."""
        return await self._subagent("resume_subagent", "subagent/resume", subagent_id, {})

    async def reopen_subagent(self, subagent_id: str) -> CommandAcceptedResult:
        """Reopen a stopped or closed subagent (``subagent/reopen``)."""
        return await self._subagent("reopen_subagent", "subagent/reopen", subagent_id, {})

    async def close_subagent(
        self, subagent_id: str, *, reason: str | None = None
    ) -> CommandAcceptedResult:
        """Close a subagent as its owner (``subagent/close``)."""
        return await self._subagent(
            "close_subagent", "subagent/close", subagent_id, _reason(reason)
        )

    async def read_subagent_result(self, subagent_id: str) -> CommandAcceptedResult:
        """Consume a subagent's ready result (``subagent/readResult``)."""
        return await self._subagent(
            "read_subagent_result", "subagent/readResult", subagent_id, {}
        )

    async def list_plugins(self) -> PluginListResult:
        """List this session's installed plugins (``plugin/list``); a query,
        like :meth:`list_tasks`."""
        ack = await self._require_live_connection("list_plugins").request(
            "plugin/list", {"sessionId": self.session_id}
        )
        return cast(PluginListResult, ack)

    async def install_plugin(self, target: PluginInstallTarget) -> PluginInstallResult:
        """Install one plugin from a marketplace or a host folder
        (``plugin/install``)."""
        return cast(
            PluginInstallResult,
            await self._command("install_plugin", "plugin/install", {"target": target}),
        )

    async def set_skill_activation(
        self,
        *,
        selector: str,
        scope: SkillActivationScope,
        activation: SkillActivationState,
    ) -> SkillSetActivationResult:
        """Turn one skill on or off in one scope (``skill/setActivation``)."""
        return cast(
            SkillSetActivationResult,
            await self._command(
                "set_skill_activation",
                "skill/setActivation",
                {"activation": activation, "scope": scope, "selector": selector},
            ),
        )

    # ---- consumer-driven pending-retirement verbs ---------------------------------

    def stop_retrying(self, command_id: str) -> PendingRetirement[_I] | None:
        """Stop the pending retry loop for one entry and take its input back.

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
        """Feed a consumer-driven replay's answer through the live pending
        settlement rules. ``"held"`` means the answer settled nothing."""
        settled = self._pending.replay_answered(command_id, answer)
        if settled != "held":
            self._submit.forget_retired([settled])
        return settled

    # ---- the protocol drivers that need client->server I/O ----

    async def resolve_snapshot_join(
        self, facts: SnapshotJoinFacts
    ) -> tuple[PendingRetirement[_I], ...]:
        """Resolve a snapshot join by performing the I/O its plan demands
        : same-``commandId`` resubmits FIRST, then the replays,
        then the reclaimed-signature verdict.

        The order is normative: the protocol requires an unacked entry be resubmitted
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
        # the protocol "Queue movement": a ``turn/started``/``turn/completed`` for a
        # turn that is not an entry's own decides that entry's fate at a launch
        # boundary, and the protocol carries no view event for a command-intake
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
        # An approval decision retires no pending command — it is not a
        # pending entry — but it still has to be awaitable through the same
        # ``io``, or a consumer has no barrier for the round trip it just
        # triggered.
        if decided is not None:
            tasks.append(_decided_io(decided))

    def _approval_updated(
        self,
        requested: ApprovalRequestParams,
        params: ApprovalUpdatedParams,
        tasks: List[Awaitable[tuple[PendingRetirement[_I], ...]]],
    ) -> None:
        decided = self._approvals.updated(requested, params)
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
        # the protocol "Materialized": the commandId-bearing ``userMessage`` landed,
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
