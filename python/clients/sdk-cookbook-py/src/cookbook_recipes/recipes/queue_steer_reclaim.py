"""Recipe twin: queue, steer, and reclaim turns — the multi-turn traffic
rules every chat-style UI eventually hits.

Runs against ``muse-conformance serve-fixture`` playing the committed golden
transcript ``schema/msp/transcripts/turn-unqueued-round-trip``.

What it teaches: ``turn/start`` answers with a ``disposition`` and that word
is the whole routing decision (``started`` / ``queued`` — the ack's
``turnId`` names the PRE-MINTED turn — / ``steered``); a queued submit can be
taken back before it launches (``turn/unqueue``, then the durable
``turn/unqueued``); folding ``turn/unqueued`` through ``Session.apply``
retires the entry ``reclaimed`` with the original input restored to the
composer and settles the pre-minted turn's outcome as ``unqueued`` (no
``turn/completed`` ever carries a reclaimed turnId); and the reclaim is
surgical — the active turn runs to its own terminal.

Steering is taught on the page but not exercised here: no committed
transcript records a steered submit, because what a steer absorbs depends on
a live model's timing.

The ``Session`` below is constructed fold-only (no connection): every wire
write goes through ``Connection.command`` with an explicit commandId, and
the recipe feeds the session the recorded view notifications — the same
routing ``MuseClient`` does for you on a live connection.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from muse_code import Session, read_session_durability

from ..kit import (
    equals,
    Host,
    JourneyReport,
    object_at,
    require_host,
    run_journey,
    Segment,
    spawn_fixture_host,
    string_at,
    within,
)
from ..runner import Recipe, RecipeHosts

HANDSHAKE_BUDGET_MS = 30_000
COMMAND_BUDGET_MS = 30_000
CLOSE_BUDGET_MS = 30_000

SCENARIO = "turn-unqueued-round-trip"

# The transcript's own client-side values; see the module docstring.
WORKSPACE_ROOT = "/home/me/src/proj"
ACTIVE_PROMPT = "Review the current deployment state"
QUEUED_PROMPT = "Run the queued deployment checks"
SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1"
ACTIVE_TURN_COMMAND_ID = "018f6a32-1111-7000-8000-0000000000a1"
QUEUED_TURN_COMMAND_ID = "018f6a32-3333-7000-8000-0000000000c3"
UNQUEUE_COMMAND_ID = "018f6a32-5555-7000-8000-0000000000c5"


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    conformance_bin: str
    transcript_root: str
    host: Host | None = None
    session: "Session[str] | None" = None
    applied: int = 0
    session_id: str | None = None
    active_turn_id: str | None = None
    queued_turn_id: str | None = None


def _known(value: str | None, what: str) -> str:
    if value is None:
        raise RuntimeError(f"{what} is not known: an earlier segment did not finish")
    return value


def _require_session(context: Context) -> "Session[str]":
    if context.session is None:
        raise RuntimeError("no session: an earlier segment did not finish")
    return context.session


def _apply_view(context: Context) -> list[Any]:
    """Feed every not-yet-applied recorded notification for this session
    through ``Session.apply``, returning the retirements those folds produced
    — the recipe's stand-in for the per-session routing ``MuseClient``
    performs on a live connection."""
    host = require_host(context.host, "spawn")
    session = _require_session(context)
    retirements: list[Any] = []
    seen = host.notifications()
    while context.applied < len(seen):
        notification = seen[context.applied]
        context.applied += 1
        if notification.params.get("sessionId") != session.session_id:
            continue
        outcome = session.apply(
            {"method": notification.method, "params": dict(notification.params)}
        )
        retirements.extend(outcome.retirements)
    return retirements


async def _spawn(context: Context) -> None:
    context.host = await spawn_fixture_host(
        conformance_bin=context.conformance_bin,
        transcript_dir=Path(context.transcript_root) / SCENARIO,
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        client_info={"name": "conformance", "version": "0.0.0"},
        budget_ms=HANDSHAKE_BUDGET_MS,
    )


async def _session(context: Context) -> None:
    host = require_host(context.host, "spawn")
    started = await within("the session/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "session/start",
        {"workspaceRoot": WORKSPACE_ROOT},
        max_attempts=1,
        command_id=SESSION_START_COMMAND_ID,
    ))
    session_obj = object_at(started, "session", "session/start result")
    session_id = string_at(session_obj, "sessionId", "session/start session")
    # Durability comes off the handshake, exactly as a real client reads it:
    # it decides what happens to pending commands if the host dies.
    durability = read_session_durability(host.msp.initialize_result)
    equals(durability.kind, "durable", "the handshake's session durability")
    context.session_id = session_id
    context.session = Session(session_id, durability)


async def _start_active(context: Context) -> None:
    host = require_host(context.host, "spawn")
    session = _require_session(context)
    session_id = _known(context.session_id, "the session id")
    # The SS4.13 entry FIRST, then the wire: the pending set is what a UI
    # renders optimistically, so it exists from the moment of submission.
    session.pending.submitted(ACTIVE_TURN_COMMAND_ID, ACTIVE_PROMPT)
    ack = await within("the turn/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "turn/start",
        {"sessionId": session_id, "input": [{"type": "text", "text": ACTIVE_PROMPT}]},
        max_attempts=1,
        command_id=ACTIVE_TURN_COMMAND_ID,
    ))
    equals(ack.get("status"), "accepted", "turn/start ack status")
    equals(ack.get("disposition"), "started", "the idle submit's disposition")
    equals(ack.get("startedNewTurn"), True, "the disposition's boolean shorthand")
    # The ack's turnId is authoritative — always take it, never derive it.
    turn_id = string_at(ack, "turnId", "turn/start ack")
    session.pending.acked(ACTIVE_TURN_COMMAND_ID, {"turnId": turn_id, "disposition": "started"})
    context.active_turn_id = turn_id

    # The commandId-bearing userMessage folding in is what retires the entry:
    # the optimistic echo is replaced by the durable item.
    def _carries_command(notification: Any) -> bool:
        if notification.method != "item/completed":
            return False
        item = notification.params.get("item")
        return isinstance(item, dict) and item.get("commandId") == ACTIVE_TURN_COMMAND_ID

    await host.wait_for("the active turn's userMessage item", COMMAND_BUDGET_MS, _carries_command)
    retirements = _apply_view(context)
    materialized = next(
        (r for r in retirements if r.command_id == ACTIVE_TURN_COMMAND_ID), None
    )
    if materialized is None or materialized.kind != "materialized":
        raise AssertionError(
            f"the started submit should retire as materialized; got {retirements!r}"
        )
    equals(session.pending.has(ACTIVE_TURN_COMMAND_ID), False, "the materialized entry is gone")


async def _queue(context: Context) -> None:
    host = require_host(context.host, "spawn")
    session = _require_session(context)
    session_id = _known(context.session_id, "the session id")
    session.pending.submitted(QUEUED_TURN_COMMAND_ID, QUEUED_PROMPT)
    ack = await within("the turn/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "turn/start",
        {
            "sessionId": session_id,
            "input": [{"type": "text", "text": QUEUED_PROMPT}],
            "ifBusy": "queue",
        },
        max_attempts=1,
        command_id=QUEUED_TURN_COMMAND_ID,
    ))
    equals(ack.get("status"), "accepted", "the queued submit's ack status")
    equals(ack.get("disposition"), "queued", "the busy submit's disposition")
    equals(ack.get("startedNewTurn"), False, "queued input starts no turn yet")
    queued_turn_id = string_at(ack, "turnId", "the queued submit's ack")
    session.pending.acked(
        QUEUED_TURN_COMMAND_ID, {"turnId": queued_turn_id, "disposition": "queued"}
    )
    context.queued_turn_id = queued_turn_id
    # Nothing has settled the queued entry: it stays pending — exactly what a
    # UI renders as "queued, not yet running".
    equals(session.pending.has(QUEUED_TURN_COMMAND_ID), True, "the queued entry is held")


async def _reclaim(context: Context) -> None:
    host = require_host(context.host, "spawn")
    session = _require_session(context)
    session_id = _known(context.session_id, "the session id")
    queued_turn_id = _known(context.queued_turn_id, "the queued turn id")
    # Mint the handle BEFORE the fold settles it, the way a UI already
    # holding "queued turn X" would: the wait below must resolve, not hang.
    queued = session.turn(queued_turn_id)
    ack = await within("the turn/unqueue ack", COMMAND_BUDGET_MS, host.connection.command(
        "turn/unqueue",
        {"sessionId": session_id, "turnId": queued_turn_id},
        max_attempts=1,
        command_id=UNQUEUE_COMMAND_ID,
    ))
    equals(ack.get("status"), "accepted", "turn/unqueue ack status")
    equals(ack.get("turnId"), queued_turn_id, "the turnId the unqueue ack echoes")

    unqueued = await host.wait_for(
        "the turn/unqueued notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/unqueued" and n.params.get("turnId") == queued_turn_id,
    )
    # The notification's commandId names the turn/start that QUEUED the turn
    # — the entry to retire — not the unqueue command that reclaimed it.
    equals(unqueued.params.get("commandId"), QUEUED_TURN_COMMAND_ID, "turn/unqueued's commandId")

    retirements = _apply_view(context)
    reclaimed = next(
        (r for r in retirements if r.command_id == QUEUED_TURN_COMMAND_ID), None
    )
    if reclaimed is None or reclaimed.kind != "reclaimed":
        raise AssertionError(
            f"the reclaim should retire the entry as reclaimed; got {retirements!r}"
        )
    # The whole point of the gesture: the input comes BACK. A client that
    # drops it here has turned "un-send" into "delete my draft".
    equals(reclaimed.restore_to_composer, True, "the reclaim restores to the composer")
    equals(reclaimed.input, QUEUED_PROMPT, "the input handed back to the composer")
    equals(session.pending.has(QUEUED_TURN_COMMAND_ID), False, "the reclaimed entry is gone")

    # The pre-minted turn's outcome is `unqueued` — its own terminal kind. No
    # turn/completed will ever carry this turnId, so a wait folding only
    # turn/completed would hang forever. Bounded: if the fold's settle
    # contract regressed, the intended red must not become a job-wall hang.
    outcome = await within(
        "the reclaimed turn's settled outcome", COMMAND_BUDGET_MS, queued.completed
    )
    equals(outcome.kind, "unqueued", "the reclaimed turn's outcome")


async def _active_untouched(context: Context) -> None:
    host = require_host(context.host, "spawn")
    session = _require_session(context)
    active_turn_id = _known(context.active_turn_id, "the active turn id")
    completed = await host.wait_for(
        "the active turn's turn/completed",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == active_turn_id,
    )
    equals(completed.params.get("terminal"), "completed", "the active turn's terminal")
    _apply_view(context)
    outcome = await within(
        "the active turn's folded outcome",
        COMMAND_BUDGET_MS,
        session.turn(active_turn_id).completed,
    )
    if outcome.kind != "completed":
        raise AssertionError(f"the active turn should complete; got {outcome!r}")
    equals(outcome.params.get("terminal"), "completed", "the folded outcome's terminal")
    equals(outcome.observed_start, True, "this session observed the active turn start")


async def _drain(context: Context) -> None:
    host = require_host(context.host, "spawn")
    exit_ = await host.close(CLOSE_BUDGET_MS)
    equals(exit_.code, 0, "the fixture host's exit code after stdin EOF")
    context.host = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment("spawn", f"Spawn the canned host playing the {SCENARIO} transcript", _spawn),
    Segment("session", "Start a session and mirror it in a fold-only Session", _session),
    Segment(
        "start-active",
        'Submit while idle: disposition "started", entry retires as materialized',
        _start_active,
    ),
    Segment(
        "queue", 'Submit while busy: disposition "queued", the ack pre-mints the turn', _queue
    ),
    Segment(
        "reclaim", "Reclaim the queued turn: turn/unqueue, then the durable turn/unqueued", _reclaim
    ),
    Segment(
        "active-untouched",
        "The active turn never noticed: it runs to its own completed terminal",
        _active_untouched,
    ),
    Segment("drain", "Close stdin and let the fixture host exit cleanly", _drain),
)


async def _run(hosts: RecipeHosts) -> JourneyReport:
    if hosts.conformance_bin is None:
        raise ValueError("conformance_bin is required")
    context = Context(
        conformance_bin=hosts.conformance_bin, transcript_root=hosts.transcript_root
    )

    async def teardown(owned: Context) -> None:
        if owned.host is not None:
            await owned.host.abandon(CLOSE_BUDGET_MS)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="queue-steer-reclaim",
    title="Queue, steer, and reclaim turns",
    docs_page="developer-docs/src/content/docs/cookbook/queue-steer-and-reclaim-turns.mdx",
    needs=("conformance_bin",),
    run=_run,
)
