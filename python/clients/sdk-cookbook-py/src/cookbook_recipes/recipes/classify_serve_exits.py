"""Recipe twin: classify every way ``muse serve`` can exit.

Stderr is evidence a client captures and never parses, and the exit code is
the contract a client branches on when the process dies before or instead of
answering. The SDK does the mapping — ``MuseServeChild.exit`` resolves to an
``ExitClassification`` the moment the host is gone — so what a client writes
is one branch on ``kind``.

Four exits, each proven where it can be proven honestly: the switched-off
SDK gate (exit 5, never retry), a spawn failure (not an exit at all —
``child.exit`` REJECTS), the configuration row (exit 3 via the fixture host,
the release binary has no producer for it), and the clean stdin-EOF drain
(exit 0, the one durably-closed row). Plus the one non-exit this recipe
exists to keep separate: a FAILED TURN on a live host, with
``is_launch_failure`` reading the launch-boundary WIRE marker — driven
through the public facade fold (``Session``/``Turn``), the surface a Python
consumer actually reads a ``TurnOutcome`` from.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass
from typing import Any, Mapping

from muse_code import Session, is_launch_failure, read_session_durability
from muse_code.connection.spawn import MuseServeChild, spawn_msp_connection
from quickstart_journey.host import SDK_GATE_ENV

from ..kit import (
    equals,
    Host,
    HostOptions,
    JourneyReport,
    object_at,
    require_host,
    run_journey,
    Segment,
    string_at,
    TimeoutBudgetError,
    within,
)
from ..runner import Recipe, RecipeHosts

EXIT_BUDGET_MS = 30_000
HANDSHAKE_BUDGET_MS = 30_000
COMMAND_BUDGET_MS = 30_000
CLOSE_BUDGET_MS = 30_000


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    muse_bin: str
    conformance_bin: str
    host: Host | None = None
    workspace_root: str | None = None
    session_id: str | None = None
    failed_params: Mapping[str, Any] | None = None
    failed_observed_start: bool = False


def _base_env(home: str) -> dict[str, str]:
    """The complete child environment every spawn here starts from."""
    return {
        "HOME": home,
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "TBH_CREDENTIAL_BACKEND": "file",
        "TBH_DISABLE_TELEMETRY": "1",
    }


async def _gate_closed(context: Context) -> None:
    # The one env difference from every healthy spawn in this cookbook: the
    # gate env explicitly "off". A switched-off host answers exit 5 for every
    # argument vector — nothing was parsed, no host was constructed — so
    # initialize is never worth sending; the exit is the whole conversation.
    handshake = await spawn_msp_connection(
        context.muse_bin,
        args=("serve",),
        env={
            **_base_env(tempfile.mkdtemp(prefix="muse-cookbook-home-")),
            SDK_GATE_ENV: "off",
        },
    )
    try:
        classification = await within(
            "the gated host's exit", EXIT_BUDGET_MS, handshake.child.exit
        )
        equals(classification.kind, "sdkSurfaceUnavailable", "the closed gate's classification")
        equals(classification.exit_code, 5, "the closed gate's exit code")
        # "never" means never: do not retry, and not with different arguments
        # either — no invocation of this binary will serve.
        equals(classification.retry, "never", "the closed gate's retry posture")
        # The evidence obligation: stderr is captured and surfaced, never
        # parsed. Its presence is asserted; its content deliberately not.
        if not classification.stderr_tail:
            raise AssertionError("a refused start must leave stderr evidence to surface")
    finally:
        # A fast no-op on the already-exited child; on the failure path it is
        # what keeps a detached process-group leader from outliving the run.
        try:
            await handshake.child.close()
        except Exception:  # noqa: BLE001 - reclaim only
            pass


async def _never_launched(context: Context) -> None:
    # No process ran, so there is no exit to classify: child.exit REJECTS
    # with the spawn error. Branch on this separately from every
    # ExitClassification row — "the host never ran" and "the host ran and
    # died" have different remedies.
    home = tempfile.mkdtemp(prefix="muse-cookbook-home-")
    missing = os.path.join(home, "no-such-muse-host")
    try:
        handshake = await spawn_msp_connection(missing, env=_base_env(home))
    except FileNotFoundError:
        # The Python SDK surfaces the spawn failure at the spawn call itself
        # (asyncio raises before a child object exists) — the same "never ran
        # is not an exit" boundary, reached one call earlier than in TS.
        return
    try:
        classification = await within(
            "the failed spawn's settlement", EXIT_BUDGET_MS, handshake.child.exit
        )
    except TimeoutBudgetError:
        # Our own budget is NOT the rejection this segment exists to see: a
        # child.exit that hangs on a failed spawn is a regression, not a pass.
        raise
    except FileNotFoundError:
        return
    raise AssertionError(
        f"a host that never ran must not classify; got {classification!r}"
    )


async def _config_error_row(context: Context) -> None:
    # The canned host exits with exactly the code it is told to — how the
    # SDK's own exit-table test reaches every row deterministically. Fixture
    # plumbing, not client guidance: today's release binary cannot be
    # provoked into exit 3, and the row's meaning is the contract this pins.
    child = await MuseServeChild.spawn(
        context.conformance_bin,
        args=("serve-fixture", "--exit-code", "3", "--stderr-lines", "3"),
        env=_base_env(tempfile.mkdtemp(prefix="muse-cookbook-home-")),
    )
    try:
        classification = await within("the fixture host's exit", EXIT_BUDGET_MS, child.exit)
        equals(classification.kind, "configError", "exit 3's classification")
        equals(classification.exit_code, 3, "the configuration row's exit code")
        equals(classification.retry, "fix-config", "the configuration row's retry posture")
        if not classification.stderr_tail:
            raise AssertionError("the configuration row must carry stderr naming what to fix")
    finally:
        try:
            await child.close()
        except Exception:  # noqa: BLE001 - reclaim only
            pass


async def _spawn_live_host(context: Context) -> None:
    # An isolated HOME with no credentials: the host composes its logged-out
    # fallback and keeps serving — the next segment needs a host whose turns
    # fail while the process lives.
    context.workspace_root = tempfile.mkdtemp(prefix="muse-cookbook-ws-")
    context.host = await Host.start(
        HostOptions(
            muse_bin=context.muse_bin,
            home=tempfile.mkdtemp(prefix="muse-cookbook-home-"),
            workspace_root=context.workspace_root,
            client_info={"name": "muse_sdk_cookbook_py", "version": "0.0.0"},
        ),
        HANDSHAKE_BUDGET_MS,
    )
    host = require_host(context.host, "spawn-live-host")
    result = await within("the session/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "session/start", {"workspaceRoot": context.workspace_root}
    ))
    session = object_at(result, "session", "session/start result")
    context.session_id = string_at(session, "sessionId", "session/start session")


async def _failed_turn_is_not_an_exit(context: Context) -> None:
    host = require_host(context.host, "spawn-live-host")
    session_id = context.session_id
    if session_id is None:
        raise RuntimeError("`spawn-live-host` did not finish")
    ack = await within("the turn/start ack", COMMAND_BUDGET_MS, host.connection.command(
        "turn/start", {"sessionId": session_id, "input": [{"type": "text", "text": "say hello"}]}
    ))
    equals(ack.get("status"), "accepted", "turn/start ack status")
    turn_id = string_at(ack, "turnId", "turn/start ack")
    completed = await host.wait_for(
        "the turn/completed notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    equals(completed.params.get("terminal"), "failed", "the logged-out turn's terminal")
    # The started-ness is asserted, not assumed: the logged-out turn's run
    # STARTED and then could not reach a model.
    observed_start = any(
        n.method == "turn/started" and n.params.get("turnId") == turn_id
        for n in host.notifications()
    )
    equals(observed_start, True, "turn/started observed for the logged-out turn")
    # Not every failed turn is a launch failure: its error kind is the typed
    # "authRequired" (retryable: false — sign in, then resubmit). Branch on
    # the marker, never on terminal == "failed" alone.
    error = object_at(completed.params, "error", "turn/completed params")
    equals(error.get("kind"), "authRequired", "the logged-out failure's error kind")
    equals(error.get("retryable"), False, "authRequired is not retryable until sign-in")
    context.failed_params = completed.params
    context.failed_observed_start = observed_start
    # ...and none of it is a host exit: the same process answers the very
    # next request. THIS is the distinction the recipe exists to teach.
    read = await within(
        "session/read on the host that just failed a turn",
        COMMAND_BUDGET_MS,
        host.connection.request("session/read", {"sessionId": session_id, "excludeItems": True}),
    )
    session = object_at(read, "session", "session/read result")
    equals(session.get("sessionId"), session_id, "the live host still reads its session")


def _fold_outcome(
    host: Host, session_id: str, frames: list[Mapping[str, Any]], turn_id: str
) -> Any:
    """A ``TurnOutcome`` the PUBLIC way: fold the frames through ``Session``.

    A facade consumer gets its outcome from the turn waiter; this
    connection-level recipe builds the same value through the same public
    fold instead of reaching for the SDK's internal dataclasses.
    """
    session: Session[Any] = Session(
        session_id, read_session_durability(host.msp.initialize_result)
    )
    turn = session.turn(turn_id)
    for frame in frames:
        session.apply(frame)
    completed = turn.completed
    if not completed.done():
        raise AssertionError("the folded frames did not settle the turn wait")
    return completed.result()


async def _launch_failure_is_a_turn_marker(context: Context) -> None:
    host = require_host(context.host, "spawn-live-host")
    session_id = context.session_id
    failed = context.failed_params
    if session_id is None or failed is None:
        raise RuntimeError("`failed-turn-is-not-an-exit` did not finish")
    real_turn_id = str(failed.get("turnId"))
    # The FALSE arm, on the REAL wire frames: started then failed
    # (authRequired) is not a launch failure.
    real_outcome = _fold_outcome(
        host,
        session_id,
        [
            {
                "method": "turn/started",
                "params": {
                    "sessionId": session_id,
                    "turnId": real_turn_id,
                    "viewCursor": "v:recipe:1",
                },
            },
            {"method": "turn/completed", "params": dict(failed)},
        ],
        real_turn_id,
    )
    equals(is_launch_failure(real_outcome), False, "is_launch_failure on an auth-required terminal")
    # The TRUE arm: the deferred-start-failed shape — the same failed
    # terminal, had the turn died at the LAUNCH boundary instead (error kind
    # "launchError", no turn/started ever emitted). Synthetic on purpose: a
    # headless recipe cannot make a real host fail a launch on demand, and
    # the helper's contract is exactly this wire shape — the same
    # real-arm-plus-synthetic-arm pattern the fingerprint recipe uses.
    launch_params = dict(failed)
    launch_params["turnId"] = f"{real_turn_id}-launch-shape"
    launch_params["error"] = {
        "kind": "launchError",
        "message": "synthetic launch failure",
        "retryable": True,
    }
    launch_outcome = _fold_outcome(
        host,
        session_id,
        [{"method": "turn/completed", "params": launch_params}],
        launch_params["turnId"],
    )
    equals(launch_outcome.observed_start, False, "no turn/started on the launch shape")
    equals(is_launch_failure(launch_outcome), True, "is_launch_failure on the launch-error shape")


async def _clean_drain(context: Context) -> None:
    host = require_host(context.host, "spawn-live-host")
    exit_ = await host.close(CLOSE_BUDGET_MS)
    equals(exit_.code, 0, "the host's exit code after stdin EOF")
    equals(exit_.signal, None, "the host's exit signal after stdin EOF")
    classification = await host.msp.child.exit
    equals(classification.kind, "cleanShutdown", "the orderly drain's classification")
    context.host = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment(
        "gate-closed",
        "A host whose SDK gate is switched off answers exit 5 before parsing anything",
        _gate_closed,
    ),
    Segment(
        "never-launched", "A binary that could not spawn rejects instead of classifying", _never_launched
    ),
    Segment(
        "config-error-row", "Exit 3 classifies as configError with the fix-config posture", _config_error_row
    ),
    Segment("spawn-live-host", "Spawn the release-built host, logged out on purpose", _spawn_live_host),
    Segment(
        "failed-turn-is-not-an-exit",
        "A failed turn is a wire event; the host that delivered it is still serving",
        _failed_turn_is_not_an_exit,
    ),
    Segment(
        "launch-failure-is-a-turn-marker",
        "is_launch_failure reads the launch-boundary wire shape, never a process exit",
        _launch_failure_is_a_turn_marker,
    ),
    Segment(
        "clean-drain",
        "Close stdin and the orderly drain ends in the one durably-closed row",
        _clean_drain,
    ),
)


async def _run(hosts: RecipeHosts) -> JourneyReport:
    if hosts.muse_bin is None:
        raise ValueError("muse_bin is required")
    if hosts.conformance_bin is None:
        raise ValueError("conformance_bin is required")
    context = Context(muse_bin=hosts.muse_bin, conformance_bin=hosts.conformance_bin)

    async def teardown(owned: Context) -> None:
        if owned.host is not None:
            await owned.host.abandon(CLOSE_BUDGET_MS)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="classify-serve-exits",
    title="Classify every way muse serve can exit",
    docs_page="developer-docs/src/content/docs/cookbook/classify-every-serve-exit.mdx",
    needs=("muse_bin", "conformance_bin"),
    run=_run,
)
