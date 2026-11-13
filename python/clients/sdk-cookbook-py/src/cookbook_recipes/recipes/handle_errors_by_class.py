"""Recipe twin: handle errors by class.

Runs against ``muse-conformance serve-fixture`` playing five committed golden
transcripts — the executable companion to the errors guide. Every MSP error
carries ``error.data.kind``, and every kind maps to exactly one next move for
the client. :func:`classify` is that mapping: a table over the whole error
catalogue, checked at run time against the wire package's list of known
kinds, plus the two members that outrank the table, ``data.retryable`` and
the ``missingAnchor`` reason of ``notFound``. One arm per transcript:

- ``usershell-without-grant`` — ``capabilityRequired`` (-32010), terminal
  for this connection; grants happen only at the handshake: ``reconnect``.
- ``cursor-never-existed`` — ``notFound`` with ``reason: "missingAnchor"``
  (-32011), the position rather than the reference is wrong: ``resync``.
- ``cursor-truncated`` — ``viewTruncated`` (-32040) with ``earliestCursor``,
  a ``resync`` that says where from.
- ``goal-missing-goal-rejection`` — ``commandRejected`` (-32030) with the
  snake_case reason ``missing_goal``, durable and user-facing: ``tellTheUser``.
- ``provider-failure-turn`` — no error response at all: the accepted turn
  fails later on the session view, a ``turn/completed`` with
  ``terminal: "failed"`` and ``error.retryable: true``; the retry is a NEW
  turn under a NEW commandId, and the arm plays that too.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from muse_code.connection import MspError
from muse_code_msp import ERROR_KIND_KNOWN_VALUES

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

# The five moves, in three classes: "retry" (retryable: the same command under
# the same commandId, after a backoff), "tellTheUser" (user-facing: a durable
# answer to the user's intent), and three terminal moves that differ in what
# you do instead of resending.
ClientMove = str
CLIENT_MOVES: tuple[ClientMove, ...] = ("retry", "tellTheUser", "reconnect", "resync", "stop")

# One row per kind. The recipe checks this dict against the wire package's
# list of known kinds, so a kind it forgets fails the run.
CLIENT_MOVE: dict[str, ClientMove] = {
    # Retryable: nothing was admitted; the same commandId may go again.
    "overloaded": "retry",
    "backpressured": "retry",
    "approvalBrokerUnavailable": "retry",
    # User-facing: a durable answer to the user's intent.
    "commandRejected": "tellTheUser",
    "sessionNotFound": "tellTheUser",
    "sessionInUse": "tellTheUser",
    "sessionAmbiguous": "tellTheUser",
    "forkBoundaryInvalid": "tellTheUser",
    "skillNotFound": "tellTheUser",
    "marketplaceNotFound": "tellTheUser",
    "pluginNotFound": "tellTheUser",
    "marketplaceAlreadyExists": "tellTheUser",
    "pluginMutationsDisabled": "tellTheUser",
    "uploadNotFound": "tellTheUser",
    "outputUnavailable": "tellTheUser",
    "approvalAlreadyResolved": "tellTheUser",
    "approvalReviewerUnavailable": "tellTheUser",
    "userInputAlreadySettled": "tellTheUser",
    "userInputAnswerInvalid": "tellTheUser",
    # Terminal, reconnect: granted only at the handshake.
    "capabilityRequired": "reconnect",
    "experimentalRequired": "reconnect",
    # Terminal, resync: the position is gone, or the answer is on the view.
    "viewTruncated": "resync",
    "boundaryPruned": "resync",
    "boundaryUnusable": "resync",
    "noBoundary": "resync",
    "interrupted": "resync",
    "cancelled": "resync",
    "approvalNotFound": "resync",
    "approvalRequirementStale": "resync",
    "approvalResolving": "resync",
    "userInputNotFound": "resync",
    # Terminal, stop: a precondition or a client bug; fix the request.
    "parseError": "stop",
    "invalidRequest": "stop",
    "notInitialized": "stop",
    "alreadyInitialized": "stop",
    "methodNotFound": "stop",
    "invalidParams": "stop",
    "internal": "stop",
    "pageEventTooLarge": "stop",
    "outputResultTooLarge": "stop",
    "inputTooLarge": "stop",
    "notFound": "stop",  # a missing view anchor becomes "resync" below
    "sessionNotLoaded": "stop",
    "sessionStreamMismatch": "stop",
    "computerUseUnavailable": "stop",
    "approvalChoiceInvalid": "stop",
}


def classify(error: MspError) -> ClientMove:
    """The move for a typed request error. Branches on ``kind``, never on message text."""
    # An explicit retryable from the host outranks the table.
    if error.retryable is True:
        return "retry"
    if error.kind == "notFound" and error.data.get("reason") == "missingAnchor":
        return "resync"
    # A newer host can send a kind this table has never seen: terminal until
    # you learn it, unless the host marked it retryable above.
    move = CLIENT_MOVE.get(error.kind, "stop")
    if move == "retry" and error.retryable is False:
        return "stop"
    return move


# The second layer. A turn that was accepted can still fail, and that failure
# is a ``turn/completed`` on the session view, never an error response. A
# failed terminal whose error is retryable asks for a NEW turn under a NEW
# commandId; any other failure is told to the user; everything else settled.
TurnMove = str


def classify_terminal(params: Mapping[str, Any]) -> TurnMove:
    if params.get("terminal") != "failed":
        return "settled"
    error = params.get("error")
    retryable = error.get("retryable") if isinstance(error, Mapping) else None
    return "newTurn" if retryable is True else "tellTheUser"


# The transcripts' own client-side values; see the module docstring.
SESSION_ID = "0198f0aa-1111-7000-8000-0000000000aa"
WORKSPACE_ROOT = "/home/me/src/proj"
USERSHELL_COMMAND_ID = "018f6a24-9999-7bbb-8ccc-00000000feed"
USERSHELL_COMMAND_TEXT = "git status"
UNISSUED_RESUME_COMMAND_ID = "0198f0ab-8888-7000-8000-0000000000c4"
UNISSUED_CURSOR = "v10:0198f0aa-2222-7000-8000-0000000000bb:9"
STALE_RESUME_COMMAND_ID = "0198f0ab-8888-7000-8000-0000000000c3"
STALE_CURSOR = "v10:0198f0aa-1111-7000-8000-0000000000aa:3"
SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1"
GOAL_PAUSE_COMMAND_ID = "018f6a22-400f-7000-8000-00000000d00f"
VIEW_SESSION_ID = "018f7294-0000-7000-8000-5f0e73500000"
VIEW_SUBSCRIBE_AFTER = "v10:018f7294-0000-7000-8000-5f0e73500000:4"
FAILING_TURN_COMMAND_ID = "018f7294-0000-7000-8000-5f0e73500105"
FAILING_TURN_PROMPT = "summarize the failing tests"
NEW_TURN_COMMAND_ID = "018f7294-0000-7000-8000-5f0e73500114"
NEW_TURN_PROMPT = "try again"


@dataclass
class Context:
    """The recipe's own state, reset by each arm's spawn segment."""

    conformance_bin: str
    transcript_root: str
    host: Host | None = None
    session_id: str | None = None
    failed_turn_id: str | None = None


def _known(value: str | None, what: str) -> str:
    if value is None:
        raise RuntimeError(f"{what} is not known: an earlier segment did not finish")
    return value


async def _expect_msp_error(what: str, action: Callable[[], Awaitable[Any]]) -> MspError:
    """Run ``action`` and hand back the MspError it must raise; anything else is a failure."""
    try:
        await action()
    except MspError as error:
        return error
    raise AssertionError(f"{what} must answer a typed MSP error; it succeeded instead")


def _spawn_segment(id_: str, scenario: str) -> Segment[Context]:
    async def spawn(context: Context) -> None:
        # Reclaim the previous arm's child; reset what an arm learns from its wire.
        if context.host is not None:
            await context.host.abandon(CLOSE_BUDGET_MS)
        context.host = None
        context.session_id = None
        context.failed_turn_id = None
        context.host = await spawn_fixture_host(
            conformance_bin=context.conformance_bin,
            transcript_dir=Path(context.transcript_root) / scenario,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
            client_info={"name": "conformance", "version": "0.0.0"},
            budget_ms=HANDSHAKE_BUDGET_MS,
        )

    return Segment(id_, f"Spawn the canned host playing the {scenario} transcript", spawn)


def _drain_segment(arm: str) -> Segment[Context]:
    async def drain(context: Context) -> None:
        host = require_host(context.host, f"{arm}-spawn")
        exit_ = await host.close(CLOSE_BUDGET_MS)
        equals(exit_.code, 0, "the fixture host's exit code after stdin EOF")
        context.host = None

    return Segment(f"{arm}-drain", "Close stdin and let the fixture host exit cleanly", drain)


async def _table_covers_the_catalogue(context: Context) -> None:
    # The wire package publishes the kinds it knows; the table must name each
    # of them exactly once and map it to one of the five moves.
    missing = sorted(set(ERROR_KIND_KNOWN_VALUES) - set(CLIENT_MOVE))
    if missing:
        raise AssertionError(f"the table has no row for these known kinds: {missing}")
    unknown = sorted(set(CLIENT_MOVE) - set(ERROR_KIND_KNOWN_VALUES))
    if unknown:
        raise AssertionError(f"the table names kinds the wire package does not know: {unknown}")
    for kind, move in CLIENT_MOVE.items():
        if move not in CLIENT_MOVES:
            raise AssertionError(f"{kind} maps to {move!r}, which is not one of the five moves")
    equals(CLIENT_MOVE["overloaded"], "retry", "the move for overloaded")
    equals(CLIENT_MOVE["commandRejected"], "tellTheUser", "the move for commandRejected")
    equals(CLIENT_MOVE["notFound"], "stop", "the move for a notFound that names no view anchor")


async def _moves_off_the_wire(context: Context) -> None:
    # These errors are built locally from the error objects a host would
    # send, because no committed transcript produces them; the function never
    # looks at anything but the error, so the answer is the same.
    overloaded = MspError({"code": -32001, "message": "ingress saturated", "data": {"kind": "overloaded"}})
    equals(classify(overloaded), "retry", "the move for overloaded")
    # An explicit retryable from the host outranks the table either way.
    pinned = MspError(
        {
            "code": -32001,
            "message": "ingress saturated, do not retry",
            "data": {"kind": "overloaded", "retryable": False},
        }
    )
    equals(classify(pinned), "stop", "the move for overloaded pinned not retryable")
    # A kind this table has never seen is terminal until you learn it.
    unknown = MspError({"code": -32099, "message": "from a newer host", "data": {"kind": "notYetInvented"}})
    equals(classify(unknown), "stop", "the move for a kind the table does not know")
    # Unless the host says so: an unknown kind marked retryable is a retry,
    # the way a host still starting up answers before it can serve.
    starting = MspError(
        {"code": -32015, "message": "startup pending", "data": {"kind": "startupPending", "retryable": True}}
    )
    equals(classify(starting), "retry", "the move for an unknown kind the host marks retryable")


async def _capability_denied(context: Context) -> None:
    host = require_host(context.host, "capability-spawn")
    # The handshake granted nothing, because this client asked for nothing.
    granted = host.msp.initialize_result.get("grantedCapabilities")
    equals(len(granted) if isinstance(granted, list) else 0, 0, "capabilities granted at the handshake")
    denial = await _expect_msp_error(
        "session/userShell without the grant",
        lambda: within("the session/userShell answer", COMMAND_BUDGET_MS, host.connection.command(
            "session/userShell",
            {"sessionId": SESSION_ID, "commandText": USERSHELL_COMMAND_TEXT},
            max_attempts=1,
            command_id=USERSHELL_COMMAND_ID,
        )),
    )
    equals(denial.kind, "capabilityRequired", "the denial's error kind")
    equals(denial.code, -32010, "the denial's JSON-RPC code")
    equals(denial.data.get("capability"), "userShell", "the capability the denial names")
    equals(denial.retryable, False, "whether the denial is retryable")
    # Terminal for this connection: grants happen only at the handshake, so
    # the client's next move is a new connection that asks for the grant.
    equals(classify(denial), "reconnect", "the move for a missing capability")


async def _anchor_missing(context: Context) -> None:
    host = require_host(context.host, "anchor-spawn")
    refusal = await _expect_msp_error(
        "session/resume with an unissued cursor",
        lambda: within("the session/resume answer", COMMAND_BUDGET_MS, host.connection.command(
            "session/resume",
            {"sessionId": SESSION_ID, "cursor": UNISSUED_CURSOR},
            max_attempts=1,
            command_id=UNISSUED_RESUME_COMMAND_ID,
        )),
    )
    equals(refusal.kind, "notFound", "the refusal's error kind")
    equals(refusal.code, -32011, "the refusal's JSON-RPC code")
    equals(refusal.data.get("reason"), "missingAnchor", "the refusal's reason")
    equals(refusal.data.get("sessionId"), SESSION_ID, "the session the refusal names")
    # The reason is what turns a terminal notFound into a resync: the
    # position is wrong, not the reference. Reopen without a cursor.
    equals(classify(refusal), "resync", "the move for a missing view anchor")


async def _truncated(context: Context) -> None:
    host = require_host(context.host, "truncated-spawn")
    refusal = await _expect_msp_error(
        "session/resume with a stale cursor",
        lambda: within("the session/resume answer", COMMAND_BUDGET_MS, host.connection.command(
            "session/resume",
            {"sessionId": SESSION_ID, "cursor": STALE_CURSOR},
            max_attempts=1,
            command_id=STALE_RESUME_COMMAND_ID,
        )),
    )
    equals(refusal.kind, "viewTruncated", "the refusal's error kind")
    equals(refusal.code, -32040, "the refusal's JSON-RPC code")
    # The error says where to resync from: the oldest position still served.
    earliest = string_at(refusal.data, "earliestCursor", "the viewTruncated data")
    equals(earliest, "v10:0198f0aa-1111-7000-8000-0000000000aa:200", "the earliest servable cursor")
    equals(classify(refusal), "resync", "the move for a truncated view")


async def _rejected_session(context: Context) -> None:
    host = require_host(context.host, "rejected-spawn")
    started = await within("the session/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "session/start",
        {"sessionId": SESSION_ID, "workspaceRoot": WORKSPACE_ROOT},
        max_attempts=1,
        command_id=SESSION_START_COMMAND_ID,
    ))
    session = object_at(started, "session", "session/start result")
    context.session_id = string_at(session, "sessionId", "session/start session")


async def _rejected(context: Context) -> None:
    host = require_host(context.host, "rejected-spawn")
    session_id = _known(context.session_id, "the session id")
    rejection = await _expect_msp_error(
        "goal/pause with no goal set",
        lambda: within("the goal/pause answer", COMMAND_BUDGET_MS, host.connection.command(
            "goal/pause",
            {"sessionId": session_id},
            max_attempts=1,
            command_id=GOAL_PAUSE_COMMAND_ID,
        )),
    )
    equals(rejection.kind, "commandRejected", "the rejection's error kind")
    equals(rejection.code, -32030, "the rejection's JSON-RPC code")
    equals(rejection.data.get("reason"), "missing_goal", "the rejection's reason")
    equals(rejection.data.get("commandId"), GOAL_PAUSE_COMMAND_ID, "the command the rejection settles")
    equals(rejection.retryable, False, "whether the rejection is retryable")
    # Durable and user-facing: the same commandId gets the same answer, so
    # the client tells the user and leaves the composer as it was.
    equals(classify(rejection), "tellTheUser", "the move for a durable rejection")


async def _view_subscribe(context: Context) -> None:
    host = require_host(context.host, "view-spawn")
    subscribed = await within("the view/subscribe result", COMMAND_BUDGET_MS, host.connection.request(
        "view/subscribe", {"sessionId": VIEW_SESSION_ID, "after": VIEW_SUBSCRIBE_AFTER}
    ))
    string_at(subscribed, "viewCursor", "view/subscribe result")


async def _view_turn_fails(context: Context) -> None:
    host = require_host(context.host, "view-spawn")
    # The request itself is answered with a result: admission accepted it.
    ack = await within("the turn/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "turn/start",
        {"sessionId": VIEW_SESSION_ID, "input": [{"type": "text", "text": FAILING_TURN_PROMPT}]},
        max_attempts=1,
        command_id=FAILING_TURN_COMMAND_ID,
    ))
    equals(ack.get("status"), "accepted", "turn/start ack status")
    turn_id = string_at(ack, "turnId", "turn/start ack")
    # The failure arrives later, on the view, as the turn's terminal.
    completed = await host.wait_for(
        "the failing turn's terminal",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    equals(completed.params.get("terminal"), "failed", "the failing turn's terminal")
    error = object_at(completed.params, "error", "the failed turn/completed params")
    equals(error.get("kind"), "modelError", "the terminal's error kind")
    equals(error.get("retryable"), True, "whether the terminal's error is retryable")
    # The turn is over; a retryable terminal asks for a NEW turn, never a
    # replay of this commandId.
    equals(classify_terminal(completed.params), "newTurn", "the move for a retryable failed terminal")
    context.failed_turn_id = turn_id


async def _view_new_turn(context: Context) -> None:
    host = require_host(context.host, "view-spawn")
    failed_turn_id = _known(context.failed_turn_id, "the failed turn's id")
    ack = await within("the new turn/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "turn/start",
        {"sessionId": VIEW_SESSION_ID, "input": [{"type": "text", "text": NEW_TURN_PROMPT}]},
        max_attempts=1,
        command_id=NEW_TURN_COMMAND_ID,
    ))
    equals(ack.get("status"), "accepted", "the new turn/start ack status")
    turn_id = string_at(ack, "turnId", "the new turn/start ack")
    if turn_id == failed_turn_id:
        raise AssertionError("the retry must be a new turn, not the failed one")
    completed = await host.wait_for(
        "the new turn's terminal",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    equals(completed.params.get("terminal"), "completed", "the new turn's terminal")
    equals(classify_terminal(completed.params), "settled", "the move for a completed terminal")


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment(
        "table-covers-the-catalogue",
        "The table maps every known error kind to one of the five moves",
        _table_covers_the_catalogue,
    ),
    Segment(
        "moves-off-the-wire",
        "The moves for answers no committed transcript produces: overloaded, an explicit retryable, an unknown kind",
        _moves_off_the_wire,
    ),
    _spawn_segment("capability-spawn", "usershell-without-grant"),
    Segment(
        "capability-denied",
        "Call a capability-gated method without the grant: capabilityRequired, move reconnect",
        _capability_denied,
    ),
    _drain_segment("capability"),
    _spawn_segment("anchor-spawn", "cursor-never-existed"),
    Segment(
        "anchor-missing",
        "Resume from a cursor the host never issued: notFound with missingAnchor, move resync",
        _anchor_missing,
    ),
    _drain_segment("anchor"),
    _spawn_segment("truncated-spawn", "cursor-truncated"),
    Segment(
        "truncated",
        "Resume from a cursor older than the retained view: viewTruncated, move resync",
        _truncated,
    ),
    _drain_segment("truncated"),
    _spawn_segment("rejected-spawn", "goal-missing-goal-rejection"),
    Segment("rejected-session", "Start a session that has no goal", _rejected_session),
    Segment(
        "rejected",
        "Pause the goal that does not exist: commandRejected, move tellTheUser",
        _rejected,
    ),
    _drain_segment("rejected"),
    _spawn_segment("view-spawn", "provider-failure-turn"),
    Segment("view-subscribe", "Subscribe to the session view the turn will report on", _view_subscribe),
    Segment(
        "view-turn-fails",
        "An accepted turn fails on the view, not as an error response: move newTurn",
        _view_turn_fails,
    ),
    Segment(
        "view-new-turn",
        "Retry as a new turn under a new commandId, and watch it complete",
        _view_new_turn,
    ),
    _drain_segment("view"),
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
    id="handle-errors-by-class",
    title="Handle errors by class",
    docs_page="cookbook/handle-errors-by-class",
    needs=("conformance_bin",),
    run=_run,
)
