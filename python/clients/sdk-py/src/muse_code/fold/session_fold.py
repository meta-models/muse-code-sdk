"""``SessionFold`` — the client fold, bound to the generated wire types.

The two stores compose here, bound to ``muse_code_msp``'s shapes: items are
the generated ``Item`` dicts, state-family values are the generated
``session/*`` params objects, and every event this fold accepts is the params
object the wire actually carries. Nothing here restates a wire shape.

Beyond the two-store composition, the fold owns the parts of the view that
are neither an item nor a state family:

- the TURN LIFECYCLE — ``turn/started``, ``turn/completed``,
  ``turn/retracted``, ``turn/unqueued``, and the non-terminal
  ``turn/retryScheduled``;
- the APPROVAL and USER-INPUT view events as fold INPUTS — the pending sets
  and their first durable terminal. The decision flow (choosing and sending a
  resolution) is the facade's, not the fold's;
- the DELIVERY marker ``view/gap`` — it seeds no store, it moves the fold's
  CURRENCY (``pending_gap``/``current``). The recovery that fills the
  hole needs client-to-server I/O and is therefore the facade's.

One rule governs all of it: the fold never invents a terminal. A retract and a
reclaim are not ``TurnTerminal`` values and are never rendered as one, an
unrecognized ``TurnTerminal`` is kept verbatim, and a second resolution never
displaces the first durable one.

Where the TS facade seals its read surfaces at compile time
(``DeepReadonly``, interface allowlists), this port seals them at runtime
instead: ``items`` and ``session_state`` return thin read-only VIEWS that
expose no mutator at all — the same invariant, enforced in the idiom the
language has.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Literal, Mapping

from .item_store import (
    DeltaApplyOutcome,
    ItemApplyOutcome,
    ItemLike,
    ItemStore,
    TerminalUnknownItemAnnotation,
)
from .state_store import SessionStateStore, StateApplyOutcome, StateValue

Params = Mapping[str, Any]
"""A wire params object at runtime: a JSON object decoded to a dict."""

SESSION_STATE_METHODS: tuple[str, ...] = (
    "session/approvalModeChanged",
    "session/branchChanged",
    "session/contextUsage",
    "session/goalChanged",
    "session/modelChanged",
    "session/nameChanged",
    "session/reasoningEffortChanged",
    "session/todoListChanged",
    "session/tokenUsage",
)
"""The session-state families, each keyed in the store by its method name."""

VIEW_EVENT_METHODS: frozenset[str] = frozenset(
    (
        "item/started",
        "item/updated",
        "item/completed",
        "item/delta",
        "turn/started",
        "turn/completed",
        "turn/retracted",
        "turn/retryScheduled",
        "turn/unqueued",
        "approval/requested",
        "approval/updated",
        "approval/resolved",
        "userInput/requested",
        "userInput/settled",
        "view/gap",
        # The one-shot login-swap route disclosure (#25603, tdd SS4.6.8):
        # routed to its own non-storing outcome — a notice, never sticky
        # session state (a setModel repair would never clear a stored copy,
        # and a snapshot reseed would wipe it).
        "session/modelRouteUnserved",
    )
) | frozenset(SESSION_STATE_METHODS)
"""Every notification method this fold routes to its own arm.

Totality against the generated layer — every ``muse_code_msp.NOTIFICATIONS``
entry except the handshake's ``initialized`` and the live host-state
projections is a fold input — is pinned by ``test_session_fold.py``'s
coverage test, the runtime twin of the TS compile-time ``AssertNever`` pins.
"""

LIVE_HOST_STATE_PROJECTIONS: frozenset[str] = frozenset(
    ("skill/changed", "usage/changed", "session/statusChanged")
)
"""Notifications that are live host-state projections, not view events
(ADR 32471 D3, tdd SS3.22.2; ADR 32563 D3, tdd SS3.23): no ``viewCursor``,
no ``sourceRange``, nothing durable to fold. The consumer reaction is an
ACTION (re-issue ``skill/list``) or its own rendering (``usage/changed``
carries the full usage payload), so these ride the client's notification
callback
rather than this fold; the totality test pins the exclusion in both
directions, exactly like the TS fold's ``LiveHostStateProjection``."""

TurnState = Literal["running", "settled", "retracted", "unqueued"]
"""Where a turn stands. Client fold state — not a wire vocabulary."""


@dataclass(frozen=True)
class TurnEntry:
    """A turn as the fold has observed it.

    Attributes:
        turn_id: The wire turn id.
        state: Where the turn stands.
        command_id: The submitting command, when an event carried it.
        terminal: The server's terminal, verbatim. ``None`` unless
            ``turn/completed`` folded (INV-006).
        error: Present iff the terminal was ``"failed"`` (tdd SS4.5.1).
        retry_scheduled: The latest scheduled model retry; non-terminal
            (tdd SS4.5.1).
    """

    turn_id: str
    state: TurnState
    command_id: str | None = None
    terminal: str | None = None
    error: Params | None = None
    retry_scheduled: Params | None = None


@dataclass(frozen=True)
class PendingApproval:
    """An approval awaiting its first durable terminal.

    Attributes:
        approval_id: The wire approval id.
        requested: The (latest) ``approval/requested`` params, verbatim.
        latest_update: The most recent ``approval/updated`` refresh, if any.
    """

    approval_id: str
    requested: Params
    latest_update: Params | None = None


@dataclass(frozen=True)
class ItemFold:
    """An item event folded into the item store."""

    outcome: ItemApplyOutcome


@dataclass(frozen=True)
class ItemDeltaFold:
    """An ``item/delta`` folded into the item store's accumulators."""

    outcome: DeltaApplyOutcome


@dataclass(frozen=True)
class TurnFold:
    """A turn-lifecycle event folded."""

    turn_id: str
    state: TurnState


@dataclass(frozen=True)
class SessionStateFold:
    """A session-state event folded into the state store."""

    outcome: StateApplyOutcome


@dataclass(frozen=True)
class ApprovalPending:
    """An approval opened or refreshed; it awaits a durable terminal."""

    approval_id: str


@dataclass(frozen=True)
class ApprovalResolvedFold:
    """An approval's durable terminal folded.

    Attributes:
        approval_id: The wire approval id.
        first_terminal: ``False`` when a durable terminal had already landed;
            the first wins (tdd SS5).
    """

    approval_id: str
    first_terminal: bool


@dataclass(frozen=True)
class UserInputPending:
    """A user-input prompt opened or refreshed."""

    user_input_id: str


@dataclass(frozen=True)
class UserInputSettledFold:
    """A user-input prompt's durable settlement folded.

    Attributes:
        user_input_id: The wire prompt id.
        first_settlement: ``False`` when a settlement had already landed.
    """

    user_input_id: str
    first_settlement: bool


@dataclass(frozen=True)
class DeliveryGap:
    """A ``view/gap`` folded: push delivery dropped the open interval
    ``(after, next)``, so this fold is not current until a sanctioned
    recovery fills the hole (tdd SS4.8, FM-003).

    The bounds are the FRAME's own, verbatim — the coalesced outstanding hole
    is ``SessionFold.pending_gap``, which is what a recovery walks.
    """

    after: str
    next: str


@dataclass(frozen=True)
class ModelRouteUnservedNotice:
    """The one-shot ``session/modelRouteUnserved`` disclosure (tdd SS4.6.8).

    An accepted first-party login credential update installed a provider that
    cannot serve the session's STANDING model route. A notice, never sticky
    session state: it seeds no store — render it once; a routable
    ``session/setModel`` is the repair.
    """

    command_id: str
    installed_provider_id: str
    model_id: str
    provider_id: str | None


@dataclass(frozen=True)
class IgnoredUnrecognizedMethod:
    """A newer host's method this SDK has never heard of (SS1.5.4)."""

    method: str


@dataclass(frozen=True)
class IgnoredMissingParams:
    """A frame that carried no foldable ``params`` object.

    The wire's ``Notification`` declares ``params`` optional, and JSON-RPC
    permits ``null`` and positional arrays — none of which any arm can fold,
    since every one reads at least a ``sessionId``. Dropped rather than
    raised: SS1.5.4's posture is that a frame this SDK cannot fold leaves the
    rest of the fold intact, and an exception here would kill the embedding
    consumer's notification pump.
    """

    method: str


@dataclass(frozen=True)
class IgnoredStaleFrame:
    """A recognized frame the fold deliberately dropped, state unchanged.

    A ``turn/started`` or ``turn/completed`` for a turn that already left
    ``running``, an ``approval/updated`` for an approval it never saw
    requested (or whose entry a resolution already deleted), or a redelivered
    ``approval/requested`` / ``userInput/requested`` for an approval/prompt
    that already has its durable terminal. Truthful by contract: a "pending"
    outcome here would make a renderer show an entry the fold does not hold.
    """

    method: str
    id: str


FoldOutcome = (
    ItemFold
    | ItemDeltaFold
    | TurnFold
    | SessionStateFold
    | ApprovalPending
    | ApprovalResolvedFold
    | UserInputPending
    | UserInputSettledFold
    | DeliveryGap
    | ModelRouteUnservedNotice
    | IgnoredUnrecognizedMethod
    | IgnoredMissingParams
    | IgnoredStaleFrame
)
"""What one ``apply`` did — enough to drive a render without re-diffing."""


class FoldItems:
    """The fold's read-only view of its :class:`ItemStore`.

    Every mutation goes through :meth:`SessionFold.apply`; a directly
    reachable ``seed``/``apply_delta`` would let a consumer desync the
    composite view (items cleared, turn/pending maps not), breaking INV-002
    replay equality. An ALLOWLIST: this view defines exactly the read
    surface, so a mutator added to the store later never leaks onto it.
    """

    __slots__ = ("_store",)

    def __init__(self, store: ItemStore) -> None:
        """Wraps the fold-owned store; consumers never construct one."""
        self._store = store

    def accumulated(self, item_id: str, field: str = "text") -> str | None:
        """The accumulated delta text for a field path, or ``None``."""
        return self._store.accumulated(item_id, field)

    def accumulated_fields(self, item_id: str) -> list[str]:
        """Every field path with accumulated deltas, sorted."""
        return self._store.accumulated_fields(item_id)

    @property
    def ephemeral_session_discarded(self) -> bool:
        """Whether an ephemeral host death discarded this session."""
        return self._store.ephemeral_session_discarded

    def get(self, item_id: str) -> ItemLike | None:
        """The held item at its latest revision, or ``None``."""
        return self._store.get(item_id)

    def has(self, item_id: str) -> bool:
        """Whether the fold holds this item."""
        return self._store.has(item_id)

    def is_terminal_unknown(self, item_id: str) -> bool:
        """Whether this item carries the terminal-unknown annotation."""
        return self._store.is_terminal_unknown(item_id)

    def last_opened_item_id(self) -> str | None:
        """The id of the most recently opened item, or ``None``."""
        return self._store.last_opened_item_id()

    def list(self) -> list[ItemLike]:
        """Items in first-opened order (tdd SS4.9.1)."""
        return self._store.list()

    @property
    def size(self) -> int:
        """How many items the fold holds."""
        return self._store.size


class FoldSessionState:
    """The fold's read-only view of its :class:`SessionStateStore`.

    Families are keyed by notification method name (``session/*``). Named
    ``session_state`` on the fold rather than ``state`` because the surface
    contract reserves ``state`` for the FR-008 aggregate that arrives with
    snapshot ingestion.
    """

    __slots__ = ("_store",)

    def __init__(self, store: SessionStateStore) -> None:
        """Wraps the fold-owned store; consumers never construct one."""
        self._store = store

    def get(self, family: str) -> StateValue:
        """The family's held params object, ``None`` when absent or cleared."""
        return self._store.get(family)

    def has(self, family: str) -> bool:
        """Whether the family holds any fact (an explicit clear counts)."""
        return self._store.has(family)

    def families(self) -> list[str]:
        """Every family that holds a value, in insertion order."""
        return self._store.families()


@dataclass
class _InternalTurn:
    turn_id: str
    state: TurnState
    command_id: str | None = None
    terminal: str | None = None
    error: Params | None = None
    retry_scheduled: Params | None = None


@dataclass
class _InternalApproval:
    requested: Params
    latest_update: Params | None = None


class SessionFold:
    """The whole client-side session view: items, session state, turns, and
    the pending approval/user-input sets."""

    def __init__(self) -> None:
        """Create an empty fold."""
        self._item_store = ItemStore()
        self._state_store = SessionStateStore()
        self._items_view = FoldItems(self._item_store)
        self._state_view = FoldSessionState(self._state_store)
        self._turns: dict[str, _InternalTurn] = {}
        self._pending_approvals: dict[str, _InternalApproval] = {}
        self._resolved_approvals: dict[str, Params] = {}
        self._pending_user_inputs: dict[str, Params] = {}
        self._settled_user_inputs: dict[str, Params] = {}
        self._active_turn_id: str | None = None
        self._pending_gap: dict[str, str] | None = None

    @property
    def items(self) -> FoldItems:
        """Items, snapshot-only: the mutators are ``apply()``'s, not yours."""
        return self._items_view

    @property
    def session_state(self) -> FoldSessionState:
        """The session-state families, keyed by notification method name."""
        return self._state_view

    def mark_ephemeral_host_death(
        self, is_in_progress: Callable[[ItemLike], bool]
    ) -> list[TerminalUnknownItemAnnotation]:
        """Discharge the SS2.13.3b ephemeral host-death obligation.

        Every item still in progress becomes terminal-unknown and the fold
        refuses further item events (spec FM-002). A FOLD-level method rather
        than a ``FoldItems`` entry on purpose: ``items`` is snapshot-only and
        this IS a mutator. The in-progress probe stays the caller's, so the
        store remains wire-shape-blind (INV-638-01).

        Args:
            is_in_progress: The wire-aware probe, e.g.
                ``lambda item: item.get("status") == "inProgress"``.

        Returns:
            The terminal-unknown annotations, in first-opened item order.
        """
        return self._item_store.mark_ephemeral_host_death(is_in_progress)

    @property
    def active_turn_id(self) -> str | None:
        """The turn currently running, if one is."""
        return self._active_turn_id

    @property
    def pending_gap(self) -> Mapping[str, str] | None:
        """The outstanding delivery hole, or ``None`` (tdd SS4.8, FM-003).

        COALESCED, keeping the FIRST ``after``: consecutive overflows are one
        hole from a filler's point of view. A recovery walks
        ``(after, next)`` and calls :meth:`gap_filled` with the target it
        actually reached, so a hole that grew while the walk was in flight
        cannot be reported filled.
        """
        return self._pending_gap

    @property
    def current(self) -> bool:
        """Is this fold current with the session view?

        FM-003's "only then reports current": ``False`` from the moment a
        ``view/gap`` folds until its hole is filled. Live events keep folding
        meanwhile — they are real facts and dropping them would add a second
        hole — so this flag is the ONLY statement that the transcript has a
        hole in it.
        """
        return self._pending_gap is None

    def gap_filled(self, next_cursor: str) -> bool:
        """A recovery filled the hole up to ``next_cursor``.

        EQUALITY, never a relational compare (tdd SS4.1): the argument is the
        target the walk reached, and it clears only when that is still the
        outstanding target. A gap that arrived mid-walk left a newer
        ``next``, so this answers ``False`` and the fold stays not-current —
        the truthful answer, since the second hole is unfilled.

        Args:
            next_cursor: The ``next`` bound the walk actually reached.

        Returns:
            Whether the outstanding hole cleared.
        """
        if self._pending_gap is None or self._pending_gap["next"] != next_cursor:
            return False
        self._pending_gap = None
        return True

    def apply(self, event: Mapping[str, Any]) -> FoldOutcome:
        """Fold one view event (a wire notification's ``method`` + ``params``).

        The unrecognized-method arm is not defensive padding: the wire is an
        external boundary and SS1.5.4 makes a NEW notification additive
        evolution, so a host newer than this SDK really does reach it.
        Ignoring the frame keeps the rest of the fold intact, which is what
        tolerance means.

        Args:
            event: A mapping with ``method`` and (usually) ``params`` — the
                generated ``Notification`` frame folds as-is, envelope
                members tolerated.

        Returns:
            What the fold did with the frame.
        """
        method = str(event.get("method"))
        params = event.get("params")
        # `params: null`, a scalar, or a positional ARRAY are all legal
        # JSON-RPC spellings no arm can fold (every arm reads at least a
        # sessionId). Classify here so every caller inherits it (the TS
        # overload-pair rule).
        if not isinstance(params, dict):
            return IgnoredMissingParams(method)

        if method in ("item/started", "item/updated", "item/completed"):
            return ItemFold(self._item_store.apply(params["item"]))
        if method == "item/delta":
            return ItemDeltaFold(
                self._item_store.apply_delta(
                    params["itemId"], params["delta"], params.get("field", "text")
                )
            )
        if method == "turn/started":
            return self._turn_started(params)
        if method == "turn/completed":
            return self._turn_completed(params)
        if method == "turn/retracted":
            return self._turn_retracted(params)
        if method == "turn/unqueued":
            return self._turn_unqueued(params)
        if method == "turn/retryScheduled":
            return self._turn_retry_scheduled(params)
        if method == "approval/requested":
            return self._approval_requested(params)
        if method == "approval/updated":
            return self._approval_updated(params)
        if method == "approval/resolved":
            return self._approval_resolved(params)
        if method == "userInput/requested":
            return self._user_input_requested(params)
        if method == "userInput/settled":
            return self._user_input_settled(params)
        if method == "view/gap":
            return self._delivery_gap(params)
        if method == "session/modelRouteUnserved":
            return ModelRouteUnservedNotice(
                command_id=str(params.get("commandId", "")),
                installed_provider_id=str(params.get("installedProviderId", "")),
                model_id=str(params.get("modelId", "")),
                provider_id=(
                    None
                    if params.get("providerId") is None
                    else str(params.get("providerId"))
                ),
            )
        if method in SESSION_STATE_METHODS:
            return SessionStateFold(
                self._state_store.apply(method, params, params.get("viewCursor"))
            )
        return IgnoredUnrecognizedMethod(method)

    def turns(self) -> list[TurnEntry]:
        """Turns in first-observed order."""
        return [self._turn_snapshot(turn) for turn in self._turns.values()]

    def turn(self, turn_id: str) -> TurnEntry | None:
        """One turn's entry, or ``None`` if the fold never observed it."""
        held = self._turns.get(turn_id)
        return None if held is None else self._turn_snapshot(held)

    def pending_approvals(self) -> list[PendingApproval]:
        """Approvals awaiting a durable terminal, in first-observed order."""
        return [
            PendingApproval(
                approval_id=approval_id,
                requested=held.requested,
                latest_update=held.latest_update,
            )
            for approval_id, held in self._pending_approvals.items()
        ]

    def resolved_approvals(self) -> list[Params]:
        """The winning durable terminal per approval, in first-observed order."""
        return list(self._resolved_approvals.values())

    def pending_user_inputs(self) -> list[Params]:
        """Prompts awaiting a durable settlement, in first-observed order.

        The entries ARE the generated request params — the wire shape already
        carries ``userInputId``, so a wrapper would only duplicate it.
        """
        return list(self._pending_user_inputs.values())

    def settled_user_inputs(self) -> list[Params]:
        """The winning durable settlement per prompt, in first-observed order."""
        return list(self._settled_user_inputs.values())

    # ---- turn lifecycle -----------------------------------------------------

    def _turn_started(self, params: Params) -> FoldOutcome:
        # A turn the fold has already seen leave `running` never re-opens. A
        # redelivered `turn/started` after a terminal/retract/reclaim would
        # mint `{state: "running", terminal: ...}` — a shape TurnEntry's own
        # docs say cannot exist — and re-point `active_turn_id` at a turn no
        # completion will follow. `_turn_for` mints fresh entries as
        # `running`, so a first sighting (and a redelivery while genuinely
        # running) still folds.
        turn_id = str(params["turnId"])
        turn = self._turn_for(turn_id)
        if turn.state != "running":
            return IgnoredStaleFrame("turn/started", turn_id)
        turn.command_id = params.get("commandId")
        turn.state = "running"
        self._active_turn_id = turn_id
        return TurnFold(turn_id, turn.state)

    def _turn_completed(self, params: Params) -> FoldOutcome:
        # A turn the fold never saw start still settles here: single-shot and
        # gap-filled turns arrive terminal-first (tdd SS4.4.1's sibling rule).
        turn_id = str(params["turnId"])
        turn = self._turn_for(turn_id)
        # ...but a RETRACTED or RECLAIMED turn stays that way. Replaying the
        # completion frame that preceded an accepted retract would flip the
        # entry back to `settled` and lose the retract fact entirely.
        if turn.state in ("retracted", "unqueued"):
            return IgnoredStaleFrame("turn/completed", turn_id)
        turn.state = "settled"
        turn.terminal = params.get("terminal")
        if params.get("error") is not None:
            turn.error = params["error"]
        # The retry hint is a "retrying in Ns" countdown, and it clears on the
        # turn's next event — which a completion is (tdd SS4.5.1).
        turn.retry_scheduled = None
        self._clear_active(turn_id)
        return TurnFold(turn_id, turn.state)

    def _turn_retracted(self, params: Params) -> FoldOutcome:
        turn_id = str(params["turnId"])
        turn = self._turn_for(turn_id)
        turn.command_id = params.get("commandId")
        # A retract is NOT a TurnTerminal; leaving `terminal` unset is the
        # whole point (INV-006). The retracted user message re-arrives via
        # `item/updated` with `retracted: true`, which the item half folds.
        turn.state = "retracted"
        self._clear_active(turn_id)
        return TurnFold(turn_id, turn.state)

    def _turn_unqueued(self, params: Params) -> FoldOutcome:
        # The reclaim of a QUEUED submit: this turn was pre-minted at
        # admission and never launched, so no `turn/started` preceded it and
        # no `turn/completed` will follow (tdd SS3.6, SS4.5.1). It therefore
        # never becomes the active turn and never carries a terminal.
        turn_id = str(params["turnId"])
        turn = self._turn_for(turn_id)
        turn.command_id = params.get("commandId")
        turn.state = "unqueued"
        self._clear_active(turn_id)
        return TurnFold(turn_id, turn.state)

    def _turn_retry_scheduled(self, params: Params) -> FoldOutcome:
        # Non-terminal by contract: it never resolves a turn-wait (SS3.1.4).
        turn_id = str(params["turnId"])
        turn = self._turn_for(turn_id)
        # ...but it is still a turn frame, so it takes the same redelivery
        # guard as the other arms: a replayed page must not re-plant the hint
        # on a turn that already left `running`.
        if turn.state != "running":
            return IgnoredStaleFrame("turn/retryScheduled", turn_id)
        turn.retry_scheduled = params
        return TurnFold(turn_id, turn.state)

    def _turn_for(self, turn_id: str) -> _InternalTurn:
        held = self._turns.get(turn_id)
        if held is not None:
            return held
        fresh = _InternalTurn(turn_id=turn_id, state="running")
        self._turns[turn_id] = fresh
        return fresh

    def _clear_active(self, turn_id: str) -> None:
        if self._active_turn_id == turn_id:
            self._active_turn_id = None

    @staticmethod
    def _turn_snapshot(turn: _InternalTurn) -> TurnEntry:
        return TurnEntry(
            turn_id=turn.turn_id,
            state=turn.state,
            command_id=turn.command_id,
            terminal=turn.terminal,
            error=turn.error,
            retry_scheduled=turn.retry_scheduled,
        )

    # ---- the delivery-plane marker ------------------------------------------

    def _delivery_gap(self, params: Params) -> FoldOutcome:
        # Coalesced on the FIRST `after`: a second overflow while the first
        # hole is still open extends the range rather than replacing it.
        # Replacing it would move the lower bound past events that were never
        # delivered, so a walk from the newer `after` would skip them
        # permanently — a silent hole manufactured by the very state that
        # exists to name one.
        first_after = (
            self._pending_gap["after"] if self._pending_gap is not None else str(params["after"])
        )
        self._pending_gap = {
            "after": first_after,
            "next": str(params["next"]),
            "sessionId": str(params["sessionId"]),
        }
        # The FRAME's own bounds, not the coalesced ones: this is a report of
        # what arrived. `pending_gap` is the outstanding hole.
        return DeliveryGap(after=str(params["after"]), next=str(params["next"]))

    # ---- approvals and user input as fold inputs ----------------------------

    def _approval_requested(self, params: Params) -> FoldOutcome:
        approval_id = str(params["approvalId"])
        # A request for an approval that already has its durable terminal (a
        # redelivered or pre-join frame) never re-opens it: no second
        # resolution is coming, so the resurrected entry would pend forever
        # (tdd SS5's first-terminal-wins, request side).
        if approval_id in self._resolved_approvals:
            return IgnoredStaleFrame("approval/requested", approval_id)
        # A re-request REPLACES the entry, `latest_update` included: a
        # re-issued request already embodies the latest refresh (tdd SS5.6.3),
        # so pairing the new request with the OLD update would show stale
        # stage/choices and a decide against them bounces -32053.
        self._pending_approvals[approval_id] = _InternalApproval(requested=params)
        return ApprovalPending(approval_id)

    def _approval_updated(self, params: Params) -> FoldOutcome:
        # An update REFRESHES a pending view; it never opens one. An update
        # for an approval this fold never saw requested (a pre-join frame) is
        # dropped rather than synthesized into a request it cannot honestly
        # describe. A POST-RESOLVE update lands here too, because the resolve
        # deleted the entry; surfacing the failed-persistence report such a
        # frame can carry is the facade's, tracked by issue #23379.
        approval_id = str(params["approvalId"])
        held = self._pending_approvals.get(approval_id)
        if held is None:
            return IgnoredStaleFrame("approval/updated", approval_id)
        held.latest_update = params
        return ApprovalPending(approval_id)

    def _approval_resolved(self, params: Params) -> FoldOutcome:
        approval_id = str(params["approvalId"])
        self._pending_approvals.pop(approval_id, None)
        first_terminal = approval_id not in self._resolved_approvals
        # The FIRST durable terminal decision is the one that stands (tdd
        # SS5); a later one is a losing racer's echo, never an overwrite.
        if first_terminal:
            self._resolved_approvals[approval_id] = params
        return ApprovalResolvedFold(approval_id, first_terminal)

    def _user_input_requested(self, params: Params) -> FoldOutcome:
        user_input_id = str(params["userInputId"])
        # Symmetric with `_approval_requested`: a settled prompt stays settled.
        if user_input_id in self._settled_user_inputs:
            return IgnoredStaleFrame("userInput/requested", user_input_id)
        self._pending_user_inputs[user_input_id] = params
        return UserInputPending(user_input_id)

    def _user_input_settled(self, params: Params) -> FoldOutcome:
        user_input_id = str(params["userInputId"])
        self._pending_user_inputs.pop(user_input_id, None)
        first_settlement = user_input_id not in self._settled_user_inputs
        if first_settlement:
            self._settled_user_inputs[user_input_id] = params
        return UserInputSettledFold(user_input_id, first_settlement)
