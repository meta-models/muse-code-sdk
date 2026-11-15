"""The applied-tools verification arm: a caller that spells
``config["allowedBuiltInTools"]`` can prove the host echoed the
post-intersection set, and the check fails loudly -- never silently --
when the echo is absent or still names an excluded tool.

The spelling itself rides the stable-typed ``config`` field verbatim:
``_forward_config`` returns a config naming no MCP server unchanged, so
an experimental ``allowedBuiltInTools`` member reaches ``session/start``
and ``session/resume`` exactly as spelled, and the host -- not the
client -- owns the shape check. The echo is read structurally from the
opening result, like the permission-profile proof reads
``session.permissionState``: the stable result types strip the
experimental member.

Causal, never time-based: every wait is ``wait_for_writes`` / ``pump``.
The mocked host here stands in for a P8 host only for the echo-present
arms; a pre-P8 host serves no echo, which is exactly the absent-echo
arm below.
"""

from __future__ import annotations

import asyncio
from typing import Any, cast

import pytest

from muse_code import (
    AppliedBuiltInToolsNotApplied,
    MuseClient,
    MuseClientOptions,
    ResumeSessionOptions,
    StartSessionOptions,
    read_session_durability,
    verify_applied_built_in_tools,
)
from muse_code.connection import Connection
from muse_code_msp import SessionConfig
from muse_code_msp.experimental import (
    SessionConfig as ExperimentalSessionConfig,
)

from helpers_connection import (
    FakeDuplex,
    answer,
    pump,
    sent_params,
    wait_for_writes,
)

Params = dict[str, Any]

ALLOWED = ["read", "search", "edit"]


def _client() -> tuple[MuseClient[Any], FakeDuplex]:
    transport = FakeDuplex()
    client: MuseClient[Any] = MuseClient(
        Connection(transport),
        MuseClientOptions(
            durability=read_session_durability({"sessionDurability": "durable"})
        ),
    )
    return client, transport


def _config(allowed: list[str]) -> SessionConfig:
    # The documented spelling: type the dict with the experimental
    # SessionConfig, cast at the stable-typed facade boundary. The cast
    # is the opt-in; graduation would remove it.
    experimental: ExperimentalSessionConfig = {"allowedBuiltInTools": allowed}
    return cast(SessionConfig, experimental)


def _start_result(session_id: str, applied: Any = ...) -> Params:
    result: Params = {"session": {"sessionId": session_id, "status": "idle"}, "viewCursor": "v:1"}
    if applied is not ...:
        result["appliedBuiltInTools"] = applied
    return result


def _resume_result(session_id: str, applied: Any = ...) -> Params:
    result: Params = {
        "history": {"mode": "none", "items": []},
        "pendingRequests": [],
        "session": {"sessionId": session_id, "status": "idle"},
        "viewCursor": "v:2",
    }
    if applied is not ...:
        result["appliedBuiltInTools"] = applied
    return result


async def _start(
    client: MuseClient[Any], transport: FakeDuplex, result: Params, index: int = 0
) -> Any:
    pending = asyncio.ensure_future(
        client.start_session(
            StartSessionOptions(workspace_root="/w", config=_config(ALLOWED))
        )
    )
    await wait_for_writes(transport, index + 1)
    answer(transport, index, result)
    session = await pending
    await pump()
    return session


@pytest.mark.asyncio
async def test_config_spelling_allowed_tools_reaches_session_start_verbatim() -> None:
    client, transport = _client()
    session = await _start(client, transport, _start_result("s-1", ["read"]))
    assert sent_params(transport, 0)["config"] == {"allowedBuiltInTools": ALLOWED}
    assert verify_applied_built_in_tools(session.opening, ALLOWED) == ["read"]
    await client.close()


@pytest.mark.asyncio
async def test_config_spelling_reaches_session_resume_verbatim() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.resume_session(
            ResumeSessionOptions(session_id="s-2", config=_config(ALLOWED))
        )
    )
    await wait_for_writes(transport, 1)
    assert sent_params(transport, 0)["config"] == {"allowedBuiltInTools": ALLOWED}
    answer(transport, 0, _resume_result("s-2", ["read", "search"]))
    session = await pending
    await pump()
    assert verify_applied_built_in_tools(session.opening, ALLOWED) == [
        "read",
        "search",
    ]
    await client.close()


@pytest.mark.asyncio
async def test_echo_absent_fails_as_unapplied_and_the_session_still_opens() -> None:
    client, transport = _client()
    # No echo: the pre-P8 answer. The open itself succeeds -- verification
    # is opt-in, so the failure lands in the helper, never silently.
    session = await _start(client, transport, _start_result("s-1"))
    with pytest.raises(AppliedBuiltInToolsNotApplied) as refused:
        verify_applied_built_in_tools(session.opening, ALLOWED)
    assert refused.value.requested == ALLOWED
    assert refused.value.applied is None
    assert refused.value.session_id == "s-1"
    await client.close()


@pytest.mark.asyncio
async def test_echo_containing_an_excluded_tool_fails() -> None:
    client, transport = _client()
    session = await _start(client, transport, _start_result("s-1", ["read", "workflow"]))
    with pytest.raises(AppliedBuiltInToolsNotApplied) as refused:
        verify_applied_built_in_tools(session.opening, ALLOWED)
    assert refused.value.applied == ["read", "workflow"]
    assert refused.value.session_id == "s-1"
    await client.close()


@pytest.mark.asyncio
async def test_echo_subset_of_requested_passes() -> None:
    # The host intersects with the tools it serves; a strict subset is a
    # pass, never a mismatch.
    client, transport = _client()
    session = await _start(client, transport, _start_result("s-1", ["read"]))
    assert verify_applied_built_in_tools(session.opening, ALLOWED) == ["read"]
    await client.close()


@pytest.mark.asyncio
async def test_no_config_spelled_is_a_no_op() -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(StartSessionOptions(workspace_root="/w"))
    )
    await wait_for_writes(transport, 1)
    assert "config" not in sent_params(transport, 0)
    answer(transport, 0, _start_result("s-1"))
    session = await pending
    await pump()
    assert session.session_id == "s-1"
    await client.close()


@pytest.mark.asyncio
async def test_malformed_echo_fails_as_unapplied() -> None:
    client, transport = _client()
    session = await _start(client, transport, _start_result("s-1", "read"))
    with pytest.raises(AppliedBuiltInToolsNotApplied) as refused:
        verify_applied_built_in_tools(session.opening, ALLOWED)
    assert refused.value.applied is None
    session = await _start(client, transport, _start_result("s-1", ["read", ""]), index=1)
    with pytest.raises(AppliedBuiltInToolsNotApplied) as refused:
        verify_applied_built_in_tools(session.opening, ALLOWED)
    assert refused.value.applied is None
    await client.close()


def test_blank_requested_name_is_a_usage_error() -> None:
    with pytest.raises(ValueError, match="non-empty strings"):
        verify_applied_built_in_tools(None, [""])
    # No opening at all cannot prove anything either.
    with pytest.raises(AppliedBuiltInToolsNotApplied) as refused:
        verify_applied_built_in_tools(None, ALLOWED)
    assert refused.value.applied is None
    assert refused.value.session_id is None


@pytest.mark.asyncio
async def test_empty_request_passes_only_on_an_empty_echo() -> None:
    client, transport = _client()
    session = await _start(client, transport, _start_result("s-1", []))
    assert verify_applied_built_in_tools(session.opening, []) == []
    session = await _start(client, transport, _start_result("s-1", ["workflow"]), index=1)
    with pytest.raises(AppliedBuiltInToolsNotApplied):
        verify_applied_built_in_tools(session.opening, [])
    await client.close()
