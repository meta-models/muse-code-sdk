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
the TS journey's are since the disclosure contract's clause-4 promotion.

STEP PARITY: :data:`SEGMENT_IDS` mirrors the TS journey's step
registry (``clients/sdk-quickstart/src/journey.ts`` ``SEGMENT_IDS``) id for
id, in order — the TS registry is the source of truth, and its charter test pins
the parity against the TS source rather than a count. One handshake-segment
adaptation is Python-owned: the TS journey asserts the protocol
fingerprint-mismatch WARNING surfaced nothing; the Python SDK's owner-ruled
posture is the STRICT gate, so reaching the segment at all
proves the gate passed, and the segment asserts the served/pinned equality
explicitly.

It is written against the SDK facade an application uses —
``MuseClient.spawn``, ``start_session``, ``session.run``, ``send_user_turn``
with ``items()``, ``on_approval``, ``turn.cancel()``, ``resume_session``,
``close`` — never the raw connection, so the first program a reader copies
teaches that layer.

The journey has two modes. :func:`run_configured_journey` is the ACCEPTANCE
mode: it seeds ``home`` with a loopback fake first-party endpoint
(``provider.py``), so the host really runs a model and every segment is
exercised. :func:`run_journey` with no seeded ``home`` is the credential-free
degradation path — still supported, never the acceptance artifact.

its acceptance scenario rides here too:
:func:`run_configured_sync_journey` reruns the same twelve steps on the SYNC
wrapper (``SyncMuseClient``), blocking verbs end to end, and must reach the
same verdicts.
"""

from __future__ import annotations

import asyncio
import sys
import tempfile
from dataclasses import dataclass, field, replace
from typing import Any, List, Mapping, Sequence

import muse_code
from muse_code import (
    ApprovalDecisionInput,
    MuseClient,
    MuseClientSpawnOptions,
    ResumeSessionOptions,
    SendUserTurnOptions,
    Session,
    StartSessionOptions,
    SyncMuseClient,
    SyncSession,
    SyncTurn,
    Turn,
    TurnOutcome,
)
from muse_code.connection import MspError
from muse_code_msp import ClientInfo

from .host import (
    HOST_DRAIN_WINDOW_MS,
    STUB_VIEW_CURSOR,
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

QUICKSTART_CLIENT_INFO: ClientInfo = {
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
    client: "MuseClient[Any] | None" = None
    session: "Session[Any] | None" = None
    resume_client: "MuseClient[Any] | None" = None
    resumed: Mapping[str, Any] | None = None


def _require_client(context: Context) -> "MuseClient[Any]":
    if context.client is None:
        raise AssertionError("no live client: an earlier segment did not finish")
    return context.client


def _require_session(context: Context) -> "Session[Any]":
    if context.session is None:
        raise AssertionError("no session: `session-new` did not finish")
    return context.session


def _require_session_id(context: Context) -> str:
    if context.session_id is None:
        raise AssertionError("no session: `session-new` did not finish")
    return context.session_id


def _completed_agent_messages(
    items: Sequence[Mapping[str, Any]],
) -> list[tuple[str, str, str]]:
    """Every completed ``agentMessage`` a turn served, in first-opened order,
    as ``(itemId, messagePhase, text)``.

    A turn holds several — commentary before and between tool calls, then
    the final answer — and no position is special: the LAST one is not "the
    answer": the phase labels a message, its position does not. Show them
    all, each with its phase, once the turn has ended. An absent
    ``messagePhase`` is an older host, which served final answers only (an
    absent phase reads as a final answer).
    """
    messages: list[tuple[str, str, str]] = []
    for item in items:
        if item.get("kind") != "agentMessage" or item.get("status") != "completed":
            continue
        text = item.get("text")
        phase = item.get("messagePhase")
        messages.append(
            (
                str(item.get("itemId")),
                "commentary" if phase == "commentary" else "finalAnswer",
                text if isinstance(text, str) else "",
            )
        )
    return messages


def _spawn_options(context: Context) -> MuseClientSpawnOptions:
    """Spawn ``muse serve`` and complete the handshake in one call. The first
    three fields are all an application needs; the rest are what this
    journey adds because it tests one specific build in a throwaway HOME."""
    options = MuseClientSpawnOptions(
        muse_bin=None,  # None runs the first `muse` on your PATH
        args=["serve"],
        client_info=QUICKSTART_CLIENT_INFO,
    )
    # What the journey adds: the binary under test and a throwaway HOME.
    return replace(
        options,
        muse_bin=context.muse_bin,
        cwd=context.workspace_root,
        env=isolated_host_env(context.home),
        shutdown_timeout_ms=HOST_DRAIN_WINDOW_MS,
    )


def _require_terminal(outcome: TurnOutcome, expected: str) -> None:
    """Fails with the host's own reason text when a turn ends any other way."""
    if outcome.kind != "completed":
        raise AssertionError(
            f"the turn ended {outcome.kind!r}, expected terminal {expected!r}"
        )
    terminal = outcome.params.get("terminal")
    if terminal != expected:
        reason = outcome.params.get("reason")
        note = f"; host reason: {reason}" if isinstance(reason, str) else ""
        raise AssertionError(
            f"turn/completed terminal was {terminal!r}, expected {expected!r}{note}"
        )


async def _close_quietly(what: str, client: "MuseClient[Any]") -> None:
    """Best-effort teardown for a failure path. Never raises: since the SDK
    owns termination, an expiry means the drain was not CLEAN — the child is
    reclaimed either way."""
    try:
        await within(
            f"{what}'s orderly drain and exit", CLOSE_BUDGET_MS + 10_000, client.close()
        )
    except Exception as error:  # noqa: BLE001 - warned, never raised
        sys.stderr.write(
            f"warning: {what} did not drain cleanly ({error}); the SDK escalates "
            "to SIGTERM/SIGKILL, so the child is reclaimed even when the drain "
            "is not.\n"
        )


# ---- the twelve segments (TS journey.ts parity, id for id, in order) --------


async def _spawn(context: Context) -> None:
    # `MuseClient.spawn` spawns and handshakes in one step. Spawn is proven by
    # the handshake answering at all: a host that dies on launch raises
    # `MuseHostStartError` here, with its exit and stderr, instead of a hang.
    context.client = await within(
        "the host's spawn and handshake",
        HANDSHAKE_BUDGET_MS,
        MuseClient.spawn(_spawn_options(context)),
    )


async def _handshake(context: Context) -> None:
    client = _require_client(context)
    result: Mapping[str, Any] = client.initialize_result
    server_info = _object_at(result, "serverInfo", "initialize result")
    _string_at(server_info, "name", "initialize serverInfo")
    _string_at(server_info, "version", "initialize serverInfo")
    _string_at(result, "museHome", "initialize result")
    _string_at(result, "sessionDurability", "initialize result")
    schema = _object_at(result, "schema", "initialize result")
    # The Python SDK's fingerprint posture is the STRICT gate: a
    # mismatch fails `initialize`, so reaching here proves the gate passed —
    # the explicit equality keeps the fact readable in the report.
    _equals(
        _string_at(schema, "fingerprint", "initialize schema"),
        muse_code.EXPECTED_SCHEMA_FINGERPRINT,
        "the served schema fingerprint vs the fingerprint muse-code-sdk pins",
    )


def _opening_result(session: "Session[Any] | SyncSession[Any]") -> Mapping[str, Any]:
    opening = session.opening
    if opening is None:
        raise AssertionError("the session carries no opening result")
    return opening.result


async def _session_new(context: Context) -> None:
    client = _require_client(context)
    session = await within(
        "the session/start reply",
        COMMAND_BUDGET_MS,
        client.start_session(StartSessionOptions(workspace_root=context.workspace_root)),
    )
    result = _opening_result(session)
    summary = _object_at(result, "session", "session/start result")
    _equals(summary.get("sessionId"), session.session_id, "the started session id")
    _equals(summary.get("status"), "idle", "a fresh session's status")
    _equals(
        summary.get("workspaceRoot"),
        context.workspace_root,
        "the session's workspace root",
    )
    # A DEFAULT start writes no durable fact, so the cursor is pinned to
    # exactly the before-genesis "".
    _equals(result.get("viewCursor"), "", "a default start's view cursor")
    context.session = session
    context.session_id = session.session_id


async def _session_effective_model(context: Context) -> None:
    summary = _object_at(
        _opening_result(_require_session(context)), "session", "session/start result"
    )
    _string_at(summary, "providerId", "started session")
    _string_at(summary, "modelId", "started session")


async def _turn(context: Context) -> None:
    session = _require_session(context)
    # One call: send the prompt, wait for the server to end the turn, and get
    # back its outcome, final answer and items.
    result = await within("the turn", STREAM_BUDGET_MS, session.run(PROMPT))
    _require_terminal(result.outcome, "completed")

    # Every completed agent message, each with its phase; the last item is
    # not "the answer" (the phase labels a message, its position does not),
    # and a phase this client does not know still reads as a final answer.
    messages = _completed_agent_messages(result.items)
    shown = [f"[{phase}] {text}" for _, phase, text in messages]
    if not any(text for _, _, text in messages):
        raise AssertionError(
            f"the turn completed without a non-empty agentMessage item; saw {shown!r}"
        )
    # The answer must have arrived incrementally, not in one final lump. The
    # fold accumulates text only from item/delta frames, so a non-empty
    # accumulation IS the streaming evidence.
    if not any(session.fold.items.accumulated(item_id) for item_id, _, _ in messages):
        raise AssertionError("the turn completed without streaming a single item/delta")


async def _stream_turn(turn: "Turn[Any]") -> list[str]:
    kinds: list[str] = []
    async for item in turn.items():
        kinds.append(str(item.get("kind")))
    return kinds


async def _approval(context: Context) -> None:
    session = _require_session(context)
    failures: list[Any] = []
    # Register before the turn. The SDK sends only a choice the request
    # offered; anything else is refused and reported to `on_approval_error`.
    session.on_approval_error(failures.append)
    session.on_approval(lambda request: ApprovalDecisionInput(choice_id="allow_once"))

    # Send the turn yourself to read its items as they stream in.
    turn = await within(
        "the turn/start ack",
        COMMAND_BUDGET_MS,
        session.send_user_turn(
            SendUserTurnOptions(input=[{"type": "text", "text": APPROVAL_PROMPT}])
        ),
    )
    kinds = await within("the approval turn's items", STREAM_BUDGET_MS, _stream_turn(turn))
    _require_terminal(await turn.completed, "completed")

    if failures:
        raise AssertionError(f"the approval round trip failed: {failures!r}")
    if "toolCall" not in kinds:
        raise AssertionError(
            f"the turn never streamed the tool call it asked about; kinds: {kinds!r}"
        )
    # The authoritative outcome is the server's approval/resolved, folded into
    # the session, never the decision's ack.
    if not session.fold.resolved_approvals():
        raise AssertionError(
            "the turn ended without an approval/resolved: it never asked, "
            "or the decision never landed"
        )


async def _first_item(turn: "Turn[Any]") -> None:
    async for _item in turn.items():
        return


async def _cancel(context: Context) -> None:
    session = _require_session(context)
    turn = await within(
        "the turn/start ack",
        COMMAND_BUDGET_MS,
        session.send_user_turn(
            SendUserTurnOptions(input=[{"type": "text", "text": PROMPT}])
        ),
    )
    # The first item (the prompt itself) folds once the turn runs, so the
    # cancel below lands on a running turn, never a queued one.
    await within("the cancel turn's first item", STREAM_BUDGET_MS, _first_item(turn))
    # The turn must still be running when the cancel lands (the provider's
    # hold keeps it in flight; see provider.HOLD_S).
    completed = asyncio.ensure_future(turn.completed)
    if completed.done():
        raise AssertionError(
            f"the turn ended ({completed.result()!r}) before it could be cancelled"
        )

    # A request, not an outcome: the turn is over when the server says so.
    await within("the turn/cancel ack", COMMAND_BUDGET_MS, turn.cancel())
    outcome = await within("the cancelled turn's end", STREAM_BUDGET_MS, completed)
    _require_terminal(outcome, "cancelled")


async def _resume(context: Context) -> None:
    # The session lease belongs to the live host, so the first one has to
    # drain cleanly before a second can load the session.
    first = _require_client(context)
    await within("the first host's orderly drain", CLOSE_BUDGET_MS, first.close())
    exit_ = await first.exit
    _equals(exit_.kind, "cleanShutdown", "the first host's exit after stdin EOF")
    context.client = None

    session_id = _require_session_id(context)
    client: "MuseClient[Any]" = await within(
        "the resume host's spawn and handshake",
        HANDSHAKE_BUDGET_MS,
        MuseClient.spawn(_spawn_options(context)),
    )
    context.resume_client = client

    resumed_session = await within(
        "the session/resume reply",
        COMMAND_BUDGET_MS,
        client.resume_session(
            ResumeSessionOptions(session_id=session_id, exclude_items=False)
        ),
    )
    resumed = _opening_result(resumed_session)
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
    client = context.resume_client
    if client is None:
        raise AssertionError("`resume` did not finish")
    session_id = _require_session_id(context)
    # A cursor at an impossible sequence: no host can ever have minted it.
    impossible = f"v10:{session_id}:999999"
    try:
        await within(
            "the session/resume refusal",
            COMMAND_BUDGET_MS,
            client.resume_session(
                ResumeSessionOptions(
                    session_id=session_id, cursor=impossible, exclude_items=False
                )
            ),
        )
    except MspError as error:
        # ONLY the pinned refusal counts (`notFound` / -32011): a bare MspError
        # catch would let any unrelated protocol error read as the refusal.
        if error.kind == "notFound":
            return
        raise
    raise AssertionError(
        f"session/resume accepted a cursor that never existed ({impossible})"
    )


async def _terminate(context: Context) -> None:
    client = context.resume_client
    if client is None:
        raise AssertionError("`resume` did not finish")
    # 14990 its acceptance scenario: stdin closed by close(), the SDK waits for
    # the orderly drain, and the exit classification is what actually happened.
    await within("the host's orderly drain and exit", CLOSE_BUDGET_MS, client.close())
    classification = await within(
        "the SDK's exit classification", COMMAND_BUDGET_MS, client.exit
    )
    _equals(classification.kind, "cleanShutdown", "the SDK's exit classification")
    context.resume_client = None


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
"""Segment ids in run order — the step registry its charter test pins against the
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
        if owned.client is not None:
            await _close_quietly("the host", owned.client)
        if owned.resume_client is not None:
            await _close_quietly("the resume host", owned.resume_client)

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
        client_info=QUICKSTART_CLIENT_INFO,
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


def _run_sync_turn(session: "SyncSession[Any]", prompt: str) -> SyncTurn:
    return session.send_user_turn(
        SendUserTurnOptions(
            input=[{"type": "text", "text": prompt}], composer_input=prompt
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
    # Both journeys read providerId/modelId from the session summary in the
    # session/start result.
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
    # Every completed agent message the turn served, each with its phase; the
    # last one is not "the answer" (the phase labels a message, its position
    # does not) and an absent phase is an older host's final answer.
    agent_items = [
        i for i in items if i.get("kind") == "agentMessage" and i.get("status") == "completed"
    ]
    if not agent_items:
        raise AssertionError("the turn completed without an agentMessage item")
    shown = [
        f"[{'commentary' if i.get('messagePhase') == 'commentary' else 'finalAnswer'}] "
        f"{i.get('text') or ''}"
        for i in agent_items
    ]
    # The fold's delta accumulator only fills from item/delta frames, so a
    # non-empty accumulation for some streamed message IS the
    # incremental-streaming evidence.
    if not any(session.fold.items.accumulated(str(i["itemId"])) for i in agent_items):
        raise AssertionError("the turn completed without streaming a single item/delta")
    if not any(
        (session.fold.items.get(str(i["itemId"])) or {}).get("text") for i in agent_items
    ):
        raise AssertionError(
            f"the turn completed without a non-empty agentMessage item; saw {shown!r}"
        )


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


def _sync_wait_first_item(context: SyncContext, turn: SyncTurn) -> None:
    """Block until the turn's first item (the prompt itself) has folded, under
    the async step's budget.

    The first item folds once the turn runs, so the cancel lands on a running
    turn, never a queued one (a cancel that beats a queued turn's launch is
    rejected). The sync surface has no bounded wait, so this harness — a
    first-party journey, not shipped SDK code — runs the async handle's
    ``items()`` under ``within`` on the wrapper's own runner, which keeps it
    serialized with the wrapper's verbs. A public bounded-iteration knob would
    freeze API for one harness call (Constitution XI).
    """
    client = _require_sync_client(context)

    async def first_item() -> None:
        async for _item in turn._turn.items():  # noqa: SLF001 - see the docstring
            return

    client._runner.run(  # noqa: SLF001 - see the docstring
        within("the cancel turn's first item", STREAM_BUDGET_MS, first_item())
    )


def _sync_cancel_segment(context: SyncContext) -> None:
    session = _require_sync_session(context)
    turn = _run_sync_turn(session, PROMPT)
    _sync_wait_first_item(context, turn)
    turn.cancel()
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
    impossible = f"v10:{session_id}:999999"
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
    # The sync close drives the same orderly shutdown; the wrapper
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
"""The rerun's registry — its charter test pins it equal to :data:`SEGMENT_IDS`."""


def run_configured_sync_journey(
    muse_bin: str, workspace_root: str | None = None
) -> ConfiguredJourneyResult:
    """The sync rerun: the journey rewritten on the sync wrapper, same twelve
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
