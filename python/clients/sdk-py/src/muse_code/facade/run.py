"""``Session.run`` — one call from a prompt to the turn's final answer. Port of
the TypeScript SDK's run module.

Built only from facade verbs the session already has: ``send_user_turn``, the
turn-wait, ``items()``, and ``unqueue``/``cancel`` when the awaiting task is
cancelled. It holds no state of its own (the session holds a stop that
outlives a second cancellation) and reaches the fold and the pending set only
through those verbs and the read-only pending view, so every pending command
rule keeps applying exactly as for a hand-written ``send_user_turn`` loop.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import TYPE_CHECKING, List, Sequence, Tuple, TypeVar, Union

from muse_code_msp import (
    COMMAND_STATUS_KNOWN_VALUES,
    ITEM_KIND_KNOWN_VALUES,
    ITEM_STATUS_KNOWN_VALUES,
    MESSAGE_PHASE_KNOWN_VALUES,
    TURN_START_DISPOSITION_KNOWN_VALUES,
    TokenUsage,
    TurnInputPart,
)

from ..connection import connection as connection_module
from ..connection.connection import MspError
from ..pending.pending_command_set import COMMAND_REJECTED_KIND
from .turn_handle import FoldedItem, Turn, TurnOutcome
from .turn_submit import SendUserTurnOptions

if TYPE_CHECKING:
    from collections.abc import Awaitable

    from .session import Session

_I = TypeVar("_I")

# Read from the generated KNOWN_VALUES so a typo fails at import, the runtime
# twin of the TS closed-vocabulary bind.
_AGENT_MESSAGE = "agentMessage"
_COMPLETED = "completed"
_RUNTIME_BUSY = "runtime_busy"
_COMMENTARY = "commentary"
_ACCEPTED = "accepted"
_QUEUED = "queued"
assert _AGENT_MESSAGE in ITEM_KIND_KNOWN_VALUES
assert _COMPLETED in ITEM_STATUS_KNOWN_VALUES
assert _COMMENTARY in MESSAGE_PHASE_KNOWN_VALUES
assert _ACCEPTED in COMMAND_STATUS_KNOWN_VALUES
assert _QUEUED in TURN_START_DISPOSITION_KNOWN_VALUES

RunInput = Union[str, Sequence[TurnInputPart]]
"""What ``run`` submits: a string is one text part; a sequence goes verbatim."""


@dataclass(frozen=True)
class RunResult:
    """What ``run`` returns once the server has ended the turn.

    Attributes:
        turn_id: The turn the ``turn/start`` ack named.
        outcome: The server-authored outcome; a failed or cancelled turn still
            returns.
        final_text: The ``text`` of the turn's last ``agentMessage`` item (in
            first-opened order) that completed and is not ``"commentary"``: an
            absent or unknown ``messagePhase`` on a completed item reads as
            ``"finalAnswer"``. ``None`` when the turn produced no such item.
        items: The turn's items as the fold holds them at the end, in
            first-opened order.
        usage: The turn's token usage from ``turn/completed``; ``None`` on
            other outcomes.
    """

    turn_id: str
    outcome: TurnOutcome
    final_text: str | None
    items: Tuple[FoldedItem, ...]
    usage: TokenUsage | None


def input_parts(prompt: RunInput) -> List[TurnInputPart]:
    """A string becomes one text part; a sequence is copied verbatim."""
    if isinstance(prompt, str):
        return [{"text": prompt, "type": "text"}]
    return list(prompt)


async def run_turn(session: "Session[_I]", options: SendUserTurnOptions[_I]) -> RunResult:
    """Submit ``options`` and wait for the turn's end; see ``Session.run``."""
    # Shielded: once `turn/start` is on the wire only its ack names the turn,
    # so a cancellation that lands first still needs that ack to stop it.
    submitting = asyncio.ensure_future(session.send_user_turn(options))
    try:
        turn = await asyncio.shield(submitting)
    except asyncio.CancelledError:
        await _held(session, _stop_once_submitted(session, submitting))
        raise
    try:
        outcome = await turn.completed
    except asyncio.CancelledError:
        await _held(session, _stop_and_settle(session, turn))
        raise
    # The turn has settled, so this replays the fold's items at their latest
    # revision and ends; it never waits.
    items = tuple([item async for item in turn.items()])
    return RunResult(
        turn_id=turn.turn_id,
        outcome=outcome,
        final_text=_final_answer_text(items),
        items=items,
        usage=outcome.params.get("usage") if outcome.kind == "completed" else None,
    )


async def _held(session: "Session[_I]", stop: "Awaitable[None]") -> None:
    # Held by the session, so a second cancellation raises at once while the stop
    # goes on, as the TypeScript stop does; it ends when it settles, the client
    # closes or the loop tears down, and it closes nothing.
    task = asyncio.ensure_future(stop)
    session._hold_stop(task)
    await asyncio.shield(task)


async def _stop_once_submitted(
    session: "Session[_I]", submitting: "asyncio.Future[Turn[_I]]"
) -> None:
    submitted = await _submitted(submitting)
    if submitted is not None:
        await _stop_and_settle(session, submitted)


async def _submitted(submitting: "asyncio.Future[Turn[_I]]") -> Turn[_I] | None:
    # A refused submit names no turn, so there is nothing to stop.
    try:
        return await submitting
    except Exception:
        return None


async def _stop_and_settle(session: "Session[_I]", turn: Turn[_I]) -> None:
    # A fresh turn-wait is already done when the turn ended before this
    # cancellation could act (same tick as its terminal, or terminal before the
    # submit's ack); there is nothing left to stop, so nothing is sent.
    ended = asyncio.ensure_future(turn.completed)
    if not ended.done():
        await _stop(session, turn)
    # The turn's end is the server's to report. Waiting for it leaves the
    # session idle when the cancellation propagates, and the turn-wait settles
    # on every exit, host death included.
    with contextlib.suppress(Exception):
        await ended


async def _stop(session: "Session[_I]", turn: Turn[_I]) -> None:
    """Unqueue the turn while this session holds its queued entry and no
    ``turn/started`` has folded; otherwise, or when the unqueue loses the
    launch race (the host rejects it, never upgrading it to a cancel), cancel
    it. A refused stop is not reported: the turn-wait awaited next is what
    reports how the turn ended."""
    queued = any(
        entry.ack is not None
        and entry.ack["turnId"] == turn.turn_id
        and entry.ack["disposition"] == _QUEUED
        for entry in session.pending.list()
    )
    if queued and not turn.observed_start:
        unqueue = None
        attempt = 0
        while True:
            attempt += 1
            try:
                if unqueue is None:
                    unqueue = session._resendable_unqueue(turn.turn_id)
                if (await unqueue()).ack.get("status") == _ACCEPTED:
                    return
                break
            except MspError as error:
                # Lost the launch race, or refused: the turn may run, so cancel it.
                if not _untaken(error) or turn.observed_start:
                    break
                # Read at call time: the backoff is the connection's own.
                await connection_module._default_retry_delay(attempt, error)
                if turn.observed_start:
                    break
            except Exception:
                break
    with contextlib.suppress(Exception):
        await turn.cancel()


def _untaken(error: MspError) -> bool:
    """The host's busy answer: the session runtime did not take the call, nothing was written."""
    return error.kind == COMMAND_REJECTED_KIND and error.data.get("reason") == _RUNTIME_BUSY


def _final_answer_text(items: Sequence[FoldedItem]) -> str | None:
    for item in reversed(items):
        if (
            item.get("kind") == _AGENT_MESSAGE
            and item.get("status") == _COMPLETED
            and item.get("messagePhase") != _COMMENTARY
        ):
            return item.get("text")
    return None
