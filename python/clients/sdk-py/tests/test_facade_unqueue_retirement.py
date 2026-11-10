"""Under ``MuseClient``, ``turn.unqueue()`` hands back this session's reclaim
whatever order the ack and ``turn/unqueued`` arrive in.

A host routinely writes the ``turn/unqueue`` ack and the ``turn/unqueued``
notification in one read. The connection resolves the ack's future, but the
awaiting ``unqueue()`` resumes only after the whole read is dispatched, so
``MuseClient``'s pump folds ``turn/unqueued`` through ``Session.apply`` first.
The fold retires the queued entry and returns the retirement, and the pump has
nobody to hand it to: before the fix ``unqueue()`` then found no entry and the
app lost the queued input.

Port of ``clients/sdk-ts/test/facade-unqueue-retirement.test.ts``. Causal,
never time-based: the fake-duplex arms wait on a bounded loop-turn pump, and
the fixture arm on the host's own replies.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Awaitable, TypeVar

import pytest

import muse_code
from muse_code import (
    MuseClient,
    MuseClientOptions,
    SendUserTurnOptions,
    Session,
    StartSessionOptions,
    Turn,
    read_session_durability,
)
from muse_code.connection import Connection
from muse_code.connection.spawn import spawn_msp_connection
from muse_code.pending import COMMAND_REJECTED_CODE, COMMAND_REJECTED_KIND, ReclaimedRetirement
from muse_code.replay import load_transcript

from helpers_connection import FakeDuplex, frame, pump, sent_frame, sent_params, wait_for_writes
from helpers_host_lifetime import fixture_host_bin

Params = dict[str, Any]
_T = TypeVar("_T")

SESSION = "s-1"
QUEUED_TURN = "t-2"
QUEUED_INPUT = "queued draft"
SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": SESSION, "kind": "session"},
}
DURABLE = read_session_durability({"sessionDurability": "durable"})


def _reply(transport: FakeDuplex, index: int, result: Params) -> str:
    command_id = sent_params(transport, index)["commandId"]
    return frame(
        {"jsonrpc": "2.0", "id": sent_frame(transport, index)["id"], "result": {**result, "commandId": command_id}}
    )


def _unqueued(command_id: str) -> str:
    return frame(
        {
            "jsonrpc": "2.0",
            "method": "turn/unqueued",
            "params": {
                "commandId": command_id,
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "turnId": QUEUED_TURN,
                "viewCursor": "v:9",
            },
        }
    )


async def _client_queued_turn() -> "tuple[MuseClient[str], Session[str], FakeDuplex, Turn[str], str]":
    # A MuseClient-opened session holding one acked queued submit, so every
    # view frame below reaches the session through the client's real router.
    transport = FakeDuplex()
    minted = iter(f"mint-{n}" for n in range(1000))
    client: MuseClient[str] = MuseClient(
        Connection(transport, mint_command_id=lambda: next(minted)), MuseClientOptions(durability=DURABLE)
    )
    opening = asyncio.ensure_future(client.start_session(StartSessionOptions()))
    await wait_for_writes(transport, 1)
    transport.incoming.push(_reply(transport, 0, {"session": {"sessionId": SESSION, "status": "idle"}, "viewCursor": "v:1"}))
    session = await opening
    submitting = asyncio.ensure_future(
        session.send_user_turn(SendUserTurnOptions(input=[{"type": "text", "text": "q"}], composer_input=QUEUED_INPUT))
    )
    await wait_for_writes(transport, 2)
    queued_command_id = sent_params(transport, 1)["commandId"]
    transport.incoming.push(
        _reply(transport, 1, {"disposition": "queued", "startedNewTurn": True, "status": "accepted", "turnId": QUEUED_TURN})
    )
    return client, session, transport, await submitting, queued_command_id


@pytest.mark.asyncio
@pytest.mark.parametrize("ack_first", [True, False], ids=["ack-then-unqueued", "unqueued-then-ack"])
async def test_unqueue_returns_the_reclaim_the_router_folded_in_the_same_read(ack_first: bool) -> None:
    client, session, transport, turn, queued_command_id = await _client_queued_turn()
    unqueuing = asyncio.ensure_future(turn.unqueue())
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "turn/unqueue"
    ack = _reply(transport, 2, {"status": "accepted", "turnId": QUEUED_TURN})
    # ONE read: the router folds turn/unqueued before the ack's await resumes.
    transport.incoming.push(ack + _unqueued(queued_command_id) if ack_first else _unqueued(queued_command_id) + ack)
    outcome = await unqueuing
    assert outcome.ack["status"] == "accepted"
    assert outcome.retirement == ReclaimedRetirement(command_id=queued_command_id, input=QUEUED_INPUT), (
        "the queued input comes back from unqueue()"
    )
    assert not session.pending.has(queued_command_id), "the entry retired exactly once"
    assert (await turn.completed).kind == "unqueued"
    await client.close()


@pytest.mark.asyncio
async def test_a_reclaim_held_for_a_refused_unqueue_is_dropped() -> None:
    # Bounded memory: the held reclaim lives only while its own unqueue is in
    # flight. The refusal settles that call, so the hold goes with it and a
    # later unqueue of the same turn cannot hand the reclaim out a second time.
    client, session, transport, turn, queued_command_id = await _client_queued_turn()
    refused = asyncio.ensure_future(turn.unqueue())
    await wait_for_writes(transport, 3)
    rejection = frame(
        {
            "jsonrpc": "2.0",
            "id": sent_frame(transport, 2)["id"],
            "error": {
                "code": COMMAND_REJECTED_CODE,
                "message": "turn already launched",
                "data": {"kind": COMMAND_REJECTED_KIND, "reason": "run_active"},
            },
        }
    )
    transport.incoming.push(_unqueued(queued_command_id) + rejection)
    with pytest.raises(Exception):
        await refused
    assert not session.pending.has(queued_command_id), "the fold still retired the entry"

    again = asyncio.ensure_future(turn.unqueue())
    await wait_for_writes(transport, 4)
    transport.incoming.push(_reply(transport, 3, {"status": "accepted", "turnId": QUEUED_TURN}))
    assert (await again).retirement is None, "the earlier reclaim is not handed out twice"
    await pump()
    await client.close()


# The committed transcript, through ``MuseClient``, against the real canned
# host. ``serve-fixture`` writes the unqueue ack and ``turn/unqueued`` in one
# burst, so this is the order a real app meets on every run.
SCENARIO = Path(__file__).resolve().parents[3] / "schema" / "msp" / "transcripts" / "turn-unqueued-round-trip"
# Failure-path bound only: a healthy serve-fixture answers in milliseconds; a
# run that reaches this wall is wedged and the assertion should say so.
REPORTING_DEADLINE_S = 60.0


async def _bounded(awaitable: Awaitable[_T]) -> _T:
    return await asyncio.wait_for(awaitable, timeout=REPORTING_DEADLINE_S)


@pytest.mark.asyncio
async def test_turn_unqueued_round_trip_through_muse_client_returns_the_reclaim(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    binary = fixture_host_bin()
    if binary is None:
        pytest.skip("no muse-conformance fixture host available (Rust build)")
    transcript = load_transcript(SCENARIO)
    recorded_fp = next(
        f for f in transcript.server_frames if isinstance(f.get("result"), dict) and "schema" in f["result"]
    )["result"]["schema"]["fingerprint"]
    monkeypatch.setattr(muse_code, "EXPECTED_SCHEMA_FINGERPRINT", recorded_fp)
    # Acks echo the RECORDED commandId and the connection checks the echo, so
    # the one minter hands out the transcript's ids in send order.
    recorded = [
        "0198f0ab-9999-7000-8000-0000000000c1",
        "018f6a32-1111-7000-8000-0000000000a1",
        "018f6a32-3333-7000-8000-0000000000c3",
        "018f6a32-5555-7000-8000-0000000000c5",
    ]
    stderr: list[str] = []
    handshake = await spawn_msp_connection(
        binary,
        args=("serve-fixture", "--transcript", str(SCENARIO)),
        on_stderr=stderr.append,
        connection_options={"mint_command_id": lambda: recorded.pop(0)},
    )
    # Built by hand, not with ``MuseClient.spawn``: spawn requests a capability
    # the recorded ``initialize`` line does not carry.
    spawned = await _bounded(handshake.initialize({"clientInfo": {"name": "conformance", "version": "0.0.0"}}))
    client: MuseClient[str] = MuseClient(
        spawned.connection,
        MuseClientOptions(durability=read_session_durability(spawned.initialize_result), host=spawned),
    )
    try:
        session = await _bounded(client.start_session(StartSessionOptions(workspace_root="/home/me/src/proj")))
        active_prompt = "Review the current deployment state"
        active = await _bounded(
            session.send_user_turn(
                SendUserTurnOptions(input=[{"type": "text", "text": active_prompt}], composer_input=active_prompt)
            )
        )

        async def user_message_folded() -> None:
            # The queued submit must follow the active turn's userMessage, as recorded.
            async for item in active.items():
                if item.get("kind") == "userMessage":
                    return

        await _bounded(user_message_folded())
        queued_prompt = "Run the queued deployment checks"
        queued = await _bounded(
            session.send_user_turn(
                SendUserTurnOptions(
                    input=[{"type": "text", "text": queued_prompt}], if_busy="queue", composer_input=queued_prompt
                )
            )
        )
        entry = next(held for held in session.pending.list() if held.ack and held.ack["turnId"] == queued.turn_id)

        outcome = await _bounded(queued.unqueue())
        assert outcome.ack["status"] == "accepted"
        assert outcome.retirement == ReclaimedRetirement(command_id=entry.command_id, input=queued_prompt), (
            f"the reclaim comes back from unqueue(); fixture stderr: {''.join(stderr)}"
        )
        assert session.pending.size == 0
        assert (await _bounded(queued.completed)).kind == "unqueued"
        assert (await _bounded(active.completed)).kind == "completed"
    finally:
        await _bounded(client.close())
    assert (await client.exit).kind == "cleanShutdown", "".join(stderr)
