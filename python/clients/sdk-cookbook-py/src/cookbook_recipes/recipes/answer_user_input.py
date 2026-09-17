"""Recipe twin: answer the agent's question (userInput).

Runs against ``muse-conformance serve-fixture`` playing the committed golden
transcript ``schema/msp/transcripts/userinput-answer-round-trip``.

What it teaches: mid-turn the agent can stop and ask the USER a structured
question. Like an approval, the ask arrives twice for two audiences
(``userInput/requested`` for your UI; ``userInput/request`` as a JSON-RPC
request the client must answer — the reply means "this client is showing the
question", NOT "here is the answer"); a pending question SURVIVES the client
(this transcript resumes and finds it in ``pendingRequests``, then the host
re-issues the request to the late joiner); answer with a ``selectedLabel``
the host OFFERED; and the ack is not the outcome — ``userInput/settled`` is,
after which the tool call completes with the answer as its visible output.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from ..kit import (
    array_at,
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

# The transcript's own client-side values: a real client knows the session id
# because it persisted it when the session started; the commandIds are the
# recorded ones because the canned host's acks echo them.
SESSION_ID = "0198f0aa-1111-7000-8000-0000000000bb"
SESSION_RESUME_COMMAND_ID = "0198f0ab-8888-7000-8000-0000000000d2"
USER_INPUT_ANSWER_COMMAND_ID = "018f6a2b-3333-7abc-8def-00000000d002"

ANSWER_LABEL = "Postgres"
"""The answer this recipe picks; asserted to be a label the host offered."""


@dataclass
class Context:
    """The recipe's own state, one segment feeding the next."""

    conformance_bin: str
    transcript_root: str
    host: Host | None = None
    asked: "asyncio.Future[Mapping[str, Any]] | None" = None
    answered: "asyncio.Event | None" = None
    pending_user_input_id: str | None = None
    user_input_id: str | None = None
    turn_id: str | None = None
    item_id: str | None = None
    question_id: str | None = None


def _known(value: str | None, what: str) -> str:
    if value is None:
        raise RuntimeError(f"{what} is not known: an earlier segment did not finish")
    return value


async def _spawn(context: Context) -> None:
    host = await spawn_fixture_host(
        conformance_bin=context.conformance_bin,
        transcript_dir=Path(context.transcript_root) / "userinput-answer-round-trip",
        env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
        client_info={"name": "conformance", "version": "0.0.0"},
        budget_ms=HANDSHAKE_BUDGET_MS,
    )
    # Answer userInput/request — the JSON-RPC request half of the ask. The
    # reply is an empty acknowledgement ("this client is showing the
    # question"), NOT an answer; the answer travels as userInput/answer.
    # Registered before the resume, because the host re-issues the pending
    # request the moment the resume completes. The connection enqueues the
    # reply write synchronously after this handler returns, so setting the
    # event inline plus the next segment's flush gives the deterministic
    # reply-before-next-request ordering the fixture enforces.
    asked: asyncio.Future[Mapping[str, Any]] = asyncio.get_running_loop().create_future()
    answered = asyncio.Event()
    context.asked = asked
    context.answered = answered

    async def handle(request: Mapping[str, Any]) -> Mapping[str, Any]:
        # Check the method, exactly as the page teaches: one handler serves
        # the whole connection. The canned transcript only ever sends
        # userInput/request, so the raise arm never fires in replay.
        if request.get("method") != "userInput/request":
            raise RuntimeError(f"unhandled server request: {request.get('method')}")
        params = request.get("params")
        if not asked.done():
            asked.set_result(params if isinstance(params, Mapping) else {})
        answered.set()
        return {}

    host.connection.on_server_request(handle)
    context.host = host


async def _resume(context: Context) -> None:
    host = require_host(context.host, "spawn")
    # The recorded client discovers the model catalog BEFORE the resume — one
    # sessionless read-only model/list ("a client may list before it has a
    # session"); the resume result's own modelId then names the model in
    # force. Taught in depth by list-models-and-switch-mid-session.
    await within("the model/list reply", COMMAND_BUDGET_MS, host.connection.request("model/list", {}))
    resumed = await within("the session/resume ack", COMMAND_BUDGET_MS, host.connection.command(
        "session/resume",
        {"sessionId": SESSION_ID, "excludeItems": True},
        max_attempts=1,
        command_id=SESSION_RESUME_COMMAND_ID,
    ))
    session = object_at(resumed, "session", "session/resume result")
    equals(session.get("sessionId"), SESSION_ID, "the resumed session's id")
    # A question the user has not answered holds the turn open, so the
    # session comes back running, not idle.
    equals(session.get("status"), "running", "the resumed session's status")
    # This is the field a resuming client must read: unanswered requests
    # survive the client that received them first, and a UI that skips this
    # list resumes into a turn that looks stuck for no reason.
    pending = array_at(resumed, "pendingRequests", "session/resume result")
    user_input = next(
        (entry for entry in pending if isinstance(entry, dict) and entry.get("kind") == "userInput"),
        None,
    )
    if user_input is None:
        raise AssertionError(
            f"the resume result lists no pending userInput request; it listed {pending!r}"
        )
    context.pending_user_input_id = string_at(
        user_input, "userInputId", "a pendingRequests entry"
    )


async def _question(context: Context) -> None:
    if context.asked is None:
        raise RuntimeError("`spawn` did not finish")
    pending_user_input_id = _known(context.pending_user_input_id, "the pending userInputId")
    params = await within(
        "the userInput/request from the host", COMMAND_BUDGET_MS, context.asked
    )
    equals(params.get("sessionId"), SESSION_ID, "the question's session id")
    # The re-issued request IS the pending one the resume result named: same
    # userInputId, so a client that tracked the pending list can tell it is
    # not being asked something new.
    user_input_id = string_at(params, "userInputId", "userInput/request params")
    equals(user_input_id, pending_user_input_id, "the re-issued request's userInputId")
    context.user_input_id = user_input_id
    context.turn_id = string_at(params, "turnId", "userInput/request params")
    # The item the question belongs to: the request_user_input tool call that
    # completes once the answer settles.
    context.item_id = string_at(params, "itemId", "userInput/request params")

    # What a UI puts in front of the user: the questions, each with the
    # options the host offered. Pick from what was OFFERED — the options come
    # from the agent's own question.
    questions = array_at(params, "questions", "userInput/request params")
    if not questions:
        raise AssertionError("the userInput/request carried no questions")
    question = questions[0]
    context.question_id = string_at(question, "id", "the first question")
    string_at(question, "question", "the first question")
    selection = object_at(question, "selection", "the first question")
    equals(selection.get("mode"), "single", "the first question's selection mode")
    options = array_at(question, "options", "the first question")
    offered = [string_at(option, "label", "an options entry") for option in options]
    if ANSWER_LABEL not in offered:
        raise AssertionError(
            f'the host did not offer "{ANSWER_LABEL}"; it offered {offered!r}'
        )
    # The page teaches this field as a UI deadline, so the journey pins it.
    equals(params.get("autoResolutionMs"), 120_000, "the question's auto-resolution window")


async def _backfill(context: Context) -> None:
    host = require_host(context.host, "spawn")
    user_input_id = _known(context.user_input_id, "the userInputId")
    # Reply first, next request second. Bounded, so a handler that never
    # fires reports that instead of hanging.
    if context.answered is None:
        raise RuntimeError("`spawn` did not finish")
    await within("the reply to userInput/request", COMMAND_BUDGET_MS, context.answered.wait())
    await within("the reply flush", COMMAND_BUDGET_MS, host.connection.flush())
    # The resume above excluded items, so the UI has nothing to render yet.
    # view/page backfills it — and the question is IN the view, so a client
    # rendering the view shows the question in place.
    page = await within("the view/page reply", COMMAND_BUDGET_MS, host.connection.request(
        "view/page", {"sessionId": SESSION_ID, "direction": "forward", "limit": 200}
    ))
    events = array_at(page, "events", "view/page result")
    requested = next(
        (e for e in events if isinstance(e, dict) and e.get("method") == "userInput/requested"),
        None,
    )
    if requested is None:
        raise AssertionError("the paged view carries no userInput/requested event")
    requested_params = object_at(requested, "params", "the userInput/requested event")
    equals(requested_params.get("userInputId"), user_input_id, "the viewed question's userInputId")


async def _answer(context: Context) -> None:
    host = require_host(context.host, "spawn")
    user_input_id = _known(context.user_input_id, "the userInputId")
    question_id = _known(context.question_id, "the question id")
    ack = await within("the userInput/answer ack", COMMAND_BUDGET_MS, host.connection.command(
        "userInput/answer",
        {
            "sessionId": SESSION_ID,
            "userInputId": user_input_id,
            "answers": [{"questionId": question_id, "selectedLabel": ANSWER_LABEL}],
        },
        max_attempts=1,
        command_id=USER_INPUT_ANSWER_COMMAND_ID,
    ))
    equals(ack.get("status"), "accepted", "userInput/answer ack status")
    equals(ack.get("userInputId"), user_input_id, "the userInputId the ack echoes")


async def _settled(context: Context) -> None:
    host = require_host(context.host, "spawn")
    user_input_id = _known(context.user_input_id, "the userInputId")
    question_id = _known(context.question_id, "the question id")
    item_id = _known(context.item_id, "the tool call's itemId")
    turn_id = _known(context.turn_id, "the turn id")
    settled = await host.wait_for(
        "the userInput/settled notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "userInput/settled" and n.params.get("userInputId") == user_input_id,
    )
    # The ack said "accepted". THIS says how the question ended.
    equals(settled.params.get("outcome"), "answered", "the settlement outcome")
    answers = array_at(settled.params, "answers", "userInput/settled params")
    if not answers:
        raise AssertionError("the settlement carried no answers")
    answer = answers[0]
    equals(answer.get("questionId"), question_id, "the settled answer's questionId")
    equals(answer.get("selectedLabel"), ANSWER_LABEL, "the settled answer's selectedLabel")
    equals(
        settled.params.get("decidedByCommandId"),
        USER_INPUT_ANSWER_COMMAND_ID,
        "the command the settlement credits",
    )

    # The question was a tool call, and the answer is its result: the item
    # completes with the selected label as its visible output.
    def _tool_completed(notification: Any) -> bool:
        if notification.method != "item/completed":
            return False
        item = notification.params.get("item")
        return isinstance(item, dict) and item.get("itemId") == item_id

    completed = await host.wait_for(
        "the tool call's item/completed notification", COMMAND_BUDGET_MS, _tool_completed
    )
    item = object_at(completed.params, "item", "item/completed params")
    equals(item.get("status"), "completed", "the tool call's status")
    equals(item.get("visibleOutput"), ANSWER_LABEL, "the tool call's visible output")

    # Answering unblocks the agent: the turn runs on to its own terminal.
    turn = await host.wait_for(
        "the turn/completed notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    equals(turn.params.get("terminal"), "completed", "the turn's terminal")


async def _drain(context: Context) -> None:
    host = require_host(context.host, "spawn")
    exit_ = await host.close(CLOSE_BUDGET_MS)
    equals(exit_.code, 0, "the fixture host's exit code after stdin EOF")
    context.host = None


SEGMENTS: tuple[Segment[Context], ...] = (
    Segment(
        "spawn",
        "Spawn the canned host playing the userinput-answer-round-trip transcript",
        _spawn,
    ),
    Segment(
        "resume", "Resume the session and find the question waiting in pendingRequests", _resume
    ),
    Segment(
        "question", "Take the re-issued userInput/request and read the offered options", _question
    ),
    Segment("backfill", "Reply first, then page the view the question came from", _backfill),
    Segment("answer", f'Answer with "{ANSWER_LABEL}"', _answer),
    Segment("settled", "Read the outcome off userInput/settled, then let the turn finish", _settled),
    Segment("drain", "Close stdin and let the fixture host exit cleanly", _drain),
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
    id="answer-user-input",
    title="Answer the agent's question (userInput)",
    docs_page="developer-" "docs/src/content/docs/cookbook/answer-the-agents-question.mdx",
    needs=("conformance_bin",),
    run=_run,
)
