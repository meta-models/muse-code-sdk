"""Recipe twin: stop a turn while it is running — the user's Stop button, and
the programmatic cancel.

Runs against ``muse-conformance serve-fixture`` playing three committed golden
transcripts: ``schema/msp/transcripts/cancel-mid-turn`` (the plain cancel),
``schema/msp/transcripts/turn-interrupt-queued-successor`` (the Stop gesture,
with a second turn queued behind the running one) and
``schema/msp/transcripts/turn-interrupt-queued-successor-burst`` (the same
exchange with the queued turn's ``turn/started`` written right after the
stopped turn's terminal, before the replay exchange, as a live host may write
it).

What it teaches: a stop is a REQUEST, not an outcome — the ack to
``turn/cancel`` or ``turn/interrupt`` says the host will try; the turn is over
only when ``turn.completed`` settles with the terminal ``"cancelled"``. A
stopped turn keeps a balanced history: the in-flight toolCall item is completed
as ``"cancelled"``, never dropped. And the two stop lanes:
``turn.interrupt()`` is the user's Stop/Esc gesture on the priority lane,
``turn.cancel()`` is programmatic cleanup on the normal lane; neither consumes
a turn queued behind the stopped one — the queued submit stays pending, the
SDK re-verifies it at the stopped turn's terminal (the queue moves up), and
it launches and completes on its own.

Fixture mechanics: serve-fixture replays recorded server lines byte-exactly,
so acks echo the RECORDED commandId and the SDK verifies that echo. The
connection's one commandId minter is therefore scripted with each transcript's
ids in send order (the queue-movement replay re-sends an id it already holds,
so it takes none); everything else goes through the ``MuseClient`` facade.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence, TypeVar

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
from muse_code.pending import PendingCommandEntry

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

# The transcripts' own client-side values; see the module docstring.
WORKSPACE_ROOT = "/home/me/src/proj"
PROMPT = "Run the flaky integration suite"
QUEUED_PROMPT = "Summarize the last failing test"
SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1"
# ``cancel-mid-turn``: the running turn and the cancel.
CANCEL_TURN_COMMAND_ID = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10"
TURN_CANCEL_COMMAND_ID = "018f6a21-0f0f-7aaa-bbbb-0123456789ab"
# ``turn-interrupt-queued-successor``: the running turn, the queued one, the interrupt.
INTERRUPT_TURN_COMMAND_ID = "018f6a41-1111-7000-8000-0000000000a1"
QUEUED_TURN_COMMAND_ID = "018f6a41-2222-7000-8000-0000000000b2"
TURN_INTERRUPT_COMMAND_ID = "018f6a41-3333-7000-8000-0000000000c3"


@dataclass(frozen=True)
class Arm:
    """One arm of the recipe: one transcript, one stop lane."""

    # Segment-id prefix, so the report names which arm a line belongs to.
    id: str
    # The transcript directory name under the corpus root.
    scenario: str
    # The transcript's client-minted commandIds, in send order.
    command_ids: Sequence[str]


CANCEL = Arm(
    id="cancel",
    scenario="cancel-mid-turn",
    command_ids=(SESSION_START_COMMAND_ID, CANCEL_TURN_COMMAND_ID, TURN_CANCEL_COMMAND_ID),
)

INTERRUPT = Arm(
    id="interrupt",
    scenario="turn-interrupt-queued-successor",
    command_ids=(
        SESSION_START_COMMAND_ID,
        INTERRUPT_TURN_COMMAND_ID,
        QUEUED_TURN_COMMAND_ID,
        TURN_INTERRUPT_COMMAND_ID,
    ),
)

# The same exchange with the queued turn's ``turn/started`` in the same burst
# as the stopped turn's terminal: the order that reads wrong to a check made
# after an await, and right on the wire. Same ids, same send order.
INTERRUPT_BURST = Arm(
    id="interrupt-burst",
    scenario="turn-interrupt-queued-successor-burst",
    command_ids=INTERRUPT.command_ids,
)


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    conformance_bin: str
    transcript_root: str
    client: "MuseClient[str] | None" = None
    session: "Session[str] | None" = None
    turn: "Turn[str] | None" = None
    # The toolCall that was running when we asked for the stop.
    tool_call_id: str | None = None
    # The interrupt arm: the submit queued behind the running turn.
    queued: "Turn[str] | None" = None
    # The queued submit's pending entry, as ``session.pending`` showed it.
    queued_entry: "PendingCommandEntry[str] | None" = None
    # The interrupt arm: the wire-order watch the stop step opens; see
    # ``_queued_starts_after_terminal``.
    launch_order: "asyncio.Task[bool] | None" = None


def _scripted_command_ids(ids: Sequence[str]) -> Callable[[], str]:
    """Hand out the transcript's commandIds in send order. Harness-only: a real
    client keeps the SDK's default minter, which is what makes ids unique."""
    queue = list(ids)

    def mint() -> str:
        if not queue:
            raise RuntimeError("the recipe sent more commands than the transcript records")
        return queue.pop(0)

    return mint


_T = TypeVar("_T")


def _known(value: _T | None, what: str) -> _T:
    if value is None:
        raise RuntimeError(f"{what} is not known: an earlier segment did not finish")
    return value


async def _spawn_fixture(context: Context, arm: Arm) -> None:
    # Reclaim before overwriting the slot: a previous arm whose drain threw
    # leaves its client here, and the arm's own wire state goes with it, so a
    # failed arm cannot feed a stale id to the next one.
    previous = context.client
    if previous is not None:
        try:
            await within("the previous arm's fixture host", CLOSE_BUDGET_MS, previous.close())
        except Exception:  # noqa: BLE001 - the previous arm already reported
            pass
    context.client = None
    context.session = None
    context.turn = None
    context.tool_call_id = None
    context.queued = None
    context.queued_entry = None
    context.launch_order = None
    transcript_dir = Path(context.transcript_root) / arm.scenario
    stderr: list[str] = []
    # Built by hand rather than with ``MuseClient.spawn``: spawn asks for an
    # extra capability the recorded ``initialize`` line does not carry.
    handshake = await spawn_msp_connection(
        context.conformance_bin,
        args=("serve-fixture", "--transcript", str(transcript_dir)),
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        on_stderr=stderr.append,
        shutdown_timeout_ms=HOST_DRAIN_WINDOW_MS,
        connection_options={"mint_command_id": _scripted_command_ids(arm.command_ids)},
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
    client = _known(context.client, "the client")
    session = await within(
        "the session/start result",
        COMMAND_BUDGET_MS,
        client.start_session(StartSessionOptions(workspace_root=WORKSPACE_ROOT)),
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
    session = _known(context.session, "the session")
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


async def _expect_stopped_turn(context: Context, what: str) -> None:
    """The stop's outcome: the turn's own terminal, and the balanced history."""
    session = _known(context.session, "the session")
    turn = _known(context.turn, "the running turn")
    tool_call_id = _known(context.tool_call_id, "the running toolCall")
    # The ack is a promise to try, not the outcome. The outcome is the turn's
    # terminal.
    outcome = await within(f"the {what} turn's outcome", COMMAND_BUDGET_MS, turn.completed)
    if outcome.kind != "completed":
        raise AssertionError(f"the {what} turn should complete; got {outcome!r}")
    equals(outcome.params.get("terminal"), "cancelled", "the turn's terminal")
    # Balanced history: the in-flight toolCall was completed as cancelled, not
    # dropped on the floor.
    tool_call = session.fold.items.get(tool_call_id)
    equals(
        tool_call.get("status") if tool_call is not None else None,
        "cancelled",
        "the toolCall's final status",
    )


async def _cancel(context: Context) -> None:
    turn = _known(context.turn, "the running turn")
    ack = await within("the turn/cancel ack", COMMAND_BUDGET_MS, turn.cancel())
    equals(ack.get("status"), "accepted", "turn/cancel ack status")
    await _expect_stopped_turn(context, "cancelled")


async def _queue(context: Context) -> None:
    session = _known(context.session, "the session")
    queued = await within(
        "the queued submit's ack",
        COMMAND_BUDGET_MS,
        session.send_user_turn(
            SendUserTurnOptions(
                input=[{"type": "text", "text": QUEUED_PROMPT}],
                if_busy="queue",
            )
        ),
    )
    # The handle names a turn that does not run yet: the entry stays in
    # ``session.pending``, acked "queued", until the wire says launched,
    # rejected, or reclaimed.
    entry = next(
        (
            held
            for held in session.pending.list()
            if held.ack is not None and held.ack["turnId"] == queued.turn_id
        ),
        None,
    )
    if entry is None or entry.ack is None:
        raise AssertionError("the queued submit left no pending entry")
    equals(entry.ack["disposition"], "queued", "the busy submit's disposition")
    equals(queued.observed_start, False, "queued input starts no turn yet")
    context.queued = queued
    context.queued_entry = entry


async def _interrupt(context: Context) -> None:
    session = _known(context.session, "the session")
    turn = _known(context.turn, "the running turn")
    queued = _known(context.queued, "the queued turn")
    # Still queued, before any await: the watch below sees only frames from
    # here on, so a launch before Stop must fail by name, not as the
    # successor step's timeout.
    equals(queued.observed_start, False, "the queued turn had not started before Stop")
    # Watch the wire before pressing Stop: the queued turn launches when the
    # stopped turn reaches its terminal, and only the frames' order on the
    # wire says which came first. The successor step reads the answer.
    launch_order = asyncio.create_task(
        _queued_starts_after_terminal(session.events(), turn, queued)
    )
    # Observed here, so a failure before the successor step reads it is that
    # step's failure, not a stray "exception was never retrieved" warning.
    launch_order.add_done_callback(lambda task: task.cancelled() or task.exception())
    context.launch_order = launch_order
    # The user's stop gesture is ``turn/interrupt``, the priority lane; its
    # ack is admission only, exactly like the cancel's.
    ack = await within("the turn/interrupt ack", COMMAND_BUDGET_MS, turn.interrupt())
    equals(ack.get("status"), "accepted", "turn/interrupt ack status")
    equals(ack.get("turnId"), turn.turn_id, "the turn the interrupt ack names")
    await _expect_stopped_turn(context, "interrupted")


async def _successor(context: Context) -> None:
    session = _known(context.session, "the session")
    queued = _known(context.queued, "the queued turn")
    entry = _known(context.queued_entry, "the queued entry")
    launch_order = _known(context.launch_order, "the launch-order watch")
    # A stop is scoped to the ACTIVE turn. The queued submit's fate is
    # decided at the launch boundary, where the SDK re-verified it and the
    # host launched it.
    outcome = await within("the queued turn's outcome", COMMAND_BUDGET_MS, queued.completed)
    if outcome.kind != "completed":
        raise AssertionError(f"the queued turn should run to completion; got {outcome!r}")
    equals(outcome.params.get("terminal"), "completed", "the queued turn's terminal")
    # Wire order, not continuation order: the watch opened before the Stop
    # saw the stopped turn's terminal and then this turn's ``turn/started``.
    started_after_terminal = await within(
        "the queued turn's launch", COMMAND_BUDGET_MS, launch_order
    )
    equals(
        started_after_terminal,
        True,
        "the queued turn's turn/started came after the stopped turn's terminal",
    )
    equals(queued.observed_start, True, "the handle saw the queued turn start")
    equals(session.pending.has(entry.command_id), False, "the launched entry left the pending set")
    answered = await within("the queued turn's items", COMMAND_BUDGET_MS, _agent_answered(queued))
    if not answered:
        raise AssertionError("the queued turn completed without the agent's message")


async def _queued_starts_after_terminal(
    events: Any, stopped: "Turn[str]", queued: "Turn[str]"
) -> bool:
    """Wire order at the stop boundary, read from the session's event stream:
    True when the queued turn's ``turn/started`` arrives after the stopped
    turn's ``turn/completed``, False when it arrives before it (an early
    launch). ``events`` is opened before the Stop is sent, so it holds both
    frames. The handle's ``observed_start`` cannot answer this after an await:
    a host may write the terminal and the launch in one chunk, and both fold
    before the continuation runs."""
    terminal_seen = False
    try:
        async for event in events:
            frame = event.frame
            turn_id = (frame.get("params") or {}).get("turnId")
            if frame.get("method") == "turn/completed" and turn_id == stopped.turn_id:
                terminal_seen = True
            elif frame.get("method") == "turn/started" and turn_id == queued.turn_id:
                return terminal_seen
    finally:
        await events.aclose()
    raise AssertionError("the session's events ended before the queued turn started")


async def _agent_answered(turn: "Turn[str]") -> bool:
    """Whether the turn's items hold a completed agent message; the walk ends with the turn."""
    answered = False
    async for item in turn.items():
        if item.get("kind") == "agentMessage" and item.get("status") == "completed":
            answered = True
    return answered


async def _drain(context: Context) -> None:
    client = _known(context.client, "the client")
    await within("the fixture host's orderly drain and exit", CLOSE_BUDGET_MS, client.close())
    classification = await client.exit
    equals(classification.kind, "cleanShutdown", "the fixture host's exit classification")
    context.client = None


def _opening(arm: Arm) -> tuple[Segment[Context], ...]:
    async def spawn(context: Context) -> None:
        await _spawn_fixture(context, arm)

    return (
        Segment(f"{arm.id}-spawn", f"Spawn the canned host playing the {arm.scenario} transcript", spawn),
        Segment(f"{arm.id}-session", "Start the session the turn will run in", _session),
        Segment(f"{arm.id}-turn-start", "Start a turn and watch its work stream in", _turn_start),
    )


def _interrupt_segments(arm: Arm) -> tuple[Segment[Context], ...]:
    """The interrupt arm over one of the two interrupt transcripts: queue, Stop, successor, drain."""
    return (
        *_opening(arm),
        Segment(
            f"{arm.id}-queue",
            'Submit a second turn while the first runs: disposition "queued"',
            _queue,
        ),
        Segment(
            f"{arm.id}-stop",
            "Press Stop: interrupt the running turn, then wait for its own terminal",
            _interrupt,
        ),
        Segment(
            f"{arm.id}-successor",
            "The queued turn was not consumed by the stop: it launches and completes",
            _successor,
        ),
        Segment(f"{arm.id}-drain", "Close stdin and let the fixture host exit cleanly", _drain),
    )


SEGMENTS: tuple[Segment[Context], ...] = (
    *_opening(CANCEL),
    Segment(f"{CANCEL.id}-stop", "Ask for the cancel, then wait for the turn's own terminal", _cancel),
    Segment(f"{CANCEL.id}-drain", "Close stdin and let the fixture host exit cleanly", _drain),
    *_interrupt_segments(INTERRUPT),
    *_interrupt_segments(INTERRUPT_BURST),
)


async def _run(hosts: RecipeHosts) -> JourneyReport:
    if hosts.conformance_bin is None:
        raise ValueError("conformance_bin is required")
    context = Context(conformance_bin=hosts.conformance_bin, transcript_root=hosts.transcript_root)

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
    title="Stop a turn while it is running",
    docs_page="cookbook/cancel-a-running-turn",
    needs=("conformance_bin",),
    run=_run,
)
