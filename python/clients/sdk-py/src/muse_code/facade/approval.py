"""The approval round trip: inbound ``approval/requested`` → the consumer's
handler → outbound ``approval/decide``. Port of the TypeScript SDK's
approval router.

Split out of ``session.py`` rather than added to it: the router owns a
handler, a per-stage latch, and a decision-shaping guard chain that have
nothing to do with folding a view, and ``Session`` was already the package's
largest module.

SHAPE NOTE, established from the bundle rather than assumed. ``approval/request``
as a SERVER REQUEST is not enrolled for the view stream this router rides —
the schema carries ``approval/requested`` as a NOTIFICATION — so the round
trip is notification-in / command-out, which is exactly the pair the
protocol names. The server-request form would be a protocol enrollment
request upstream, never a local interface.
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Literal, Union

from muse_code_msp import (
    ApprovalDecideParams,
    ApprovalRequestParams,
    ApprovalUpdatedParams,
)

from ..connection.connection import Connection

# Every ``approval/decide`` member the guard chain below forwards. Composition
# alone does not stop drift — the chain is hand-listed — so a regenerated
# member reds THIS import (and thus every test) until it is forwarded, exactly
# as the ``MuseClient`` option pins do. ``commandId`` is excluded because the
# connection is the single minter.
_DECIDE_FORWARDED = frozenset(
    {"approvalId", "choiceId", "requirementId", "sessionId", "feedback"}
)
assert _DECIDE_FORWARDED | {"commandId"} == (
    ApprovalDecideParams.__required_keys__ | ApprovalDecideParams.__optional_keys__
), "approval/decide grew a member — forward it through ApprovalRouter"

# The refreshed-request merge in ``ApprovalRouter.updated``, listed by SOURCE:
# stage-scoped members come from the ``approval/updated`` frame, identity
# members from the retained request (stable across the stages of one
# approval). A regenerated member, required or optional, fails this import
# until it is given a side; otherwise it would silently vanish from every
# later stage's request.
_REFRESH_FROM_UPDATE = frozenset(
    {
        "availableChoices",
        "currentRequirementId",
        "sessionId",
        "sourceRange",
        "subagentOrigin",
        "subject",
        "viewCursor",
    }
)
_REFRESH_FROM_REQUEST = frozenset(
    {
        "approvalId",
        "itemId",
        "judgeEscalated",
        "protectedWrite",
        "rawArgs",
        "taskId",
        "toolCallId",
        "toolName",
        "turnId",
    }
)
assert _REFRESH_FROM_UPDATE | _REFRESH_FROM_REQUEST == (
    ApprovalRequestParams.__required_keys__ | ApprovalRequestParams.__optional_keys__
), "approval/requested grew a member — give it a side in ApprovalRouter.updated"


@dataclass(frozen=True)
class ApprovalDecisionInput:
    """What an approval handler answers with: a choice the SERVER offered, and
    optional feedback.

    The governing decision is select-never-create, and this TYPE cannot enforce it —
    ``choiceId`` is a string on the wire — so the router checks the answer
    against the request's own ``availableChoices`` before the frame is built.

    Attributes:
        choice_id: The chosen ``availableChoices`` entry's ``choiceId``.
        feedback: Optional feedback text; omitted from the frame when ``None``.
    """

    choice_id: str
    feedback: str | None = None


ApprovalHandler = Callable[
    [ApprovalRequestParams],
    "ApprovalDecisionInput | Awaitable[ApprovalDecisionInput]",
]
"""The consumer's decision callback. May be sync or async."""


@dataclass(frozen=True)
class UnofferedChoice:
    """The handler picked a ``choiceId`` the request never offered."""

    approval_id: str
    choice_id: str
    available_choice_ids: tuple[str, ...]
    kind: Literal["unofferedChoice"] = "unofferedChoice"


@dataclass(frozen=True)
class HandlerRaised:
    """The consumer's decision handler raised; nothing reached the wire."""

    approval_id: str
    error: BaseException
    kind: Literal["handlerThrew"] = "handlerThrew"


@dataclass(frozen=True)
class SubmitFailed:
    """The ``approval/decide`` round trip itself failed (or there was no
    connection to author it on)."""

    approval_id: str
    error: BaseException
    kind: Literal["submitFailed"] = "submitFailed"


ApprovalFailure = Union[UnofferedChoice, HandlerRaised, SubmitFailed]
"""Why one approval round trip did not complete.

REPORTED, not raised: the trip is driven from a notification, so an exception
would escape into the consumer's pump with nothing to catch it — the same
hazard ``Session.apply`` already refuses a malformed frame for. Each arm names
a DIFFERENT owner (the consumer's handler, the consumer's choice, the host),
because the repair differs.
"""

ApprovalFailureHandler = Callable[[ApprovalFailure], None]
"""Receives each :data:`ApprovalFailure`; its ``kind`` names whose repair it is."""


class ApprovalRouter:
    """Routes folded ``approval/requested`` frames, and ``approval/updated``
    frames that advance a pending approval's stage, to the consumer's handler
    and authors the ``approval/decide`` command."""

    def __init__(self, session_id: str, connection: Connection | None) -> None:
        """Builds the router; ``connection`` is absent on a fold-only session.

        Args:
            session_id: The owning session's id, echoed into every decide.
            connection: The wire seam the decide command authors through.
        """
        self._session_id = session_id
        self._connection = connection
        self._handler: ApprovalHandler | None = None
        self._on_failure: ApprovalFailureHandler | None = None
        # Approval STAGES already decided, keyed by ``approvalId`` +
        # ``requirementId``. Not ``approvalId`` alone: ``requirementId`` is
        # the protocol's multi-stage race guard, so a stage-2 request must get its own
        # decision or the approval pends forever. Not per-request either: a
        # redelivered ``approval/requested`` for the SAME stage must author no
        # second decide, or a two-stage approval races itself. The key is kept
        # on FAILURE too — a genuinely advancing stage brings a new
        # ``requirementId`` and therefore a new key, so "ask the consumer once
        # per stage" holds absolutely.
        self._decided_stages: set[str] = set()
        # Approvals whose own decide ack said ``terminal: true``: the host
        # closed the whole approval, so a trailing stage update names nobody's
        # question.
        self._terminal_approvals: set[str] = set()
        # The decide each approval has on the wire, set when its ack lands.
        # An update read in the same chunk as a ``terminal: true`` ack is
        # folded before that decide resumes, so the update must wait for it.
        self._in_flight: dict[str, asyncio.Event] = {}

    def on_approval(self, handler: ApprovalHandler) -> None:
        """Register the decision callback.

        REPLACES any previous handler rather than adding to a list: two
        handlers would race to decide one approval and only one decision can
        win, so the loser's would be silently discarded.
        """
        self._handler = handler

    def on_approval_error(self, handler: ApprovalFailureHandler) -> None:
        """Observe round trips that did not complete. See :data:`ApprovalFailure`."""
        self._on_failure = handler

    def requested(self, params: ApprovalRequestParams) -> Awaitable[None] | None:
        """An ``approval/requested`` folded. Returns the decision round trip to
        await, or ``None`` when this call schedules nothing — no handler, an
        already-decided stage, or a fold-only session (whose ``SubmitFailed``
        is reported synchronously before returning).

        No handler at all is the supported default posture, NOT a degraded one
        : the client runs under the server's own default-deny, and this
        SDK parks nothing — no queued decision, no synthesized denial, no
        local hold.
        """
        handler = self._handler
        if handler is None:
            return None
        stage = self._stage_key(params)
        if stage in self._decided_stages:
            return None
        # Latched BEFORE anything can yield: a redelivery folded on the very
        # next frame must find the stage already claimed, and an await boundary
        # here would let both pass the check.
        self._decided_stages.add(stage)
        connection = self._connection
        # Checked HERE, synchronously, not inside the coroutine: a fold-only
        # session may apply events with no running loop at all, and a returned
        # coroutine would force ``Session.apply`` to schedule one just to
        # deliver this report. Before the handler
        # runs, deliberately — asking a consumer to decide and then dropping
        # the answer is worse than not asking.
        if connection is None:
            # A plain ``RuntimeError``: constructing fold-only and then
            # registering a decide handler is API misuse, not a protocol STATE
            # a typed error names.
            self._report(
                SubmitFailed(
                    approval_id=params["approvalId"],
                    error=RuntimeError(
                        "approval/decide needs a connection; this Session was "
                        "constructed fold-only"
                    ),
                )
            )
            return None
        return self._decide(connection, params, handler)

    def updated(
        self,
        requested: ApprovalRequestParams,
        params: ApprovalUpdatedParams,
    ) -> Awaitable[None] | None:
        """An ``approval/updated`` folded onto a STILL-PENDING approval.

        A multi-stage approval advances ``currentRequirementId`` through this
        frame alone on the notification plane, so waiting for a re-issued
        ``approval/requested`` would leave the new stage undecided and the turn
        pending. The update carries none of the request's identity members,
        but the fold retains the original request and those members are stable
        across the stages of one approval, so the merged request is honest.
        Routing it through :meth:`requested` reuses the per-stage latch: an
        update naming an already-decided stage authors nothing.
        """
        # ``alreadyTerminal``: the host holds a durable terminal whose resolve
        # frame has not landed yet; a decision against it can only bounce.
        if params["change"]["kind"] == "alreadyTerminal":
            return None
        if requested["approvalId"] in self._terminal_approvals:
            return None
        refreshed: ApprovalRequestParams = {
            "approvalId": requested["approvalId"],
            "availableChoices": params["availableChoices"],
            "currentRequirementId": params["currentRequirementId"],
            "itemId": requested["itemId"],
            "judgeEscalated": requested["judgeEscalated"],
            "protectedWrite": requested["protectedWrite"],
            "rawArgs": requested["rawArgs"],
            "sessionId": params["sessionId"],
            "sourceRange": params["sourceRange"],
            "subject": params["subject"],
            "taskId": requested["taskId"],
            "toolCallId": requested["toolCallId"],
            "toolName": requested["toolName"],
            "turnId": requested["turnId"],
            "viewCursor": params["viewCursor"],
        }
        # Omitted rather than nulled when absent, like ``feedback`` below.
        if "subagentOrigin" in params:
            refreshed["subagentOrigin"] = params["subagentOrigin"]
        acked = self._in_flight.get(requested["approvalId"])
        if acked is not None:
            return self._after_ack(acked, refreshed)
        return self.requested(refreshed)

    async def _after_ack(
        self, acked: asyncio.Event, refreshed: ApprovalRequestParams
    ) -> None:
        await acked.wait()
        if refreshed["approvalId"] in self._terminal_approvals:
            return
        decided = self.requested(refreshed)
        if decided is not None:
            await decided

    @staticmethod
    def _stage_key(params: ApprovalRequestParams) -> str:
        requirement = params["currentRequirementId"]
        return (
            f"{params['approvalId']} "
            f"{requirement['approvalId']}:{requirement['sourceIndex']}"
        )

    async def _decide(
        self,
        connection: Connection,
        params: ApprovalRequestParams,
        handler: ApprovalHandler,
    ) -> None:
        try:
            answered = handler(params)
            decision = (
                await answered if inspect.isawaitable(answered) else answered
            )
            # The reads are INSIDE the try: a malformed return (a handler that
            # forgot its ``return``, a wrong type) is the consumer's callback
            # misbehaving, exactly like a raise — reported as ``handlerThrew``,
            # never escaped into the never-rejecting ``io`` (a prior review
            # round 1).
            choice_id = decision.choice_id
            feedback = decision.feedback
        except Exception as error:  # noqa: BLE001 - the consumer's callback
            self._report(HandlerRaised(approval_id=params["approvalId"], error=error))
            return

        available_choice_ids = tuple(
            choice["choiceId"] for choice in params["availableChoices"]
        )
        if choice_id not in available_choice_ids:
            # Select-never-create, enforced on THIS side of the
            # transport. An invented choice bounces -32052 a round trip later,
            # by which time the stage may have advanced — so the diagnosis a
            # consumer would actually see is a stale-requirement error about a
            # frame it should never have sent.
            self._report(
                UnofferedChoice(
                    approval_id=params["approvalId"],
                    choice_id=choice_id,
                    available_choice_ids=available_choice_ids,
                )
            )
            return

        decide_params: dict[str, Any] = {
            "approvalId": params["approvalId"],
            "choiceId": choice_id,
            # Echoed from the request, never remembered: the protocol makes a stale
            # value a -32053, and the request in hand is the only current
            # statement of it.
            "requirementId": params["currentRequirementId"],
            "sessionId": self._session_id,
        }
        # Omitted rather than nulled: ``feedback`` is valid only on
        # choices with ``acceptsFeedback``, so an explicit null would be
        # rejected by the host.
        if feedback is not None:
            decide_params["feedback"] = feedback

        # The wait covers only this round trip: an update for this approval
        # read before the ack lands waits for it, while a handler still open
        # or a decide that never started blocks nobody.
        approval_id = params["approvalId"]
        acked = asyncio.Event()
        self._in_flight[approval_id] = acked
        try:
            # No explicit ``command_id``: unlike ``send_user_turn``, nothing
            # here needs the id before the ack, so ``Connection.command()``
            # mints and stamps it — and its own same-id retry then reuses that
            # id for free.
            result = await connection.command("approval/decide", decide_params)
            if result.get("terminal") is True:
                self._terminal_approvals.add(approval_id)
        except Exception as error:  # noqa: BLE001 - reported, never escapes
            self._report(SubmitFailed(approval_id=approval_id, error=error))
        finally:
            acked.set()
            if self._in_flight.get(approval_id) is acked:
                del self._in_flight[approval_id]

    def _report(self, failure: ApprovalFailure) -> None:
        handler = self._on_failure
        if handler is None:
            return
        try:
            handler(failure)
        except Exception:  # noqa: BLE001, S110
            # The consumer's failure OBSERVER raised. Swallowed, deliberately:
            # an exception escaping here rides ``SessionApplyOutcome.io``,
            # whose contract is "IT NEVER REJECTS" — and since most consumers
            # never await ``io``, it would surface as an escaping failure in
            # the pump, the exact hazard that contract exists to prevent. The
            # failure itself was already handed to the observer; there is no
            # one left to tell.
            pass
