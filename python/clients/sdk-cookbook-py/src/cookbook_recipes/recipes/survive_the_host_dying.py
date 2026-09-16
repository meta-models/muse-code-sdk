"""Recipe twin: survive the host dying under you.

Hosts die — a crash, an OOM kill, a stray signal — and none of them ask your
app first. The durability fork every embedder has to get right:

- read ``sessionDurability`` off the handshake with
  ``read_session_durability`` BEFORE you need it (absent means durable; an
  unrecognized value guarantees NOTHING);
- when the host dies, report the death to every session
  (``Session.host_exited``) and branch on the discharge: durable → live
  waits reject with ``MuseHostDiedError`` and nothing is discarded;
  ephemeral → the obligation discharges in full (terminal-unknown items,
  retired commands with inputs handed back, deliberately NO composer
  restore);
- an orderly close is NOT a death (``notADeath``);
- what survives is what you PUT in the session: give it a durable fact
  before you rely on resuming it.

HARNESS PLUMBING, NOT CLIENT GUIDANCE, two pieces: the SDK exposes no pid or
kill, so the killable host is launched through a three-line shell wrapper
that prints its pid on stderr and ``exec``s the real binary; and the journey
spawns hosts the way ``MuseClient.spawn`` does inside (``spawn_msp_connection``
+ ``initialize`` + a composed ``MuseClient``) because it also has to speak
``session/list``, which the facade does not wrap.
"""

from __future__ import annotations

import asyncio
import os
import re
import signal
import tempfile
import time
from dataclasses import dataclass
from typing import Any, Callable, List, Mapping, Tuple

from muse_code import (
    DiscardedSessions,
    MuseClient,
    MuseClientOptions,
    MuseHostDiedError,
    MuseSessionDiscardedError,
    ResumeSessionOptions,
    Session,
    StartSessionOptions,
    read_session_durability,
)
from muse_code.connection.spawn import (
    ExitClassification,
    SpawnedMspConnection,
    spawn_msp_connection,
)

from ..kit import (
    equals,
    HOST_DRAIN_WINDOW_MS,
    isolated_host_env,
    JourneyReport,
    run_journey,
    Segment,
    TimeoutBudgetError,
    within,
)
from ..runner import Recipe, RecipeHosts

HANDSHAKE_BUDGET_MS = 30_000
COMMAND_BUDGET_MS = 30_000
EXIT_BUDGET_MS = 15_000
SETTLE_BUDGET_MS = 10_000
CLOSE_BUDGET_MS = 30_000

PID_MARKER = "muse-cookbook-host-pid"
"""The stderr marker the shell wrapper prints. Test plumbing; see the module
docstring."""

APPROVAL_MODE = "denyUnmatched"
"""The one durable fact the killed session carries. It MUST stay a
non-default mode: the host records a mode only when the selection differs
from its default, so a default pick writes nothing, leaves the session
empty, and hands the fresh-host segment straight back to the litter reclaim
it exists to outlive. ``denyUnmatched`` because it is also the most
conservative mode, so nothing here reads as advice about which mode to run."""

EPHEMERAL_SESSION_ID = "an-ephemeral-conversation"

SIGKILL_ROW = ExitClassification(kind="crash", exit_signal="SIGKILL")
"""The synthetic crash row the ephemeral arm discharges with."""


async def _capture(wait: "asyncio.Future[Any]") -> Tuple[str, Any]:
    """A wait's settlement, without letting a rejection escape."""
    try:
        outcome = await wait
    except Exception as error:  # noqa: BLE001 - the settlement IS the datum
        return ("rejected", error)
    return ("resolved", outcome)


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    muse_bin: str
    home: str
    workspace_root: str
    client_a: "MuseClient[Any] | None" = None
    host_pid: int | None = None
    session_a: "Session[Any] | None" = None
    session_id: str | None = None
    doomed_wait: "asyncio.Task[Tuple[str, Any]] | None" = None
    exit_row: ExitClassification | None = None
    client_b: "MuseClient[Any] | None" = None
    session_b: "Session[Any] | None" = None
    ephemeral: "Session[str] | None" = None
    ephemeral_discharge: Any = None
    discarded: DiscardedSessions | None = None


def _must(value: Any, what: str) -> Any:
    if value is None:
        raise RuntimeError(f"no {what}: an earlier segment did not finish")
    return value


async def _spawn_host(
    context: Context, killable: bool
) -> tuple["MuseClient[Any]", SpawnedMspConnection, Callable[[], str]]:
    """Spawn a host and hand back the facade this page teaches, ``MuseClient``.

    Spelled the way ``MuseClient.spawn`` is spelled inside, so the journey
    keeps the raw connection for the one method the facade does not wrap,
    ``session/list``. ``killable`` selects the pid-marker wrapper: ``$$`` is
    the shell's own pid and ``exec`` REPLACES the shell with the host binary,
    so the printed pid IS the host's pid.
    """
    stderr: List[str] = []
    if killable:
        command = "/bin/sh"
        args: tuple[str, ...] = ("-c", f'echo "{PID_MARKER}=$$" >&2; exec "$0" serve', context.muse_bin)
    else:
        command = context.muse_bin
        args = ("serve",)
    handshake = await spawn_msp_connection(
        command,
        args=args,
        cwd=context.workspace_root,
        env=isolated_host_env(context.home),
        on_stderr=stderr.append,
        # The kit's owned drain window, so the drain bound and the SDK's
        # actual window cannot drift apart.
        shutdown_timeout_ms=HOST_DRAIN_WINDOW_MS,
    )
    try:
        host = await within(
            "the MSP handshake",
            HANDSHAKE_BUDGET_MS,
            handshake.initialize(
                {"clientInfo": {"name": "muse_sdk_cookbook_py", "version": "0.0.0"}}
            ),
        )
    except BaseException:
        # A failed handshake must not leak the process it already spawned.
        try:
            await handshake.close()
        except Exception:  # noqa: BLE001 - reclaim only
            pass
        raise
    client: MuseClient[Any] = MuseClient(
        host.connection,
        MuseClientOptions(durability=read_session_durability(host.initialize_result), host=host),
    )
    return client, host, lambda: "".join(stderr)


async def _host_pid(stderr: Callable[[], str], budget_ms: int) -> int:
    """Wait for the wrapper's pid marker to land on the recorded stderr.

    A failure cap, not pacing: the marker is the wrapper's first write, so a
    run that reaches the wall has a wedged spawn to report.
    """
    deadline = time.monotonic() + budget_ms / 1000
    marker = re.compile(rf"{PID_MARKER}=(\d+)")
    while True:
        matched = marker.search(stderr())
        if matched:
            return int(matched.group(1))
        if time.monotonic() > deadline:
            raise TimeoutBudgetError("the host pid marker on stderr", budget_ms)
        await asyncio.sleep(0.025)


def _synthetic_handshake(session_durability: str | None = None) -> Mapping[str, Any]:
    """A synthetic handshake result for the transport-less arm. Only
    ``sessionDurability`` matters; an application never builds one of these —
    it reads the real result off ``MuseClient.spawn``."""
    result: dict[str, Any] = {
        "experimentalApi": False,
        "grantedCapabilities": [],
        "museHome": "/nowhere/.muse",
        "platformFamily": "unix",
        "platformOs": "linux",
        "schema": {"fingerprint": "sha256:0", "version": 1},
        "serverInfo": {"name": "a-host-that-never-ran", "version": "0.0.0"},
        "userAgent": "a-host-that-never-ran/0.0.0",
    }
    if session_durability is not None:
        result["sessionDurability"] = session_durability
    return result


def _item_started(item: Mapping[str, Any], view_cursor: str) -> Mapping[str, Any]:
    """An ``item/started`` view event for the fold-only arm."""
    return {
        "method": "item/started",
        "params": {"item": dict(item), "sessionId": EPHEMERAL_SESSION_ID, "viewCursor": view_cursor},
    }


async def _spawn_and_read_durability(context: Context) -> None:
    client, _host, stderr = await _spawn_host(context, killable=True)
    context.client_a = client
    context.host_pid = await _host_pid(stderr, SETTLE_BUDGET_MS)
    # Read the profile the moment you have the handshake — after the host
    # dies is too late to ask it. The release host's sessions are durable.
    profile = read_session_durability(client.initialize_result)
    equals(profile.kind, "durable", "the release host's durability profile")


async def _start_and_follow(context: Context) -> None:
    client = _must(context.client_a, "spawned client")
    # Give the session something to keep: a session holding nothing but its
    # own start records is litter to the next host once the host that started
    # it is gone. Selecting an approval mode is the cheapest durable fact a
    # session can carry without a model or credentials.
    session = await within(
        "session/start",
        COMMAND_BUDGET_MS,
        client.start_session(
            StartSessionOptions(workspace_root=context.workspace_root, approval_mode=APPROVAL_MODE)
        ),
    )
    context.session_a = session
    context.session_id = session.session_id
    opening = session.opening
    if opening is None or opening.verb != "session/start":
        raise AssertionError("the session did not open through session/start")
    started = opening.result["session"]
    equals(
        (started.get("approvalMode") or {}).get("mode"),
        APPROVAL_MODE,
        "the approval mode the session started with",
    )
    # A consumer following a turn is a promise held across the death. This
    # turn id gets no answer — deliberately: the durable arm proves the death
    # REJECTS the wait instead of leaving it hanging forever.
    wait = session.turn("a-turn-you-were-following").completed
    context.doomed_wait = asyncio.ensure_future(_capture(wait))
    # And a command in flight: a client-side pending record, exactly like the
    # ephemeral arm's. The durable promise is that a death touches NONE of it.
    session.pending.submitted("cmd-durable-1", "work in flight")


async def _the_host_dies(context: Context) -> None:
    client = _must(context.client_a, "spawned client")
    pid = _must(context.host_pid, "host pid")
    # The death itself: from OUTSIDE the SDK, exactly like the OOM killer.
    try:
        os.kill(pid, signal.SIGKILL)
    finally:
        # Cleared UNCONDITIONALLY: a delivered SIGKILL guarantees death (the
        # watcher reaps while client.exit settles), and a kill that RAISES
        # means the pid is already freed (ESRCH) or unkillable for teardown
        # too — either way, keeping it would hand the journey-end teardown a
        # pid the OS may have re-issued (review finding). The teardown kill's
        # real case is a failure before this segment reaches the kill.
        context.host_pid = None
    exit_ = await within("the exit classification", EXIT_BUDGET_MS, client.exit)
    equals(exit_.kind, "crash", "the SDK's reading of the exit")
    # A signal kill has NO exit code; the signal is the whole diagnostic.
    equals(exit_.exit_code, None, "a signal kill's exit code")
    equals(exit_.exit_signal, "SIGKILL", "the signal that ended the host")
    context.exit_row = exit_


async def _durable_death_rejects_the_waiters(context: Context) -> None:
    session = _must(context.session_a, "started session")
    exit_ = _must(context.exit_row, "exit classification")
    # Report every notification of the death: the client already reported the
    # transport EOF the kill produced; this reports the process exit. A later
    # report replays the latched discharge, so double-reporting is required,
    # not just safe.
    discharge = session.host_exited(exit_)
    equals(discharge.kind, "durableDeath", "the discharge arm for a durable session")
    equals(discharge.profile.kind, "durable", "the profile the discharge names")

    # The wait registered before the death is REJECTED — not hung, not
    # resolved with an invented terminal.
    settled_kind, settled_value = await within(
        "the followed turn's wait settling",
        SETTLE_BUDGET_MS,
        _must(context.doomed_wait, "captured turn wait"),
    )
    equals(settled_kind, "rejected", "a durable death rejects a live turn wait")
    if not isinstance(settled_value, MuseHostDiedError):
        raise AssertionError(
            f"the wait rejected with {settled_value!r}, not MuseHostDiedError"
        )

    # FM-001's other half: NOTHING is discarded. The items and pending
    # commands are left exactly as observed; their terminals arrive when the
    # session resumes on a fresh host.
    equals(session.pending.discarded, False, "a durable death discards no pending commands")
    survivor = session.pending.get("cmd-durable-1")
    if survivor is None:
        raise AssertionError("the pending command vanished across a durable death")
    equals(survivor.command_id, "cmd-durable-1", "the pending command after the death")
    equals(survivor.input, "work in flight", "the pending command's input, untouched")

    # Asking about a turn AFTER the death inherits the rejection instead of
    # hanging: no answer is coming on this connection.
    late_kind, late_value = await within(
        "a post-death turn wait settling",
        SETTLE_BUDGET_MS,
        _capture(session.turn("a-turn-asked-about-after-the-death").completed),
    )
    equals(late_kind, "rejected", "a wait registered after a durable death")
    if not isinstance(late_value, MuseHostDiedError):
        raise AssertionError(
            f"the late wait rejected with {late_value!r}, not MuseHostDiedError"
        )


async def _resume_on_a_fresh_host(context: Context) -> None:
    session_id = _must(context.session_id, "session id")
    client, host, _stderr = await _spawn_host(context, killable=False)
    context.client_b = client
    equals(
        read_session_durability(client.initialize_result).kind,
        "durable",
        "the fresh host's durability profile",
    )
    # List before you resume: a fresh host answers session/list only once its
    # startup housekeeping has settled — including the pass that reclaims
    # dead hosts' empty sessions — so this call is the receipt that the pass
    # ran and kept THIS session.
    listing = await within(
        "session/list", COMMAND_BUDGET_MS, host.connection.request("session/list", {})
    )
    rows = listing.get("sessions")
    if not isinstance(rows, list):
        raise AssertionError(f"session/list served no sessions array: {listing!r}")
    listed = next((row for row in rows if row.get("sessionId") == session_id), None)
    if listed is None:
        raise AssertionError(
            f"the fresh host does not list session {session_id} after its "
            f"startup housekeeping (listed: {[row.get('sessionId') for row in rows]!r})"
        )
    equals(listed.get("status"), "notLoaded", "the dead host's session as the fresh host lists it")
    resumed = await within(
        "session/resume",
        COMMAND_BUDGET_MS,
        client.resume_session(ResumeSessionOptions(session_id=session_id, exclude_items=False)),
    )
    context.session_b = resumed
    equals(resumed.session_id, session_id, "the resumed session's id")
    opening = resumed.opening
    if opening is None or opening.verb != "session/resume":
        raise AssertionError("the session did not open through session/resume")
    info = opening.result["session"]
    equals(info.get("sessionId"), session_id, "the session the fresh host loaded")
    # The session's own record of its workspace survived the SIGKILL: state
    # the DEAD host wrote and the fresh host read back.
    equals(info.get("workspaceRoot"), context.workspace_root, "the workspace root after the crash")
    # And so did the fact chosen before the kill.
    equals(
        (info.get("approvalMode") or {}).get("mode"),
        APPROVAL_MODE,
        "the approval mode after the crash",
    )


async def _an_orderly_close_is_not_a_death(context: Context) -> None:
    client = _must(context.client_b, "fresh client")
    session = _must(context.session_b, "resumed session")
    await within("the orderly drain", CLOSE_BUDGET_MS, client.close())
    exit_ = await within("the exit classification", EXIT_BUDGET_MS, client.exit)
    equals(exit_.kind, "cleanShutdown", "the exit row after an orderly close")
    # The third discharge arm: an orderly exit is the ONE row where the drain
    # completed and the durable records were written. Nothing discharges.
    discharge = session.host_exited(exit_)
    equals(discharge.kind, "notADeath", "an orderly close discharges nothing")
    context.client_b = None


async def _read_the_profiles(context: Context) -> None:
    # Absent is DECIDABLE, not fabricated: no host that omits the member is
    # ephemeral.
    equals(
        read_session_durability(_synthetic_handshake()).kind,
        "durable",
        "an absent sessionDurability",
    )
    equals(
        read_session_durability(_synthetic_handshake("ephemeral")).kind,
        "ephemeral",
        "a declared ephemeral profile",
    )
    # The sharpest clause: a value this SDK has never heard of guarantees
    # NOTHING. Assume nothing survives that host.
    unknown = read_session_durability(_synthetic_handshake("holographic"))
    equals(unknown.kind, "unrecognized", "a durability value this SDK predates")
    # The consequence, witnessed: an abnormal death on the unrecognized
    # profile discharges exactly as ephemeral does.
    assume_nothing: Session[str] = Session("a-session-on-an-unknown-profile", unknown)
    equals(
        assume_nothing.host_exited(SIGKILL_ROW).kind,
        "discharged",
        "an unrecognized profile's abnormal death",
    )


async def _ephemeral_death_discharges_in_full(context: Context) -> None:
    # Fold-only construction is the SDK's sanctioned transport-less form —
    # the honest way to demo this arm headlessly, because the real host
    # declares durable. An application reads the profile off the handshake.
    context.discarded = DiscardedSessions()
    session: Session[str] = Session(
        EPHEMERAL_SESSION_ID,
        read_session_durability(_synthetic_handshake("ephemeral")),
        discarded=context.discarded,
    )
    context.ephemeral = session
    # One in-progress item, one already-terminal item, one pending command,
    # one live turn wait: each clause of the discharge gets a witness.
    session.apply(
        _item_started(
            {"itemId": "tool-1", "kind": "toolCall", "revision": 1, "status": "inProgress", "turnId": "turn-1"},
            "v:1",
        )
    )
    session.apply(
        _item_started(
            {"itemId": "msg-1", "kind": "agentMessage", "revision": 1, "status": "completed", "turnId": "turn-1"},
            "v:2",
        )
    )
    session.pending.submitted("cmd-1", "and fix the flaky test")
    wait = asyncio.ensure_future(_capture(session.turn("turn-1").completed))
    # Settle scheduling: the capture task must be RUNNING (parked on the
    # wait) before the discharge resolves it synchronously.
    await asyncio.sleep(0)

    discharge = session.host_exited(SIGKILL_ROW)
    equals(discharge.kind, "discharged", "the discharge arm for an ephemeral session")
    context.ephemeral_discharge = discharge

    # In-progress items come back annotated terminal-unknown — the item that
    # already completed is left alone, and no completion is invented.
    equals(len(discharge.terminal_unknown_items), 1, "one item was still in progress")
    equals(discharge.terminal_unknown_items[0].item_id, "tool-1", "the in-progress item")

    # Pending commands are retired with their INPUT handed back, so a UI can
    # show what was in flight. Deliberately NO composer restore: the client
    # does not know whether the work ran, and inviting a resubmit is inviting
    # a double execution.
    equals(len(discharge.retired_commands), 1, "one command was pending")
    retired = discharge.retired_commands[0]
    equals(retired.command_id, "cmd-1", "the retired command")
    equals(retired.kind, "terminalUnknown", "the retirement's kind")
    equals(retired.input, "and fix the flaky test", "the input handed back")
    if hasattr(retired, "restore_to_composer"):
        raise AssertionError("a terminal-unknown retirement must not offer a composer restore")

    # The live wait SETTLES — resolved with the terminal-unknown outcome, not
    # rejected: for an ephemeral session "stop waiting" is an answer.
    settled_kind, settled_value = await within("the turn wait settling", SETTLE_BUDGET_MS, wait)
    equals(settled_kind, "resolved", "an ephemeral discharge settles live waits")
    equals(settled_value.kind, "terminalUnknown", "the settled outcome")


async def _after_a_discharge_nothing_lies(context: Context) -> None:
    session = _must(context.ephemeral, "discharged ephemeral session")
    discharge = _must(context.ephemeral_discharge, "latched discharge")
    # No more folding: a trailing drain frame is refused, never woven into a
    # transcript the client was told to discard.
    refused = session.apply(
        _item_started(
            {"itemId": "tool-2", "kind": "toolCall", "revision": 1, "status": "inProgress"}, "v:3"
        )
    )
    equals(refused.fold.kind, "refusedSessionDiscarded", "folding after a discharge")
    # No new submits either — a command accepted now would be retired "we
    # don't know whether this ran" about input never sent to any host.
    try:
        session.pending.submitted("cmd-2", "one more thing")
        refused_submit = False
    except MuseSessionDiscardedError:
        refused_submit = True
    equals(refused_submit, True, "submitting after a discharge raises MuseSessionDiscardedError")
    # Asking about an unknown turn settles terminal-unknown on the spot
    # rather than hanging a wait no host will ever answer.
    late_kind, late_value = await within(
        "a post-discharge turn wait settling",
        SETTLE_BUDGET_MS,
        _capture(session.turn("turn-asked-about-too-late").completed),
    )
    equals(late_kind, "resolved", "a wait registered after the discharge settles")
    equals(late_value.kind, "terminalUnknown", "the late wait's settled outcome")
    # The discharge recorded its facts in the client-scoped registry — the
    # exact reads behind "do not reattach" and "do not replay these ids".
    discarded = _must(context.discarded, "discard registry")
    equals(
        EPHEMERAL_SESSION_ID in discarded.session_ids, True, "the dead session is recorded"
    )
    equals("cmd-1" in discarded.command_ids, True, "the retired commandId is recorded")
    # A second notification of the SAME death replays the SAME discharge —
    # the retired inputs are a one-shot delta, and replaying the first report
    # is what keeps a later reader from silently losing them.
    equals(session.host_exited(SIGKILL_ROW) is discharge, True, "a repeat report replays the discharge")


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment(
        "spawn-and-read-durability",
        "Spawn the release host and read its durability profile off the handshake",
        _spawn_and_read_durability,
    ),
    Segment(
        "start-a-session-and-follow-a-turn",
        "Start a session with one durable fact and register a turn wait the host will never answer",
        _start_and_follow,
    ),
    Segment(
        "the-host-dies",
        "SIGKILL the host mid-session and read the SDK's exit classification",
        _the_host_dies,
    ),
    Segment(
        "durable-death-rejects-the-waiters",
        "The durable discharge: waits reject with MuseHostDiedError, nothing is discarded",
        _durable_death_rejects_the_waiters,
    ),
    Segment(
        "resume-on-a-fresh-host",
        "Spawn a fresh host, find the session in its listing, and resume it: the state survived",
        _resume_on_a_fresh_host,
    ),
    Segment(
        "an-orderly-close-is-not-a-death",
        "Close the fresh host cleanly and see host_exited answer notADeath",
        _an_orderly_close_is_not_a_death,
    ),
    Segment(
        "read-the-ephemeral-and-unrecognized-profiles",
        "The three durability readings: absent, ephemeral, and unrecognized",
        _read_the_profiles,
    ),
    Segment(
        "ephemeral-death-discharges-in-full",
        "An ephemeral host's death: terminal-unknown items, retired commands, settled waits",
        _ephemeral_death_discharges_in_full,
    ),
    Segment(
        "after-a-discharge-nothing-lies",
        "The discharged session refuses new events, new submits, and reattachment",
        _after_a_discharge_nothing_lies,
    ),
)


async def _run(hosts: RecipeHosts) -> JourneyReport:
    if hosts.muse_bin is None:
        raise ValueError("muse_bin is required")
    context = Context(
        muse_bin=hosts.muse_bin,
        # Shared by BOTH hosts, so the durable session's state persists
        # across them.
        home=tempfile.mkdtemp(prefix="muse-cookbook-home-"),
        workspace_root=tempfile.mkdtemp(prefix="muse-cookbook-ws-"),
    )

    async def teardown(owned: Context) -> None:
        # The killed host first: if a segment failed before the kill, the
        # wrapper child is still alive and nothing below closes it.
        if owned.host_pid is not None:
            try:
                os.kill(owned.host_pid, signal.SIGKILL)
            except OSError:
                pass  # Already gone — the expected case.
        for client in (owned.client_a, owned.client_b):
            if client is None:
                continue
            try:
                await within("the teardown close", CLOSE_BUDGET_MS, client.close())
            except Exception as error:  # noqa: BLE001 - warned, never raised
                import sys

                print(f"warning: teardown close failed ({error})", file=sys.stderr)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="survive-the-host-dying",
    title="Survive the host dying under you",
    docs_page="developer-docs/src/content/docs/cookbook/survive-the-host-dying.mdx",
    needs=("muse_bin",),
    run=_run,
)
