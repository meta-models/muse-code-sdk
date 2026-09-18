"""The ``muse-code-sdk`` first-session journey, end to end, against a
release-built ``muse serve`` — the Python twin of
``clients/sdk-quickstart/src/journey.ts``.

This is the acceptance artifact: it is cited as proof that the SDK works, so
it holds itself to the TS journey's two rules verbatim.

1. **Every assertion states the spec-correct behavior.** Where today's host
   is wrong, the segment carries an ``expect_block`` naming the open issue.
2. **An expect-block cannot rot.** It names the issues and the SIGNATURE of
   the failure they cause; a segment that starts passing while blocked FAILS
   the journey so it gets promoted.

Nothing here is expect-blocked: all twelve segments are required, exactly as
the TS journey's are since its a tracked issue clause-4 promotion.

STEP PARITY::data:`SEGMENT_IDS` mirrors the TS journey's step
registry (``clients/sdk-quickstart/src/journey.ts`` ``SEGMENT_IDS``) id for
id, in order — the TS registry is the source of truth, and PY-the governing rule pins
the parity against the TS source rather than a count. One handshake-segment
adaptation is Python-owned: the TS journey asserts the protocol
fingerprint-mismatch WARNING surfaced nothing; the Python SDK's owner-ruled
posture is the STRICT gate, so reaching the segment at all
proves the gate passed, and the segment asserts the served/pinned equality
explicitly.

The journey has two modes.:func:`run_configured_journey` is the ACCEPTANCE
mode: it seeds ``home`` with a loopback fake first-party endpoint
(``provider.py``), so the host really runs a model and every segment is
exercised.:func:`run_journey` with no seeded ``home`` is the credential-free
degradation path — still supported, never the acceptance artifact.

its acceptance scenario rides here too:
:func:`run_configured_sync_journey` reruns the same twelve steps on the SYNC
wrapper (``SyncMuseClient``), blocking verbs end to end, and must reach the
same verdicts.
"""

from __future__ import annotations

import re
import tempfile
from dataclasses import dataclass, field
from typing import Any, List, Mapping

import muse_code
from muse_code import (
    MuseClientSpawnOptions,
    ResumeSessionOptions,
    SendUserTurnOptions,
    StartSessionOptions,
    SyncMuseClient,
    SyncSession,
    SyncTurn,
)
from muse_code.connection import MspError

from .host import (
    HOST_DRAIN_WINDOW_MS,
    STUB_VIEW_CURSOR,
    Host,
    HostOptions,
    isolated_host_env,
    within,
)
from .provider import (
    ConfiguredProvider,
    FakeProviderOptions,
    start_configured_provider,
)
from .segments import (
    JourneyReport,
    Segment,
    SyncSegment,
    run_journey as run_kit_journey,
    run_sync_journey as run_sync_kit_journey,
)

QUICKSTART_CLIENT_INFO: Mapping[str, str] = {
    "name": "muse_sdk_quickstart_py",
    "version": "0.0.0",
}
"""How this journey identifies itself to the host's session/audit
attribution. Named at every spawn site rather than defaulted in the kit, so
nothing can inherit the quickstart's identity by omission (T-24225-6)."""

APPROVAL_ARTIFACT = "approved.txt"
"""The artifact the approval prompt asks for; the provider routes its ONE
scripted ``bash`` tool call on this name plus the tool's own, so the
discriminator and the prompt can never drift apart."""

PROMPT = "Reply with the single word: hello"
"""The prompt every turn segment sends. Plain, deterministic, harmless."""

REPLY_TEXT = "hello"
"""The single word the prompt asks for, and what the fake provider replies."""

APPROVAL_PROMPT = f"Create a file called {APPROVAL_ARTIFACT} containing the word yes"
"""A prompt that must make the agent ask permission before touching disk."""

HANDSHAKE_BUDGET_MS = 30_000
COMMAND_BUDGET_MS = 30_000
STREAM_BUDGET_MS = 60_000
CLOSE_BUDGET_MS = 30_000


def _equals(actual: object, expected: object, what: str) -> None:
    if actual != expected:
        raise AssertionError(f"{what}: expected {expected!r}, got {actual!r}")


def _string_at(value: Mapping[str, Any], key: str, where: str) -> str:
    member = value.get(key)
    if not isinstance(member, str) or not member:
        raise AssertionError(f"{where}: {key!r} is not a non-empty string ({member!r})")
    return member


def _object_at(value: Mapping[str, Any], key: str, where: str) -> Mapping[str, Any]:
    member = value.get(key)
    if not isinstance(member, dict):
        raise AssertionError(f"{where}: {key!r} is not an object ({member!r})")
    return member


def _array_at(value: Mapping[str, Any], key: str, where: str) -> List[Any]:
    member = value.get(key)
    if not isinstance(member, list):
        raise AssertionError(f"{where}: {key!r} is not an array ({member!r})")
    return member


@dataclass
class Context:
    """Everything the segments read and write as the journey proceeds."""

    muse_bin: str
    home: str
    workspace_root: str
    session_id: str | None = None
    host: Host | None = None
    resume_host: Host | None = None
    resumed: Mapping[str, Any] | None = None


def _require_host(context: Context) -> Host:
    if context.host is None:
        raise AssertionError("no live host: an earlier segment did not finish")
    return context.host


def _require_session_id(context: Context) -> str:
    if context.session_id is None:
        raise AssertionError("no session: `session-new` did not finish")
    return context.session_id


def _agent_text(params: Mapping[str, Any]) -> str | None:
    item = params.get("item")
    if not isinstance(item, dict) or item.get("kind") != "agentMessage":
        return None
    text = item.get("text")
    return text if isinstance(text, str) else None


async def _start_turn(host: Host, session_id: str, prompt: str) -> str:
    """Run one ``turn/start`` and return the admitted ``turnId`` — shared by
    the turn, approval and cancel segments so all three observe the same
    admission contract."""
    ack = await within(
        "the turn/start ack",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "turn/start",
            {"sessionId": session_id, "input": [{"type": "text", "text": prompt}]},
            max_attempts=1,
        ),
    )
    _equals(ack.get("status"), "accepted", "turn/start ack status")
    # `started` and `queued` are BOTH correct answers: a
    # turn/start landing after the previous turn completed but before the
    # session settles to idle mints a queued turn. `steered` is deliberately
    # NOT accepted — it merges into a RUNNING turn, which no segment asks for.
    disposition = ack.get("disposition")
    if disposition not in ("started", "queued"):
        raise AssertionError(
            f'turn/start ack disposition: expected "started" or "queued", '
            f"got {disposition!r}"
        )
    _equals(
        ack.get("startedNewTurn"),
        disposition == "started",
        "turn/start ack startedNewTurn",
    )
    return _string_at(ack, "turnId", "turn/start ack")


def _require_terminal(completed: Mapping[str, Any], expected: str) -> None:
    """Fails with the host's own reason text when a turn ends off-terminal."""
    terminal = completed.get("terminal")
    if terminal != expected:
        reason = completed.get("reason")
        note = f"; host reason: {reason}" if isinstance(reason, str) else ""
        raise AssertionError(
            f"turn/completed terminal was {terminal!r}, expected {expected!r}{note}"
        )


# ---- the twelve segments (TS journey.ts parity, id for id, in order) --------


async def _spawn(context: Context) -> None:
    # Host.start spawns and handshakes in one step, which is what a consumer
    # writes. Spawn is proven by the handshake answering at all: a host that
    # dies on launch surfaces its classified exit here instead of a hang.
    context.host = await Host.start(
        HostOptions(
            muse_bin=context.muse_bin,
            home=context.home,
            workspace_root=context.workspace_root,
            client_info=QUICKSTART_CLIENT_INFO,
        ),
        HANDSHAKE_BUDGET_MS,
    )


async def _handshake(context: Context) -> None:
    host = _require_host(context)
    result: Mapping[str, Any] = host.msp.initialize_result
    server_info = _object_at(result, "serverInfo", "initialize result")
    _string_at(server_info, "name", "initialize serverInfo")
    _string_at(server_info, "version", "initialize serverInfo")
    _string_at(result, "museHome", "initialize result")
    _string_at(result, "sessionDurability", "initialize result")
    schema = _object_at(result, "schema", "initialize result")
    # The Python SDK's fingerprint posture is the STRICT gate (C-638-4): a
    # mismatch fails `initialize`, so reaching here proves the gate passed —
    # the explicit equality keeps the fact readable in the report.
    _equals(
        _string_at(schema, "fingerprint", "initialize schema"),
        muse_code.EXPECTED_SCHEMA_FINGERPRINT,
        "the served schema fingerprint vs the fingerprint muse-code-sdk pins",
    )


async def _session_new(context: Context) -> None:
    host = _require_host(context)
    result = await within(
        "the session/start ack",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "session/start", {"workspaceRoot": context.workspace_root}, max_attempts=1
        ),
    )
    session = _object_at(result, "session", "session/start result")
    session_id = _string_at(session, "sessionId", "session/start session")
    _equals(session.get("status"), "idle", "a fresh session's status")
    _equals(
        session.get("workspaceRoot"),
        context.workspace_root,
        "the session's workspace root",
    )
    # A DEFAULT start writes no durable fact, so the cursor is pinned to
    # exactly the before-genesis "".
    _equals(result.get("viewCursor"), "", "a default start's view cursor")
    # The push side of the same fact: the host announces the session it just
    # created, and it is the same session.
    started = await host.wait_for(
        "the session/started notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "session/started",
    )
    announced = _object_at(started.params, "session", "session/started params")
    _equals(announced.get("sessionId"), session_id, "the announced session id")
    context.session_id = session_id


async def _session_effective_model(context: Context) -> None:
    host = _require_host(context)
    session_id = _require_session_id(context)
    read = await within(
        "the session/read result",
        COMMAND_BUDGET_MS,
        host.connection.request(
            "session/read", {"sessionId": session_id, "excludeItems": True}
        ),
    )
    session = _object_at(read, "session", "session/read result")
    _string_at(session, "providerId", "session/read session")
    _string_at(session, "modelId", "session/read session")


async def _turn(context: Context) -> None:
    host = _require_host(context)
    session_id = _require_session_id(context)
    turn_id = await _start_turn(host, session_id, PROMPT)

    await host.wait_for(
        "the turn/started notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/started" and n.params.get("turnId") == turn_id,
    )
    completed = await host.wait_for(
        "the turn/completed notification",
        STREAM_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    _require_terminal(completed.params, "completed")

    # The turn is only useful if the agent actually said something, and it
    # must have arrived incrementally, not in one final lump.
    deltas = [n for n in host.notifications() if n.method == "item/delta"]
    if not deltas:
        raise AssertionError("the turn completed without streaming a single item/delta")
    answers = [
        text
        for text in (_agent_text(n.params) for n in host.notifications())
        if text is not None
    ]
    if not answers or not answers[-1]:
        raise AssertionError("the turn completed without a non-empty agentMessage item")


async def _approval(context: Context) -> None:
    host = _require_host(context)
    session_id = _require_session_id(context)
    turn_id = await _start_turn(host, session_id, APPROVAL_PROMPT)

    # Racing turn/completed against approval/requested turns "the turn died
    # before asking" into that sentence rather than a bare timeout.
    event = await host.wait_for(
        "an approval/requested notification",
        STREAM_BUDGET_MS,
        lambda n: n.method == "approval/requested"
        or (n.method == "turn/completed" and n.params.get("turnId") == turn_id),
    )
    if event.method != "approval/requested":
        reason = event.params.get("reason")
        note = f"; host reason: {reason}" if isinstance(reason, str) else ""
        raise AssertionError(f"the turn ended before asking for approval{note}")

    approval_id = _string_at(event.params, "approvalId", "approval/requested params")
    decided = await within(
        "the approval/decide ack",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "approval/decide",
            {
                "sessionId": session_id,
                "approvalId": approval_id,
                "requirementId": {"approvalId": approval_id, "sourceIndex": 0},
                "choiceId": "allow_once",
                "feedback": None,
            },
            max_attempts=1,
        ),
    )
    _equals(decided.get("terminal"), True, "the approval decision is terminal")
    resolved = await host.wait_for(
        "the approval/resolved notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "approval/resolved"
        and n.params.get("approvalId") == approval_id,
    )
    _equals(resolved.params.get("approvalId"), approval_id, "the resolved approval id")


async def _cancel(context: Context) -> None:
    host = _require_host(context)
    session_id = _require_session_id(context)
    turn_id = await _start_turn(host, session_id, PROMPT)
    await host.wait_for(
        "the turn/started notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/started" and n.params.get("turnId") == turn_id,
    )

    # The turn must still be running when the cancel lands (the provider's
    # hold keeps it in flight; see provider.HOLD_S).
    already_done = next(
        (
            n
            for n in host.notifications()
            if n.method == "turn/completed" and n.params.get("turnId") == turn_id
        ),
        None,
    )
    if already_done is not None:
        raise AssertionError(
            f"the turn reached {already_done.params.get('terminal')!r} before it "
            "could be cancelled"
        )

    await within(
        "the turn/cancel ack",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "turn/cancel", {"sessionId": session_id, "turnId": turn_id}, max_attempts=1
        ),
    )
    completed = await host.wait_for(
        "the cancelled turn/completed notification",
        STREAM_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    _require_terminal(completed.params, "cancelled")


async def _resume(context: Context) -> None:
    # The session lease belongs to the live host, so the first one has to
    # drain cleanly before a second can load the session.
    first = _require_host(context)
    first_exit = await first.close(CLOSE_BUDGET_MS)
    _equals(first_exit.code, 0, "the first host's exit code after stdin EOF")
    context.host = None

    session_id = _require_session_id(context)
    host = await Host.start(
        HostOptions(
            muse_bin=context.muse_bin,
            home=context.home,
            workspace_root=context.workspace_root,
            client_info=QUICKSTART_CLIENT_INFO,
        ),
        HANDSHAKE_BUDGET_MS,
    )
    context.resume_host = host

    resumed = await within(
        "the session/resume ack",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "session/resume",
            {"sessionId": session_id, "excludeItems": False},
            max_attempts=1,
        ),
    )
    context.resumed = resumed

    session = _object_at(resumed, "session", "session/resume result")
    _equals(session.get("sessionId"), session_id, "the resumed session id")
    _equals(
        session.get("workspaceRoot"),
        context.workspace_root,
        "the resumed workspace root",
    )
    cursor = _string_at(resumed, "viewCursor", "session/resume result")
    if cursor == STUB_VIEW_CURSOR:
        raise AssertionError(f"session/resume returned the stub cursor {cursor}")
    history = _object_at(resumed, "history", "session/resume result")
    _equals(history.get("mode"), "inline", "the resumed history mode")
    _array_at(history, "items", "session/resume history")
    _array_at(resumed, "pendingRequests", "session/resume result")


async def _resume_effective_model(context: Context) -> None:
    resumed = context.resumed
    if resumed is None:
        raise AssertionError("`resume` did not finish")
    session = _object_at(resumed, "session", "session/resume result")
    _string_at(session, "providerId", "resumed session")
    _string_at(session, "modelId", "resumed session")


def _require_history_kinds(resumed: Mapping[str, Any]) -> None:
    history = _object_at(resumed, "history", "session/resume result")
    items = _array_at(history, "items", "session/resume history")
    kinds = [item.get("kind") if isinstance(item, dict) else None for item in items]
    if "userMessage" not in kinds:
        raise AssertionError(f"resumed history has no userMessage; kinds: {kinds!r}")
    if "agentMessage" not in kinds:
        raise AssertionError(f"resumed history has no agentMessage; kinds: {kinds!r}")


async def _resume_history(context: Context) -> None:
    resumed = context.resumed
    if resumed is None:
        raise AssertionError("`resume` did not finish")
    _require_history_kinds(resumed)


async def _resume_rejects_unknown_cursor(context: Context) -> None:
    host = context.resume_host
    if host is None:
        raise AssertionError("`resume` did not finish")
    session_id = _require_session_id(context)
    # A cursor at an impossible sequence: no host can ever have minted it.
    impossible = f"v:{session_id}:999999"
    try:
        result = await within(
            "the session/resume refusal",
            COMMAND_BUDGET_MS,
            host.connection.command(
                "session/resume",
                {"sessionId": session_id, "cursor": impossible, "excludeItems": False},
                max_attempts=1,
            ),
        )
    except MspError as error:
        # ONLY the pinned refusal counts (`notFound` / -32011): a bare MspError
        # catch would let any unrelated protocol error read as the refusal.
        if error.kind == "notFound":
            return
        raise
    raise AssertionError(
        f"session/resume accepted a cursor that never existed ({impossible}) "
        f"and returned {str(result)[:400]}"
    )


async def _terminate(context: Context) -> None:
    host = context.resume_host
    if host is None:
        raise AssertionError("`resume` did not finish")
    # 14990 its acceptance scenario: stdin closed by close(), the SDK waits for the
    # orderly drain, and the exit is what actually happened.
    exit_ = await host.close(CLOSE_BUDGET_MS)
    _equals(exit_.code, 0, "the host's exit code after stdin EOF")
    _equals(exit_.signal, None, "the host's exit signal after stdin EOF")
    classification = await within(
        "the SDK's exit classification", COMMAND_BUDGET_MS, host.msp.child.exit
    )
    _equals(classification.kind, "cleanShutdown", "the SDK's exit classification")
    context.resume_host = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment("spawn", "Spawn the release-built host and keep it alive", _spawn),
    Segment(
        "handshake",
        "The handshake result describes the host and matches the SDK's schema pin",
        _handshake,
    ),
    Segment("session-new", "Start a new session in the workspace", _session_new),
    Segment(
        "session-effective-model",
        "The new session names the provider and model it will actually use",
        _session_effective_model,
    ),
    Segment("turn", "Send a prompt and receive the agent's answer as a stream", _turn),
    Segment(
        "approval",
        "Answer the agent's permission request and see it resolved",
        _approval,
    ),
    Segment("cancel", "Cancel a turn while it is running", _cancel),
    Segment(
        "resume",
        "Close the host, reopen it, and load the same session with its state",
        _resume,
    ),
    Segment(
        "resume-effective-model",
        "The resumed session still names the provider and model it will use",
        _resume_effective_model,
    ),
    Segment(
        "resume-history",
        "The resumed history carries the turn that already happened",
        _resume_history,
    ),
    Segment(
        "resume-rejects-unknown-cursor",
        "Resuming from a cursor that never existed is refused",
        _resume_rejects_unknown_cursor,
    ),
    Segment("terminate", "Close stdin and let the host drain and exit cleanly", _terminate),
)

SEGMENT_IDS: tuple[str, ...] = tuple(segment.id for segment in SEGMENTS)
"""Segment ids in run order — the step registry PY-the governing rule pins against the
TS journey's."""

EXPECT_BLOCKED: tuple[dict[str, Any], ...] = tuple(
    {"id": segment.id, "issues": list(segment.expect_block.issues)}
    for segment in SEGMENTS
    if segment.expect_block is not None
)
"""Expect-blocked segment id → issue numbers."""
@dataclass(frozen=True)
class JourneyOptions:
    """See the TS twin: ``home`` seeded = configured; fresh temp = the
    credential-free degradation path."""

    muse_bin: str
    home: str | None = None
    workspace_root: str | None = None


@dataclass(frozen=True)
class ConfiguredJourneyResult:
    """What a provider-configured run observed, beyond the segment report."""

    report: JourneyReport
    base_url: str
    catalog_gets: int
    scripted_tool_calls: int


def _provider_options() -> FakeProviderOptions:
    # `"bash"` because serve composes exec's managed shell tool family: the
    # model-visible tool is `bash`, not the legacy raw `shell`.
    return FakeProviderOptions(
        scripted_tool_call_when=(APPROVAL_ARTIFACT, '"bash"'),
        scripted_tool_call_command=f"printf yes > {APPROVAL_ARTIFACT}",
        reply_text=REPLY_TEXT,
    )


async def run_journey(options: JourneyOptions) -> JourneyReport:
    """Run the twelve segments; see :data:`JourneyOptions` for the modes."""
    context = Context(
        muse_bin=options.muse_bin,
        home=options.home or tempfile.mkdtemp(prefix="muse-quickstart-home-"),
        workspace_root=options.workspace_root
        or tempfile.mkdtemp(prefix="muse-quickstart-ws-"),
    )

    async def teardown(owned: Context) -> None:
        if owned.host is not None:
            await owned.host.abandon(CLOSE_BUDGET_MS)
        if owned.resume_host is not None:
            await owned.resume_host.abandon(CLOSE_BUDGET_MS)

    return await run_kit_journey(SEGMENTS, context, teardown)


async def run_configured_journey(
    muse_bin: str, workspace_root: str | None = None
) -> ConfiguredJourneyResult:
    """The ACCEPTANCE mode: the same twelve segments, against a host whose
    ``HOME`` already has a (loopback, keyless) provider configured."""
    provider = start_configured_provider(_provider_options())
    try:
        report = await run_journey(
            JourneyOptions(
                muse_bin=muse_bin, home=provider.home, workspace_root=workspace_root
            )
        )
        return ConfiguredJourneyResult(
            report=report,
            base_url=provider.base_url,
            catalog_gets=provider.catalog_gets(),
            scripted_tool_calls=provider.scripted_tool_calls(),
        )
    finally:
        provider.close()


# ---- its acceptance scenario: the same journey, rewritten on the sync wrapper ----------


@dataclass
class SyncContext:
    """The sync rerun's state — the blocking twins of :class:`Context`."""

    muse_bin: str
    home: str
    workspace_root: str
    session_id: str | None = None
    client: "SyncMuseClient[Any] | None" = None
    session: "SyncSession[Any] | None" = None
    resume_client: "SyncMuseClient[Any] | None" = None
    resume_session: "SyncSession[Any] | None" = None
    approval_failures: List[Any] = field(default_factory=list)


def _sync_spawn_options(context: SyncContext) -> MuseClientSpawnOptions:
    return MuseClientSpawnOptions(
        muse_bin=context.muse_bin,
        client_info=dict(QUICKSTART_CLIENT_INFO),
        args=["serve"],
        cwd=context.workspace_root,
        env=isolated_host_env(context.home),
        shutdown_timeout_ms=HOST_DRAIN_WINDOW_MS,
    )


def _require_sync_client(context: SyncContext) -> "SyncMuseClient[Any]":
    if context.client is None:
        raise AssertionError("no live client: an earlier segment did not finish")
    return context.client


def _require_sync_session(context: SyncContext) -> "SyncSession[Any]":
    if context.session is None:
        raise AssertionError("no session: `session-new` did not finish")
    return context.session


def _opening_result(session: "SyncSession[Any]") -> Mapping[str, Any]:
    opening = session.opening
    if opening is None:
        raise AssertionError("the session carries no opening result")
    return opening.result


def _run_sync_turn(session: "SyncSession[Any]", prompt: str) -> SyncTurn:
    return session.send_user_turn(
        SendUserTurnOptions(
            input=[{"type": "text", "text": prompt}], composer_input=prompt
        )
    )


def _sync_cancel(context: SyncContext, turn_id: str) -> None:
    """The rerun's ONE deliberate reach past the wrapper's public surface.

    Neither facade owns a cancel verb — ``turn/cancel`` is a raw
    connection-plane command in the TS journey too — so the sync REWRITE keeps
    it raw exactly like the async journey does. The sync surface deliberately
    exposes no connection, so
    this harness — a first-party journey, not shipped SDK code — drives the
    one raw command through the wrapper's own runner seam, which is also what
    keeps it serialized with the wrapper's verbs. A public escape hatch here
    would freeze API for one harness call (Constitution XI). The facade-verb
    gap itself is tracked in a tracked issue.
    """
    client = _require_sync_client(context)
    session_id = context.session_id
    connection = client._client._connection  # noqa: SLF001 - see the docstring
    client._runner.run(  # noqa: SLF001 - see the docstring
        connection.command(
            "turn/cancel",
            {"sessionId": session_id, "turnId": turn_id},
            max_attempts=1,
        )
    )


def _sync_spawn(context: SyncContext) -> None:
    context.client = SyncMuseClient.spawn(_sync_spawn_options(context))


def _sync_handshake(context: SyncContext) -> None:
    client = _require_sync_client(context)
    result: Mapping[str, Any] = client.initialize_result
    server_info = _object_at(result, "serverInfo", "initialize result")
    _string_at(server_info, "name", "initialize serverInfo")
    _string_at(server_info, "version", "initialize serverInfo")
    _string_at(result, "museHome", "initialize result")
    _string_at(result, "sessionDurability", "initialize result")
    schema = _object_at(result, "schema", "initialize result")
    _equals(
        _string_at(schema, "fingerprint", "initialize schema"),
        muse_code.EXPECTED_SCHEMA_FINGERPRINT,
        "the served schema fingerprint vs the fingerprint muse-code-sdk pins",
    )


def _sync_session_new(context: SyncContext) -> None:
    client = _require_sync_client(context)
    session = client.start_session(
        StartSessionOptions(workspace_root=context.workspace_root)
    )
    context.session = session
    context.session_id = session.session_id
    result = _opening_result(session)
    summary = _object_at(result, "session", "session/start result")
    _equals(summary.get("status"), "idle", "a fresh session's status")
    _equals(
        summary.get("workspaceRoot"),
        context.workspace_root,
        "the session's workspace root",
    )
    _equals(result.get("viewCursor"), "", "a default start's view cursor")


def _sync_session_effective_model(context: SyncContext) -> None:
    # The sync surface reads the same facts off the session/start RESULT the
    # wire already carries (providerId/modelId ride the session summary); the
    # async journey's session/read is a connection-plane spelling of the same
    # observable.
    session = _require_sync_session(context)
    summary = _object_at(_opening_result(session), "session", "session/start result")
    _string_at(summary, "providerId", "started session")
    _string_at(summary, "modelId", "started session")


def _sync_turn(context: SyncContext) -> None:
    session = _require_sync_session(context)
    turn = _run_sync_turn(session, PROMPT)
    items = list(turn.items())
    outcome = turn.completed()
    if outcome.kind != "completed":
        raise AssertionError(f"the turn ended {outcome.kind!r}, expected completed")
    agent_items = [i for i in items if i.get("kind") == "agentMessage"]
    if not agent_items:
        raise AssertionError("the turn completed without an agentMessage item")
    item_id = str(agent_items[-1]["itemId"])
    # The fold's delta accumulator only fills from item/delta frames, so a
    # non-empty accumulation IS the incremental-streaming evidence.
    accumulated = session.fold.items.accumulated(item_id)
    if not accumulated:
        raise AssertionError("the turn completed without streaming a single item/delta")
    held = session.fold.items.get(item_id)
    if held is None or not held.get("text"):
        raise AssertionError("the turn completed without a non-empty agentMessage item")


def _sync_approval(context: SyncContext) -> None:
    from muse_code import ApprovalDecisionInput

    session = _require_sync_session(context)
    session.on_approval_error(context.approval_failures.append)
    session.on_approval(lambda _r: ApprovalDecisionInput(choice_id="allow_once"))
    turn = _run_sync_turn(session, APPROVAL_PROMPT)
    outcome = turn.completed()
    if outcome.kind != "completed":
        raise AssertionError(f"the approval turn ended {outcome.kind!r}")
    if context.approval_failures:
        raise AssertionError(
            f"the approval round trip failed: {context.approval_failures!r}"
        )
    resolved = session.fold.resolved_approvals()
    if not resolved:
        raise AssertionError("no approval/resolved folded — the decide never landed")


def _sync_wait_turn_started(context: SyncContext, turn: SyncTurn) -> None:
    """Block until this turn's ``turn/started`` has folded.

    The turn/start ack can legally say ``queued``, and a cancel
    landing before the queued turn launches is rejected — the exact race the
    async journey defends by waiting for the notification first. The sync
    twin waits on the same server fact through the facade's own fold
    (``observed_start`` flips only when ``turn/started`` folds), pumped
    through the runner seam ``_sync_cancel`` already uses, under the SAME
    labeled harness budget the async arm waits with — never a machine-speed
    spin.
    """
    import asyncio

    client = _require_sync_client(context)

    async def wait() -> None:
        while not turn.observed_start:
            await asyncio.sleep(0.01)

    client._runner.run(  # noqa: SLF001 - see _sync_cancel's docstring
        within("turn/started before the sync cancel", COMMAND_BUDGET_MS, wait())
    )


def _sync_cancel_segment(context: SyncContext) -> None:
    session = _require_sync_session(context)
    turn = _run_sync_turn(session, PROMPT)
    _sync_wait_turn_started(context, turn)
    _sync_cancel(context, turn.turn_id)
    outcome = turn.completed()
    if outcome.kind != "completed" or outcome.params.get("terminal") != "cancelled":
        terminal = (
            outcome.params.get("terminal") if outcome.kind == "completed" else outcome.kind
        )
        raise AssertionError(f"expected a cancelled terminal, got {terminal!r}")


def _sync_resume(context: SyncContext) -> None:
    client = _require_sync_client(context)
    client.close()
    context.client = None
    session_id = context.session_id
    if session_id is None:
        raise AssertionError("no session: `session-new` did not finish")

    resume_client: "SyncMuseClient[Any]" = SyncMuseClient.spawn(
        _sync_spawn_options(context)
    )
    context.resume_client = resume_client
    context.client = resume_client
    resumed_session = resume_client.resume_session(
        ResumeSessionOptions(session_id=session_id, exclude_items=False)
    )
    context.resume_session = resumed_session
    result = _opening_result(resumed_session)
    summary = _object_at(result, "session", "session/resume result")
    _equals(summary.get("sessionId"), session_id, "the resumed session id")
    _equals(
        summary.get("workspaceRoot"),
        context.workspace_root,
        "the resumed workspace root",
    )
    cursor = _string_at(result, "viewCursor", "session/resume result")
    if cursor == STUB_VIEW_CURSOR:
        raise AssertionError(f"session/resume returned the stub cursor {cursor}")
    history = _object_at(result, "history", "session/resume result")
    _equals(history.get("mode"), "inline", "the resumed history mode")
    _array_at(history, "items", "session/resume history")
    _array_at(result, "pendingRequests", "session/resume result")


def _sync_resume_effective_model(context: SyncContext) -> None:
    session = context.resume_session
    if session is None:
        raise AssertionError("`resume` did not finish")
    summary = _object_at(_opening_result(session), "session", "session/resume result")
    _string_at(summary, "providerId", "resumed session")
    _string_at(summary, "modelId", "resumed session")


def _sync_resume_history(context: SyncContext) -> None:
    session = context.resume_session
    if session is None:
        raise AssertionError("`resume` did not finish")
    _require_history_kinds(_opening_result(session))


def _sync_resume_rejects_unknown_cursor(context: SyncContext) -> None:
    client = context.resume_client
    session_id = context.session_id
    if client is None or session_id is None:
        raise AssertionError("`resume` did not finish")
    impossible = f"v:{session_id}:999999"
    try:
        client.resume_session(
            ResumeSessionOptions(
                session_id=session_id, cursor=impossible, exclude_items=False
            )
        )
    except MspError as error:
        if error.kind == "notFound":
            return
        raise
    raise AssertionError(
        f"session/resume accepted a cursor that never existed ({impossible})"
    )


def _sync_terminate(context: SyncContext) -> None:
    client = context.resume_client
    if client is None:
        raise AssertionError("`resume` did not finish")
    # The sync close drives the same orderly the protocol shutdown; the wrapper
    # then retires its loop, so it is terminal — a second close must no-op
    # (the exit-classification arm is the async journey's, whose surface
    # returns the exit row).
    client.close()
    client.close()
    context.resume_client = None
    context.client = None


SYNC_SEGMENTS: tuple[SyncSegment[SyncContext], ...] = (
    SyncSegment("spawn", "Spawn the release-built host and keep it alive", _sync_spawn),
    SyncSegment(
        "handshake",
        "The handshake result describes the host and matches the SDK's schema pin",
        _sync_handshake,
    ),
    SyncSegment("session-new", "Start a new session in the workspace", _sync_session_new),
    SyncSegment(
        "session-effective-model",
        "The new session names the provider and model it will actually use",
        _sync_session_effective_model,
    ),
    SyncSegment(
        "turn", "Send a prompt and receive the agent's answer as a stream", _sync_turn
    ),
    SyncSegment(
        "approval",
        "Answer the agent's permission request and see it resolved",
        _sync_approval,
    ),
    SyncSegment("cancel", "Cancel a turn while it is running", _sync_cancel_segment),
    SyncSegment(
        "resume",
        "Close the host, reopen it, and load the same session with its state",
        _sync_resume,
    ),
    SyncSegment(
        "resume-effective-model",
        "The resumed session still names the provider and model it will use",
        _sync_resume_effective_model,
    ),
    SyncSegment(
        "resume-history",
        "The resumed history carries the turn that already happened",
        _sync_resume_history,
    ),
    SyncSegment(
        "resume-rejects-unknown-cursor",
        "Resuming from a cursor that never existed is refused",
        _sync_resume_rejects_unknown_cursor,
    ),
    SyncSegment(
        "terminate", "Close stdin and let the host drain and exit cleanly", _sync_terminate
    ),
)

SYNC_SEGMENT_IDS: tuple[str, ...] = tuple(segment.id for segment in SYNC_SEGMENTS)
"""The rerun's registry — PY-the governing rule pins it equal to:data:`SEGMENT_IDS`."""


def run_configured_sync_journey(
    muse_bin: str, workspace_root: str | None = None
) -> ConfiguredJourneyResult:
    """its acceptance scenario: the journey rewritten on the sync wrapper, same twelve
    steps, blocking verbs end to end — it must pass with the same verdicts.

    A SYNCHRONOUS function driven by the kit's SYNC runner, deliberately:
    the sync verbs refuse from a thread with a running event loop
    , so no loop may exist here — each verb blocks this thread,
    exactly as a consumer script would.
    """
    provider = start_configured_provider(_provider_options())
    try:
        context = SyncContext(
            muse_bin=muse_bin,
            home=provider.home,
            workspace_root=workspace_root
            or tempfile.mkdtemp(prefix="muse-quickstart-sync-ws-"),
        )

        def teardown(owned: SyncContext) -> None:
            for client in (owned.client, owned.resume_client):
                if client is not None:
                    try:
                        client.close()
                    except Exception:  # noqa: BLE001 - teardown best effort
                        pass

        report = run_sync_kit_journey(SYNC_SEGMENTS, context, teardown)
        return ConfiguredJourneyResult(
            report=report,
            base_url=provider.base_url,
            catalog_gets=provider.catalog_gets(),
            scripted_tool_calls=provider.scripted_tool_calls(),
        )
    finally:
        provider.close()
