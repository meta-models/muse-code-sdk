"""A question still open when a session is resumed is re-sent as a
``userInput/request`` server request. The client that owns the connection
routes it to its session as the ``userInput/requested`` twin it shares params
with, so the session lists it, and answers with the empty receipt ``{}``. Every
other server-request method except ``approval/request``, and every request on
a bare ``Connection``, keeps ``-32601``.

Port of ``clients/sdk-ts/test/facade-user-input-resend.test.ts``. Causal, never
time-based: every wait is a bounded loop-turn pump.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from muse_code import (
    MuseClient,
    MuseClientOptions,
    ResumeSessionOptions,
    Session,
    read_session_durability,
)
from muse_code import MuseSessionDiscardedError
from muse_code.connection import Connection, ProtocolError
from muse_code.connection.spawn import ExitClassification

from helpers_connection import FakeDuplex, frame, pump, sent_frame, wait_for_writes

Params = dict[str, Any]

SESSION = "s-9"


def _question(view_cursor: str) -> Params:
    return {
        "itemId": "i-2",
        "questions": [],
        "sessionId": SESSION,
        "toolCallId": "call-2",
        "toolName": "ask",
        "turnId": "turn-1",
        "userInputId": "input-1",
        "viewCursor": view_cursor,
    }


async def _resumed(
    tail: str = "",
) -> "tuple[MuseClient[Any], Session[Any], FakeDuplex]":
    """Resume ``s-9``; ``tail`` is read in the same chunk as the resume reply."""
    transport = FakeDuplex()
    client: MuseClient[Any] = MuseClient(
        Connection(transport),
        MuseClientOptions(
            durability=read_session_durability({"sessionDurability": "durable"})
        ),
    )
    pending = asyncio.ensure_future(
        client.resume_session(ResumeSessionOptions(session_id=SESSION))
    )
    await wait_for_writes(transport, 1)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": sent_frame(transport, 0)["id"],
                "result": {
                    "session": {"sessionId": SESSION, "status": "idle"},
                    "history": {"mode": "none", "items": []},
                    "pendingRequests": [],
                    "viewCursor": "cursor-1",
                },
            }
        )
        + tail
    )
    return client, await pending, transport


def _listed(session: Session[Any]) -> list[str]:
    return [str(entry["userInputId"]) for entry in session.fold.pending_user_inputs()]


@pytest.mark.asyncio
async def test_question_resent_only_as_a_server_request_is_listed_and_receipted() -> None:
    client, session, transport = await _resumed()

    # The host re-sends the params it folded, so the request keeps the
    # question's own cursor, behind the resume cursor.
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "userInput/request",
                "params": _question("cursor-0"),
            }
        )
    )
    await wait_for_writes(transport, 2)

    assert sent_frame(transport, 1) == {"jsonrpc": "2.0", "id": 7, "result": {}}
    assert _listed(session) == ["input-1"]
    await client.close()


@pytest.mark.asyncio
async def test_question_resent_in_the_same_read_as_the_resume_reply_is_listed() -> None:
    # The host re-sends right after the resume reply, so a real client often
    # reads both in one chunk. The handler task runs before the open registers
    # the session, so only the hold keeps the question.
    client, session, transport = await _resumed(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "userInput/request",
                "params": _question("cursor-0"),
            }
        )
    )
    await wait_for_writes(transport, 2)

    assert sent_frame(transport, 1) == {"jsonrpc": "2.0", "id": 7, "result": {}}
    assert _listed(session) == ["input-1"]
    await client.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("request_first", [False, True])
async def test_question_sent_as_both_frames_is_listed_once(request_first: bool) -> None:
    client, session, transport = await _resumed()
    notification = frame(
        {"jsonrpc": "2.0", "method": "userInput/requested", "params": _question("cursor-2")}
    )
    request = frame(
        {
            "jsonrpc": "2.0",
            "id": 7,
            "method": "userInput/request",
            "params": _question("cursor-2"),
        }
    )

    # One chunk: the connection reads every line of it before the asserts.
    transport.chunks.push(request + notification if request_first else notification + request)
    await wait_for_writes(transport, 2)

    assert sent_frame(transport, 1) == {"jsonrpc": "2.0", "id": 7, "result": {}}
    assert _listed(session) == ["input-1"]
    await client.close()


@pytest.mark.asyncio
async def test_resent_request_naming_no_session_or_an_unknown_one_still_gets_the_receipt() -> None:
    client, session, transport = await _resumed()
    unnamed = _question("cursor-0")
    del unnamed["sessionId"]

    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "userInput/request",
                "params": {**_question("cursor-0"), "sessionId": "s-other"},
            }
        )
        + frame({"jsonrpc": "2.0", "id": 8, "method": "userInput/request", "params": unnamed})
    )
    await wait_for_writes(transport, 3)

    replies = sorted((sent_frame(transport, 1), sent_frame(transport, 2)), key=lambda r: r["id"])
    assert replies == [
        {"jsonrpc": "2.0", "id": 7, "result": {}},
        {"jsonrpc": "2.0", "id": 8, "result": {}},
    ]
    assert _listed(session) == []
    await client.close()


@pytest.mark.asyncio
async def test_client_owned_connection_still_refuses_an_unrouted_server_request() -> None:
    client, session, transport = await _resumed()

    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 8,
                "method": "test/unroutedRequest",
                "params": {"sessionId": SESSION},
            }
        )
    )
    await wait_for_writes(transport, 2)

    reply = sent_frame(transport, 1)
    assert reply["id"] == 8
    assert reply["error"]["code"] == -32601
    assert reply["error"]["data"]["kind"] == "methodNotFound"
    assert _listed(session) == []
    await client.close()


@pytest.mark.asyncio
async def test_bare_connection_still_refuses_user_input_request() -> None:
    transport = FakeDuplex()
    bare = Connection(transport)

    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "userInput/request",
                "params": _question("cursor-0"),
            }
        )
    )
    await wait_for_writes(transport, 1)

    reply = sent_frame(transport, 0)
    assert reply["id"] == 7
    assert reply["error"]["code"] == -32601
    assert reply["error"]["data"]["kind"] == "methodNotFound"
    await bare.close()


@pytest.mark.asyncio
async def test_listed_question_is_answered_with_answer_user_input() -> None:
    client, session, transport = await _resumed()
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "userInput/request",
                "params": _question("cursor-0"),
            }
        )
    )
    await wait_for_writes(transport, 2)

    answers: list[Any] = [{"questionId": "q-1", "selectedLabel": "Yes"}]
    answering = asyncio.ensure_future(session.answer_user_input("input-1", answers))
    await wait_for_writes(transport, 3)
    sent = sent_frame(transport, 2)
    params = dict(sent["params"])
    command_id = params.pop("commandId")
    assert sent["method"] == "userInput/answer"
    assert isinstance(command_id, str) and command_id
    assert params == {"sessionId": SESSION, "userInputId": "input-1", "answers": answers}

    result = {"commandId": command_id, "status": "accepted", "userInputId": "input-1"}
    transport.chunks.push(frame({"jsonrpc": "2.0", "id": sent["id"], "result": result}))
    assert await answering == result
    # The question settles only on the server's userInput/settled.
    assert _listed(session) == ["input-1"]
    await client.close()


@pytest.mark.asyncio
async def test_answer_user_input_rejects_an_ack_for_another_question() -> None:
    client, session, transport = await _resumed()

    answering = asyncio.ensure_future(
        session.answer_user_input("input-1", [{"questionId": "q-1", "freeText": "ok"}])
    )
    await wait_for_writes(transport, 2)
    sent = sent_frame(transport, 1)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": sent["id"],
                "result": {
                    "commandId": sent["params"]["commandId"],
                    "status": "accepted",
                    "userInputId": "input-2",
                },
            }
        )
    )
    with pytest.raises(ProtocolError):
        await answering
    await client.close()


@pytest.mark.asyncio
async def test_fold_only_session_refuses_answer_user_input() -> None:
    session: Session[str] = Session(
        SESSION, read_session_durability({"sessionDurability": "durable"})
    )
    with pytest.raises(Exception, match="connection"):
        await session.answer_user_input("input-1", [{"questionId": "q-1", "freeText": "ok"}])


@pytest.mark.asyncio
async def test_question_settled_in_the_same_read_as_its_resent_request_is_not_listed() -> None:
    client, session, transport = await _resumed()
    settled = frame(
        {
            "jsonrpc": "2.0",
            "method": "userInput/settled",
            "params": {
                "answers": [],
                "clarification": None,
                "decidedAt": "2025-08-07T18:23:20.100Z",
                "decidedByCommandId": None,
                "outcome": "answered",
                "reason": None,
                "sessionId": SESSION,
                "userInputId": "input-1",
                "viewCursor": "cursor-2",
            },
        }
    )
    # The handler task runs after the settlement read with it: a settled
    # question stays settled, so the late twin lists nothing.
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": 7,
                "method": "userInput/request",
                "params": _question("cursor-0"),
            }
        )
        + settled
    )
    await wait_for_writes(transport, 2)

    assert sent_frame(transport, 1) == {"jsonrpc": "2.0", "id": 7, "result": {}}
    assert _listed(session) == []
    await client.close()


@pytest.mark.asyncio
async def test_answer_user_input_rejects_an_ack_with_no_command_id() -> None:
    client, session, transport = await _resumed()

    answering = asyncio.ensure_future(
        session.answer_user_input("input-1", [{"questionId": "q-1", "freeText": "ok"}])
    )
    await wait_for_writes(transport, 2)
    sent = sent_frame(transport, 1)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": sent["id"],
                "result": {"status": "accepted", "userInputId": "input-1"},
            }
        )
    )
    with pytest.raises(ProtocolError):
        await answering
    await client.close()


@pytest.mark.asyncio
async def test_discarded_session_refuses_answer_user_input_before_sending() -> None:
    transport = FakeDuplex()
    session: Session[str] = Session(
        SESSION,
        read_session_durability({"sessionDurability": "ephemeral"}),
        connection=Connection(transport),
    )
    crash = ExitClassification(
        kind="crash", exit_code=77, exit_signal=None, stderr_tail=("thread 'main' panicked",)
    )
    assert session.host_exited(crash).kind == "discharged"

    answering = asyncio.ensure_future(
        session.answer_user_input("input-1", [{"questionId": "q-1", "freeText": "ok"}])
    )
    await pump()
    assert transport.writes == []
    with pytest.raises(MuseSessionDiscardedError):
        await answering
