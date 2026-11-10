"""Turn and session control verbs the host already serves: the turn
handle's ``cancel``/``interrupt``/``steer``/``unqueue``, the ``Session``
control and subagent/plugin/skill verbs, and ``MuseClient.list_models`` /
``read_usage``.

Port of ``clients/sdk-ts/test/facade-control-verbs.test.ts``. Causal, never
time-based: every wait is a bounded loop-turn pump.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

import pytest

from muse_code import (
    MuseClient,
    MuseClientOptions,
    MuseSessionDiscardedError,
    Session,
    SendUserTurnOptions,
    SteerTurnOptions,
    SyncMuseClient,
    Turn,
    read_session_durability,
)
from muse_code.connection import Connection
from muse_code.connection.spawn import ExitClassification
from muse_code.pending import (
    COMMAND_REJECTED_CODE,
    COMMAND_REJECTED_KIND,
    MaterializedRetirement,
    ReclaimedRetirement,
)

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

Params = dict[str, Any]

DURABLE = read_session_durability({"sessionDurability": "durable"})
SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}


def _wired() -> "tuple[Session[str], FakeDuplex]":
    transport = FakeDuplex()
    minted = iter(f"mint-{n}" for n in range(1000))
    connection = Connection(transport, mint_command_id=lambda: next(minted))
    session: Session[str] = Session("s-1", DURABLE, connection=connection)
    return session, transport


def _without_command_id(transport: FakeDuplex, index: int) -> Params:
    params = dict(sent_params(transport, index))
    params.pop("commandId", None)
    return params


def _ack(transport: FakeDuplex, index: int, result: Params) -> None:
    answer(transport, index, {**result, "commandId": sent_params(transport, index)["commandId"]})


def _user_message(item_id: str, turn_id: str, command_id: str | None = None) -> Params:
    item: Params = {
        "itemId": item_id,
        "kind": "userMessage",
        "revision": 1,
        "sessionId": "s-1",
        "status": "completed",
        "turnId": turn_id,
    }
    if command_id is not None:
        item["commandId"] = command_id
    return {
        "method": "item/completed",
        "params": {"sessionId": "s-1", "turnId": turn_id, "item": item},
    }


def _every_verb(
    session: Session[str], turn: Turn[str]
) -> list[tuple[str, Callable[[], Awaitable[Any]]]]:
    return [
        ("turn.cancel", lambda: turn.cancel()),
        ("turn.interrupt", lambda: turn.interrupt()),
        ("turn.steer", lambda: turn.steer(SteerTurnOptions(input=[{"type": "text", "text": "s"}]))),
        ("turn.unqueue", lambda: turn.unqueue()),
        ("fork", lambda: session.fork()),
        ("compact", lambda: session.compact()),
        ("set_model", lambda: session.set_model({"modelId": "m"})),
        ("set_reasoning_effort", lambda: session.set_reasoning_effort("high")),
        ("set_approval_mode", lambda: session.set_approval_mode("onRequest")),
        ("rename", lambda: session.rename("n")),
        ("leave", lambda: session.leave()),
        ("send_subagent_message", lambda: session.send_subagent_message("sa-1", "b")),
        ("followup_subagent_task", lambda: session.followup_subagent_task("sa-1", "b")),
        ("interrupt_subagent", lambda: session.interrupt_subagent("sa-1")),
        ("stop_subagent", lambda: session.stop_subagent("sa-1")),
        ("resume_subagent", lambda: session.resume_subagent("sa-1")),
        ("reopen_subagent", lambda: session.reopen_subagent("sa-1")),
        ("close_subagent", lambda: session.close_subagent("sa-1")),
        ("read_subagent_result", lambda: session.read_subagent_result("sa-1")),
        ("list_plugins", lambda: session.list_plugins()),
        ("install_plugin", lambda: session.install_plugin({"localPath": {"path": "/p"}})),
        (
            "set_skill_activation",
            lambda: session.set_skill_activation(selector="k", scope="user", activation="off"),
        ),
    ]


async def _unqueue_ack(turn: Turn[str]) -> Any:
    return (await turn.unqueue()).ack


@pytest.mark.asyncio
async def test_turn_cancel_interrupt_unqueue_target_the_handles_own_turn() -> None:
    cases: list[tuple[str, Callable[[Turn[str]], Awaitable[Any]], Params]] = [
        ("turn/cancel", lambda t: t.cancel(), {"sessionId": "s-1", "turnId": "t-1"}),
        ("turn/interrupt", lambda t: t.interrupt(), {"sessionId": "s-1", "turnId": "t-1"}),
        (
            "turn/interrupt",
            lambda t: t.interrupt(retract=True),
            {"retract": True, "sessionId": "s-1", "turnId": "t-1"},
        ),
        ("turn/unqueue", _unqueue_ack, {"sessionId": "s-1", "turnId": "t-1"}),
    ]
    for method, call, params in cases:
        session, transport = _wired()
        pending = asyncio.ensure_future(call(session.turn("t-1")))
        await wait_for_writes(transport, 1)
        assert sent_frame(transport, 0)["method"] == method
        assert _without_command_id(transport, 0) == params, f"{method} sends the full params"
        assert isinstance(sent_params(transport, 0).get("commandId"), str), f"{method} is a command"
        _ack(transport, 0, {"status": "accepted", "turnId": "t-1"})
        assert (await pending)["turnId"] == "t-1"


@pytest.mark.asyncio
async def test_steer_records_the_pending_entry_before_the_ack_and_materializes() -> None:
    session, transport = _wired()
    session.apply(_user_message("i-0", "t-1"))
    steering = asyncio.ensure_future(
        session.turn("t-1").steer(
            SteerTurnOptions(
                input=[{"type": "text", "text": "only the agent crate"}],
                reasoning_effort="high",
                composer_input="draft",
            )
        )
    )
    await wait_for_writes(transport, 1)
    assert sent_frame(transport, 0)["method"] == "turn/steer"
    assert _without_command_id(transport, 0) == {
        "expectedTurnId": "t-1",
        "input": [{"type": "text", "text": "only the agent crate"}],
        "reasoningEffort": "high",
        "sessionId": "s-1",
    }
    command_id = sent_params(transport, 0)["commandId"]
    # The entry exists BEFORE the ack, anchored after the last folded item.
    entry = session.pending.get(command_id)
    assert entry is not None
    assert entry.input == "draft"
    assert entry.anchor_after_item_id == "i-0"

    _ack(transport, 0, {"status": "accepted", "turnId": "t-1"})
    assert (await steering)["turnId"] == "t-1"
    held = session.pending.get(command_id)
    assert held is not None
    assert held.ack == {"disposition": "steered", "turnId": "t-1"}

    applied = session.apply(_user_message("i-1", "t-1", command_id))
    assert list(applied.retirements) == [
        MaterializedRetirement(command_id=command_id, matched_by="userMessage", item_id="i-1")
    ]
    assert not session.pending.has(command_id)


@pytest.mark.asyncio
async def test_a_durably_rejected_steer_retires_to_the_composer() -> None:
    session, transport = _wired()
    steering = asyncio.ensure_future(
        session.turn("t-1").steer(
            SteerTurnOptions(input=[{"type": "text", "text": "s"}], composer_input="draft")
        )
    )
    await wait_for_writes(transport, 1)
    command_id = sent_params(transport, 0)["commandId"]
    answer_error(
        transport,
        0,
        {
            "code": COMMAND_REJECTED_CODE,
            "message": "turn already finished",
            "data": {"kind": COMMAND_REJECTED_KIND, "reason": "already_terminal"},
        },
    )
    with pytest.raises(Exception):
        await steering
    assert not session.pending.has(command_id)


@pytest.mark.asyncio
async def test_an_acked_steer_is_replayed_as_turn_steer_at_reconnect() -> None:
    session, transport = _wired()
    steering = asyncio.ensure_future(
        session.turn("t-1").steer(SteerTurnOptions(input=[{"type": "text", "text": "s"}]))
    )
    await wait_for_writes(transport, 1)
    command_id = sent_params(transport, 0)["commandId"]
    _ack(transport, 0, {"status": "accepted", "turnId": "t-1"})
    await steering

    resolving = asyncio.ensure_future(session.resolve_reconnect())
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "turn/steer"
    assert sent_params(transport, 1) == sent_params(transport, 0)
    _ack(transport, 1, {"status": "accepted", "turnId": "t-1"})
    assert await resolving == ()
    assert session.pending.has(command_id), "a still-pending steered ack holds"


async def _assert_replay_memory_pruned(
    session: Session[str], transport: FakeDuplex, retired_command_id: str
) -> None:
    """Prove a retired command's ``turn/start`` params left the replay memory:
    re-seed the SAME ``commandId`` beside one live, unacked submit and drive
    the no-snapshot reconnect. A pruned memory sends exactly one frame, the
    live entry's; a leaked one re-sends the retired ``turn/start`` first."""
    session.pending.submitted(retired_command_id, "re-seeded")
    live = asyncio.ensure_future(
        session.send_user_turn(
            SendUserTurnOptions(input=[{"type": "text", "text": "again"}], composer_input="again")
        )
    )
    live_write = len(transport.writes)
    await wait_for_writes(transport, live_write + 1)
    live_command_id = sent_params(transport, live_write)["commandId"]
    # Admits nothing, so the live entry holds unacked for the resubmit.
    answer_error(
        transport,
        live_write,
        {"code": -32602, "message": "invalid params", "data": {"kind": "invalidParams"}},
    )
    with pytest.raises(Exception):
        await live

    reconnected = asyncio.ensure_future(session.resolve_reconnect())
    replay_write = len(transport.writes)
    await wait_for_writes(transport, replay_write + 1)
    assert sent_params(transport, replay_write)["commandId"] == live_command_id, (
        f"the reconnect re-sent retired {retired_command_id}: its replay memory was not pruned"
    )
    _ack(
        transport,
        replay_write,
        {"disposition": "started", "startedNewTurn": True, "status": "accepted", "turnId": "t-live"},
    )
    assert await reconnected == ()
    await pump()
    assert len(transport.writes) == replay_write + 1, "only the live entry is resubmitted"


async def _queued_turn() -> "tuple[Session[str], FakeDuplex, Turn[str], str]":
    session, transport = _wired()
    submitting = asyncio.ensure_future(
        session.send_user_turn(
            SendUserTurnOptions(input=[{"type": "text", "text": "q"}], composer_input="queued text")
        )
    )
    await wait_for_writes(transport, 1)
    queued_command_id = sent_params(transport, 0)["commandId"]
    _ack(
        transport,
        0,
        {"disposition": "queued", "startedNewTurn": True, "status": "accepted", "turnId": "t-2"},
    )
    return session, transport, await submitting, queued_command_id


@pytest.mark.asyncio
async def test_an_accepted_unqueue_retires_the_queued_entry_at_once() -> None:
    session, transport, turn, queued_command_id = await _queued_turn()
    unqueuing = asyncio.ensure_future(turn.unqueue())
    await wait_for_writes(transport, 2)
    assert sent_frame(transport, 1)["method"] == "turn/unqueue"
    assert sent_params(transport, 1)["turnId"] == "t-2"
    assert sent_params(transport, 1)["commandId"] != queued_command_id
    _ack(transport, 1, {"status": "accepted", "turnId": "t-2"})
    outcome = await unqueuing
    # The client's own accepted reclaim ack retires the entry then and there,
    # with the same composer restore.
    assert outcome.ack["turnId"] == "t-2"
    assert outcome.retirement == ReclaimedRetirement(
        command_id=queued_command_id, input="queued text"
    )
    assert not session.pending.has(queued_command_id)

    applied = session.apply(
        {
            "method": "turn/unqueued",
            "params": {
                "commandId": queued_command_id,
                "sessionId": "s-1",
                "sourceRange": SOURCE,
                "turnId": "t-2",
                "viewCursor": "v:1",
            },
        }
    )
    assert list(applied.retirements) == [], "the view event finds nothing left to retire"
    assert (await turn.completed).kind == "unqueued"
    # The accepted unqueue is the only retirement of this entry, so it alone
    # must clear the queued turn's replay memory.
    await _assert_replay_memory_pruned(session, transport, queued_command_id)


@pytest.mark.asyncio
async def test_a_turn_unqueued_folded_before_the_unqueue_ack_retires_the_entry_there_once() -> None:
    session, transport, turn, queued_command_id = await _queued_turn()
    unqueuing = asyncio.ensure_future(turn.unqueue())
    await wait_for_writes(transport, 2)

    # The view event wins the race with the ack: ``apply`` retires the entry.
    applied = session.apply(
        {
            "method": "turn/unqueued",
            "params": {
                "commandId": queued_command_id,
                "sessionId": "s-1",
                "sourceRange": SOURCE,
                "turnId": "t-2",
                "viewCursor": "v:1",
            },
        }
    )
    assert list(applied.retirements) == [
        ReclaimedRetirement(command_id=queued_command_id, input="queued text")
    ]
    assert not session.pending.has(queued_command_id)

    _ack(transport, 1, {"status": "accepted", "turnId": "t-2"})
    outcome = await unqueuing
    assert outcome.ack["status"] == "accepted"
    assert outcome.retirement is None, "apply already returned the retirement; the ack retires nothing twice"
    assert (await turn.completed).kind == "unqueued"
    await _assert_replay_memory_pruned(session, transport, queued_command_id)


@pytest.mark.asyncio
async def test_a_rejected_unqueue_retires_nothing() -> None:
    session, transport, turn, queued_command_id = await _queued_turn()
    unqueuing = asyncio.ensure_future(turn.unqueue())
    await wait_for_writes(transport, 2)
    answer_error(
        transport,
        1,
        {
            "code": COMMAND_REJECTED_CODE,
            "message": "turn already launched",
            "data": {"kind": COMMAND_REJECTED_KIND, "reason": "run_active"},
        },
    )
    with pytest.raises(Exception):
        await unqueuing
    assert session.pending.has(queued_command_id)


@pytest.mark.asyncio
async def test_session_control_subagent_plugin_skill_verbs_send_full_params() -> None:
    accepted: Params = {"status": "accepted"}
    cases: list[tuple[str, Callable[[Session[str]], Awaitable[Any]], Params, Params]] = [
        (
            "session/fork",
            lambda s: s.fork(cut_point={"lastTurnId": "t-1"}, exclude_items=True),
            {"cutPoint": {"lastTurnId": "t-1"}, "excludeItems": True, "sessionId": "s-1"},
            {"viewCursor": "v", "pendingRequests": []},
        ),
        ("session/fork", lambda s: s.fork(), {"sessionId": "s-1"}, {"viewCursor": "v"}),
        (
            "session/compact",
            lambda s: s.compact(turn_id="t-1"),
            {"sessionId": "s-1", "turnId": "t-1"},
            accepted,
        ),
        ("session/compact", lambda s: s.compact(), {"sessionId": "s-1"}, {"status": "noop"}),
        (
            "session/setModel",
            lambda s: s.set_model({"modelId": "m-1", "providerId": "p"}),
            {"model": {"modelId": "m-1", "providerId": "p"}, "sessionId": "s-1"},
            accepted,
        ),
        (
            "session/setReasoningEffort",
            lambda s: s.set_reasoning_effort("high"),
            {"reasoningEffort": "high", "sessionId": "s-1"},
            accepted,
        ),
        (
            "session/setApprovalMode",
            lambda s: s.set_approval_mode("denyUnmatched"),
            {"mode": "denyUnmatched", "sessionId": "s-1"},
            {"applyOutcome": "applied", "status": "accepted"},
        ),
        (
            "session/rename",
            lambda s: s.rename("n-1"),
            {"name": "n-1", "sessionId": "s-1"},
            {"name": "n-1", "status": "accepted"},
        ),
        (
            "session/leave",
            lambda s: s.leave(stop=True),
            {"sessionId": "s-1", "stop": True},
            accepted,
        ),
        ("session/leave", lambda s: s.leave(), {"sessionId": "s-1"}, accepted),
        (
            "subagent/sendMessage",
            lambda s: s.send_subagent_message("sa-1", "note"),
            {"body": "note", "sessionId": "s-1", "subagentId": "sa-1"},
            accepted,
        ),
        (
            "subagent/followupTask",
            lambda s: s.followup_subagent_task("sa-1", "task"),
            {"body": "task", "sessionId": "s-1", "subagentId": "sa-1"},
            accepted,
        ),
        (
            "subagent/interrupt",
            lambda s: s.interrupt_subagent("sa-1", reason="r"),
            {"reason": "r", "sessionId": "s-1", "subagentId": "sa-1"},
            accepted,
        ),
        (
            "subagent/stop",
            lambda s: s.stop_subagent("sa-1"),
            {"sessionId": "s-1", "subagentId": "sa-1"},
            accepted,
        ),
        (
            "subagent/resume",
            lambda s: s.resume_subagent("sa-1"),
            {"sessionId": "s-1", "subagentId": "sa-1"},
            accepted,
        ),
        (
            "subagent/reopen",
            lambda s: s.reopen_subagent("sa-1"),
            {"sessionId": "s-1", "subagentId": "sa-1"},
            accepted,
        ),
        (
            "subagent/close",
            lambda s: s.close_subagent("sa-1", reason="done"),
            {"reason": "done", "sessionId": "s-1", "subagentId": "sa-1"},
            accepted,
        ),
        (
            "subagent/readResult",
            lambda s: s.read_subagent_result("sa-1"),
            {"sessionId": "s-1", "subagentId": "sa-1"},
            accepted,
        ),
        (
            "plugin/install",
            lambda s: s.install_plugin({"marketplace": {"marketplace": "store", "name": "p"}}),
            {"sessionId": "s-1", "target": {"marketplace": {"marketplace": "store", "name": "p"}}},
            {"enabled": True, "id": "p@store", "status": "accepted", "version": "1"},
        ),
        (
            "skill/setActivation",
            lambda s: s.set_skill_activation(selector="lint", scope="project", activation="off"),
            {"activation": "off", "scope": "project", "selector": "lint", "sessionId": "s-1"},
            {"activation": "off", "previous": "on", "status": "accepted"},
        ),
    ]
    for method, call, params, result in cases:
        session, transport = _wired()
        pending = asyncio.ensure_future(call(session))
        await wait_for_writes(transport, 1)
        assert sent_frame(transport, 0)["method"] == method
        assert isinstance(sent_params(transport, 0).get("commandId"), str), f"{method} is a command"
        assert _without_command_id(transport, 0) == params, f"{method} sends the full params"
        echoed = {**result, "commandId": sent_params(transport, 0)["commandId"]}
        answer(transport, 0, echoed)
        assert await pending == echoed, f"{method} resolves the wire result"


@pytest.mark.asyncio
async def test_list_plugins_is_a_read_only_query() -> None:
    session, transport = _wired()
    pending = asyncio.ensure_future(session.list_plugins())
    await wait_for_writes(transport, 1)
    assert sent_frame(transport, 0)["method"] == "plugin/list"
    assert sent_params(transport, 0) == {"sessionId": "s-1"}
    answer(transport, 0, {"plugins": []})
    assert await pending == {"plugins": []}


@pytest.mark.asyncio
async def test_client_list_models_and_read_usage_are_queries() -> None:
    transport = FakeDuplex()
    client: MuseClient[Any] = MuseClient(
        Connection(transport), MuseClientOptions(durability=DURABLE)
    )
    catalog: Params = {"models": [], "profileId": None, "providerId": "p", "source": "bundled"}

    listing = asyncio.ensure_future(client.list_models({"sessionId": "s-1"}))
    await wait_for_writes(transport, 1)
    assert sent_frame(transport, 0)["method"] == "model/list"
    assert sent_params(transport, 0) == {"sessionId": "s-1"}
    answer(transport, 0, catalog)
    assert await listing == catalog

    bare = asyncio.ensure_future(client.list_models())
    await wait_for_writes(transport, 2)
    assert sent_params(transport, 1) == {}
    answer(transport, 1, catalog)
    await bare

    usage = asyncio.ensure_future(client.read_usage())
    await wait_for_writes(transport, 3)
    assert sent_frame(transport, 2)["method"] == "usage/read"
    assert "params" not in sent_frame(transport, 2)
    answer(transport, 2, {})
    assert await usage == {}


@pytest.mark.asyncio
async def test_fold_only_session_refuses_every_control_verb_and_still_folds() -> None:
    session: Session[str] = Session("s-1", DURABLE)
    for verb, call in _every_verb(session, session.turn("t-1")):
        with pytest.raises(RuntimeError, match="needs a connection"):
            await call()
        assert verb  # named for the failure message above
    # The refusal refuses only the send: local folding stays usable.
    session.apply(_user_message("m-1", "t-1"))
    assert session.fold.items.get("m-1") is not None


@pytest.mark.asyncio
async def test_discarded_session_refuses_every_control_verb_before_sending() -> None:
    transport = FakeDuplex()
    session: Session[str] = Session(
        "s-9",
        read_session_durability({"sessionDurability": "ephemeral"}),
        connection=Connection(transport),
    )
    crash = ExitClassification(
        kind="crash", exit_code=77, exit_signal=None, stderr_tail=("thread 'main' panicked",)
    )
    assert session.host_exited(crash).kind == "discharged"
    turn = session.turn("t-1")
    for verb, call in _every_verb(session, turn):
        with pytest.raises(MuseSessionDiscardedError):
            await call()
        assert verb
    await pump()
    assert transport.writes == []
    # Its own read surface keeps the discard semantics: the waiter was told.
    assert (await turn.completed).kind == "terminalUnknown"


class _AutoHost:
    """Answers each request from inside ``write`` (the sync loop is parked
    in the blocking verb, so frames cannot be fed from outside)."""

    def __init__(self) -> None:
        self.chunks = AsyncChunks()
        self.writes: list[str] = []

    @property
    def incoming(self) -> Any:
        return self.chunks

    async def write(self, chunk: str) -> None:
        self.writes.append(chunk)
        sent = json.loads(chunk)
        method = sent.get("method")
        if method == "shutdown":
            result: Params = {}
        elif method == "session/start":
            result = {
                "session": {"sessionId": "s-1", "status": "idle", "turnCount": 0},
                "viewCursor": "v:0",
            }
        else:
            # One generic ack is enough: these twins pass the result through.
            result = {"status": "accepted", "turnId": "t-1"}
        params = sent.get("params") or {}
        if "commandId" in params:
            result["commandId"] = params["commandId"]
        if "id" in sent:
            self.chunks.push(frame({"jsonrpc": "2.0", "id": sent["id"], "result": result}))

    async def close(self, flushed: object = None) -> None:
        if flushed is not None and hasattr(flushed, "__await__"):
            await flushed  # type: ignore[arg-type]
        self.chunks.end()


def test_every_sync_twin_sends_its_own_wire_method_and_params() -> None:
    host = _AutoHost()

    async def factory() -> MuseClient[Any]:
        return MuseClient(
            Connection(host), MuseClientOptions(durability=DURABLE)  # type: ignore[arg-type]
        )

    client: SyncMuseClient[str] = SyncMuseClient.create(factory)
    session = client.start_session()
    turn = session.turn("t-1")
    sa = {"sessionId": "s-1", "subagentId": "sa-1"}
    cases: list[tuple[Callable[[], Any], str, Params]] = [
        (lambda: turn.cancel(), "turn/cancel", {"sessionId": "s-1", "turnId": "t-1"}),
        (
            lambda: turn.interrupt(retract=True),
            "turn/interrupt",
            {"retract": True, "sessionId": "s-1", "turnId": "t-1"},
        ),
        (
            lambda: turn.steer(SteerTurnOptions(input=[{"type": "text", "text": "s"}])),
            "turn/steer",
            {"expectedTurnId": "t-1", "input": [{"type": "text", "text": "s"}], "sessionId": "s-1"},
        ),
        (lambda: turn.unqueue(), "turn/unqueue", {"sessionId": "s-1", "turnId": "t-1"}),
        (
            lambda: session.fork(exclude_items=True),
            "session/fork",
            {"excludeItems": True, "sessionId": "s-1"},
        ),
        (lambda: session.compact(turn_id="t-1"), "session/compact", {"sessionId": "s-1", "turnId": "t-1"}),
        (
            lambda: session.set_model({"modelId": "m"}),
            "session/setModel",
            {"model": {"modelId": "m"}, "sessionId": "s-1"},
        ),
        (
            lambda: session.set_reasoning_effort("low"),
            "session/setReasoningEffort",
            {"reasoningEffort": "low", "sessionId": "s-1"},
        ),
        (
            lambda: session.set_approval_mode("allowAll"),
            "session/setApprovalMode",
            {"mode": "allowAll", "sessionId": "s-1"},
        ),
        (lambda: session.rename("n"), "session/rename", {"name": "n", "sessionId": "s-1"}),
        (lambda: session.leave(stop=True), "session/leave", {"sessionId": "s-1", "stop": True}),
        (
            lambda: session.send_subagent_message("sa-1", "b"),
            "subagent/sendMessage",
            {**sa, "body": "b"},
        ),
        (
            lambda: session.followup_subagent_task("sa-1", "b"),
            "subagent/followupTask",
            {**sa, "body": "b"},
        ),
        (
            lambda: session.interrupt_subagent("sa-1", reason="r"),
            "subagent/interrupt",
            {**sa, "reason": "r"},
        ),
        (lambda: session.stop_subagent("sa-1", reason="r"), "subagent/stop", {**sa, "reason": "r"}),
        (lambda: session.resume_subagent("sa-1"), "subagent/resume", sa),
        (lambda: session.reopen_subagent("sa-1"), "subagent/reopen", sa),
        (lambda: session.close_subagent("sa-1", reason="r"), "subagent/close", {**sa, "reason": "r"}),
        (lambda: session.read_subagent_result("sa-1"), "subagent/readResult", sa),
        (lambda: session.list_plugins(), "plugin/list", {"sessionId": "s-1"}),
        (
            lambda: session.install_plugin({"localPath": {"path": "/p"}}),
            "plugin/install",
            {"sessionId": "s-1", "target": {"localPath": {"path": "/p"}}},
        ),
        (
            lambda: session.set_skill_activation(selector="k", scope="user", activation="off"),
            "skill/setActivation",
            {"activation": "off", "scope": "user", "selector": "k", "sessionId": "s-1"},
        ),
        (lambda: client.list_models({"sessionId": "s-1"}), "model/list", {"sessionId": "s-1"}),
        (lambda: client.read_usage(), "usage/read", {}),
    ]
    for call, method, params in cases:
        call()
        sent = json.loads(host.writes[-1])
        assert sent["method"] == method, f"expected {method}, sent {sent['method']}"
        sent_params_ = dict(sent.get("params") or {})
        sent_params_.pop("commandId", None)
        assert sent_params_ == params, f"{method} sends the full params"
    client.close()
