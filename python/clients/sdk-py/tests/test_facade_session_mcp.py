"""``spawn`` requests ``sessionMcp``, and ``start_session`` and
``resume_session`` forward ``config`` (per-session MCP servers) only when the
host granted it in the handshake. A ``config`` naming servers on a connection without that grant is
refused, typed, before anything is sent; the refusal covers only that open, so
the same client keeps opening sessions without servers. As on the host, a
``config`` naming no server needs no grant.

Port of ``clients/sdk-ts/test/facade-session-mcp.test.ts``: transcript-level
proof against a throwaway ``python -c`` host: what the facade sends, never
that a live host started the servers.
"""

from __future__ import annotations

import asyncio
import json
import sys
from typing import Any, Sequence

import pytest

from muse_code import (
    EXPECTED_SCHEMA_FINGERPRINT,
    MuseCapabilityNotGrantedError,
    MuseClient,
    MuseClientOptions,
    MuseClientSpawnOptions,
    ResumeSessionOptions,
    StartSessionOptions,
    read_session_durability,
)
from muse_code.connection import Connection
from muse_code_msp import SessionConfig

from helpers_connection import FakeDuplex, pump
from helpers_host_lifetime import FAILURE_CAP_S

CLIENT_INFO: Any = {"name": "sdk_test", "version": "0.0.0"}

CONFIG: SessionConfig = {
    "mcpServers": {
        "docs": {"transport": "stdio", "command": "docs-mcp", "args": ["--stdio"]},
        "search": {"transport": "streamableHttp", "url": "https://example.invalid/mcp"},
    }
}


def _inline_host(offers: Sequence[str]) -> str:
    """A host that, like a real one, grants only what the client requested
    among the capabilities it ``offers`` (an empty offer is a host with
    per-session MCP turned off). Opens echo the params they received, and
    ``session/list`` reports the ``initialize`` request's capabilities and
    every method received after it."""
    initialize_result = {
        "experimentalApi": False,
        "grantedCapabilities": [],
        "museHome": "/nonexistent",
        "platformFamily": "unix",
        "platformOs": "linux",
        "schema": {"fingerprint": EXPECTED_SCHEMA_FINGERPRINT, "version": 1},
        "serverInfo": {"name": "inline", "version": "0.0.0"},
        "sessionDurability": "durable",
        "userAgent": "inline-host/0.0.0",
    }
    return (
        "import json, sys\n"
        f"INIT = json.loads({json.dumps(initialize_result)!r})\n"
        f"OFFERS = {list(offers)!r}\n"
        "received = []\n"
        "requested = []\n"
        "capabilities = None\n"
        "def send(m):\n"
        "    sys.stdout.write(json.dumps(m) + '\\n'); sys.stdout.flush()\n"
        "for line in sys.stdin:\n"
        "    frame = json.loads(line)\n"
        "    if 'id' not in frame:\n"
        "        continue\n"
        "    if frame['method'] == 'initialize':\n"
        "        capabilities = frame['params'].get('capabilities')\n"
        "        caps = capabilities or {}\n"
        "        requested = list(caps.get('requestedCapabilities') or [])\n"
        "        INIT['grantedCapabilities'] = [c for c in requested if c in OFFERS]\n"
        "        send({'jsonrpc': '2.0', 'id': frame['id'], 'result': INIT})\n"
        "        continue\n"
        "    received.append(frame['method'])\n"
        "    if frame['method'] == 'session/list':\n"
        "        send({'jsonrpc': '2.0', 'id': frame['id'],"
        " 'result': {'sessions': [], 'received': received, 'requested': requested,"
        " 'capabilities': capabilities}})\n"
        "        continue\n"
        "    session_id = frame['params'].get('sessionId', 's-1')\n"
        "    send({'jsonrpc': '2.0', 'id': frame['id'], 'result': {\n"
        "        'session': {'sessionId': session_id, 'status': 'idle'},\n"
        "        'viewCursor': 'c-0', 'history': {'mode': 'none', 'items': []},\n"
        "        'pendingRequests': [], 'echoed': frame['params']}})\n"
    )


async def _spawn_offering(
    offers: Sequence[str], capabilities: Any = None
) -> MuseClient[Any]:
    # A default spawn unless ``capabilities`` is given: the caller requests
    # nothing itself.
    return await asyncio.wait_for(
        MuseClient.spawn(
            MuseClientSpawnOptions(
                muse_bin=sys.executable,
                args=["-c", _inline_host(offers)],
                client_info=CLIENT_INFO,
                capabilities=capabilities,
            )
        ),
        FAILURE_CAP_S,
    )


def _echoed(session: Any) -> dict[str, Any]:
    return dict(session.opening.result["echoed"])


async def _host_view(client: MuseClient[Any]) -> Any:
    return await client.list_sessions()


async def _received(client: MuseClient[Any]) -> list[str]:
    listed = await _host_view(client)
    return [method for method in listed["received"] if method != "session/list"]


@pytest.mark.asyncio
async def test_spawn_requests_session_mcp_and_keeps_the_callers_requests_and_posture() -> None:
    posture = {
        "experimentalApi": True,
        "optOutNotificationMethods": ["item/delta"],
        "userInputDialogs": True,
    }
    client = await _spawn_offering(
        ["userShell", "sessionMcp"],
        {**posture, "requestedCapabilities": ["userShell", "sessionMcp", "userShell"]},
    )
    try:
        assert (await _host_view(client))["capabilities"] == {
            **posture,
            "requestedCapabilities": ["userShell", "sessionMcp"],
        }
        assert client.initialize_result["grantedCapabilities"] == ["userShell", "sessionMcp"]
    finally:
        await asyncio.wait_for(client.close(), FAILURE_CAP_S)


@pytest.mark.asyncio
async def test_a_default_spawn_on_a_host_offering_session_mcp_forwards_config_verbatim() -> None:
    client = await _spawn_offering(["sessionMcp"])
    try:
        assert (await _host_view(client))["requested"] == ["sessionMcp"]
        started = await client.start_session(
            StartSessionOptions(workspace_root="/w", config=CONFIG)
        )
        assert _echoed(started)["config"] == CONFIG

        resumed = await client.resume_session(
            ResumeSessionOptions(session_id="s-2", config=CONFIG)
        )
        assert _echoed(resumed)["config"] == CONFIG
    finally:
        await asyncio.wait_for(client.close(), FAILURE_CAP_S)


@pytest.mark.asyncio
async def test_a_host_withholding_session_mcp_gets_no_server_config_and_the_client_stays_usable() -> None:
    client = await _spawn_offering([])
    try:
        with pytest.raises(MuseCapabilityNotGrantedError) as started:
            await client.start_session(StartSessionOptions(workspace_root="/w", config=CONFIG))
        assert started.value.capability == "sessionMcp"
        assert started.value.method == "session/start"
        with pytest.raises(MuseCapabilityNotGrantedError) as resumed:
            await client.resume_session(ResumeSessionOptions(session_id="s-2", config=CONFIG))
        assert resumed.value.capability == "sessionMcp"
        assert resumed.value.method == "session/resume"
        assert await _received(client) == [], "neither refused open reached the wire"

        # Only the config-bearing open is refused. The same
        # client opens without servers, and a config naming none needs no grant.
        plain = await client.start_session(StartSessionOptions(workspace_root="/w"))
        assert "config" not in _echoed(plain)
        empty = await client.start_session(
            StartSessionOptions(workspace_root="/w", config={"mcpServers": {}})
        )
        assert _echoed(empty)["config"] == {"mcpServers": {}}
        assert await _received(client) == ["session/start", "session/start"]
    finally:
        await asyncio.wait_for(client.close(), FAILURE_CAP_S)


@pytest.mark.asyncio
async def test_the_refusal_names_the_method_it_refused() -> None:
    # A client built around a caller's own connection has no handshake on
    # record, so it cannot show the grant and refuses the same way.
    transport = FakeDuplex()
    client: MuseClient[Any] = MuseClient(
        Connection(transport),
        MuseClientOptions(durability=read_session_durability({"sessionDurability": "durable"})),
    )

    with pytest.raises(MuseCapabilityNotGrantedError) as excinfo:
        await client.resume_session(ResumeSessionOptions(session_id="s-2", config=CONFIG))
    assert excinfo.value.method == "session/resume"
    assert "sessionMcp" in str(excinfo.value)
    await pump()
    assert transport.writes == []
