"""``Session.run``: one call from a prompt to the turn's final answer, and its
task-cancellation arms.

Port of ``clients/sdk-ts/test/facade-run.test.ts``; the TypeScript
``AbortSignal`` arms map to cancelling the task that awaits ``run``. Causal,
never time-based: every wait is a bounded loop-turn pump.
"""

from __future__ import annotations

import asyncio
import inspect
from dataclasses import fields
from typing import Any

import pytest

from muse_code import (
    MuseClient,
    MuseClientOptions,
    MuseHostDiedError,
    RunResult,
    SendUserTurnOptions,
    Session,
    StartSessionOptions,
    SyncSession,
    read_session_durability,
)
from muse_code.connection import Connection, MspError
from muse_code.connection import connection as connection_module
from muse_code.connection.spawn import ExitClassification
from muse_code.pending import COMMAND_REJECTED_CODE, COMMAND_REJECTED_KIND

from helpers_connection import (
    MAX_TURNS,
    FakeDuplex,
    answer,
    answer_error,
    pump,
    sent_frame,
    sent_params,
    wait_for_writes,
)

Params = dict[str, Any]

SESSION = "s-1"
SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}
USAGE: Params = {"inputTokens": 12, "outputTokens": 34}

_cursor = 0


def _next_cursor() -> str:
    global _cursor
    _cursor += 1
    return f"v:{_cursor}"


def _wired(durability: str = "durable") -> "tuple[Session[str], FakeDuplex]":
    transport = FakeDuplex()
    minted = iter(f"mint-{n}" for n in range(1000))
    connection = Connection(transport, mint_command_id=lambda: next(minted))
    session: Session[str] = Session(
        SESSION,
        read_session_durability({"sessionDurability": durability}),
        connection=connection,
    )
    return session, transport


def _methods(transport: FakeDuplex) -> list[str]:
    return [sent_frame(transport, index)["method"] for index in range(len(transport.writes))]


def _ack(transport: FakeDuplex, index: int, result: Params) -> None:
    answer(transport, index, {**result, "commandId": sent_params(transport, index)["commandId"]})


def _ack_start(transport: FakeDuplex, index: int, turn_id: str, disposition: str) -> None:
    _ack(
        transport,
        index,
        {"disposition": disposition, "startedNewTurn": True, "status": "accepted", "turnId": turn_id},
    )


def _turn_started(turn_id: str) -> Params:
    return {
        "method": "turn/started",
        "params": {
            "commandId": turn_id,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "turnId": turn_id,
            "viewCursor": _next_cursor(),
        },
    }


def _turn_completed(turn_id: str, terminal: str, usage: Params | None = None) -> Params:
    params: Params = {
        "sessionId": SESSION,
        "sourceRange": SOURCE,
        "terminal": terminal,
        "turnId": turn_id,
        "viewCursor": _next_cursor(),
    }
    if usage is not None:
        params["usage"] = usage
    return {"method": "turn/completed", "params": params}


def _turn_unqueued(turn_id: str, command_id: str) -> Params:
    return {
        "method": "turn/unqueued",
        "params": {
            "commandId": command_id,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "turnId": turn_id,
            "viewCursor": _next_cursor(),
        },
    }


def _completed(item: Params) -> Params:
    return {
        "method": "item/completed",
        "params": {
            "item": item,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "viewCursor": _next_cursor(),
        },
    }


def _agent_message(item_id: str, turn_id: str, **extra: Any) -> Params:
    return {
        "itemId": item_id,
        "kind": "agentMessage",
        "revision": 1,
        "status": "completed",
        "turnId": turn_id,
        **extra,
    }


async def _run_to(
    disposition: str,
) -> "tuple[Session[str], FakeDuplex, asyncio.Task[RunResult], str]":
    """Start ``run`` as a task, answer its ``turn/start`` with ``disposition``,
    and fold ``turn/started`` when the turn ran."""
    session, transport = _wired()
    running = asyncio.ensure_future(session.run("go"))
    await wait_for_writes(transport, 1)
    command_id = sent_params(transport, 0)["commandId"]
    _ack_start(transport, 0, "t-1", disposition)
    await pump()
    if disposition == "started":
        session.apply(_turn_started("t-1"))
    return session, transport, running, command_id


@pytest.mark.asyncio
async def test_run_sends_one_turn_start_and_returns_outcome_final_text_items_usage() -> None:
    session, transport = _wired()
    running = asyncio.ensure_future(
        session.run("Summarize this repository.", if_busy="queue", reasoning_effort="high")
    )
    await wait_for_writes(transport, 1)
    assert sent_frame(transport, 0)["method"] == "turn/start"
    params = dict(sent_params(transport, 0))
    assert isinstance(params.pop("commandId"), str)
    assert params == {
        "ifBusy": "queue",
        "input": [{"text": "Summarize this repository.", "type": "text"}],
        "reasoningEffort": "high",
        "sessionId": SESSION,
    }
    _ack_start(transport, 0, "t-1", "started")
    await pump()

    session.apply(_turn_started("t-1"))
    session.apply(_completed(_agent_message("a-1", "t-1", messagePhase="commentary", text="Looking around.")))
    session.apply(_completed(_agent_message("a-2", "t-1", messagePhase="finalAnswer", text="It is an SDK.")))
    session.apply(_completed(_agent_message("x-1", "t-other", text="another turn's reply")))
    session.apply(_turn_completed("t-1", "completed", USAGE))

    result = await running
    assert result.turn_id == "t-1"
    assert result.outcome.kind == "completed"
    assert result.final_text == "It is an SDK."
    assert [item["itemId"] for item in result.items] == ["a-1", "a-2"]
    assert result.usage == USAGE
    assert len(transport.writes) == 1, "run sends nothing but the turn/start"


@pytest.mark.asyncio
async def test_run_forwards_input_parts_verbatim() -> None:
    session, transport = _wired()
    parts: Any = [{"text": "look at", "type": "text"}, {"text": "@README.md", "type": "text"}]
    running = asyncio.ensure_future(session.run(parts))
    await wait_for_writes(transport, 1)
    assert sent_params(transport, 0)["input"] == parts
    running.cancel()
    _ack_start(transport, 0, "t-1", "started")
    await wait_for_writes(transport, 2)
    _ack(transport, 1, {"status": "accepted", "turnId": "t-1"})
    session.apply(_turn_completed("t-1", "cancelled"))
    with pytest.raises(asyncio.CancelledError):
        await running


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("items", "expected"),
    [
        (
            [
                _agent_message("a-1", "t-1", messagePhase="finalAnswer", text="answer"),
                _agent_message("a-2", "t-1", messagePhase="commentary", text="trailing note"),
            ],
            "answer",
        ),
        (
            [
                _agent_message("a-1", "t-1", messagePhase="finalAnswer", text="first"),
                _agent_message("a-2", "t-1", text="second"),
            ],
            "second",
        ),
        ([_agent_message("a-1", "t-1", text="no phase")], "no phase"),
        ([_agent_message("a-1", "t-1", messagePhase="summary", text="newer phase")], "newer phase"),
        (
            [
                _agent_message("a-1", "t-1", text="kept"),
                _agent_message("a-2", "t-1", status="failed", text="broken"),
            ],
            "kept",
        ),
        ([_agent_message("a-1", "t-1", messagePhase="commentary", text="only commentary")], None),
        (
            [
                {
                    "itemId": "r-1",
                    "kind": "reasoning",
                    "revision": 1,
                    "status": "completed",
                    "text": "thinking",
                    "turnId": "t-1",
                }
            ],
            None,
        ),
    ],
    ids=["later-commentary-skipped", "last-of-several", "absent-phase", "unknown-phase", "failed-skipped", "none", "other-kind"],
)
async def test_final_text_is_the_last_completed_agent_message_that_is_not_commentary(
    items: list[Params], expected: str | None
) -> None:
    session, transport = _wired()
    running = asyncio.ensure_future(session.run("go"))
    await wait_for_writes(transport, 1)
    _ack_start(transport, 0, "t-1", "started")
    await pump()
    for item in items:
        session.apply(_completed(item))
    session.apply(_turn_completed("t-1", "completed"))
    assert (await running).final_text == expected


@pytest.mark.asyncio
async def test_a_failed_turn_returns_rather_than_raises() -> None:
    session, _transport, running, _ = await _run_to("started")
    session.apply(_turn_completed("t-1", "failed"))
    result = await running
    assert result.outcome.kind == "completed"
    assert result.outcome.kind == "completed" and result.outcome.params["terminal"] == "failed"
    assert result.usage is None
    assert result.final_text is None


@pytest.mark.asyncio
async def test_an_ephemeral_host_death_returns_terminal_unknown_with_folded_items() -> None:
    session, transport = _wired("ephemeral")
    running = asyncio.ensure_future(session.run("go"))
    await wait_for_writes(transport, 1)
    _ack_start(transport, 0, "t-1", "started")
    await pump()
    session.apply(_completed(_agent_message("a-1", "t-1", text="partial")))
    session.host_exited(ExitClassification(kind="crash", exit_code=77, exit_signal=None, stderr_tail=()))
    result = await running
    assert result.outcome.kind == "terminalUnknown"
    assert [item["itemId"] for item in result.items] == ["a-1"]
    assert result.usage is None


@pytest.mark.asyncio
async def test_a_refused_submit_raises_its_own_error() -> None:
    session, transport = _wired()
    running = asyncio.ensure_future(session.run("go"))
    await wait_for_writes(transport, 1)
    answer_error(
        transport,
        0,
        {"code": COMMAND_REJECTED_CODE, "message": "busy", "data": {"kind": COMMAND_REJECTED_KIND, "reason": "busy"}},
    )
    with pytest.raises(MspError):
        await running


@pytest.mark.asyncio
async def test_a_task_cancelled_before_it_runs_sends_nothing() -> None:
    session, transport = _wired()
    running = asyncio.ensure_future(session.run("go"))
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    await pump()
    assert transport.writes == []


@pytest.mark.asyncio
async def test_cancelling_a_running_turn_cancels_it_and_waits_for_the_terminal() -> None:
    session, transport, running, _ = await _run_to("started")
    running.cancel()
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "turn/cancel"
    assert sent_params(transport, 1)["turnId"] == "t-1"
    _ack(transport, 1, {"status": "accepted", "turnId": "t-1"})
    await pump()
    assert not running.done(), "run waits for the server's terminal"

    session.apply(_turn_completed("t-1", "cancelled"))
    with pytest.raises(asyncio.CancelledError):
        await running
    assert len(transport.writes) == 2


@pytest.mark.asyncio
async def test_cancelling_a_queued_turn_unqueues_it_and_sends_no_cancel() -> None:
    session, transport, running, command_id = await _run_to("queued")
    running.cancel()
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "turn/unqueue"
    assert sent_params(transport, 1)["turnId"] == "t-1"
    _ack(transport, 1, {"status": "accepted", "turnId": "t-1"})
    await pump()
    assert not session.pending.has(command_id), "the accepted unqueue retired the queued entry"
    assert not running.done(), "run waits for turn/unqueued"

    session.apply(_turn_unqueued("t-1", command_id))
    with pytest.raises(asyncio.CancelledError):
        await running
    assert len(transport.writes) == 2, "no turn/cancel follows an accepted unqueue"


@pytest.mark.asyncio
async def test_an_unqueue_that_loses_the_launch_race_falls_back_to_cancel() -> None:
    session, transport, running, _ = await _run_to("queued")
    running.cancel()
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "turn/unqueue"
    answer_error(
        transport,
        1,
        {
            "code": COMMAND_REJECTED_CODE,
            "message": "turn already launched",
            "data": {"kind": COMMAND_REJECTED_KIND, "reason": "run_active"},
        },
    )
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "turn/cancel"
    assert sent_params(transport, 2)["turnId"] == "t-1"
    _ack(transport, 2, {"status": "accepted", "turnId": "t-1"})
    session.apply(_turn_started("t-1"))
    session.apply(_turn_completed("t-1", "cancelled"))
    with pytest.raises(asyncio.CancelledError):
        await running


@pytest.mark.asyncio
async def test_an_unqueue_acked_without_acceptance_falls_back_to_cancel() -> None:
    # `status` is an open enum: any answer but `accepted` reclaimed nothing.
    session, transport, running, command_id = await _run_to("queued")
    running.cancel()
    await wait_for_writes(transport, 2)
    _ack(transport, 1, {"status": "deferred", "turnId": "t-1"})
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "turn/cancel"
    assert session.pending.has(command_id), "an unaccepted unqueue retires nothing"
    _ack(transport, 2, {"status": "accepted", "turnId": "t-1"})
    session.apply(_turn_completed("t-1", "cancelled"))
    with pytest.raises(asyncio.CancelledError):
        await running


# An unqueue the session runtime did not take wrote nothing, so the
# cancellation sends it again after the connection's backoff instead of
# reading it as a lost launch race.


class _Backoff:
    """Stands in for the connection's retry backoff: each wait parks until the
    test releases it, so no arm sleeps."""

    def __init__(self) -> None:
        self.waiting: list[asyncio.Future[None]] = []

    async def __call__(self, _attempt: int, _error: MspError) -> None:
        gate: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        self.waiting.append(gate)
        await gate

    def release(self) -> None:
        self.waiting.pop(0).set_result(None)

    async def parked(self, count: int) -> None:
        """Yields until ``count`` waits are parked, bounded, then asserts it."""
        for _ in range(MAX_TURNS):
            if len(self.waiting) >= count:
                break
            await asyncio.sleep(0)
        assert len(self.waiting) == count, (
            f"expected {count} parked backoff wait(s): the untaken unqueue waits out the backoff, then goes out again"
        )


@pytest.fixture
def backoff(monkeypatch: pytest.MonkeyPatch) -> _Backoff:
    parked = _Backoff()
    monkeypatch.setattr(connection_module, "_default_retry_delay", parked)
    return parked


def _untaken(transport: FakeDuplex, index: int) -> Params:
    """The host's answer to a ``turn/unqueue`` the session runtime did not take in time."""
    return {
        "code": COMMAND_REJECTED_CODE,
        "message": "turn/unqueue was not taken: the session runtime did not take the reclaim in time",
        "data": {
            "commandId": sent_params(transport, index)["commandId"],
            "kind": COMMAND_REJECTED_KIND,
            "reason": "runtime_busy",
            "retryable": True,
        },
    }


@pytest.mark.asyncio
async def test_an_unqueue_the_runtime_did_not_take_goes_out_again_with_no_cap_and_no_cancel(
    backoff: _Backoff,
) -> None:
    session, transport, running, command_id = await _run_to("queued")
    running.cancel()
    await wait_for_writes(transport, 2)
    answer_error(transport, 1, _untaken(transport, 1))
    await backoff.parked(1)
    backoff.release()
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "turn/unqueue"
    assert sent_params(transport, 2)["turnId"] == "t-1"
    first_command_id = sent_params(transport, 1)["commandId"]
    assert sent_params(transport, 2)["commandId"] == first_command_id, (
        "the resend keeps the first unqueue's commandId"
    )

    answer_error(transport, 2, _untaken(transport, 2))
    await backoff.parked(1)
    backoff.release()
    await wait_for_writes(transport, 4)
    assert sent_frame(transport, 3)["method"] == "turn/unqueue"
    assert sent_params(transport, 3)["commandId"] == first_command_id, "every resend keeps that commandId"
    _ack(transport, 3, {"status": "accepted", "turnId": "t-1"})
    await pump()
    assert not session.pending.has(command_id), "the accepted resend retired the queued entry"

    session.apply(_turn_unqueued("t-1", command_id))
    with pytest.raises(asyncio.CancelledError):
        await running
    assert len(transport.writes) == 4, "no turn/cancel follows an accepted resend"


@pytest.mark.asyncio
async def test_an_untaken_unqueue_whose_resend_loses_the_launch_race_falls_back_to_cancel(
    backoff: _Backoff,
) -> None:
    session, transport, running, _ = await _run_to("queued")
    running.cancel()
    await wait_for_writes(transport, 2)
    answer_error(transport, 1, _untaken(transport, 1))
    await backoff.parked(1)
    backoff.release()
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "turn/unqueue"
    assert sent_params(transport, 2)["commandId"] == sent_params(transport, 1)["commandId"], (
        "the resend keeps the first unqueue's commandId"
    )
    answer_error(
        transport,
        2,
        {
            "code": COMMAND_REJECTED_CODE,
            "message": "turn already launched",
            "data": {"kind": COMMAND_REJECTED_KIND, "reason": "run_active"},
        },
    )
    await wait_for_writes(transport, 4)
    assert sent_frame(transport, 3)["method"] == "turn/cancel"
    assert sent_params(transport, 3)["turnId"] == "t-1"
    _ack(transport, 3, {"status": "accepted", "turnId": "t-1"})
    session.apply(_turn_started("t-1"))
    session.apply(_turn_completed("t-1", "cancelled"))
    with pytest.raises(asyncio.CancelledError):
        await running


@pytest.mark.asyncio
async def test_an_untaken_unqueue_whose_turn_started_meanwhile_is_cancelled_at_once(
    backoff: _Backoff,
) -> None:
    session, transport, running, _ = await _run_to("queued")
    running.cancel()
    await wait_for_writes(transport, 2)
    session.apply(_turn_started("t-1"))
    answer_error(transport, 1, _untaken(transport, 1))
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "turn/cancel"
    assert not backoff.waiting, "a turn that started is cancelled at once, with no backoff"
    _ack(transport, 2, {"status": "accepted", "turnId": "t-1"})
    session.apply(_turn_completed("t-1", "cancelled"))
    with pytest.raises(asyncio.CancelledError):
        await running
    assert len(transport.writes) == 3


@pytest.mark.asyncio
async def test_a_second_cancellation_returns_at_once_and_the_resend_still_goes_out(
    backoff: _Backoff,
) -> None:
    session, transport, running, command_id = await _run_to("queued")
    running.cancel()
    await wait_for_writes(transport, 2)
    answer_error(transport, 1, _untaken(transport, 1))
    await backoff.parked(1)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    assert _methods(transport) == ["turn/start", "turn/unqueue"], "nothing goes out before the backoff"
    assert not backoff.waiting[0].cancelled(), "the stop's backoff wait outlives the second cancellation"

    backoff.release()
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "turn/unqueue", "the stop goes on after run returned"
    assert sent_params(transport, 2)["commandId"] == sent_params(transport, 1)["commandId"], (
        "the resend keeps the first unqueue's commandId"
    )
    _ack(transport, 2, {"status": "accepted", "turnId": "t-1"})
    await pump()
    assert not session.pending.has(command_id), "the accepted resend retired the queued entry"
    assert len(transport.writes) == 3, "no turn/cancel follows an accepted resend"


@pytest.mark.asyncio
async def test_closing_the_client_ends_a_stop_that_outlived_a_second_cancellation(
    backoff: _Backoff,
) -> None:
    # No task stays pending once the close settles, the stop the session
    # holds after a second cancellation included.
    transport = FakeDuplex()
    minted = iter(f"mint-{n}" for n in range(1000))
    client: MuseClient[str] = MuseClient(
        Connection(transport, mint_command_id=lambda: next(minted)),
        MuseClientOptions(durability=read_session_durability({"sessionDurability": "durable"})),
    )
    opening = asyncio.ensure_future(client.start_session(StartSessionOptions()))
    await wait_for_writes(transport, 1)
    _ack(transport, 0, {"session": {"sessionId": SESSION, "status": "idle"}, "viewCursor": "v:0"})
    session = await opening
    before = asyncio.all_tasks()
    running = asyncio.ensure_future(session.run("go"))
    await wait_for_writes(transport, 2)
    _ack_start(transport, 1, "t-1", "queued")
    await pump()
    running.cancel()
    await wait_for_writes(transport, 3)
    answer_error(transport, 2, _untaken(transport, 2))
    await backoff.parked(1)
    running.cancel()
    with pytest.raises(asyncio.CancelledError):
        await running
    outliving = asyncio.all_tasks() - before
    assert len(outliving) == 1, "one stop outlives run, held by the session"

    await client.close()
    assert all(task.done() for task in outliving), "the close leaves the held stop no longer pending"
    assert backoff.waiting[0].cancelled(), "nor its backoff wait"
    assert _methods(transport) == ["session/start", "turn/start", "turn/unqueue"], "the close sends no resend"


@pytest.mark.asyncio
async def test_a_queued_turn_whose_start_already_folded_is_cancelled_not_unqueued() -> None:
    session, transport, running, _ = await _run_to("queued")
    session.apply(_turn_started("t-1"))
    running.cancel()
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "turn/cancel"
    _ack(transport, 1, {"status": "accepted", "turnId": "t-1"})
    session.apply(_turn_completed("t-1", "cancelled"))
    with pytest.raises(asyncio.CancelledError):
        await running


@pytest.mark.asyncio
async def test_a_cancel_during_submission_stops_the_turn_once_its_ack_names_it() -> None:
    session, transport = _wired()
    running = asyncio.ensure_future(session.run("go"))
    await wait_for_writes(transport, 1)
    running.cancel()
    await pump()
    assert len(transport.writes) == 1, "nothing more is sent before the ack names the turn"
    assert not running.done()

    _ack_start(transport, 0, "t-1", "started")
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "turn/cancel"
    _ack(transport, 1, {"status": "accepted", "turnId": "t-1"})
    session.apply(_turn_completed("t-1", "cancelled"))
    with pytest.raises(asyncio.CancelledError):
        await running


@pytest.mark.asyncio
async def test_a_refused_cancel_still_waits_for_the_turns_own_terminal() -> None:
    session, transport, running, _ = await _run_to("started")
    running.cancel()
    await wait_for_writes(transport, 2)
    answer_error(
        transport,
        1,
        {
            "code": COMMAND_REJECTED_CODE,
            "message": "already finished",
            "data": {"kind": COMMAND_REJECTED_KIND, "reason": "missing_run"},
        },
    )
    await pump()
    assert not running.done()
    session.apply(_turn_completed("t-1", "completed"))
    with pytest.raises(asyncio.CancelledError):
        await running


@pytest.mark.asyncio
async def test_a_cancel_after_the_turn_ended_sends_nothing() -> None:
    # The terminal folds and the task is cancelled in the same loop tick,
    # before `run` resumes: the turn already ended, so no stop goes out.
    session, transport, running, _ = await _run_to("started")
    session.apply(_turn_completed("t-1", "completed"))
    running.cancel()
    await pump()
    # Checked before awaiting: a wrongly sent stop would wait on its ack.
    assert _methods(transport) == ["turn/start"]
    assert running.done()
    with pytest.raises(asyncio.CancelledError):
        await running


@pytest.mark.asyncio
async def test_a_cancel_during_submission_sends_nothing_when_the_terminal_beat_the_ack() -> None:
    session, transport = _wired()
    running = asyncio.ensure_future(session.run("go"))
    await wait_for_writes(transport, 1)
    running.cancel()
    await pump()
    session.apply(_turn_started("t-1"))
    session.apply(_turn_completed("t-1", "completed"))
    _ack_start(transport, 0, "t-1", "started")
    await pump()
    assert _methods(transport) == ["turn/start"]
    assert running.done()
    with pytest.raises(asyncio.CancelledError):
        await running


@pytest.mark.asyncio
async def test_a_durable_host_death_raises_the_host_exit_error() -> None:
    session, transport, running, _ = await _run_to("started")
    session.host_exited(ExitClassification(kind="crash", exit_code=77, exit_signal=None, stderr_tail=()))
    with pytest.raises(MuseHostDiedError):
        await running
    assert len(transport.writes) == 1


def test_run_takes_every_forwarded_turn_start_member_as_a_keyword() -> None:
    # `run` spells the `turn/start` members out as keywords, so this pins them
    # to SendUserTurnOptions: a new member must reach `run` and its sync twin.
    forwarded = {f.name for f in fields(SendUserTurnOptions)} - {"input", "composer_input"}
    for method in (Session.run, SyncSession.run):
        keywords = {
            name
            for name, parameter in inspect.signature(method).parameters.items()
            if parameter.kind is inspect.Parameter.KEYWORD_ONLY
        }
        assert keywords == forwarded, method.__qualname__


def test_run_result_is_exported_from_the_facade() -> None:
    import muse_code.facade as facade

    assert facade.RunResult is RunResult
    assert MuseClient is facade.MuseClient
