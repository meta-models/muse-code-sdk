"""Recipe twin: stream a turn's answer into a UI.

Runs against ``muse-conformance serve-fixture`` playing the committed golden
transcript ``schema/msp/transcripts/text-run-single-turn`` — the canned stdio
host, so this recipe is deterministic and needs no credentials and no model.

What it teaches (the docs page walks the same three points): ``item/delta``
frames are the LIVE text, appended keyed by ``itemId``; ``item/completed`` is
AUTHORITATIVE and the accumulation must equal it; the turn is over on
``turn/completed``, not on the last delta.

Fixture mechanics, so the code reads honestly: serve-fixture matches our
frames structurally against the transcript's client lines and replays the
recorded server lines byte-exactly. Acks echo the RECORDED ``commandId`` —
and ``Connection.command`` verifies that echo — so each command passes the
transcript's own commandId explicitly.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from ..kit import (
    equals,
    Host,
    JourneyReport,
    object_at,
    RecordedNotification,
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
PROMPT = "Run the agent test suite and summarize failures"
SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1"
TURN_START_COMMAND_ID = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10"


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    conformance_bin: str
    transcript: str
    host: Host | None = None
    session_id: str | None = None
    turn_id: str | None = None
    item_id: str | None = None


def _accumulate(
    notifications: Sequence[RecordedNotification], item_id: str
) -> tuple[str, int]:
    """The delta text for one item, in arrival order, plus the piece count.

    ``field`` is checked because a delta names WHICH member of the item it
    extends; appending a non-text delta to a text buffer is the quiet way to
    corrupt the rendered answer. The count comes from the accumulation itself
    so the streaming floor counts exactly the frames it summed.
    """
    text = ""
    pieces = 0
    for notification in notifications:
        if notification.method != "item/delta":
            continue
        if notification.params.get("itemId") != item_id:
            continue
        if notification.params.get("field") != "text":
            continue
        delta = notification.params.get("delta")
        if not isinstance(delta, str):
            raise AssertionError(
                f"an item/delta for {item_id} carried a non-string delta: {delta!r}"
            )
        text += delta
        pieces += 1
    return text, pieces


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
    # The recorded client discovers the model catalog right at session
    # acquisition — one read-only model/list, taught in depth by the
    # list-models-and-switch-mid-session recipe.
    await within("the model/list reply", COMMAND_BUDGET_MS, host.connection.request("model/list", {"sessionId": context.session_id}))


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
    equals(ack.get("startedNewTurn"), True, "turn/start ack startedNewTurn")
    context.turn_id = string_at(ack, "turnId", "turn/start ack")
    await host.wait_for(
        "the turn/started notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/started" and n.params.get("sessionId") == session_id,
    )


async def _answer_begins(context: Context) -> None:
    host = require_host(context.host, "spawn-fixture")
    turn_id = context.turn_id
    if turn_id is None:
        raise RuntimeError("`turn-start` did not finish")

    # A UI creates its message bubble HERE — on item/started — so the very
    # first delta has somewhere to land. The opening frame carries the itemId
    # every later delta is keyed by.
    def _agent_message_started(notification: RecordedNotification) -> bool:
        if notification.method != "item/started":
            return False
        item = notification.params.get("item")
        return isinstance(item, dict) and item.get("kind") == "agentMessage"

    started = await host.wait_for(
        "the agentMessage item/started notification", COMMAND_BUDGET_MS, _agent_message_started
    )
    item = object_at(started.params, "item", "item/started params")
    equals(item.get("turnId"), turn_id, "the agent message's turn id")
    equals(item.get("status"), "inProgress", "the agent message's status while it streams")
    equals(item.get("text"), "", "the agent message's text before any delta")
    context.item_id = string_at(item, "itemId", "item/started item")


async def _stream_and_settle(context: Context) -> None:
    host = require_host(context.host, "spawn-fixture")
    item_id = context.item_id
    if item_id is None:
        raise RuntimeError("`answer-begins` did not finish")

    def _item_completed(notification: RecordedNotification) -> bool:
        if notification.method != "item/completed":
            return False
        item = notification.params.get("item")
        return isinstance(item, dict) and item.get("itemId") == item_id

    completed = await host.wait_for(
        "the agent message's item/completed notification", COMMAND_BUDGET_MS, _item_completed
    )
    item = object_at(completed.params, "item", "item/completed params")
    equals(item.get("status"), "completed", "the finished agent message's status")
    authoritative = string_at(item, "text", "item/completed item")

    # The streaming assertion, and the reason a UI may draw deltas at all:
    # what arrived in pieces reassembles to exactly what the authoritative
    # frame carries.
    streamed_text, pieces = _accumulate(host.notifications(), item_id)
    equals(streamed_text, authoritative, "the accumulated deltas vs the authoritative text")

    # ...and it genuinely STREAMED: one delta carrying the whole answer would
    # satisfy the equality while proving nothing about the incremental path.
    if pieces < 2:
        raise AssertionError(
            f"the answer arrived in {pieces} delta(s); this recipe needs a "
            "genuinely incremental stream"
        )


async def _turn_terminal(context: Context) -> None:
    host = require_host(context.host, "spawn-fixture")
    turn_id = context.turn_id
    if turn_id is None:
        raise RuntimeError("`turn-start` did not finish")
    completed = await host.wait_for(
        "the turn/completed notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    equals(completed.params.get("terminal"), "completed", "the turn's terminal")
    # The settle frame is also where a UI reads what the turn cost.
    usage = object_at(completed.params, "usage", "turn/completed params")
    if not isinstance(usage.get("inputTokens"), (int, float)) or not isinstance(
        usage.get("outputTokens"), (int, float)
    ):
        raise AssertionError(f"turn/completed usage lacks numeric token counts: {usage!r}")


async def _drain(context: Context) -> None:
    host = require_host(context.host, "spawn-fixture")
    exit_ = await host.close(CLOSE_BUDGET_MS)
    equals(exit_.code, 0, "the fixture host's exit code after stdin EOF")
    context.host = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment(
        "spawn-fixture",
        "Spawn the canned host playing the text-run-single-turn transcript",
        _spawn_fixture,
    ),
    Segment("session", "Start the session the turn will run in", _session),
    Segment("turn-start", "Send the prompt and take the turn id off the ack", _turn_start),
    Segment(
        "answer-begins",
        "Catch the agent's message opening, empty, before any text arrives",
        _answer_begins,
    ),
    Segment(
        "stream-and-settle",
        "Accumulate the deltas, then let item/completed have the last word",
        _stream_and_settle,
    ),
    Segment("turn-terminal", "Wait for the turn's own terminal, not the last delta", _turn_terminal),
    Segment("drain", "Close stdin and let the fixture host exit cleanly", _drain),
)


async def _run(hosts: RecipeHosts) -> JourneyReport:
    if hosts.conformance_bin is None:
        raise ValueError("conformance_bin is required")
    context = Context(
        conformance_bin=hosts.conformance_bin,
        transcript=f"{hosts.transcript_root}/text-run-single-turn",
    )

    async def teardown(owned: Context) -> None:
        if owned.host is not None:
            await owned.host.abandon(CLOSE_BUDGET_MS)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="stream-a-turn",
    title="Stream a turn's answer into a UI",
    docs_page="developer-docs/src/content/docs/cookbook/stream-a-turns-answer.mdx",
    needs=("conformance_bin",),
    run=_run,
)
