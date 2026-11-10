"""Recipe twin: queue, steer, and reclaim turns — the multi-turn traffic
rules every chat-style UI eventually hits.

Runs against ``muse-conformance serve-fixture`` playing the committed golden
transcript ``schema/msp/transcripts/turn-unqueued-round-trip``.

What it teaches: a submit gets a ``disposition`` and that word is the whole
routing decision (``started`` / ``queued`` — the turn handle names the
PRE-MINTED turn — / ``steered``), and ``session.pending`` shows it: a queued
submit stays there, acked ``queued``. A queued submit can be taken back
before it launches with ``turn.unqueue()``: the accepted reclaim retires the
entry ``reclaimed`` with the original input restored to the composer, and the
pre-minted turn's ``turn.completed`` settles as ``unqueued`` (no
``turn/completed`` ever carries a reclaimed turnId). ``unqueue()``
returns that retirement whichever of the ack and ``turn/unqueued`` the client
reads first.
And the reclaim is surgical — the active turn runs to its own terminal.

Steering is taught on the page but not exercised here: no committed
transcript records a steered submit, because what a steer absorbs depends on
a live model's timing.

Fixture mechanics: serve-fixture replays recorded server lines byte-exactly,
so acks echo the RECORDED commandId and the SDK verifies that echo. The
connection's one commandId minter is therefore scripted with the transcript's
ids in send order; everything else goes through the ``MuseClient`` facade.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence, TypeVar

from muse_code import (
    MuseClient,
    MuseClientOptions,
    SendUserTurnOptions,
    Session,
    StartSessionOptions,
    Turn,
    TurnUnqueueOutcome,
    read_session_durability,
)
from muse_code.connection.spawn import spawn_msp_connection
from muse_code.pending.pending_command_set import PendingCommandEntry, ReclaimedRetirement

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

SCENARIO = "turn-unqueued-round-trip"

# The transcript's own client-side values; see the module docstring.
WORKSPACE_ROOT = "/home/me/src/proj"
ACTIVE_PROMPT = "Review the current deployment state"
QUEUED_PROMPT = "Run the queued deployment checks"
SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1"
ACTIVE_TURN_COMMAND_ID = "018f6a32-1111-7000-8000-0000000000a1"
QUEUED_TURN_COMMAND_ID = "018f6a32-3333-7000-8000-0000000000c3"
UNQUEUE_COMMAND_ID = "018f6a32-5555-7000-8000-0000000000c5"

_T = TypeVar("_T")


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    conformance_bin: str
    transcript_root: str
    client: "MuseClient[str] | None" = None
    session: "Session[str] | None" = None
    active: "Turn[str] | None" = None
    queued: "Turn[str] | None" = None
    # The queued submit's pending entry, as ``session.pending`` showed it.
    queued_entry: "PendingCommandEntry[str] | None" = None
    # What ``turn.unqueue()`` returned, set once the reclaim was accepted.
    unqueued: "TurnUnqueueOutcome[str] | None" = None


def _known(value: _T | None, what: str) -> _T:
    if value is None:
        raise RuntimeError(f"{what} is not known: an earlier segment did not finish")
    return value


def _scripted_command_ids(ids: Sequence[str]) -> Callable[[], str]:
    """Hand out the transcript's commandIds in send order. Harness-only: a real
    client keeps the SDK's default minter, which is what makes ids unique."""
    queue = list(ids)

    def mint() -> str:
        if not queue:
            raise RuntimeError("the recipe sent more commands than the transcript records")
        return queue.pop(0)

    return mint


async def _spawn(context: Context) -> None:
    transcript_dir = Path(context.transcript_root) / SCENARIO
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
                (
                    SESSION_START_COMMAND_ID,
                    ACTIVE_TURN_COMMAND_ID,
                    QUEUED_TURN_COMMAND_ID,
                    UNQUEUE_COMMAND_ID,
                )
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
    # Durability comes off the handshake: it decides what happens to pending
    # commands if the host dies.
    durability = read_session_durability(spawned.initialize_result)
    equals(durability.kind, "durable", "the handshake's session durability")
    context.client = MuseClient(
        spawned.connection, MuseClientOptions(durability=durability, host=spawned)
    )


async def _session(context: Context) -> None:
    client = _known(context.client, "the client")
    context.session = await within(
        "the session/start result",
        COMMAND_BUDGET_MS,
        client.start_session(StartSessionOptions(workspace_root=WORKSPACE_ROOT)),
    )


async def _first_item_of_kind(turn: "Turn[str]", kind: str) -> Mapping[str, object]:
    async for item in turn.items():
        if item.get("kind") == kind:
            return item
    raise AssertionError(f"the turn ended without a {kind} item")


async def _start_active(context: Context) -> None:
    session = _known(context.session, "the session")
    # ``composer_input`` is what a retirement hands back; the SDK records the
    # pending entry before it writes the wire, so a UI can render it at once.
    active = await within(
        "the turn/start ack",
        COMMAND_BUDGET_MS,
        session.send_user_turn(
            SendUserTurnOptions(
                input=[{"type": "text", "text": ACTIVE_PROMPT}], composer_input=ACTIVE_PROMPT
            )
        ),
    )
    # The userMessage carrying our commandId folding in is what retires the
    # entry: the optimistic echo is replaced by the durable item.
    user_message = await within(
        "the active turn's userMessage item",
        COMMAND_BUDGET_MS,
        _first_item_of_kind(active, "userMessage"),
    )
    equals(user_message.get("commandId"), ACTIVE_TURN_COMMAND_ID, "the userMessage's commandId")
    equals(session.pending.size, 0, "pending entries once the started submit materialized")
    equals(active.observed_start, True, "the started submit's turn began")
    context.active = active


async def _queue(context: Context) -> None:
    session = _known(context.session, "the session")
    queued = await within(
        "the queued submit's ack",
        COMMAND_BUDGET_MS,
        session.send_user_turn(
            SendUserTurnOptions(
                input=[{"type": "text", "text": QUEUED_PROMPT}],
                if_busy="queue",
                composer_input=QUEUED_PROMPT,
            )
        ),
    )
    # The handle names a turn that does not run yet. Nothing has settled the
    # entry, so it stays pending — exactly what a UI renders as "queued, not
    # yet running" — until the wire says launched, rejected, or reclaimed.
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
    equals(entry.input, QUEUED_PROMPT, "the queued entry's composer input")
    equals(queued.observed_start, False, "queued input starts no turn yet")
    context.queued = queued
    context.queued_entry = entry


async def _reclaim(context: Context) -> None:
    session = _known(context.session, "the session")
    queued = _known(context.queued, "the queued turn")
    entry = _known(context.queued_entry, "the queued entry")
    unqueued = await within("the turn/unqueue ack", COMMAND_BUDGET_MS, queued.unqueue())
    equals(unqueued.ack.get("status"), "accepted", "turn/unqueue ack status")
    equals(unqueued.ack.get("turnId"), queued.turn_id, "the turnId the unqueue ack echoes")
    equals(session.pending.has(entry.command_id), False, "the reclaimed entry is gone")
    # The next segment asserts what came back; keep it for that step.
    context.unqueued = unqueued

    # The pre-minted turn's outcome is `unqueued` — its own terminal kind. No
    # turn/completed will ever carry this turnId, so a wait folding only
    # turn/completed would hang forever.
    outcome = await within("the reclaimed turn's outcome", COMMAND_BUDGET_MS, queued.completed)
    if outcome.kind != "unqueued":
        raise AssertionError(f"the reclaimed turn should settle unqueued; got {outcome!r}")
    # turn/unqueued names the turn/start that QUEUED the turn — the entry it
    # retires — not the unqueue command that reclaimed it.
    equals(outcome.params.get("commandId"), entry.command_id, "turn/unqueued's commandId")


async def _reclaim_returns_the_draft(context: Context) -> None:
    retirement = _known(context.unqueued, "the unqueue result").retirement
    if retirement is None:
        raise AssertionError("unqueue() returned no retirement for the accepted reclaim")
    # The whole point of the gesture: the input comes BACK. A client that
    # drops it here has turned "un-send" into "delete my draft".
    if not isinstance(retirement, ReclaimedRetirement):
        raise AssertionError(f"the reclaim should retire the entry as reclaimed; got {retirement!r}")
    equals(retirement.restore_to_composer, True, "the reclaim restores to the composer")
    equals(retirement.input, QUEUED_PROMPT, "the input handed back to the composer")


async def _active_untouched(context: Context) -> None:
    active = _known(context.active, "the active turn")
    outcome = await within("the active turn's outcome", COMMAND_BUDGET_MS, active.completed)
    if outcome.kind != "completed":
        raise AssertionError(f"the active turn should complete; got {outcome!r}")
    equals(outcome.params.get("terminal"), "completed", "the active turn's terminal")
    equals(outcome.observed_start, True, "this session observed the active turn start")


async def _drain(context: Context) -> None:
    client = _known(context.client, "the client")
    await within("the fixture host's orderly drain and exit", CLOSE_BUDGET_MS, client.close())
    classification = await client.exit
    equals(classification.kind, "cleanShutdown", "the fixture host's exit classification")
    context.client = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment("spawn", f"Spawn the canned host playing the {SCENARIO} transcript", _spawn),
    Segment("session", "Start the session through the client", _session),
    Segment(
        "start-active",
        'Submit while idle: disposition "started", entry retires as materialized',
        _start_active,
    ),
    Segment(
        "queue", 'Submit while busy: disposition "queued", the ack pre-mints the turn', _queue
    ),
    Segment(
        "reclaim", "Reclaim the queued turn: unqueue, entry back to the composer", _reclaim
    ),
    Segment(
        "reclaim-returns-the-draft",
        "The accepted unqueue hands the draft back to the composer",
        _reclaim_returns_the_draft,
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
        client = owned.client
        if client is not None:
            try:
                await within("the fixture host's teardown drain", CLOSE_BUDGET_MS, client.close())
            except Exception as error:  # noqa: BLE001 - warned, never raised
                import sys

                print(f"teardown: the fixture host did not drain cleanly: {error}", file=sys.stderr)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="queue-steer-reclaim",
    title="Queue, steer, and reclaim turns",
    docs_page="cookbook/queue-steer-and-reclaim-turns",
    needs=("conformance_bin",),
    run=_run,
)
