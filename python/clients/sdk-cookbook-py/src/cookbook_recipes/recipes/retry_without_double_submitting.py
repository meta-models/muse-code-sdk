"""Recipe twin: retry a command without double-submitting.

Runs against ``muse-conformance serve-fixture`` playing three committed
golden transcripts — the executable companion to the
commands-and-idempotency guide. One arm per transcript:

- ``goal-replayed-command`` — the exactly-once contract: resubmitting the
  same ``commandId`` with the same payload JOINS the original command (a
  value-identical ack, no second effect), and reusing the id with a
  DIFFERENT payload is a client bug the SDK refuses locally.
- ``pending-command-ack-launch`` — how a pending entry usually retires: the
  command materializes at its launch boundary as a ``commandId``-bearing
  ``userMessage`` item.
- ``pending-command-ack-reject`` — the other retirement: the queued launch
  fails, the replay answers a durable ``-32030`` ``commandRejected``, and
  the entry retires ``rejected`` with the input restored to the composer.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from muse_code import PendingCommandSet
from muse_code.connection import MspError
from muse_code.pending import CommandErrorResponse, ReplayError

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

# The transcripts' own client-side values; see the module docstring.
SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1"
WORKSPACE_ROOT = "/home/me/src/proj"

REPLAY_SESSION_ID = "0198f0aa-1111-7000-8000-0000000000aa"
GOAL_SET_COMMAND_ID = "018f6a22-4010-7000-8000-00000000d010"
GOAL_OBJECTIVE = "Replay me"

FIRST_TURN_COMMAND_ID = "018f6a32-1111-7000-8000-0000000000a1"
LAUNCH_QUEUED_COMMAND_ID = "018f6a32-2222-7000-8000-0000000000b2"
LAUNCH_FIRST_PROMPT = "Review the current test failures"
LAUNCH_QUEUED_PROMPT = "Run the queued release checks"
REJECT_QUEUED_COMMAND_ID = "018f6a32-3333-7000-8000-0000000000c3"
REJECT_FIRST_PROMPT = "Review the current deployment state"
REJECT_QUEUED_PROMPT = "Run the queued deployment checks"


@dataclass
class Context:
    """The recipe's own state, reset by each arm's spawn segment."""

    conformance_bin: str
    transcript_root: str
    host: Host | None = None
    pending: "PendingCommandSet[str] | None" = None
    session_id: str | None = None
    first_turn_id: str | None = None
    queued_turn_id: str | None = None
    goal_ack: Mapping[str, Any] | None = None


def _known(value: str | None, what: str) -> str:
    if value is None:
        raise RuntimeError(f"{what} is not known: an earlier segment did not finish")
    return value


def _spawn_segment(id_: str, scenario: str) -> Segment[Context]:
    async def spawn(context: Context) -> None:
        # The arm-boundary discipline approve_or_deny.py uses: reclaim the
        # previous arm's child, reset everything an arm learns from its wire.
        if context.host is not None:
            await context.host.abandon(CLOSE_BUDGET_MS)
        context.host = None
        context.pending = None
        context.session_id = None
        context.first_turn_id = None
        context.queued_turn_id = None
        context.goal_ack = None
        context.host = await spawn_fixture_host(
            conformance_bin=context.conformance_bin,
            transcript_dir=Path(context.transcript_root) / scenario,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
            client_info={"name": "conformance", "version": "0.0.0"},
            budget_ms=HANDSHAKE_BUDGET_MS,
        )

    return Segment(id_, f"Spawn the canned host playing the {scenario} transcript", spawn)


def _start_tracked_turn_segments(arm: str, prompt: str) -> tuple[Segment[Context], ...]:
    """The shared opening of the two pending-command arms."""

    async def session(context: Context) -> None:
        host = require_host(context.host, f"{arm}-spawn")
        started = await within("the session/start ack", COMMAND_BUDGET_MS, host.connection.command(
            "session/start",
            {"workspaceRoot": WORKSPACE_ROOT},
            max_attempts=1,
            command_id=SESSION_START_COMMAND_ID,
        ))
        session_obj = object_at(started, "session", "session/start result")
        context.session_id = string_at(session_obj, "sessionId", "session/start session")
        context.pending = PendingCommandSet[str]()

    async def first_turn(context: Context) -> None:
        host = require_host(context.host, f"{arm}-spawn")
        session_id = _known(context.session_id, "the session id")
        pending = context.pending
        if pending is None:
            raise RuntimeError("`session` did not finish")
        # Record the optimistic entry BEFORE the ack: the entry is what the
        # composer renders while the submit is in flight.
        pending.submitted(FIRST_TURN_COMMAND_ID, prompt)
        equals(pending.has(FIRST_TURN_COMMAND_ID), True, "the pending set holds the submit")
        ack = await within("the turn/start ack", COMMAND_BUDGET_MS, host.connection.command(
            "turn/start",
            {"sessionId": session_id, "input": [{"type": "text", "text": prompt}]},
            max_attempts=1,
            command_id=FIRST_TURN_COMMAND_ID,
        ))
        equals(ack.get("status"), "accepted", "turn/start ack status")
        equals(ack.get("disposition"), "started", "turn/start ack disposition")
        turn_id = string_at(ack, "turnId", "turn/start ack")
        pending.acked(FIRST_TURN_COMMAND_ID, {"turnId": turn_id, "disposition": "started"})

        # The command materializes: a userMessage item carrying our commandId
        # folds in, and the entry retires in favour of the real item.
        def _carries_command(notification: Any) -> bool:
            if notification.method != "item/completed":
                return False
            item = notification.params.get("item")
            return isinstance(item, dict) and item.get("commandId") == FIRST_TURN_COMMAND_ID

        folded = await host.wait_for(
            "the commandId-bearing userMessage item", COMMAND_BUDGET_MS, _carries_command
        )
        item = object_at(folded.params, "item", "item/completed params")
        retirement = pending.observed_user_message(
            FIRST_TURN_COMMAND_ID, string_at(item, "itemId", "the userMessage item")
        )
        equals(
            getattr(retirement, "kind", None), "materialized", "the started turn's retirement"
        )
        equals(pending.has(FIRST_TURN_COMMAND_ID), False, "the materialized entry left the set")
        context.first_turn_id = turn_id

    return (
        Segment(f"{arm}-session", "Start the session the turns will run in", session),
        Segment(f"{arm}-first-turn", "Start a turn and watch its entry materialize", first_turn),
    )


def _queue_second_turn_segment(arm: str, command_id: str, prompt: str) -> Segment[Context]:
    async def queue(context: Context) -> None:
        host = require_host(context.host, f"{arm}-spawn")
        session_id = _known(context.session_id, "the session id")
        pending = context.pending
        if pending is None:
            raise RuntimeError("`session` did not finish")
        pending.submitted(command_id, prompt)
        ack = await within("the turn/start ack", COMMAND_BUDGET_MS, host.connection.command(
            "turn/start",
            {
                "sessionId": session_id,
                "input": [{"type": "text", "text": prompt}],
                "ifBusy": "queue",
            },
            max_attempts=1,
            command_id=command_id,
        ))
        equals(ack.get("status"), "accepted", "the queued turn/start ack status")
        equals(ack.get("disposition"), "queued", "the queued turn/start ack disposition")
        equals(ack.get("startedNewTurn"), False, "whether the queued submit started a turn")
        # The ack pre-mints the turn that WILL run this input. Nothing has run
        # yet: the entry stays pending, now server-confirmed queued.
        turn_id = string_at(ack, "turnId", "the queued turn/start ack")
        pending.acked(command_id, {"turnId": turn_id, "disposition": "queued"})
        context.queued_turn_id = turn_id

    return Segment(f"{arm}-queue", "Queue a second turn while the first is still running", queue)


async def _replay_session(context: Context) -> None:
    host = require_host(context.host, "replay-spawn")
    started = await within("the session/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "session/start",
        # The transcript's client supplied its own session id; replay it
        # verbatim, then use the result's id exactly as a real client would.
        {"sessionId": REPLAY_SESSION_ID, "workspaceRoot": WORKSPACE_ROOT},
        max_attempts=1,
        command_id=SESSION_START_COMMAND_ID,
    ))
    session = object_at(started, "session", "session/start result")
    context.session_id = string_at(session, "sessionId", "session/start session")


async def _replay_first_submit(context: Context) -> None:
    host = require_host(context.host, "replay-spawn")
    session_id = _known(context.session_id, "the session id")
    ack = await within("the goal/set ack", COMMAND_BUDGET_MS, host.connection.command(
        "goal/set",
        {"sessionId": session_id, "objective": GOAL_OBJECTIVE},
        max_attempts=1,
        command_id=GOAL_SET_COMMAND_ID,
    ))
    equals(ack.get("status"), "accepted", "goal/set ack status")
    turn_id = string_at(ack, "turnId", "goal/set ack")
    # The goal folds once and its woken turn runs to its own terminal, so the
    # session is idle again before the retry under test.
    await host.wait_for(
        "the session/goalChanged notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "session/goalChanged",
    )
    completed = await host.wait_for(
        "the woken turn's terminal",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    equals(completed.params.get("terminal"), "completed", "the woken turn's terminal")
    context.goal_ack = ack


async def _replay_joins(context: Context) -> None:
    host = require_host(context.host, "replay-spawn")
    session_id = _known(context.session_id, "the session id")
    first_ack = context.goal_ack
    if first_ack is None:
        raise RuntimeError("`replay-first-submit` did not finish")
    # The retry a client performs after a dropped reply: the SAME commandId
    # and the SAME payload. Connection.command itself verifies the ack is
    # value-identical to the remembered one.
    replay_ack = await within("the goal/set ack", COMMAND_BUDGET_MS, host.connection.command(
        "goal/set",
        {"sessionId": session_id, "objective": GOAL_OBJECTIVE},
        max_attempts=1,
        command_id=GOAL_SET_COMMAND_ID,
    ))
    equals(replay_ack.get("turnId"), first_ack.get("turnId"), "the replay ack's turnId")
    equals(replay_ack.get("status"), first_ack.get("status"), "the replay ack's status")
    # Exactly-once effect: the goal folded once. A second submission would
    # have folded a second session/goalChanged by now.
    goal_changes = [n for n in host.notifications() if n.method == "session/goalChanged"]
    equals(len(goal_changes), 1, "how many times the goal folded")


async def _replay_payload_identity(context: Context) -> None:
    host = require_host(context.host, "replay-spawn")
    session_id = _known(context.session_id, "the session id")
    # A different payload under a reused commandId is a client bug, not a
    # retry. The SDK refuses it before anything reaches the wire — which is
    # also why this cannot diverge the fixture: no frame is sent.
    try:
        await within("the goal/set ack", COMMAND_BUDGET_MS, host.connection.command(
            "goal/set",
            {"sessionId": session_id, "objective": "A different objective entirely"},
            max_attempts=1,
            command_id=GOAL_SET_COMMAND_ID,
        ))
    except Exception as refused:  # noqa: BLE001 - the message is the assertion
        if "different payload" not in str(refused):
            raise AssertionError(
                "a reused commandId with a different payload must be refused "
                f"locally; got {refused!r}"
            ) from refused
        return
    raise AssertionError(
        "a reused commandId with a different payload must be refused locally; nothing was raised"
    )


def _drain_segment(arm: str) -> Segment[Context]:
    async def drain(context: Context) -> None:
        host = require_host(context.host, f"{arm}-spawn")
        exit_ = await host.close(CLOSE_BUDGET_MS)
        equals(exit_.code, 0, "the fixture host's exit code after stdin EOF")
        context.host = None

    return Segment(f"{arm}-drain", "Close stdin and let the fixture host exit cleanly", drain)


async def _materialize_launch(context: Context) -> None:
    host = require_host(context.host, "materialize-spawn")
    pending = context.pending
    if pending is None:
        raise RuntimeError("`session` did not finish")
    first_turn_id = _known(context.first_turn_id, "the first turn's id")
    queued_turn_id = _known(context.queued_turn_id, "the queued turn's id")
    # The running turn completes: queue movement — the moment the fold asks
    # the client to re-verify queued entries by replaying their commandIds.
    await host.wait_for(
        "the first turn's terminal",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == first_turn_id,
    )
    demanded = pending.observed_queue_movement(first_turn_id)
    equals(len(demanded), 1, "how many entries queue movement demands a replay for")
    equals(demanded[0], LAUNCH_QUEUED_COMMAND_ID, "the entry queue movement names")

    # Here the launch wins the race the replay exists to referee: the queued
    # turn starts and folds its commandId-bearing userMessage, which retires
    # the entry as materialized — no replay left to send.
    def _carries_command(notification: Any) -> bool:
        if notification.method != "item/completed":
            return False
        item = notification.params.get("item")
        return isinstance(item, dict) and item.get("commandId") == LAUNCH_QUEUED_COMMAND_ID

    folded = await host.wait_for(
        "the queued turn's commandId-bearing userMessage item", COMMAND_BUDGET_MS, _carries_command
    )
    item = object_at(folded.params, "item", "item/completed params")
    retirement = pending.observed_user_message(
        LAUNCH_QUEUED_COMMAND_ID, string_at(item, "itemId", "the queued turn's userMessage item")
    )
    equals(getattr(retirement, "kind", None), "materialized", "the queued entry's retirement")
    equals(pending.size, 0, "entries left after the launch")
    completed = await host.wait_for(
        "the queued turn's terminal",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == queued_turn_id,
    )
    equals(completed.params.get("terminal"), "completed", "the launched queued turn's terminal")


async def _reject_launch_fails(context: Context) -> None:
    host = require_host(context.host, "reject-spawn")
    pending = context.pending
    if pending is None:
        raise RuntimeError("`session` did not finish")
    first_turn_id = _known(context.first_turn_id, "the first turn's id")
    queued_turn_id = _known(context.queued_turn_id, "the queued turn's id")
    await host.wait_for(
        "the first turn's terminal",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == first_turn_id,
    )
    demanded = pending.observed_queue_movement(first_turn_id)
    equals(demanded[0], REJECT_QUEUED_COMMAND_ID, "the entry queue movement names")
    # The no-run exit: the pre-minted turn folds a FAILED terminal with a
    # launch error and no turn/started ever arrives for it.
    failed = await host.wait_for(
        "the queued turn's failed terminal",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == queued_turn_id,
    )
    equals(failed.params.get("terminal"), "failed", "the queued turn's terminal")
    error = object_at(failed.params, "error", "the failed turn/completed params")
    equals(error.get("kind"), "launchError", "the failed terminal's error kind")
    started = any(
        n.method == "turn/started" and n.params.get("turnId") == queued_turn_id
        for n in host.notifications()
    )
    equals(started, False, "whether the failed turn ever started")


async def _reject_replay(context: Context) -> None:
    host = require_host(context.host, "reject-spawn")
    session_id = _known(context.session_id, "the session id")
    pending = context.pending
    if pending is None:
        raise RuntimeError("`session` did not finish")
    # The replay the fold demanded: same commandId, same payload. This time
    # the answer is the settlement — a durable -32030 commandRejected.
    try:
        await within("the turn/start ack", COMMAND_BUDGET_MS, host.connection.command(
            "turn/start",
            {
                "sessionId": session_id,
                "input": [{"type": "text", "text": REJECT_QUEUED_PROMPT}],
                "ifBusy": "queue",
            },
            max_attempts=1,
            command_id=REJECT_QUEUED_COMMAND_ID,
        ))
    except MspError as rejection:
        equals(rejection.code, -32030, "the rejection's JSON-RPC code")
        equals(rejection.kind, "commandRejected", "the rejection's kind")
        reason = rejection.data.get("reason")
        equals(reason, "deferred_start_failed", "the rejection's reason")
        # Feed the answer back into the fold: a durable rejection retires the
        # entry with the original input, marked for the composer. Nothing is
        # lost and nothing runs twice.
        retirement = pending.replay_answered(
            REJECT_QUEUED_COMMAND_ID,
            ReplayError(
                error=CommandErrorResponse(
                    code=rejection.code, kind=rejection.kind, reason=str(reason)
                )
            ),
        )
        if getattr(retirement, "kind", None) != "rejected":
            raise AssertionError(
                f"a durable rejection must retire the entry as rejected; got {retirement!r}"
            )
        equals(retirement.reason, "deferred_start_failed", "the retirement's reason")
        equals(retirement.restore_to_composer, True, "whether the input goes back to the composer")
        equals(retirement.input, REJECT_QUEUED_PROMPT, "the input restored to the composer")
        equals(pending.size, 0, "entries left after the rejection")
        return
    raise AssertionError("replaying a durably rejected commandId must answer the rejection")


SEGMENTS: tuple[Segment[Context], ...] = (
    _spawn_segment("replay-spawn", "goal-replayed-command"),
    Segment("replay-session", "Start the session the goal will be set in", _replay_session),
    Segment(
        "replay-first-submit",
        "Set a goal and let its woken turn run to its terminal",
        _replay_first_submit,
    ),
    Segment(
        "replay-joins",
        "Resubmit the same commandId: a value-identical ack, no second effect",
        _replay_joins,
    ),
    Segment(
        "replay-payload-identity",
        "Reusing the commandId with a different payload is refused locally",
        _replay_payload_identity,
    ),
    _drain_segment("replay"),
    _spawn_segment("materialize-spawn", "pending-command-ack-launch"),
    *_start_tracked_turn_segments("materialize", LAUNCH_FIRST_PROMPT),
    _queue_second_turn_segment("materialize", LAUNCH_QUEUED_COMMAND_ID, LAUNCH_QUEUED_PROMPT),
    Segment(
        "materialize-launch",
        "Queue movement demands a replay; the launch materializes the entry first",
        _materialize_launch,
    ),
    _drain_segment("materialize"),
    _spawn_segment("reject-spawn", "pending-command-ack-reject"),
    *_start_tracked_turn_segments("reject", REJECT_FIRST_PROMPT),
    _queue_second_turn_segment("reject", REJECT_QUEUED_COMMAND_ID, REJECT_QUEUED_PROMPT),
    Segment(
        "reject-launch-fails",
        "The queued launch fails: a failed terminal for a turn that never started",
        _reject_launch_fails,
    ),
    Segment(
        "reject-replay",
        "Replay the commandId; the durable rejection retires the entry to the composer",
        _reject_replay,
    ),
    _drain_segment("reject"),
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
    id="retry-without-double-submitting",
    title="Retry a command without double-submitting",
    docs_page="developer-" "docs/src/content/docs/cookbook/retry-without-double-submitting.mdx",
    needs=("conformance_bin",),
    run=_run,
)
