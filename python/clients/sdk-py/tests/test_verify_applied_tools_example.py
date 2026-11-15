"""The worked example's verify step, against a mocked host: the echo
arms the example promises, without a live host (a pre-P8 host serves
no echo, which is the absent-echo arm)."""

from __future__ import annotations

import asyncio
import runpy
from pathlib import Path
from typing import Any

import pytest

from muse_code import (
    AppliedBuiltInToolsNotApplied,
    MuseClient,
    MuseClientOptions,
    read_session_durability,
)
from muse_code.connection import Connection

from helpers_connection import FakeDuplex, answer, pump, wait_for_writes

EXAMPLE = Path(__file__).parents[1] / "examples" / "verify_applied_tools.py"


@pytest.fixture
def verify_session() -> Any:
    return runpy.run_path(str(EXAMPLE))["verify_session"]


def _client() -> tuple[MuseClient[Any], FakeDuplex]:
    transport = FakeDuplex()
    client: MuseClient[Any] = MuseClient(
        Connection(transport),
        MuseClientOptions(
            durability=read_session_durability({"sessionDurability": "durable"})
        ),
    )
    return client, transport


@pytest.mark.asyncio
async def test_example_returns_the_echo_without_workflow(verify_session: Any) -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        verify_session(client, "/w", ["read", "search"])
    )
    await wait_for_writes(transport, 1)
    answer(
        transport,
        0,
        {
            "session": {"sessionId": "s-1", "status": "idle"},
            "viewCursor": "v:1",
            "appliedBuiltInTools": ["read"],
        },
    )
    assert await pending == ["read"]
    await pump()
    await client.close()


@pytest.mark.asyncio
async def test_example_fails_loudly_on_an_absent_echo(verify_session: Any) -> None:
    client, transport = _client()
    pending = asyncio.ensure_future(
        verify_session(client, "/w", ["read", "search"])
    )
    await wait_for_writes(transport, 1)
    answer(
        transport,
        0,
        {"session": {"sessionId": "s-1", "status": "idle"}, "viewCursor": "v:1"},
    )
    with pytest.raises(AppliedBuiltInToolsNotApplied):
        await pending
    await pump()
    await client.close()
