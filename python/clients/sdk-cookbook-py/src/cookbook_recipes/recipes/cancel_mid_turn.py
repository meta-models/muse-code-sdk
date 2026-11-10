"""Recipe twin: cancel a turn while it is running.

Runs against ``muse-conformance serve-fixture`` playing the committed golden
transcript ``schema/msp/transcripts/cancel-mid-turn``.

What it teaches: ``turn.cancel()`` is a REQUEST, not an outcome — its ack says
the host will try; the turn is over only when ``turn.completed`` settles with
the terminal ``"cancelled"``. And a cancelled turn keeps a balanced history:
the in-flight toolCall item is completed as ``"cancelled"``, never dropped.

Fixture mechanics: serve-fixture replays recorded server lines byte-exactly,
so acks echo the RECORDED commandId and the SDK verifies that echo. The
connection's one commandId minter is therefore scripted with the transcript's
ids in send order; everything else goes through the ``MuseClient`` facade.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

from muse_code import (
    MuseClient,
    MuseClientOptions,
    SendUserTurnOptions,
    Session,
    StartSessionOptions,
    Turn,
    read_session_durability,
)
from muse_code.connection.spawn import spawn_msp_connection

from ..kit import (
    equals,
    HOST_DRAIN_WINDOW_MS,
    JourneyReport,
    pinned_to,
    recorded_fingerprint,
    run_journey,
    Segment,
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
    client: "MuseClient[str] | None" = None
    session: "Session[str] | None" = None
    turn: "Turn[str] | None" = None
    # The toolCall that was running when we asked for the cancel.
    tool_call_id: str | None = None


def _scripted_command_ids(ids: Sequence[str]) -> Callable[[], str]:
    """Hand out the transcript's commandIds in send order. Harness-only: a real
    client keeps the SDK's default minter, which is what makes ids unique."""
    queue = list(ids)

    def mint() -> str:
        if not queue:
            raise RuntimeError("the recipe sent more commands than the transcript records")
        return queue.pop(0)

    return mint


async def _spawn_fixture(context: Context) -> None:
    transcript_dir = Path(context.transcript)
    stderr: list[str] = []
    # Built by hand rather than with ``MuseClient.spawn``: spawn asks for an
    # extra capability the recorded ``initialize`` line does not carry.
    handshake = await spawn_msp_connection(
        context.conformance_bin,
        args=("serve-fixture", "--transcript", str(transcript_dir)),
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        on_stderr=stderr.append,
        shutdown_timeout_ms=HOST_DRAIN_WINDOW_MS,
        connection_options={
            "mint_command_id": _scripted_command_ids(
                (SESSION_START_COMMAND_ID, TURN_START_COMMAND_ID, TURN_CANCEL_COMMAND_ID)
            )
        },
    )
    # The strict fingerprint gate, retargeted to the bundle the transcript was
    # recorded against (the kit's ``spawn_fixture_host`` does the same).
    with pinned_to(recorded_fingerprint(transcript_dir)):
        try:
            spawned = await within(
                "the MSP handshake",
                HANDSHAKE_BUDGET_MS,
                handshake.initialize({"clientInfo": {"name": "conformance", "version": "0.0.0"}}),
            )
        except BaseException as error:
            # A failed initialize has already closed the host it spawned.
            raise RuntimeError(f"handshake failed; stderr: {''.join(stderr)}") from error
    context.client = MuseClient(
        spawned.connection,
        MuseClientOptions(
            durability=read_session_durability(spawned.initialize_result), host=spawned
        ),
    )


async def _session(context: Context) -> None:
    if context.client is None:
        raise RuntimeError("`spawn-fixture` did not finish")
    session = await within(
        "the session/start result",
        COMMAND_BUDGET_MS,
        context.client.start_session(StartSessionOptions(workspace_root=WORKSPACE_ROOT)),
    )
    opening = session.opening
    equals(opening.verb if opening is not None else None, "session/start", "how the session was opened")
    if opening is not None:
        equals(opening.result["session"].get("status"), "idle", "a fresh session's status")
    context.session = session


async def _first_running_tool_call(turn: "Turn[str]") -> str:
    # ``items()`` replays what the fold already holds, then tails, so a fast
    # host cannot slip the running tool call past us.
    async for item in turn.items():
        if item.get("kind") == "toolCall" and item.get("status") == "inProgress":
            return str(item.get("itemId"))
    raise AssertionError("the turn ended without a running toolCall")


async def _turn_start(context: Context) -> None:
    session = context.session
    if session is None:
        raise RuntimeError("`session` did not finish")
    turn = await within(
        "the turn/start ack",
        COMMAND_BUDGET_MS,
        session.send_user_turn(SendUserTurnOptions(input=[{"type": "text", "text": PROMPT}])),
    )
    tool_call_id = await within(
        "a running toolCall item", COMMAND_BUDGET_MS, _first_running_tool_call(turn)
    )
    # The turn is genuinely mid-work when output is still streaming. Open the
    # live feed and read the fold in the same step: the first chunk is in one.
    live: Any = turn.deltas()
    try:
        output = session.fold.items.accumulated(tool_call_id, "output")
        if output is None:
            delta = await within("a streamed output chunk", COMMAND_BUDGET_MS, live.__anext__())
            output = delta.get("delta")
        if not output:
            raise AssertionError("the running toolCall streamed no output")
    finally:
        await live.aclose()
    context.turn = turn
    context.tool_call_id = tool_call_id


async def _cancel(context: Context) -> None:
    session = context.session
    turn = context.turn
    tool_call_id = context.tool_call_id
    if session is None or turn is None or tool_call_id is None:
        raise RuntimeError("`turn-start` did not finish")
    ack = await within("the turn/cancel ack", COMMAND_BUDGET_MS, turn.cancel())
    equals(ack.get("status"), "accepted", "turn/cancel ack status")
    # The ack is a promise to try, not the outcome. The outcome is the turn's
    # terminal.
    outcome = await within("the cancelled turn's outcome", COMMAND_BUDGET_MS, turn.completed)
    if outcome.kind != "completed":
        raise AssertionError(f"the cancelled turn should complete; got {outcome!r}")
    equals(outcome.params.get("terminal"), "cancelled", "the turn's terminal")
    # Balanced history: the in-flight toolCall was completed as cancelled, not
    # dropped on the floor.
    tool_call = session.fold.items.get(tool_call_id)
    equals(
        tool_call.get("status") if tool_call is not None else None,
        "cancelled",
        "the toolCall's final status",
    )


async def _drain(context: Context) -> None:
    client = context.client
    if client is None:
        raise RuntimeError("`spawn-fixture` did not finish")
    await within("the fixture host's orderly drain and exit", CLOSE_BUDGET_MS, client.close())
    classification = await client.exit
    equals(classification.kind, "cleanShutdown", "the fixture host's exit classification")
    context.client = None


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
        client = owned.client
        if client is not None:
            try:
                await within("the fixture host's teardown drain", CLOSE_BUDGET_MS, client.close())
            except Exception as error:  # noqa: BLE001 - warned, never raised
                import sys

                print(f"teardown: the fixture host did not drain cleanly: {error}", file=sys.stderr)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="cancel-mid-turn",
    title="Cancel a turn while it is running",
    docs_page="cookbook/cancel-a-running-turn",
    needs=("conformance_bin",),
    run=_run,
)
