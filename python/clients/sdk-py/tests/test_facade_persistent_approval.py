"""Spec 638 FR-638-019b: server-offered choices and idempotent submission.

TEST-33067-8 / FR-33067-9 refers forward to the spec 287 amendment in #33166.
Policy-store persistence is proved separately by #33166.
"""
from __future__ import annotations

from typing import Any

import pytest

from muse_code import Session, read_session_durability
from muse_code.connection import Connection
from muse_code.facade import ApprovalDecisionInput, ApprovalFailure
from helpers_connection import (
    FakeDuplex, answer, pump, sent_frame, sent_params, settled_io, wait_for_writes,
)

Params = dict[str, Any]
TARGETS = [
    pytest.param(
        "allow_local_mcp_tool", "Always allow this MCP tool", "tool `mcp__docs__echo`",
        "mcp__docs__echo", {"kind": "tool", "toolName": "mcp__docs__echo"}, id="mcp",
    ),
    pytest.param(
        "allow_local_network", "Always allow this network destination",
        "example.com:443 (https)", "network",
        {"kind": "network", "host": "example.com", "port": 443, "protocol": "https"},
        id="network",
    ),
]
TARGET_PARAMS = "local_id,label,preview,tool_name,subject"


def fixture(
    local_id: str, label: str, preview: str, tool_name: str, subject: Params,
    offer_local: bool = True,
) -> tuple[Connection, FakeDuplex, Session[str], list[str], Params]:
    transport = FakeDuplex()
    minted: list[str] = []

    def mint() -> str:
        minted.append(f"mint-{len(minted)}")
        return minted[-1]

    connection = Connection(transport, mint_command_id=mint)
    session: Session[str] = Session(
        "s-1", read_session_durability({"sessionDurability": "durable"}), connection=connection,
    )
    choices: list[Params] = [
        {"choiceId": "allow_once", "decision": "approved", "label": "Allow once", "scope": "once"},
        {"choiceId": "allow_session", "decision": "approvedForSession",
         "label": "Allow for this session", "scope": "session", "rulePreview": preview},
    ]
    if offer_local:
        choices.append({
            "choiceId": local_id, "decision": "approvedPolicyAmendment",
            "label": label, "scope": "localPersistent", "rulePreview": preview,
        })
    choices.append({"choiceId": "abort", "decision": "abort", "label": "Reject", "scope": "once"})
    request: Params = {"method": "approval/requested", "params": {
        "approvalId": "a-1", "availableChoices": choices,
        "currentRequirementId": {"approvalId": "a-1", "sourceIndex": 0},
        "itemId": "i-1", "judgeEscalated": False, "protectedWrite": False, "rawArgs": "{}",
        "sessionId": "s-1", "subject": subject, "taskId": "task-1",
        "toolCallId": "call-1", "toolName": tool_name, "turnId": "turn-1", "viewCursor": "v:1",
        "sourceRange": {
            "first": {"id": "e-1", "sequence": 1}, "last": {"id": "e-1", "sequence": 1},
            "stream": {"id": "str-1", "kind": "session"},
        },
    }}
    return connection, transport, session, minted, request


@pytest.mark.asyncio
@pytest.mark.parametrize(TARGET_PARAMS, TARGETS)
@pytest.mark.parametrize("select_local", [False, True], ids=["session", "local"])
async def test_persistent_menu_choice_submits_once(
    local_id: str, label: str, preview: str, tool_name: str, subject: Params, select_local: bool,
) -> None:
    connection, transport, session, minted, request = fixture(local_id, label, preview, tool_name, subject)
    choice_id = local_id if select_local else "allow_session"
    seen: list[Params] = []
    failures: list[ApprovalFailure] = []

    def handler(offered: Any) -> ApprovalDecisionInput:
        seen.append(dict(offered))
        return ApprovalDecisionInput(choice_id=choice_id)

    session.on_approval(handler)
    session.on_approval_error(failures.append)
    try:
        first = session.apply(request)
        in_flight_redelivery = session.apply(request)
        await wait_for_writes(transport, 1)
        assert sent_frame(transport, 0)["method"] == "approval/decide"
        assert sent_params(transport, 0) == {
            "approvalId": "a-1", "commandId": "mint-0", "choiceId": choice_id,
            "requirementId": request["params"]["currentRequirementId"], "sessionId": "s-1",
        }
        assert [offered["availableChoices"] for offered in seen] == [request["params"]["availableChoices"]]
        answer(transport, 0, {
            "approvalId": "a-1", "commandId": "mint-0", "status": "accepted", "terminal": True,
        })
        await settled_io(first.io)
        await settled_io(in_flight_redelivery.io)
        await settled_io(session.apply(request).io)
        await pump()
        assert len(transport.writes) == 1
        assert len(seen) == 1
        assert minted == ["mint-0"]
        assert failures == []
        # The acknowledgement does not claim the rule was saved or resolve the view.
        assert len(session.fold.pending_approvals()) == 1
    finally:
        await connection.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(TARGET_PARAMS, TARGETS)
async def test_unoffered_persistent_choice_is_refused_before_submission(
    local_id: str, label: str, preview: str, tool_name: str, subject: Params,
) -> None:
    connection, transport, session, minted, request = fixture(
        local_id, label, preview, tool_name, subject, offer_local=False,
    )
    failures: list[ApprovalFailure] = []
    session.on_approval_error(failures.append)
    session.on_approval(lambda _request: ApprovalDecisionInput(choice_id=local_id))
    try:
        await settled_io(session.apply(request).io)
        await pump()
        assert transport.writes == []
        assert minted == []
        assert len(failures) == 1
        failure = failures[0]
        assert failure.kind == "unofferedChoice"
        assert failure.approval_id == "a-1"
        assert failure.choice_id == local_id
        assert failure.available_choice_ids == ("allow_once", "allow_session", "abort")
    finally:
        await connection.close()
