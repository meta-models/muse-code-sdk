"""``PendingCommand``: the client-side fold over pending commands.

Normative source: the protocol's pending-command rules. This module
implements that subsection and does not re-derive it; every rule below
quotes or cites the clause it realizes. It is **client state only** — no
wire event, method, snapshot member, or durable record — and it never
crosses the wire.

The full fold is ``S' = f(S, server events, pending client events)``: server
events remain the only source of durable truth, and a ``PendingCommand``
entry is a rendering of the client's own intent.

The entry itself is client-local by ruling, and its join keys (``commandId``,
``turnId``, ``itemId``) are opaque strings by protocol rule.
The wire vocabulary it touches is fully generated: the ``turn/start`` ack and
the ``-32030`` ``commandRejected`` registry row come from ``muse_code_msp``,
so nothing below restates a wire shape.

Where the TS module binds its constants to closed generated UNIONS so a typo
fails ``tsc``, the Python rendering exposes the registry as the generated
``ERRORS`` table instead — the wire-binding test pins
``COMMAND_REJECTED_CODE``/``COMMAND_REJECTED_KIND`` to that table's
``commandRejected`` row, the same shape ``EXPECTED_SCHEMA_FINGERPRINT`` uses.

Faithful port of the TypeScript SDK's pending-command-set module.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Final, Generic, Iterable, List, Literal, Sequence, TypedDict, TypeVar, Union

from muse_code_msp import TurnStartDisposition

from muse_code.errors import MuseSessionDiscardedError

I = TypeVar("I")

COMMAND_REJECTED_CODE: Final[int] = -32030
"""The JSON-RPC code for a durable command rejection.

Named exactly once, here; ``tests/test_pending_command_wire_binding.py``
pins it to the generated ``muse_code_msp.ERRORS`` row for
``commandRejected``, so a schema advance that moves the code reds this lane
instead of silently leaving the SDK settling on a dead code.
"""

COMMAND_REJECTED_KIND: Final[str] = "commandRejected"
"""The registry row's ``kind``, pinned to the generated table by test.

The generated Python rendering keeps open enums as ``str``, so the
TS compile-time ``Extract<...>`` binding has no Python twin; the wire-binding
test is the misspelling guard here.
"""

_QUEUED_DISPOSITION: Final[str] = "queued"
"""The ``"queued"`` disposition; pinned to the generated
``TURN_START_DISPOSITION_KNOWN_VALUES`` by the wire-binding test."""

PendingDisposition = TurnStartDisposition
"""The ack's disposition — the generated wire vocabulary.

Open: an unrecognized value is "acked, not otherwise classified" and holds
like a started turn.
"""


class PendingCommandAck(TypedDict):
    """The ack a submit received: the turn it named, and how it was admitted.

    This IS the generated ``turn/start`` result's ``turnId``/``disposition``
    pair — a ``TurnStartResult`` off the wire is handed to ``acked()``
    unchanged (TypedDicts are structural, and the result carries both keys).
    """

    turnId: str
    disposition: TurnStartDisposition


@dataclass(frozen=True)
class CommandErrorResponse:
    """An error response to a submit, or to a ``commandId`` replay.

    Attributes:
        code: The JSON-RPC error code.
        kind: The ``error.data.kind`` (the open generated ``ErrorKind``).
        reason: ``commandRejected`` reason, verbatim snake_case; ``None`` when the error carried none.
    """

    code: int
    kind: str
    reason: str | None = None


@dataclass(frozen=True)
class ReplayAck(Generic[I]):
    """A replay answered with an ack (still pending, or freshly admitted)."""

    ack: PendingCommandAck


@dataclass(frozen=True)
class ReplayError:
    """A replay answered with an error response."""

    error: CommandErrorResponse


ReplayAnswer = Union[ReplayAck[I], ReplayError]
"""The answer to an idempotent ``commandId`` replay."""


@dataclass(frozen=True)
class PendingCommandEntry(Generic[I]):
    """An entry, as a consumer sees it: an immutable snapshot of internal state.

    Attributes:
        command_id: The client-minted ``commandId``.
        input: The submitted input, held for composer restoration.
        anchor_after_item_id: The item the entry renders AFTER — the last
            item present in the client's fold at submission time (``None`` =
            before every item). Fixed at insertion: server events folding in
            afterwards MUST NOT relocate it. A snapshot join may re-anchor a kept queued entry;
            nothing else moves it.
        submission_index: Monotonic submission order.
        display_text: Optional composer display text.
        ack: The ack received, when any.
        queued_order: Set at a snapshot join for a server-confirmed queued
            entry only.
    """

    command_id: str
    input: I
    anchor_after_item_id: str | None
    submission_index: int
    display_text: str | None = None
    ack: PendingCommandAck | None = None
    queued_order: int | None = None


@dataclass(frozen=True)
class MaterializedRetirement:
    """The command materialized.

    ``matched_by == "userMessage"``: the ``commandId``-bearing ``userMessage``
    folded in and ``item_id`` is that item's OWN id (item ids and command ids
    are separate namespaces on the wire). ``matched_by == "activeTurn"``: a
    snapshot's ``activeTurn.commandId`` matched; no user-message item id is in
    hand, so ``item_id`` is ``None`` and the caller renders from the
    snapshot's items.
    """

    command_id: str
    matched_by: Literal["userMessage", "activeTurn"]
    item_id: str | None = None
    kind: Literal["materialized"] = "materialized"


@dataclass(frozen=True)
class RejectedRetirement(Generic[I]):
    """Durably rejected (``-32030``). Nothing happened; restore the input."""

    command_id: str
    reason: str
    input: I
    kind: Literal["rejected"] = "rejected"
    restore_to_composer: Literal[True] = True


@dataclass(frozen=True)
class ReclaimedRetirement(Generic[I]):
    """Reclaimed: the turn never launched. Restore the input."""

    command_id: str
    input: I
    kind: Literal["reclaimed"] = "reclaimed"
    restore_to_composer: Literal[True] = True


@dataclass(frozen=True)
class AbandonedRetirement(Generic[I]):
    """Restart recovery settled the intake ``abandoned``."""

    command_id: str
    input: I
    kind: Literal["abandoned"] = "abandoned"
    restore_to_composer: Literal[True] = True


@dataclass(frozen=True)
class RetryAbandonedByClientRetirement(Generic[I]):
    """The client itself stopped retrying a nothing-admitted error.

    The protocol: "a client that stops retrying MUST retire the entry back to its
    composer rather than leave a durable-looking echo behind."
    """

    command_id: str
    input: I
    kind: Literal["retryAbandonedByClient"] = "retryAbandonedByClient"
    restore_to_composer: Literal[True] = True


@dataclass(frozen=True)
class TerminalUnknownRetirement(Generic[I]):
    """Ephemeral-profile host death.

    The client does not know what happened and MUST NOT invent it.
    """

    command_id: str
    input: I
    kind: Literal["terminalUnknown"] = "terminalUnknown"


PendingRetirement = Union[
    MaterializedRetirement,
    RejectedRetirement[I],
    ReclaimedRetirement[I],
    AbandonedRetirement[I],
    RetryAbandonedByClientRetirement[I],
    TerminalUnknownRetirement[I],
]
"""Why an entry left the set.

Every retirement is triggered by a server-authored fact; the set never
invents one.
"""


@dataclass(frozen=True)
class TurnRef:
    """A snapshot's ``(turnId, commandId)`` pair, as the caller assembled it."""

    turn_id: str
    command_id: str


@dataclass(frozen=True)
class UserMessageRef:
    """A ``commandId``-bearing ``userMessage`` item paired with its OWN item id.

    The caller holds both when building the join facts, and the pair keeps
    the materialized retirement's ``item_id`` a real item id on the
    resume/reconnect path exactly as on the live path.
    """

    command_id: str
    item_id: str


@dataclass(frozen=True)
class SnapshotJoinFacts:
    """Facts a snapshot supplies for the join.

    Attributes:
        active_turn: The running turn, when any.
        queued_turns: Admitted-but-not-launched submits, in launch order.
        user_message_command_ids: ``commandId``-bearing ``userMessage`` items
            in ``state.items``, each paired with the item's own id.
        last_item_id: The last item of the reconciled fold — where kept
            queued entries re-anchor.
    """

    active_turn: TurnRef | None
    queued_turns: Sequence[TurnRef]
    user_message_command_ids: Iterable[UserMessageRef]
    last_item_id: str | None


@dataclass(frozen=True)
class PendingJoinPlan(Generic[I]):
    """The work a join leaves for the caller.

    The set is transport-less: it names the I/O the protocol MUSTs require and
    the caller performs it, then feeds the answers back through
    ``replay_answered`` / ``acked``.

    Attributes:
        retirements: Retirements the join itself settled.
        must_replay: Acked entries the caller MUST resolve by replaying the
            ``commandId``.
        must_resubmit: Unacked entries the caller MUST resubmit with the
            SAME ``commandId`` before any retire-to-composer — demanded once
            per plan (the single ordered pass that builds a plan visits each
            entry once), re-demanded on each new join; the protocol idempotency
            makes the re-demand safe. A fresh-``commandId`` re-send is the
            double execution this ordering prevents.
        kept: Entries kept as server-confirmed pending, in their new render
            order.
    """

    retirements: tuple[PendingRetirement[I], ...]
    must_replay: tuple[str, ...]
    must_resubmit: tuple[str, ...]
    kept: tuple[str, ...]


@dataclass
class _InternalEntry(Generic[I]):
    command_id: str
    input: I
    anchor_after_item_id: str | None
    submission_index: int
    display_text: str | None = None
    ack: PendingCommandAck | None = None
    queued_order: int | None = None


Held = Literal["held"]
_HELD: Final[Held] = "held"
"""The not-a-settlement outcome: the entry stays pending."""


def is_settlement(error: CommandErrorResponse) -> bool:
    """Whether an error response durably settles a command.

    Only a durable ``commandRejected`` (``-32030``) settles; everything else
    admitted nothing.

    The registry binds ``-32030`` <-> ``commandRejected`` one-to-one
    , so a response where the two fields DISAGREE is a
    server fault in which one field still asserts the durable rejection.
    Either signal settles (OR): the protocol's stated bias for unfamiliar
    vocabulary is toward terminal ("treat unknown reasons as terminal
    rejections"), and holding forever on a half-asserted rejection strands
    the entry as the durable-looking echo the protocol forbids.

    Args:
        error: The error response to classify.

    Returns:
        True when the error settles the command.
    """
    return error.code == COMMAND_REJECTED_CODE or error.kind == COMMAND_REJECTED_KIND


@dataclass
class PendingCommandSet(Generic[I]):
    """The client-local pending-command set.

    Tracks the commands you have submitted that the server has not yet woven
    into the view: their optimistic display order, acknowledgements, replay
    answers at reconnect, and retirements. ``Session`` owns and drives one
    per conversation; read it through the session's pending view.

    A client that never renders optimistically simply holds no entries and
    the fold degenerates to the protocol — that is a supported mode, not a degraded
    one.

    Attributes:
        discarded_command_ids: Where ``discard_ephemeral()`` records the ids
            it retired, and where every replay guard reads. Injected BY
            REFERENCE so one client can share a single set across the
            sessions it opens: the clause constrains what this CLIENT does
            next, and a per-instance set would let a FRESH session replay a
            dead host's ids at a new host. Omitted, the set owns a private
            one and behaves exactly as before.
    """

    discarded_command_ids: set[str] = field(default_factory=set)
    _entries: dict[str, _InternalEntry[I]] = field(default_factory=dict, init=False)
    _discarded: bool = field(default=False, init=False)
    _next_submission_index: int = field(default=0, init=False)

    def submitted(
        self,
        command_id: str,
        input: I,  # noqa: A002 - the wire name
        *,
        display_text: str | None = None,
        anchor_after_item_id: str | None = None,
    ) -> None:
        """Records a submission.

        Args:
            command_id: The client-minted ``commandId``.
            input: The submitted input, held for composer restoration.
            display_text: Optional composer display text.
            anchor_after_item_id: The last item present in the client's fold
                right now.
        """
        # Replay check FIRST: for an id this set actually retired, "cannot be
        # replayed against a new host" is the precise diagnosis, and the
        # generic set-closed message below would bury it.
        self._assert_not_ephemeral_replay(command_id)
        # Then the whole SET, not just the ids it retired. A brand-new submit
        # after an ephemeral host died would otherwise be accepted and retired
        # terminalUnknown by the next discharge — "we don't know whether this
        # ran" about input provably never sent to any host, which is the
        # fabricated annotation the protocol exists to forbid.
        self._assert_session_active()
        if command_id in self._entries:
            # A resubmit of the same commandId is the sanctioned exactly-once
            # retry; it does not create a second entry and MUST NOT
            # move the original's anchor.
            return
        entry: _InternalEntry[I] = _InternalEntry(
            command_id=command_id,
            input=input,
            anchor_after_item_id=anchor_after_item_id,
            submission_index=self._next_submission_index,
        )
        self._next_submission_index += 1
        if display_text is not None:
            entry.display_text = display_text
        self._entries[command_id] = entry

    def acked(self, command_id: str, ack: PendingCommandAck) -> None:
        """Records that the submit (or a replay) was acked."""
        entry = self._entries.get(command_id)
        if entry is None:
            return
        entry.ack = ack

    def ack_errored(
        self, command_id: str, error: CommandErrorResponse
    ) -> PendingRetirement[I] | Held:
        """The submit (or a replay) answered with an error.

        Only a durable ``commandRejected`` (``-32030``) is a settlement.
        Every other error admits nothing — the other the protocol admission
        errors and the protocol's envelope errors, ``inputTooLarge`` among them — so
        the entry HOLDS while the client retries with the same ``commandId``.

        Returns:
            The retirement when the error settles; ``"held"`` otherwise.
        """
        entry = self._entries.get(command_id)
        if entry is None:
            return _HELD
        if not is_settlement(error):
            return _HELD
        return self._retire(entry, self._rejection_retirement(entry, error))

    def stop_retrying(self, command_id: str) -> PendingRetirement[I] | None:
        """The client has decided to stop retrying a nothing-admitted error.

        The entry must not linger as a durable-looking echo.

        Returns:
            The composer-restoring retirement, or ``None`` for no entry.
        """
        entry = self._entries.get(command_id)
        if entry is None:
            return None
        return self._retire(
            entry,
            RetryAbandonedByClientRetirement(command_id=command_id, input=entry.input),
        )

    def observed_user_message(
        self, command_id: str, item_id: str
    ) -> PendingRetirement[I] | None:
        """A ``userMessage`` item carrying this ``commandId`` folded in.

        The entry materialized and the item replaces it at the item's own
        transcript position.

        Multi-client echo de-duplication falls out of the same join: a
        ``userMessage`` with no matching local entry is another client's
        submission — this returns ``None`` and the caller renders it plainly.

        Returns:
            The materialized retirement, or ``None`` for no matching entry.
        """
        entry = self._entries.get(command_id)
        if entry is None:
            return None
        return self._retire(
            entry,
            MaterializedRetirement(
                command_id=command_id, matched_by="userMessage", item_id=item_id
            ),
        )

    def observed_reclaim(self, command_id: str) -> PendingRetirement[I] | None:
        """A reclaim this client actually observed.

        Its own reclaim ack, or any live fold the governing decision lane charters. Retire
        immediately — same composer restore, without waiting for a snapshot
        join.

        Returns:
            The reclaimed retirement, or ``None`` for no matching entry.
        """
        entry = self._entries.get(command_id)
        if entry is None:
            return None
        return self._retire(
            entry, ReclaimedRetirement(command_id=command_id, input=entry.input)
        )

    def observed_queue_movement(self, turn_id: str) -> tuple[str, ...]:
        """Queue movement: a turn event for a turn that is NOT the entry's own.

        The protocol carries no view event for a command-intake settlement, so a
        post-ack rejection reaches a live client only by replay: on each such
        event a client holding an acked-QUEUED entry MUST re-verify it by
        replaying its ``commandId``. Queue movement is the trigger precisely
        because a queued turn's fate is decided at its launch boundary — no
        polling loop and no invented timeout.

        Args:
            turn_id: The moved turn (``turn/started`` or ``turn/completed``).

        Returns:
            The ``commandId``\\ s the caller must replay.
        """
        out: List[str] = []
        for entry in self._entries.values():
            if entry.ack is None:
                continue
            if entry.ack["disposition"] != _QUEUED_DISPOSITION:
                continue
            if entry.ack["turnId"] == turn_id:  # the entry's own turn
                continue
            out.append(entry.command_id)
        return tuple(out)

    def replay_answered(
        self, command_id: str, answer: ReplayAnswer[I]
    ) -> PendingRetirement[I] | Held:
        """Feeds back a ``commandId`` replay answer.

        Three shapes, per the protocol's rejected/abandoned arms:

        - a durable rejection: retire (reason ``"abandoned"`` -> Abandoned
          arm, any other reason -> Rejected arm);
        - the original ack, still pending: keep waiting;
        - an ack whose staleness only a snapshot can prove: keep waiting —
          the reclaimed signature needs ``queuedTurns`` in hand
          (``join_snapshot``).

        Returns:
            The retirement when the answer settles; ``"held"`` otherwise.
        """
        self._assert_not_ephemeral_replay(command_id)
        entry = self._entries.get(command_id)
        if entry is None:
            return _HELD
        if isinstance(answer, ReplayAck):
            entry.ack = answer.ack
            return _HELD
        if not is_settlement(answer.error):
            return _HELD
        return self._retire(entry, self._rejection_retirement(entry, answer.error))

    def reconnected_without_snapshot(self) -> PendingJoinPlan[I]:
        """Reconnect with NO snapshot (the default cursor-resume path).

        There is no join to run, so reconnect itself is the trigger: replay
        each ACKED entry's ``commandId`` once; resubmit each UNACKED entry's
        same ``commandId`` once before any retire-to-composer.

        Without ``queuedTurns`` in hand the reclaimed signature is
        undecidable, so a stale ``"queued"`` ack waits for the next snapshot
        join or queue movement — never a locally invented terminal.

        Returns:
            The plan naming the replays and resubmits the caller owes.
        """
        # Once-per-plan comes from the single ordered pass (each entry is
        # visited exactly once); a NEW reconnect demands again, which the protocol
        # same-commandId idempotency makes safe — a once-per-lifetime latch
        # would strand an entry whose demand was lost to a second disconnect
        #.
        must_replay: List[str] = []
        must_resubmit: List[str] = []
        for entry in self._ordered():
            if entry.ack is None:
                must_resubmit.append(entry.command_id)
            else:
                must_replay.append(entry.command_id)
        return PendingJoinPlan(
            retirements=(),
            must_replay=tuple(must_replay),
            must_resubmit=tuple(must_resubmit),
            kept=tuple(e.command_id for e in self._ordered()),
        )

    def join_snapshot(self, facts: SnapshotJoinFacts) -> PendingJoinPlan[I]:
        """Joins local entries against an authoritative snapshot.

        By ``commandId``; the five arms, in the order the protocol states them.

        Args:
            facts: The snapshot's join surfaces, caller-assembled.

        Returns:
            The plan: retirements settled by the join, plus the replays and
            resubmits the caller owes.
        """
        # Once-per-plan comes from the single ordered pass below, exactly as
        # in reconnected_without_snapshot; a NEW join demands again, which
        # the protocol same-commandId idempotency makes safe (the protocol forbids
        # stranding an entry whose demand was lost to a second disconnect).
        retirements: List[PendingRetirement[I]] = []
        must_replay: List[str] = []
        must_resubmit: List[str] = []

        user_message_item_by_command_id: dict[str, str] = {
            pair.command_id: pair.item_id for pair in facts.user_message_command_ids
        }
        queued_index_by_command_id: dict[str, int] = {
            q.command_id: index for index, q in enumerate(facts.queued_turns)
        }

        for entry in self._ordered():
            command_id = entry.command_id

            # Arm 1 — materialized: a userMessage item (its own item id is in
            # the join facts), or the activeTurn's commandId (no item id in
            # hand — the retirement says so via matched_by, never aliasing
            # the command id).
            user_message_item_id = user_message_item_by_command_id.get(command_id)
            if user_message_item_id is not None:
                retirements.append(
                    self._retire(
                        entry,
                        MaterializedRetirement(
                            command_id=command_id,
                            matched_by="userMessage",
                            item_id=user_message_item_id,
                        ),
                    )
                )
                continue
            if facts.active_turn is not None and facts.active_turn.command_id == command_id:
                retirements.append(
                    self._retire(
                        entry,
                        MaterializedRetirement(
                            command_id=command_id, matched_by="activeTurn"
                        ),
                    )
                )
                continue

            # Arm 2 — server-confirmed queued: keep, reordered to queuedTurns
            # order.
            queued_index = queued_index_by_command_id.get(command_id)
            if queued_index is not None:
                entry.queued_order = queued_index
                # A kept entry re-anchors after the last item of the
                # reconciled fold.
                entry.anchor_after_item_id = facts.last_item_id
                continue

            # Arm 3 — an acked STEER matches neither activeTurn.commandId nor
            # queuedTurns by design: it is pending on the running turn's
            # PendingSteerQueue, not settled. Keep it as
            # server-confirmed pending; retiring here shows "never ran" and
            # then double-sends when the steer delivers. A steer keeps its
            # submission anchor — it has no launch position.
            if (
                entry.ack is not None
                and facts.active_turn is not None
                and entry.ack["turnId"] == facts.active_turn.turn_id
            ):
                continue

            # Arm 4 — acked, matching nothing: resolve by replaying the
            # commandId.
            if entry.ack is not None:
                must_replay.append(command_id)
                continue

            # Arm 5 — unacked, and the join did not match it. The intake is
            # durable BEFORE the ack, and a join miss does not
            # prove the intake was never written (a parked steer is in none
            # of the join surfaces), so demand a SAME-commandId resubmit
            # before any retire-to-composer.
            must_resubmit.append(command_id)

        return PendingJoinPlan(
            retirements=tuple(retirements),
            must_replay=tuple(must_replay),
            must_resubmit=tuple(must_resubmit),
            kept=tuple(e.command_id for e in self._ordered()),
        )

    def resolve_replay_at_join(
        self,
        command_id: str,
        answer: ReplayAnswer[I],
        snapshot_queued_command_ids: Iterable[str],
    ) -> PendingRetirement[I] | Held:
        """Resolves a ``must_replay`` answer with the snapshot in hand.

        The reclaimed signature, decidable only with a snapshot: an
        acked-queued entry ABSENT from the snapshot's ``queuedTurns`` whose
        replay still answers the stale ``"queued"`` ack retires as
        *reclaimed* at the snapshot join.

        Call this with the replay answer for a ``must_replay`` entry produced
        by ``join_snapshot``, passing the same snapshot's ``queuedTurns``
        command ids.

        Returns:
            The retirement when the answer settles; ``"held"`` otherwise.
        """
        self._assert_not_ephemeral_replay(command_id)
        entry = self._entries.get(command_id)
        if entry is None:
            return _HELD

        if isinstance(answer, ReplayError):
            if not is_settlement(answer.error):
                return _HELD
            return self._retire(entry, self._rejection_retirement(entry, answer.error))

        still_queued_by_server = command_id in set(snapshot_queued_command_ids)
        if answer.ack["disposition"] == _QUEUED_DISPOSITION and not still_queued_by_server:
            # The snapshot just proved this ack stale.
            return self._retire(
                entry, ReclaimedRetirement(command_id=command_id, input=entry.input)
            )

        # A still-pending "steered" or "started" ack: the entry stays pending
        # and materializes or settles later. Never promote it locally.
        entry.ack = answer.ack
        return _HELD

    def discard_ephemeral(self) -> tuple[PendingRetirement[I], ...]:
        """Abnormal death of an EPHEMERAL-profile host.

        Nothing is ever settled, replaying a ``commandId`` at a new host is
        forbidden, and every entry falls under the discard obligation as
        terminal-unknown — a client-side annotation, never a wire fact.

        Returns:
            One terminal-unknown retirement per discarded entry.
        """
        out: List[PendingRetirement[I]] = []
        for entry in self._ordered():
            self.discarded_command_ids.add(entry.command_id)
            out.append(
                self._retire(
                    entry,
                    TerminalUnknownRetirement(
                        command_id=entry.command_id, input=entry.input
                    ),
                )
            )
        self._discarded = True
        return tuple(out)

    @property
    def discarded(self) -> bool:
        """Whether the ephemeral discard has closed this set."""
        return self._discarded

    def list(self) -> tuple[PendingCommandEntry[I], ...]:
        """Entries in render order.

        Before any join this is submission order. After a join, entries the
        server confirmed queued are re-anchored to the end of the reconciled
        fold and ordered among themselves by ``queuedTurns`` — so they sort
        after the submission-anchored entries (steers and unacked), which
        keep their own anchors. That is the protocol's "entries render in
        submission order, and for queued submits the server-confirmed order
        wins whenever it is observed".

        Returns:
            Immutable entry snapshots, in render order.
        """
        return tuple(
            PendingCommandEntry(
                command_id=entry.command_id,
                input=entry.input,
                anchor_after_item_id=entry.anchor_after_item_id,
                submission_index=entry.submission_index,
                display_text=entry.display_text,
                ack=entry.ack,
                queued_order=entry.queued_order,
            )
            for entry in self._ordered()
        )

    def get(self, command_id: str) -> PendingCommandEntry[I] | None:
        """The entry snapshot for ``command_id``, or ``None``."""
        for entry in self.list():
            if entry.command_id == command_id:
                return entry
        return None

    def has(self, command_id: str) -> bool:
        """Whether an entry with ``command_id`` is pending."""
        return command_id in self._entries

    @property
    def size(self) -> int:
        """The number of pending entries."""
        return len(self._entries)

    def _assert_session_active(self) -> None:
        if self._discarded:
            raise MuseSessionDiscardedError(
                "ephemeral session was discarded after abnormal host death; "
                "it accepts no new submissions"
            )

    def _assert_not_ephemeral_replay(self, command_id: str) -> None:
        if command_id in self.discarded_command_ids:
            raise MuseSessionDiscardedError(
                f"ephemeral host died; commandId `{command_id}` cannot be "
                "replayed against a new host"
            )

    def _rejection_retirement(
        self, entry: _InternalEntry[I], error: CommandErrorResponse
    ) -> PendingRetirement[I]:
        reason = error.reason if error.reason is not None else ""
        if reason == "abandoned":
            return AbandonedRetirement(command_id=entry.command_id, input=entry.input)
        return RejectedRetirement(
            command_id=entry.command_id, reason=reason, input=entry.input
        )

    def _retire(
        self, entry: _InternalEntry[I], retirement: PendingRetirement[I]
    ) -> PendingRetirement[I]:
        del self._entries[entry.command_id]
        return retirement

    def _ordered(self) -> List[_InternalEntry[I]]:
        submission_anchored: List[_InternalEntry[I]] = []
        launch_ordered: List[_InternalEntry[I]] = []
        for entry in self._entries.values():
            if entry.queued_order is None:
                submission_anchored.append(entry)
            else:
                launch_ordered.append(entry)
        submission_anchored.sort(key=lambda e: e.submission_index)
        launch_ordered.sort(key=lambda e: e.queued_order or 0)
        return [*submission_anchored, *launch_ordered]
