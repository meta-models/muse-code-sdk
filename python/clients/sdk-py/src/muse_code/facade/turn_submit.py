"""``turn/start`` submission and same-``commandId`` replay. Port of the
TypeScript SDK's turn-submit module.

It holds the ONE piece of state :class:`~muse_code.pending.PendingCommandSet`
deliberately cannot: the ``turn/start`` params per ``commandId``. The set
stores the COMPOSER input and is wire-blind by design, so a
replay — which must re-send the SAME logical command to be the sanctioned
retry rather than a double execution — needs the params on this side of that
boundary.
"""

from __future__ import annotations

from dataclasses import dataclass, fields
from typing import Generic, List, Sequence, TypeVar, cast

from muse_code_msp import (
    IfBusy,
    ReasoningEffort,
    TurnInputPart,
    TurnStartParams,
    TurnStartResult,
)

from ..connection.connection import Connection, MspError, Params
from ..pending.pending_command_set import (
    CommandErrorResponse,
    PendingCommandAck,
    PendingCommandSet,
    PendingRetirement,
    ReplayAck,
    ReplayAnswer,
    ReplayError,
)

_I = TypeVar("_I")


@dataclass
class SendUserTurnOptions(Generic[_I]):
    """What :meth:`Session.send_user_turn` sends, composed from the generated
    ``turn/start`` params rather than restated (INV-638-02).

    ``commandId`` is excluded because ``Connection`` is the single minter
    (INV-638-04 carrying INV-013); ``sessionId`` because the session already
    knows its own and a caller-supplied one could only disagree.

    Attributes:
        input: The turn's input parts (the wire ``input`` member).
        display_text: Optional composer display text (wire ``displayText``).
        if_busy: How to treat a submit while a turn runs (wire ``ifBusy``).
        reasoning_effort: The turn's reasoning effort (wire
            ``reasoningEffort``).
        composer_input: What to hand back to the composer if this submit is
            ever retired — SS4.13 restores the INPUT, not the wire parts.
            Optional: a consumer rendering nothing optimistically has nothing
            to restore.
    """

    input: List[TurnInputPart]
    display_text: str | None = None
    if_busy: IfBusy | None = None
    reasoning_effort: ReasoningEffort | None = None
    composer_input: _I | None = None


def _camel(field_name: str) -> str:
    """snake_case → camelCase, the C-638-1 facade→wire member mapping.

    The single copy: ``client.py`` imports this for its own drift pins rather
    than restating it (that direction has no import cycle — this module reaches
    neither ``client`` nor ``session``).
    """
    head, *rest = field_name.split("_")
    return head + "".join(part.capitalize() for part in rest)


# Drift pin — the Python twin of the TS `AssertNever` on TURN_START_FORWARDED
# (turn-submit.ts). A schema regen that adds a member to TurnStartParams but not
# to SendUserTurnOptions reds THIS import, so a regenerated member cannot
# silently fail to reach the wire (INV-638-02). `composer_input` is the SDK's
# own field (the SS4.13 restore payload), never a wire member, so it is dropped
# before the compare; `commandId`/`sessionId` are excluded because the
# connection mints the first and the session owns the second.
_TURN_WIRE_FIELDS = {"input", "display_text", "if_busy", "reasoning_effort"}
_TURN_EXCLUDED = {"commandId", "sessionId"}
assert {
    _camel(f.name) for f in fields(SendUserTurnOptions) if f.name in _TURN_WIRE_FIELDS
} | _TURN_EXCLUDED == set(
    TurnStartParams.__annotations__
), "SendUserTurnOptions drifted from TurnStartParams — forward the new member"


def command_error_response(error: BaseException) -> CommandErrorResponse | None:
    """An :class:`MspError` as the pending set reads it (SS4.13's settlement
    test).

    ``None`` for anything that is NOT a server-authored MSP error — a
    :class:`ProtocolError`, a dead transport — because those admit nothing AND
    prove nothing about the intake, so the entry must HOLD rather than be
    judged.

    Args:
        error: The exception a submit or replay raised.

    Returns:
        The typed response, or ``None`` for a non-MSP failure.
    """
    if not isinstance(error, MspError):
        return None
    reason = error.data.get("reason")
    return CommandErrorResponse(
        code=error.code,
        kind=error.kind,
        reason=reason if isinstance(reason, str) else None,
    )


class TurnSubmitter(Generic[_I]):
    """Shapes ``turn/start`` frames, records the optimistic SS4.13 entry, and
    replays a remembered command under its original ``commandId``."""

    def __init__(
        self,
        session_id: str,
        connection: Connection | None,
        pending: PendingCommandSet[_I],
    ) -> None:
        """Binds the submitter; ``connection`` is ``None`` on a fold-only
        session."""
        self._session_id = session_id
        self._connection = connection
        self._pending = pending
        # See the module doc. Pruned on retirement, so it tracks the set.
        self._memory: dict[str, Params] = {}

    @property
    def wired(self) -> bool:
        """Whether a connection is present to author through."""
        return self._connection is not None

    def require_connection(self, verb: str) -> Connection:
        """The connection, or a plain error naming the fold-only misuse.

        A plain :class:`Exception`: calling a submit verb on a fold-only
        session is API misuse, not the foreign-frame STATE
        :class:`MuseForeignSessionError` names.

        Args:
            verb: The verb name, for the error message.

        Returns:
            The live connection.

        Raises:
            RuntimeError: This session was constructed fold-only.
        """
        if self._connection is None:
            raise RuntimeError(
                f"{verb} needs a connection; this Session was constructed fold-only"
            )
        return self._connection

    async def submit(
        self, options: SendUserTurnOptions[_I], anchor_after_item_id: str | None
    ) -> PendingCommandAck:
        """Records the optimistic SS4.13 entry, then sends ``turn/start``.

        The ORDER is the point. An entry created only on the ack is invisible
        for exactly the window it exists to cover — between the user pressing
        enter and the host answering — and ``anchor_after_item_id`` is fixed
        here, at submission time, because SS4.13's insertion point may never
        be relocated by events that fold in afterwards.

        Args:
            options: The caller's turn options.
            anchor_after_item_id: The last item the session holds now.

        Returns:
            The admission ack (``turnId`` + ``disposition``).
        """
        connection = self.require_connection("send_user_turn")
        # Delegated, not re-implemented: the connection owns the single mint,
        # so INV-013's single-minter property survives this verb needing the
        # id early.
        command_id = connection.mint_command_id()
        params = self._params(command_id, options)
        self._pending.submitted(
            command_id,
            # ``composer_input`` is optional on the options object; a consumer
            # rendering nothing optimistically has nothing to restore, and the
            # set stores whatever it is handed for restoration. ``None`` is a
            # valid stored input, so the cast preserves it rather than
            # inventing a value.
            cast(_I, options.composer_input),
            display_text=params.get("displayText"),
            anchor_after_item_id=anchor_after_item_id,
        )
        self._memory[command_id] = params
        try:
            ack = await self._send(connection, params, command_id)
            self._pending.acked(command_id, ack)
            return ack
        except MspError as error:
            response = command_error_response(error)
            # Only a durable -32030 settles; every other error admitted
            # nothing and the entry HOLDS for the caller's same-commandId
            # retry (SS4.13).
            if response is not None:
                settled = self._pending.ack_errored(command_id, response)
                if settled != "held":
                    self.forget_retired([settled])
            # Re-raised, deliberately: the caller who submitted still holds its
            # own input, so this path needs no second retirement channel.
            raise

    async def replay(self, command_id: str) -> ReplayAnswer[_I] | None:
        """Re-sends one remembered ``turn/start`` under its ORIGINAL
        ``commandId`` (SS3.1.1 — always safe, the only re-send that is not a
        double execution).

        Args:
            command_id: The command to replay.

        Returns:
            The answer, or ``None`` for "no answer this set can act on" —
            either this session never authored the command, or the failure was
            transport/protocol, which proves nothing about the intake.
        """
        params = self._memory.get(command_id)
        if params is None:
            return None
        connection = self.require_connection("turn/start replay")
        try:
            ack = await self._send(connection, params, command_id)
            return ReplayAck(ack=ack)
        except MspError as error:
            response = command_error_response(error)
            if response is None:
                return None
            return ReplayError(error=response)

    async def drive_replay(
        self, command_id: str, into: List[PendingRetirement[_I]]
    ) -> None:
        """Replay one entry and feed the answer back through the live SS4.13
        rules."""
        answer = await self.replay(command_id)
        if answer is None:
            return
        settled = self._pending.replay_answered(command_id, answer)
        if settled != "held":
            into.append(settled)

    def forget_retired(
        self, retirements: Sequence[PendingRetirement[_I]]
    ) -> None:
        """Drop the replay memory for retired entries so it tracks the set."""
        for retirement in retirements:
            self._memory.pop(retirement.command_id, None)

    async def _send(
        self, connection: Connection, params: Params, command_id: str
    ) -> PendingCommandAck:
        raw = await connection.command("turn/start", params, command_id=command_id)
        result: TurnStartResult = raw  # type: ignore[assignment]
        # ``turnId`` comes from the ACK, never from the ``commandId``: SS3.2
        # makes the ack authoritative, and a queued submit's turn may already
        # exist.
        return PendingCommandAck(
            turnId=result["turnId"], disposition=result["disposition"]
        )

    def _params(self, command_id: str, options: SendUserTurnOptions[_I]) -> Params:
        # OPTIONAL MEANS OMITTED, NEVER null (tdd SS1.2): an unset member is
        # dropped from the frame rather than nulled.
        params: Params = {
            "commandId": command_id,
            "input": options.input,
            "sessionId": self._session_id,
        }
        if options.display_text is not None:
            params["displayText"] = options.display_text
        if options.if_busy is not None:
            params["ifBusy"] = options.if_busy
        if options.reasoning_effort is not None:
            params["reasoningEffort"] = options.reasoning_effort
        return params
