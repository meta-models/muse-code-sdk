"""``MuseClient.command`` is the escape hatch for wire methods the
facade does not wrap. It sends through ``Connection.command()`` (the one
``commandId`` minter and its same-id retry), and refuses, before anything is
written, the methods whose state the facade owns.

Port of ``clients/sdk-ts/test/facade-raw-command.test.ts``. Causal, never
time-based: every wait is a bounded loop-turn pump.
"""

from __future__ import annotations

import asyncio
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
    FakeDuplex,
    answer,
    answer_error,
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


def test_the_sync_twin_refuses_facade_owned_methods_before_anything_is_written() -> None:
    transport = FakeDuplex()

    async def factory() -> MuseClient[Any]:
        return MuseClient(Connection(transport), MuseClientOptions(durability=DURABLE))

    client: SyncMuseClient[Any] = SyncMuseClient.create(factory)
    try:
        with pytest.raises(MuseFacadeOwnedMethodError):
            client.command("turn/start", {"sessionId": "s-1"})
        assert transport.writes == []
    finally:
        client.close()
