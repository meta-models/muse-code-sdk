"""An explicit ``data.retryable: false`` on the auto-retried
nothing-admitted pair (``-32001 overloaded``, ``-32031 backpressured``) stops
the same-``commandId`` retry.

The MSP ``ErrorData`` contract says a present ``retryable`` overrides the
error table default for the code. The absent-flag case is the paired control:
it differs only in the flag and must still retry, so the retried set and the
attempt budget are unchanged.
"""

from __future__ import annotations

import json

import pytest

from muse_code.connection import Connection, MspError

from helpers_connection import FakeDuplex, frame, wait_for_writes

PAIR = [(-32001, "overloaded"), (-32031, "backpressured")]


@pytest.mark.asyncio
@pytest.mark.parametrize(("code", "kind"), PAIR)
async def test_an_explicit_retryable_false_is_not_auto_retried(code: int, kind: str) -> None:
    transport = FakeDuplex()
    connection = Connection(transport)

    async def must_not_wait(_attempt: int, _error: MspError) -> None:
        # Fails at the first scheduled retry, so the RED is bounded: a retry
        # would otherwise wait forever for a second answer.
        pytest.fail("an explicit retryable false must never schedule a retry")

    command = connection.command(
        "turn/start", {"n": 1}, max_attempts=3, retry_delay=must_not_wait
    )
    await wait_for_writes(transport, 1)
    sent = json.loads(transport.writes[0])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": sent["id"],
                "error": {
                    "code": code,
                    "message": "refused",
                    "data": {"kind": kind, "retryable": False},
                },
            }
        )
    )
    with pytest.raises(MspError) as excinfo:
        await command
    assert excinfo.value.code == code
    assert excinfo.value.kind == kind
    assert excinfo.value.retryable is False, "the parsed error keeps the explicit flag"
    assert len(transport.writes) == 1, "no second submission was sent"
    await connection.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(("code", "kind"), PAIR)
async def test_an_absent_retryable_flag_still_retries(code: int, kind: str) -> None:
    transport = FakeDuplex()
    connection = Connection(transport)

    async def no_sleep(_attempt: int, _error: MspError) -> None:
        return None

    command = connection.command(
        "turn/start", {"n": 1}, max_attempts=2, retry_delay=no_sleep
    )
    await wait_for_writes(transport, 1)
    first = json.loads(transport.writes[0])
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": first["id"],
                "error": {"code": code, "message": "busy", "data": {"kind": kind}},
            }
        )
    )
    await wait_for_writes(transport, 2)
    retry = json.loads(transport.writes[1])
    assert retry["params"]["commandId"] == first["params"]["commandId"]
    ack = {"commandId": retry["params"]["commandId"], "status": "accepted"}
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": retry["id"], "result": ack}))
    assert await command == ack
    await connection.close()
