"""``MuseClient.command`` and ``MuseClient.request`` are the escape hatches
for wire methods the facade does not wrap, experimental ones included. They
send through ``Connection.command()`` (the one ``commandId`` minter and its
same-id retry) and ``Connection.request()``, and refuse, before anything is
written, the methods whose state the facade owns.

Port of ``clients/sdk-ts/test/facade-raw-command.test.ts``. Causal, never
time-based: every wait is a bounded loop-turn pump.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from muse_code import (
    MuseClient,
    MuseClientOptions,
    MuseFacadeOwnedMethodError,
    SyncMuseClient,
    read_session_durability,
)
from muse_code.connection import Connection, MspError, ProtocolError

from helpers_connection import (
    AsyncChunks,
    FakeDuplex,
    answer,
    answer_error,
    frame,
    pump,
    sent_frame,
    sent_params,
    wait_for_writes,
)

DURABLE = read_session_durability({"sessionDurability": "durable"})

# Every method the facade owns, as the issue and the facade sources name them.
FACADE_OWNED = (
    "initialize",
    "session/start",
    "session/resume",
    "turn/start",
    "turn/steer",
    "turn/unqueue",
    "approval/decide",
    "userInput/answer",
    "view/page",
    "view/subscribe",
    "view/unsubscribe",
    # Experimental: the orderly stop close() owns.
    "host/shutdown",
)


def _minted_client() -> "tuple[MuseClient[Any], FakeDuplex, list[str]]":
    transport = FakeDuplex()
    minted: list[str] = []

    def mint() -> str:
        minted.append(f"mint-{len(minted)}")
        return minted[-1]

    connection = Connection(transport, mint_command_id=mint)
    client: MuseClient[Any] = MuseClient(connection, MuseClientOptions(durability=DURABLE))
    return client, transport, minted


@pytest.mark.asyncio
async def test_command_sends_an_unwrapped_method_with_the_minted_command_id() -> None:
    client, transport, minted = _minted_client()

    pending = asyncio.ensure_future(
        client.command("task/stop", {"sessionId": "s-1", "taskId": "t-1"})
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, {"commandId": "mint-0", "status": "accepted"})

    assert await pending == {"commandId": "mint-0", "status": "accepted"}
    assert sent_frame(transport, 0)["method"] == "task/stop"
    assert sent_params(transport, 0) == {
        "sessionId": "s-1",
        "taskId": "t-1",
        "commandId": "mint-0",
    }
    assert minted == ["mint-0"], "the facade mints nothing of its own"


@pytest.mark.asyncio
async def test_command_keeps_the_same_id_retry_on_a_nothing_admitted_refusal() -> None:
    client, transport, minted = _minted_client()
    delays: list[int] = []

    async def retry_delay(attempt: int, error: MspError) -> None:
        delays.append(attempt)

    pending = asyncio.ensure_future(
        client.command(
            "task/stop",
            {"sessionId": "s-1", "taskId": "t-1"},
            retry_delay=retry_delay,
        )
    )
    await wait_for_writes(transport, 1)
    answer_error(
        transport,
        0,
        {"code": -32001, "message": "busy", "data": {"kind": "overloaded", "retryable": True}},
    )
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"commandId": "mint-0", "status": "accepted"})

    await pending
    assert delays == [1]
    assert sent_params(transport, 0)["commandId"] == "mint-0"
    assert sent_params(transport, 1)["commandId"] == "mint-0", "the retry reuses the id"
    assert minted == ["mint-0"]


@pytest.mark.asyncio
async def test_every_facade_owned_method_is_refused_typed_before_anything_is_written() -> None:
    client, transport, _ = _minted_client()
    for method in FACADE_OWNED:
        outcome = asyncio.ensure_future(client.command(method, {}))
        # Checked before awaiting, so a method that is sent fails here instead
        # of waiting on an ack the fake never gives.
        await pump()
        assert transport.writes == [], f"{method} must never reach the wire"
        with pytest.raises(MuseFacadeOwnedMethodError) as excinfo:
            await outcome
        assert excinfo.value.method == method

    # The refusal is per call: the same client still sends an unwrapped method.
    pending = asyncio.ensure_future(
        client.command("task/stop", {"sessionId": "s-1", "taskId": "t-1"})
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, {"commandId": "mint-0", "status": "accepted"})
    await pending


@pytest.mark.asyncio
async def test_a_closed_client_refuses_command_before_anything_is_written() -> None:
    client, transport, _ = _minted_client()
    await client.close()

    with pytest.raises(ProtocolError):
        await client.command("task/stop", {"sessionId": "s-1", "taskId": "t-1"})
    assert transport.writes == []


@pytest.mark.asyncio
async def test_command_sends_an_experimental_method_under_the_callers_command_id() -> None:
    client, transport, minted = _minted_client()

    pending = asyncio.ensure_future(
        client.command(
            "session/setPermissionProfile",
            {"sessionId": "s-1", "profileId": "read-only"},
            command_id="pinned-1",
        )
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, {"commandId": "pinned-1", "status": "accepted"})

    assert await pending == {"commandId": "pinned-1", "status": "accepted"}
    assert sent_frame(transport, 0)["method"] == "session/setPermissionProfile"
    assert sent_params(transport, 0) == {
        "sessionId": "s-1",
        "profileId": "read-only",
        "commandId": "pinned-1",
    }
    assert minted == [], "an override is used instead of minting"


@pytest.mark.asyncio
async def test_request_round_trips_an_experimental_query_with_no_command_id() -> None:
    client, transport, minted = _minted_client()

    pending = asyncio.ensure_future(client.request("permissionProfile/list"))
    await wait_for_writes(transport, 1)
    answer(transport, 0, {"profiles": [{"id": "read-only"}]})

    assert await pending == {"profiles": [{"id": "read-only"}]}
    sent = sent_frame(transport, 0)
    assert sent["method"] == "permissionProfile/list"
    assert "params" not in sent, "omitted params stay off the frame"

    with_params = asyncio.ensure_future(
        client.request("mcpServer/list", {"sessionId": "s-1"})
    )
    await wait_for_writes(transport, 2)
    answer(transport, 1, {"servers": []})
    assert await with_params == {"servers": []}
    assert sent_params(transport, 1) == {"sessionId": "s-1"}, "a request carries no commandId"
    assert minted == [], "a request mints nothing"


@pytest.mark.asyncio
async def test_request_surfaces_the_hosts_error_unchanged_without_retrying() -> None:
    client, transport, _ = _minted_client()

    pending = asyncio.ensure_future(client.request("account/read"))
    await wait_for_writes(transport, 1)
    answer_error(
        transport,
        0,
        {"code": -32001, "message": "busy", "data": {"kind": "overloaded", "retryable": True}},
    )

    with pytest.raises(MspError) as excinfo:
        await pending
    assert excinfo.value.kind == "overloaded"
    await pump()
    assert len(transport.writes) == 1, "Connection.request does not retry"


@pytest.mark.asyncio
async def test_every_facade_owned_method_is_refused_by_request_before_anything_is_written() -> None:
    client, transport, _ = _minted_client()
    for method in FACADE_OWNED:
        outcome = asyncio.ensure_future(client.request(method))
        await pump()
        assert transport.writes == [], f"{method} must never reach the wire"
        with pytest.raises(MuseFacadeOwnedMethodError) as excinfo:
            await outcome
        assert excinfo.value.method == method

    # The refusal is per call: the same client still sends an unwrapped query.
    pending = asyncio.ensure_future(client.request("permissionProfile/list"))
    await wait_for_writes(transport, 1)
    answer(transport, 0, {"profiles": []})
    await pending


@pytest.mark.asyncio
async def test_a_closed_client_refuses_request_before_anything_is_written() -> None:
    client, transport, _ = _minted_client()
    await client.close()

    with pytest.raises(ProtocolError):
        await client.request("permissionProfile/list")
    assert transport.writes == []


def test_the_sync_twin_refuses_facade_owned_methods_before_anything_is_written() -> None:
    transport = FakeDuplex()

    async def factory() -> MuseClient[Any]:
        return MuseClient(Connection(transport), MuseClientOptions(durability=DURABLE))

    client: SyncMuseClient[Any] = SyncMuseClient.create(factory)
    try:
        with pytest.raises(MuseFacadeOwnedMethodError):
            client.command("turn/start", {"sessionId": "s-1"})
        with pytest.raises(MuseFacadeOwnedMethodError):
            client.request("view/page", {"sessionId": "s-1"})
        assert transport.writes == []
    finally:
        client.close()


class _EchoHost:
    """Answers each request from inside ``write`` with its method and params
    (the sync loop is parked in the blocking call, so frames cannot be fed
    from outside), echoing a ``commandId`` the way a command ack does."""

    def __init__(self) -> None:
        self.chunks = AsyncChunks()
        self.writes: list[str] = []

    @property
    def incoming(self) -> Any:
        return self.chunks

    async def write(self, chunk: str) -> None:
        self.writes.append(chunk)
        sent = json.loads(chunk)
        params = sent.get("params") or {}
        result: dict[str, Any] = {"echoed": sent["method"]}
        if "commandId" in params:
            result["commandId"] = params["commandId"]
        self.chunks.push(frame({"jsonrpc": "2.0", "id": sent["id"], "result": result}))

    async def close(self, flushed: object = None) -> None:
        if flushed is not None and hasattr(flushed, "__await__"):
            await flushed  # type: ignore[arg-type]
        self.chunks.end()


def test_the_sync_twins_round_trip_request_and_command() -> None:
    host = _EchoHost()

    async def factory() -> MuseClient[Any]:
        connection = Connection(host, mint_command_id=lambda: "mint-0")  # type: ignore[arg-type]
        return MuseClient(connection, MuseClientOptions(durability=DURABLE))

    client: SyncMuseClient[Any] = SyncMuseClient.create(factory)
    try:
        assert client.request("mcpServer/list", {"sessionId": "s-1"}) == {
            "echoed": "mcpServer/list"
        }
        assert client.request("permissionProfile/list") == {
            "echoed": "permissionProfile/list"
        }
        assert client.command("session/setPermissionProfile", {"sessionId": "s-1"}) == {
            "echoed": "session/setPermissionProfile",
            "commandId": "mint-0",
        }
    finally:
        client.close()

    sent = [json.loads(chunk) for chunk in host.writes]
    assert sent[0]["params"] == {"sessionId": "s-1"}, "params forwarded, no commandId"
    assert "params" not in sent[1], "omitted params stay off the frame"
    assert sent[2]["params"] == {"sessionId": "s-1", "commandId": "mint-0"}
