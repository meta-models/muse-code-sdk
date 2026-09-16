"""Recipe twin: cancel a turn while it is running.

Runs against ``muse-conformance serve-fixture`` playing the committed golden
transcript ``schema/msp/transcripts/cancel-mid-turn``.

What it teaches: ``turn/cancel`` is a REQUEST, not an outcome — the ack says
the host will try; the turn is over only when ``turn/completed`` arrives with
the terminal ``"cancelled"``. And a cancelled turn keeps a balanced history:
the in-flight toolCall item is completed as ``"cancelled"``, never dropped.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

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

# The transcript's own client-side values; see the module docstring.
WORKSPACE_ROOT = "/home/me/src/proj"
PROMPT = "Run the flaky integration suite"
SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1"
TURN_START_COMMAND_ID = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10"
TURN_CANCEL_COMMAND_ID = "018f6a21-0f0f-7aaa-bbbb-0123456789ab"


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    conformance_bin: str
    transcript: str
    host: Host | None = None
    session_id: str | None = None
    turn_id: str | None = None


async def _spawn_fixture(context: Context) -> None:
    context.host = await spawn_fixture_host(
        conformance_bin=context.conformance_bin,
        transcript_dir=Path(context.transcript),
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        client_info={"name": "conformance", "version": "0.0.0"},
        budget_ms=HANDSHAKE_BUDGET_MS,
    )


async def _session(context: Context) -> None:
    host = require_host(context.host, "spawn-fixture")
    result = await within("the session/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "session/start",
        {"workspaceRoot": WORKSPACE_ROOT},
        max_attempts=1,
        command_id=SESSION_START_COMMAND_ID,
    ))
    session = object_at(result, "session", "session/start result")
    equals(session.get("status"), "idle", "a fresh session's status")
    context.session_id = string_at(session, "sessionId", "session/start session")


async def _turn_start(context: Context) -> None:
    host = require_host(context.host, "spawn-fixture")
    session_id = context.session_id
    if session_id is None:
        raise RuntimeError("`session` did not finish")
    ack = await within("the turn/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "turn/start",
        {"sessionId": session_id, "input": [{"type": "text", "text": PROMPT}]},
        max_attempts=1,
        command_id=TURN_START_COMMAND_ID,
    ))
    equals(ack.get("status"), "accepted", "turn/start ack status")
    equals(ack.get("disposition"), "started", "turn/start ack disposition")
    turn_id = string_at(ack, "turnId", "turn/start ack")
    await host.wait_for(
        "the turn/started notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/started" and n.params.get("turnId") == turn_id,
    )
    # The turn is genuinely mid-work when output is still streaming: the
    # fixture's toolCall item is emitting item/delta frames.
    await host.wait_for(
        "a streamed item/delta while the turn runs",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "item/delta",
    )
    context.turn_id = turn_id


async def _cancel(context: Context) -> None:
    host = require_host(context.host, "spawn-fixture")
    session_id = context.session_id
    turn_id = context.turn_id
    if session_id is None or turn_id is None:
        raise RuntimeError("`turn-start` did not finish")
    ack = await within("the turn/cancel ack", COMMAND_BUDGET_MS, host.connection.command(
        "turn/cancel",
        {"sessionId": session_id, "turnId": turn_id},
        max_attempts=1,
        command_id=TURN_CANCEL_COMMAND_ID,
    ))
    equals(ack.get("status"), "accepted", "turn/cancel ack status")
    # The ack is a promise to try, not the outcome. The outcome is the turn's
    # terminal.
    completed = await host.wait_for(
        "the cancelled turn/completed notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    equals(completed.params.get("terminal"), "cancelled", "the turn's terminal")
    # Balanced history: the in-flight toolCall was completed as cancelled, not
    # dropped on the floor.
    for notification in host.notifications():
        if notification.method != "item/completed":
            continue
        item = notification.params.get("item")
        if isinstance(item, dict) and item.get("status") == "cancelled":
            return
    raise AssertionError(
        'the cancelled turn left no item/completed with status "cancelled"'
    )


async def _drain(context: Context) -> None:
    host = require_host(context.host, "spawn-fixture")
    exit_ = await host.close(CLOSE_BUDGET_MS)
    equals(exit_.code, 0, "the fixture host's exit code after stdin EOF")
    context.host = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment(
        "spawn-fixture", "Spawn the canned host playing the cancel-mid-turn transcript", _spawn_fixture
    ),
    Segment("session", "Start the session the turn will run in", _session),
    Segment("turn-start", "Start a turn and watch its work stream in", _turn_start),
    Segment("cancel", "Ask for the cancel, then wait for the turn's own terminal", _cancel),
    Segment("drain", "Close stdin and let the fixture host exit cleanly", _drain),
)


async def _run(hosts: RecipeHosts) -> JourneyReport:
    if hosts.conformance_bin is None:
        raise ValueError("conformance_bin is required")
    context = Context(
        conformance_bin=hosts.conformance_bin,
        transcript=f"{hosts.transcript_root}/cancel-mid-turn",
    )

    async def teardown(owned: Context) -> None:
        if owned.host is not None:
            await owned.host.abandon(CLOSE_BUDGET_MS)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="cancel-mid-turn",
    title="Cancel a turn while it is running",
    docs_page="developer-docs/src/content/docs/cookbook/cancel-a-running-turn.mdx",
    needs=("conformance_bin",),
    run=_run,
)
