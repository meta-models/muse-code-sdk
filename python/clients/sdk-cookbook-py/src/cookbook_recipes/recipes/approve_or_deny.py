"""Recipe twin: approve or deny the agent's permission request.

Runs against ``muse-conformance serve-fixture`` playing four committed golden
transcripts — ``approval-round-trip`` (allow), ``approval-deny-round-trip``
(deny), ``approval-choice-invalid`` (a choice the host never offered, refused,
then a listed choice) and ``approval-requirement-stale`` (a requirement token
the host never issued, refused, then the token the refusal carried) — so it
is deterministic and needs no credentials and no model. It plays the deny arm
because that path is the one an integrator gets wrong and the quickstart
never shows it, and the two refusal arms because a wrong answer is the other
thing an integrator ships: both earn a typed error that leaves the approval
pending, never a failed turn.

What it teaches (the docs page walks the same points): the host asks TWICE,
for two audiences (``approval/requested`` for your UI, ``approval/request``
as a JSON-RPC request the client must answer — reply first, decide second);
answer with a ``choiceId`` the host OFFERED; the ack is not the outcome —
``approval/resolved`` is; denying is a normal answer, not an error; and a
wrong answer is refused, typed (``-32052 approvalChoiceInvalid`` echoing the
refused id, ``-32053 approvalRequirementStale`` carrying the current token),
and changes nothing.
"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Mapping

from muse_code.connection import MspError

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

# The transcripts' own client-side values; see the module docstring.
WORKSPACE_ROOT = "/home/me/src/proj"
PROMPT = "Update Cargo.toml to bump the version"
SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1"
TURN_START_COMMAND_ID = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10"
APPROVAL_DECIDE_COMMAND_ID = "018f6a2a-3333-7abc-8def-00000000d001"
# The commandId the refusal transcripts record for the decide the host refuses.
REFUSED_DECIDE_COMMAND_ID = "018f6a2a-3333-7abc-8def-00000000d002"


@dataclass(frozen=True)
class Refusal:
    """A deliberately wrong first decide and the typed refusal it must earn.

    Attributes:
        what: What the client got wrong, for the segment title and failures.
        code: The JSON-RPC code the host must answer with.
        kind: The ``data.kind`` the host must answer with; the branch key,
            never message text.
        unoffered_choice_id: Sent instead of the arm's choice; the request
            segment proves the host did not offer it.
        stale_requirement: Send a requirement token the host did not issue
            instead of the current one.
    """

    what: str
    code: int
    kind: str
    unoffered_choice_id: str | None = None
    stale_requirement: bool = False


@dataclass(frozen=True)
class Arm:
    """One arm of the recipe: the same round trip, a different answer.

    Attributes:
        id: Segment-id prefix, so the report names which arm a line is.
        scenario: The transcript directory name under the corpus root.
        choice_id: The choice this arm picks; asserted to be one the host
            offered.
        decision: The decision ``approval/resolved`` must report.
        policy_result: The policy result ``approval/resolved`` must report.
        feedback: Sent only when the chosen option accepts feedback.
        refusal: Present on the arms that first send a wrong answer and read
            the refusal.
    """

    id: str
    scenario: str
    choice_id: str
    decision: str
    policy_result: str
    feedback: str | None = None
    refusal: Refusal | None = None


ALLOW = Arm(
    id="allow",
    scenario="approval-round-trip",
    choice_id="allow_session",
    decision="approvedForSession",
    policy_result="allow",
)

DENY = Arm(
    id="deny",
    scenario="approval-deny-round-trip",
    choice_id="abort",
    feedback="Do not modify the manifest",
    decision="abort",
    policy_result="deny",
)

INVALID_CHOICE = Arm(
    id="invalid-choice",
    scenario="approval-choice-invalid",
    choice_id="allow_once",
    decision="approved",
    policy_result="allow",
    refusal=Refusal(
        what='a hardcoded choice id the host never offered ("allow")',
        code=-32052,
        kind="approvalChoiceInvalid",
        unoffered_choice_id="allow",
    ),
)

STALE_REQUIREMENT = Arm(
    id="stale-requirement",
    scenario="approval-requirement-stale",
    choice_id="allow_once",
    decision="approved",
    policy_result="allow",
    refusal=Refusal(
        what="a requirement token the host never issued",
        code=-32053,
        kind="approvalRequirementStale",
        stale_requirement=True,
    ),
)


@dataclass
class Context:
    """The recipe's own state, reset by each arm's spawn segment."""

    conformance_bin: str
    transcript_root: str
    host: Host | None = None
    session_id: str | None = None
    turn_id: str | None = None
    approval_id: str | None = None
    requirement_id: Mapping[str, Any] | None = None
    answered: "asyncio.Event | None" = None


def _known(value: str | None, what: str) -> str:
    if value is None:
        raise RuntimeError(f"{what} is not known: an earlier segment did not finish")
    return value


def _known_requirement(context: "Context") -> Mapping[str, Any]:
    if context.requirement_id is None:
        raise RuntimeError("the current requirement is not known: an earlier segment did not finish")
    return context.requirement_id


async def _refused_by(what: str, action: Callable[[], Awaitable[Any]]) -> MspError:
    """Run ``action`` and hand back the MspError it must raise; anything else is a failure."""
    try:
        await action()
    except MspError as error:
        return error
    raise AssertionError(f"the host accepted {what}; it must answer a typed refusal")


def _arm_segments(arm: Arm) -> tuple[Segment[Context], ...]:
    async def spawn(context: Context) -> None:
        # Reclaim before overwriting the slot: a previous arm whose drain
        # threw leaves its child in context.host, and assigning over it would
        # orphan that child and leave later segments talking to a stale host.
        if context.host is not None:
            await context.host.abandon(CLOSE_BUDGET_MS)
            context.host = None
        # THE authoritative reset of everything an arm learns from its own
        # wire — here, not in drain, because drain runs after assertions that
        # can throw and would then leave stale state for the next arm.
        context.session_id = None
        context.turn_id = None
        context.approval_id = None
        context.requirement_id = None
        context.answered = None
        host = await spawn_fixture_host(
            conformance_bin=context.conformance_bin,
            transcript_dir=Path(context.transcript_root) / arm.scenario,
            env={"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
            client_info={"name": "conformance", "version": "0.0.0"},
            budget_ms=HANDSHAKE_BUDGET_MS,
        )
        # Answer approval/request — the JSON-RPC request half of the ask. The
        # reply is an empty acknowledgement: "this client is handling the
        # approval", NOT "approved"; the answer travels separately as
        # approval/decide. Registered before any turn starts. The connection
        # enqueues the reply write synchronously after this handler returns
        # (a direct await, no loop hop), so setting the event inline is
        # enough: by the time the decide segment resumes, the reply is ahead
        # of the decide in the write tail, and the flush there orders both.
        answered = asyncio.Event()
        context.answered = answered

        async def handle(request: Mapping[str, Any]) -> Mapping[str, Any]:
            # Check the method, exactly as the page teaches: one handler
            # serves the whole connection. The canned transcripts only ever
            # send approval/request, so the raise arm never fires in replay.
            if request.get("method") != "approval/request":
                raise RuntimeError(f"unhandled server request: {request.get('method')}")
            answered.set()
            return {}

        host.connection.on_server_request(handle)
        context.host = host

    async def turn(context: Context) -> None:
        host = require_host(context.host, f"{arm.id}-spawn")
        started = await within("the session/start ack", COMMAND_BUDGET_MS, host.connection.command(
            "session/start",
            {"workspaceRoot": WORKSPACE_ROOT},
            max_attempts=1,
            command_id=SESSION_START_COMMAND_ID,
        ))
        session = object_at(started, "session", "session/start result")
        session_id = string_at(session, "sessionId", "session/start session")
        # The recorded client discovers the model catalog right at session
        # acquisition — one read-only model/list.
        await within("the model/list reply", COMMAND_BUDGET_MS, host.connection.request("model/list", {"sessionId": session_id}))
        ack = await within("the turn/start ack", COMMAND_BUDGET_MS, host.connection.command(
            "turn/start",
            {"sessionId": session_id, "input": [{"type": "text", "text": PROMPT}]},
            max_attempts=1,
            command_id=TURN_START_COMMAND_ID,
        ))
        equals(ack.get("status"), "accepted", "turn/start ack status")
        context.session_id = session_id
        context.turn_id = string_at(ack, "turnId", "turn/start ack")

    async def request(context: Context) -> None:
        host = require_host(context.host, f"{arm.id}-spawn")
        turn_id = _known(context.turn_id, "the turn id")
        # Race the turn's own terminal: without it, a turn that ended WITHOUT
        # asking for permission would burn the whole budget and report a
        # timeout instead of what actually happened.
        event = await host.wait_for(
            "an approval/requested notification",
            COMMAND_BUDGET_MS,
            lambda n: n.method == "approval/requested"
            or (n.method == "turn/completed" and n.params.get("turnId") == turn_id),
        )
        if event.method != "approval/requested":
            raise AssertionError(
                f"the turn ended (terminal {event.params.get('terminal')!r}) "
                "without asking for approval"
            )
        equals(event.params.get("turnId"), turn_id, "the approval's turn id")

        # What a UI puts in front of the user: which tool, acting on what.
        subject = object_at(event.params, "subject", "approval/requested params")
        string_at(subject, "kind", "approval/requested subject")
        string_at(event.params, "toolName", "approval/requested params")

        # Pick from what the host OFFERED. A hardcoded choiceId is the bug
        # this assertion exists to catch.
        choices = array_at(event.params, "availableChoices", "approval/requested params")
        offered = [
            string_at(choice, "choiceId", "an availableChoices entry") for choice in choices
        ]
        if arm.choice_id not in offered:
            raise AssertionError(
                f'the host did not offer "{arm.choice_id}"; it offered {offered!r}'
            )
        refusal = arm.refusal
        if (
            refusal is not None
            and refusal.unoffered_choice_id is not None
            and refusal.unoffered_choice_id in offered
        ):
            # The refusal arm sends this id BECAUSE the host never offered it;
            # an offered id would make the arm's refusal pass vacuously.
            raise AssertionError(
                f'the host offered "{refusal.unoffered_choice_id}", so sending it is '
                f"not a wrong answer; it offered {offered!r}"
            )
        if arm.feedback is not None:
            # Feedback rides along only where the host says it is accepted.
            chosen = next(c for c in choices if c.get("choiceId") == arm.choice_id)
            equals(
                chosen.get("acceptsFeedback"),
                True,
                f'whether "{arm.choice_id}" accepts feedback',
            )

        context.approval_id = string_at(event.params, "approvalId", "approval/requested params")
        # The requirement being answered, quoted back verbatim on the decide.
        context.requirement_id = object_at(
            event.params, "currentRequirementId", "approval/requested params"
        )

    async def refused(context: Context) -> None:
        refusal = arm.refusal
        if refusal is None:
            raise RuntimeError(f"{arm.id} has no refusal to send")
        host = require_host(context.host, f"{arm.id}-spawn")
        session_id = _known(context.session_id, "the session id")
        approval_id = _known(context.approval_id, "the approval id")
        current = _known_requirement(context)
        # Reply first, decision second — see the spawn segment. This is the
        # arm's first decide, so the ordering wait lives here.
        if context.answered is None:
            raise RuntimeError(f"`{arm.id}-spawn` did not finish")
        await within(
            "the reply to approval/request", COMMAND_BUDGET_MS, context.answered.wait()
        )
        await within("the reply flush", COMMAND_BUDGET_MS, host.connection.flush())

        # The wrong answer, built the way a buggy client builds it: a token it
        # computed itself instead of quoting the host's, or a choice id copied
        # from somewhere this host never offered it.
        requirement_id: Mapping[str, Any] = current
        if refusal.stale_requirement:
            index = current.get("sourceIndex")
            if not isinstance(index, int):
                raise AssertionError(
                    f"currentRequirementId.sourceIndex is not an integer: {current!r}"
                )
            requirement_id = {**current, "sourceIndex": index + 1}
        choice_id = refusal.unoffered_choice_id or arm.choice_id
        params: dict[str, Any] = {
            "sessionId": session_id,
            "approvalId": approval_id,
            "requirementId": requirement_id,
            "choiceId": choice_id,
        }
        error = await _refused_by(
            refusal.what,
            lambda: within(
                "the refused approval/decide",
                COMMAND_BUDGET_MS,
                host.connection.command(
                    "approval/decide",
                    params,
                    max_attempts=1,
                    command_id=REFUSED_DECIDE_COMMAND_ID,
                ),
            ),
        )
        # Branch on code and kind, never on message text.
        equals(error.code, refusal.code, "the refusal's code")
        equals(error.kind, refusal.kind, "the refusal's kind")
        equals(error.data.get("approvalId"), approval_id, "the approval the refusal names")
        if refusal.unoffered_choice_id is not None:
            equals(
                error.data.get("choiceId"),
                refusal.unoffered_choice_id,
                "the choice id the refusal echoes",
            )
        if refusal.stale_requirement:
            # The refusal carries the token to answer with. Take it from there,
            # as a real client would, and check it is the one the request taught.
            recovered = object_at(error.data, "currentRequirementId", "approvalRequirementStale data")
            equals(
                recovered.get("approvalId"),
                current.get("approvalId"),
                "the current requirement's approval id",
            )
            equals(
                recovered.get("sourceIndex"),
                current.get("sourceIndex"),
                "the current requirement's source index",
            )
            context.requirement_id = recovered
        # Nothing was decided: no outcome followed the refusal, so the approval
        # is still pending and the corrected answer below is a first answer.
        if any(
            n.method == "approval/resolved" and n.params.get("approvalId") == approval_id
            for n in host.notifications()
        ):
            raise AssertionError(
                "the refused decide resolved the approval; a refusal must leave it pending"
            )

    async def decide(context: Context) -> None:
        host = require_host(context.host, f"{arm.id}-spawn")
        session_id = _known(context.session_id, "the session id")
        approval_id = _known(context.approval_id, "the approval id")
        requirement_id = _known_requirement(context)
        # Reply first, decision second — see the spawn segment. Bounded, so a
        # handler that never fires reports that instead of hanging. (On a
        # refusal arm the refused decide already waited; this is a no-op.)
        if context.answered is None:
            raise RuntimeError(f"`{arm.id}-spawn` did not finish")
        await within(
            "the reply to approval/request", COMMAND_BUDGET_MS, context.answered.wait()
        )
        await within("the reply flush", COMMAND_BUDGET_MS, host.connection.flush())
        params: dict[str, Any] = {
            "sessionId": session_id,
            "approvalId": approval_id,
            "requirementId": requirement_id,
            "choiceId": arm.choice_id,
        }
        if arm.feedback is not None:
            params["feedback"] = arm.feedback
        ack = await within("the approval/decide ack", COMMAND_BUDGET_MS, host.connection.command(
            "approval/decide", params, max_attempts=1, command_id=APPROVAL_DECIDE_COMMAND_ID
        ))
        equals(ack.get("status"), "accepted", "approval/decide ack status")
        equals(ack.get("approvalId"), approval_id, "the approval id the ack echoes")
        # terminal: true means this approval will not come back for more.
        equals(ack.get("terminal"), True, "whether the decision settles the approval")

    async def resolved(context: Context) -> None:
        host = require_host(context.host, f"{arm.id}-spawn")
        approval_id = _known(context.approval_id, "the approval id")
        turn_id = _known(context.turn_id, "the turn id")
        outcome = await host.wait_for(
            "the approval/resolved notification",
            COMMAND_BUDGET_MS,
            lambda n: n.method == "approval/resolved"
            and n.params.get("approvalId") == approval_id,
        )
        # The ack said "accepted". THIS says what was decided.
        equals(outcome.params.get("decision"), arm.decision, "the decision")
        equals(outcome.params.get("policyResult"), arm.policy_result, "the policy result")
        equals(outcome.params.get("resolvedBy"), "user", "who resolved the approval")
        # Which decide won: the corrected (or only) decide, never a refused one.
        equals(
            outcome.params.get("decidedByCommandId"),
            APPROVAL_DECIDE_COMMAND_ID,
            "the command that decided",
        )

        # A session-scoped choice also amends policy; a once-scoped or denying
        # choice carries no amendment — that difference IS the scope.
        amendment = outcome.params.get("amendment")
        if arm.choice_id == "allow_session":
            durability = object_at(outcome.params, "amendment", "approval/resolved params")
            equals(durability.get("durability"), "session", "the amendment's durability")
        elif amendment is not None:
            raise AssertionError(
                f'a "{arm.choice_id}" decision should amend no policy, '
                f"but carried {amendment!r}"
            )

        # Denied or allowed, the turn runs on to its own terminal. A denial is
        # an answer, not a failure.
        completed = await host.wait_for(
            "the turn/completed notification",
            COMMAND_BUDGET_MS,
            lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
        )
        equals(completed.params.get("terminal"), "completed", "the turn's terminal")

        if arm.policy_result == "deny":
            # ...and the user is told. A denied tool call that ends in silence
            # is a UI that looks broken.
            def _spoke(notification: Any) -> bool:
                if notification.method != "item/completed":
                    return False
                item = notification.params.get("item")
                return (
                    isinstance(item, dict)
                    and item.get("kind") == "agentMessage"
                    and isinstance(item.get("text"), str)
                    and len(item["text"]) > 0
                )

            if not any(_spoke(n) for n in host.notifications()):
                raise AssertionError(
                    "the denied turn ended without the agent saying what it did not do"
                )

    async def drain(context: Context) -> None:
        host = require_host(context.host, f"{arm.id}-spawn")
        exit_ = await host.close(CLOSE_BUDGET_MS)
        equals(exit_.code, 0, "the fixture host's exit code after stdin EOF")
        # Only the host slot: the NEXT arm's spawn is the authoritative reset.
        context.host = None

    refusal_segments: tuple[Segment[Context], ...] = ()
    decide_title = f'Answer with "{arm.choice_id}"'
    if arm.refusal is not None:
        refusal_segments = (
            Segment(
                f"{arm.id}-refused",
                f"Send {arm.refusal.what} and read the typed refusal",
                refused,
            ),
        )
        decide_title = f'Answer again with "{arm.choice_id}"'

    return (
        Segment(
            f"{arm.id}-spawn",
            f"Spawn the canned host playing the {arm.scenario} transcript",
            spawn,
        ),
        Segment(f"{arm.id}-turn", "Start a session and a turn that will need permission", turn),
        Segment(
            f"{arm.id}-request",
            "Take the request off the wire and read the choices the host offers",
            request,
        ),
        *refusal_segments,
        Segment(f"{arm.id}-decide", decide_title, decide),
        Segment(
            f"{arm.id}-resolved",
            "Read the outcome off approval/resolved, then let the turn finish",
            resolved,
        ),
        Segment(f"{arm.id}-drain", "Close stdin and let the fixture host exit cleanly", drain),
    )


SEGMENTS: tuple[Segment[Context], ...] = (
    *_arm_segments(ALLOW),
    *_arm_segments(DENY),
    *_arm_segments(INVALID_CHOICE),
    *_arm_segments(STALE_REQUIREMENT),
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
    id="approve-or-deny",
    title="Approve or deny the agent's permission request",
    docs_page="cookbook/approve-or-deny-a-tool-call",
    needs=("conformance_bin",),
    run=_run,
)
