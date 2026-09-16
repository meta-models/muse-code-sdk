"""Recipe twin: resume a session and verify what came back.

Runs against a real ``muse serve`` host, twice: one host starts a session and
is shut down cleanly, and a SECOND host — a fresh process over the same state
directory — resumes it. Only a real host proves the state survived a process
boundary, which is why this recipe is not played from a canned transcript.

What it teaches: "resume worked" means "the state survived", not "the call
returned" — identity and workspace, the effective provider/model (the
regression class worth a hand-written check), the inline history, the
late-joiner pending set, and the view cursor; a served cursor round-trips as
a suffix subscription (``none``/``cursorSuffix``); and a cursor the host
never issued is REFUSED (``notFound``), not silently widened.

The two halves use two client surfaces on purpose: setup goes through the
kit's connection-level ``Host`` (it reads the catalog first); the RESUME —
the half the page is about — goes through ``MuseClient``, the surface an
integrator resuming a session should be using.
"""

from __future__ import annotations

import tempfile
from dataclasses import dataclass
from typing import Any, Mapping

from muse_code import MuseClient, MuseClientSpawnOptions, ResumeSessionOptions
from muse_code.connection import MspError
from quickstart_journey.host import STUB_VIEW_CURSOR

from ..kit import (
    array_at,
    equals,
    Host,
    HOST_DRAIN_WINDOW_MS,
    HostOptions,
    isolated_host_env,
    JourneyReport,
    object_at,
    require_host,
    run_journey,
    Segment,
    string_at,
    within,
)
from ..runner import Recipe, RecipeHosts

HANDSHAKE_BUDGET_MS = 30_000
COMMAND_BUDGET_MS = 30_000
CLOSE_BUDGET_MS = 30_000

CLIENT_INFO = {"name": "muse_sdk_cookbook_py", "version": "0.0.0"}
"""Announce the cookbook, not the quickstart, in the host's attribution."""

IMPOSSIBLE_CURSOR = "v:00000000-0000-7000-8000-000000000000:1"
"""A cursor no host ever issued: structurally valid, so the refusal is about
the ANCHOR being missing and not about the string being unparseable."""


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    muse_bin: str
    home: str
    workspace_root: str
    host: Host | None = None
    resume_client: "MuseClient[Any] | None" = None
    session_id: str | None = None
    started_provider_id: str | None = None
    started_model_id: str | None = None
    resumed: Mapping[str, Any] | None = None
    served_cursor: str | None = None


def _require_resumed(context: Context) -> Mapping[str, Any]:
    if context.resumed is None:
        raise RuntimeError("`resume` did not finish")
    return context.resumed


def _resume_result(session: Any) -> Mapping[str, Any]:
    opening = session.opening
    if opening is None or opening.verb != "session/resume":
        raise AssertionError(
            f"resume_session did not report a session/resume opening: {opening!r}"
        )
    result = opening.result
    assert isinstance(result, Mapping)
    return result


async def _start(context: Context) -> None:
    host = await Host.start(
        HostOptions(
            muse_bin=context.muse_bin,
            home=context.home,
            workspace_root=context.workspace_root,
            client_info=CLIENT_INFO,
        ),
        HANDSHAKE_BUDGET_MS,
    )
    context.host = host

    # Read the model out of the host's own catalog. A pinned id here would
    # red this recipe every time the bundled catalog moved.
    catalog = await within(
        "model/list", COMMAND_BUDGET_MS, host.connection.request("model/list", {})
    )
    rows = array_at(catalog, "models", "model/list result")
    if not rows:
        raise AssertionError("the host offered no models to start a session with")
    offered = rows[0]
    provider_id = string_at(offered, "providerId", "a model/list row")
    model_id = string_at(offered, "modelId", "a model/list row")

    result = await within(
        "session/start",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "session/start",
            {
                "workspaceRoot": context.workspace_root,
                "providerId": provider_id,
                "modelId": model_id,
            },
            max_attempts=1,
        ),
    )
    session = object_at(result, "session", "session/start result")
    equals(session.get("status"), "idle", "a fresh session's status")
    equals(session.get("providerId"), provider_id, "the new session's provider")
    equals(session.get("modelId"), model_id, "the new session's model")
    # The session id is the ONLY thing an app has to persist; everything else
    # below is what the resume must hand back.
    context.session_id = string_at(session, "sessionId", "session/start session")
    context.started_provider_id = provider_id
    context.started_model_id = model_id

    # Put ONE real event in the session's view — setup against VACUITY: a
    # session that emitted nothing has the before-genesis "" head cursor, and
    # the suffix arm below would go green on the degenerate case. Setting the
    # approval mode is the cheapest view-visible state change without a model
    # or credentials; denyUnmatched deliberately, the most conservative mode,
    # so nothing here reads as advice about which mode to run.
    mode = await within(
        "session/setApprovalMode",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "session/setApprovalMode",
            {"sessionId": context.session_id, "mode": "denyUnmatched"},
            max_attempts=1,
        ),
    )
    equals(mode.get("applyOutcome"), "completed", "the approval-mode change's outcome")


async def _host_goes_away(context: Context) -> None:
    host = require_host(context.host, "start")
    exit_ = await host.close(CLOSE_BUDGET_MS)
    equals(exit_.code, 0, "the first host's exit code after stdin EOF")
    context.host = None


async def _resume(context: Context) -> None:
    session_id = context.session_id
    if session_id is None:
        raise RuntimeError("`start` did not finish")
    client: MuseClient[Any] = await within(
        "the resume host's spawn and MSP handshake",
        HANDSHAKE_BUDGET_MS,
        MuseClient.spawn(
            MuseClientSpawnOptions(
                muse_bin=context.muse_bin,
                args=("serve",),
                cwd=context.workspace_root,
                env=isolated_host_env(context.home),
                client_info=dict(CLIENT_INFO),
                # The kit's owned drain window, so the drain bound and the
                # SDK's actual window cannot drift apart.
                shutdown_timeout_ms=HOST_DRAIN_WINDOW_MS,
            )
        ),
    )
    context.resume_client = client
    session = await within(
        "session/resume",
        COMMAND_BUDGET_MS,
        # exclude_items=False is stated rather than left to the default: this
        # recipe is about what comes back, so it asks for all of it.
        client.resume_session(ResumeSessionOptions(session_id=session_id, exclude_items=False)),
    )
    context.resumed = _resume_result(session)


async def _same_session(context: Context) -> None:
    resumed = _require_resumed(context)
    session = object_at(resumed, "session", "session/resume result")
    equals(session.get("sessionId"), context.session_id, "the resumed session id")
    equals(session.get("workspaceRoot"), context.workspace_root, "the resumed workspace root")


async def _effective_model(context: Context) -> None:
    session = object_at(_require_resumed(context), "session", "session/resume result")
    provider_id = session.get("providerId")
    model_id = session.get("modelId")
    # Both members are declared nullable, so null is a real answer the wire
    # can carry — and the answer a session that lost its effective model
    # across the process boundary would give.
    if provider_id is None or model_id is None:
        raise AssertionError(
            "the resumed session lost its effective model "
            f"(providerId={provider_id!r}, modelId={model_id!r})"
        )
    # Non-null is not enough: a session resumed onto some OTHER model runs
    # the user's next turn somewhere they did not choose.
    equals(provider_id, context.started_provider_id, "the resumed provider vs the one started with")
    equals(model_id, context.started_model_id, "the resumed model vs the one started with")


async def _inline_history(context: Context) -> None:
    history = object_at(_require_resumed(context), "history", "session/resume result")
    # mode reports what was SERVED, never what was asked for: a downgrade to
    # snapshot or none means an inline render would show an empty transcript.
    equals(history.get("mode"), "inline", "the served history mode for an include-items resume")
    # noneReason is sent exactly when mode is "none" — the pair is one answer.
    equals(history.get("noneReason"), None, "noneReason on a served inline history")
    items = history.get("items")
    if not isinstance(items, list):
        raise AssertionError(f"an inline history must carry its items array, got {items!r}")
    # EXACT, never merely "is a list": this journey takes no turn, so the one
    # correct answer is zero items.
    equals(len(items), 0, "a zero-turn session's resumed item count")


async def _pending_and_cursor(context: Context) -> None:
    resumed = _require_resumed(context)
    pending = resumed.get("pendingRequests")
    # Empty is the normal answer for a session that was never mid-approval;
    # what matters is that the SET is served.
    if not isinstance(pending, list):
        raise AssertionError(f"pendingRequests must be served as an array, got {pending!r}")
    # EXACT, for the same anti-vacuity reason the item count is.
    equals(len(pending), 0, "a never-mid-approval session's resumed pending set")
    cursor = resumed.get("viewCursor")
    if not isinstance(cursor, str):
        raise AssertionError(f"session/resume must serve a view cursor, got {cursor!r}")
    # A client must NEVER read a cursor's text — it is opaque. This next
    # check is a HARNESS PRECONDITION, not client guidance: `start` folded a
    # view event on purpose, so the head cursor must now be a minted one; ""
    # would make the suffix arm vacuous.
    if cursor == "":
        raise AssertionError(
            "`start` folded one view event, so the resumed head cursor must be "
            'past genesis; got the before-genesis sentinel "", which would make '
            "the suffix arm vacuous"
        )
    # The stub IS checked too: it is the pre-Seam-C placeholder, so serving it
    # means the view fold is not wired.
    if cursor == STUB_VIEW_CURSOR:
        raise AssertionError(f"session/resume returned the pre-Seam-C stub cursor {cursor}")
    context.served_cursor = cursor


async def _cursor_resume_is_a_suffix(context: Context) -> None:
    client = context.resume_client
    if client is None:
        raise RuntimeError("`resume` did not finish")
    session_id = context.session_id
    cursor = context.served_cursor
    if session_id is None or cursor is None:
        raise RuntimeError("`pending-and-cursor` did not finish")
    # Hand back the cursor the host just gave us, VERBATIM and unexamined —
    # the opacity rule's whole point. This is the answer that means "your
    # transcript is still current", proven rather than described.
    session = await within(
        "session/resume with the served cursor",
        COMMAND_BUDGET_MS,
        client.resume_session(ResumeSessionOptions(session_id=session_id, cursor=cursor)),
    )
    history = object_at(_resume_result(session), "history", "session/resume result")
    equals(history.get("mode"), "none", "the served history mode for a retained-cursor resume")
    # The DISCRIMINATOR: "none" alone does not tell a client whether its own
    # transcript is current; only this reason does.
    equals(history.get("noneReason"), "cursorSuffix", "why no history was served")
    # No history means none of it.
    equals(history.get("items"), None, "items on a suffix resume")
    equals(history.get("snapshot"), None, "snapshot on a suffix resume")


async def _rejects_unissued_cursor(context: Context) -> None:
    client = context.resume_client
    if client is None:
        raise RuntimeError("`resume` did not finish")
    session_id = context.session_id
    if session_id is None:
        raise RuntimeError("`start` did not finish")
    try:
        await within(
            "session/resume with an unissued cursor",
            COMMAND_BUDGET_MS,
            client.resume_session(
                ResumeSessionOptions(session_id=session_id, cursor=IMPOSSIBLE_CURSOR)
            ),
        )
    except MspError as refusal:
        # The typed family an integrator branches on, and the code the wire
        # carries: the kind is what code should read, the code is what a
        # reader sees in a log.
        equals(refusal.kind, "notFound", "the refusal's error kind")
        equals(refusal.code, -32011, "the refusal's error code")
        return
    raise AssertionError(
        f"session/resume accepted a cursor that never existed ({IMPOSSIBLE_CURSOR}); "
        "a client that invents cursors must be told, not silently served "
        "someone else's history"
    )


async def _drain(context: Context) -> None:
    client = context.resume_client
    if client is None:
        raise RuntimeError("`resume` did not finish")
    await within("the resume host's orderly drain and exit", CLOSE_BUDGET_MS, client.close())
    classification = await client.exit
    equals(classification.kind, "cleanShutdown", "the resume host's exit classification")
    context.resume_client = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment(
        "start", "Start a session on one host, naming a model and folding one view event", _start
    ),
    Segment(
        "host-goes-away",
        "Shut that host down cleanly, so nothing is holding the session open",
        _host_goes_away,
    ),
    Segment(
        "resume", "Resume the session from a second host, asking for the history inline", _resume
    ),
    Segment(
        "same-session",
        "It is the session that was asked for, in the workspace it was started in",
        _same_session,
    ),
    Segment(
        "effective-model",
        "The resumed session still names the provider and model it will run on",
        _effective_model,
    ),
    Segment(
        "inline-history",
        "The history is served inline, as asked, and not deferred to paging",
        _inline_history,
    ),
    Segment(
        "pending-and-cursor",
        "The late-joiner pending set and a real view cursor come back too",
        _pending_and_cursor,
    ),
    Segment(
        "cursor-resume-is-a-suffix",
        "Resuming with the served cursor answers none/cursorSuffix, not a snapshot",
        _cursor_resume_is_a_suffix,
    ),
    Segment(
        "rejects-unissued-cursor",
        "A cursor the host never issued is refused, not quietly widened",
        _rejects_unissued_cursor,
    ),
    Segment("drain", "Close the resume host and let it exit cleanly", _drain),
)


async def _run(hosts: RecipeHosts) -> JourneyReport:
    if hosts.muse_bin is None:
        raise ValueError("muse_bin is required")
    context = Context(
        muse_bin=hosts.muse_bin,
        # ONE home for both hosts: that shared state directory is what makes
        # the second host a resume rather than a fresh start.
        home=tempfile.mkdtemp(prefix="muse-cookbook-home-"),
        workspace_root=tempfile.mkdtemp(prefix="muse-cookbook-ws-"),
    )

    async def teardown(owned: Context) -> None:
        # BOTH slots: a journey that failed before its drain can own two live
        # children, and reclaiming only one would leak the other silently.
        if owned.host is not None:
            await owned.host.abandon(CLOSE_BUDGET_MS)
        client = owned.resume_client
        if client is not None:
            try:
                await within("the resume host's teardown drain", CLOSE_BUDGET_MS, client.close())
            except Exception as error:  # noqa: BLE001 - warned, never raised
                import sys

                print(f"teardown: the resume host did not drain cleanly: {error}", file=sys.stderr)

    return await run_journey(SEGMENTS, context, teardown)


RECIPE = Recipe(
    id="resume-and-verify",
    title="Resume a session and verify what came back",
    docs_page="developer-docs/src/content/docs/cookbook/resume-a-session.mdx",
    needs=("muse_bin",),
    run=_run,
)
