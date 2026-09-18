"""PY-the governing rule ``facade_turn_iterators_and_waits`` — the owning spec the governing rule
 and the governing rule, carrying the owning spec the governing rule / the governing rule / the governing rule

Port of ``clients/sdk-ts/test/facade-turn.test.ts`` and
``clients/sdk-ts/test/facade-ephemeral-host-death.test.ts``. The two arms the task names explicitly are the two the protocol
no-run exits of a pre-minted turn — ``turn/unqueued`` and the launch failure —
plus the durable/ephemeral host-death discharge.

Every event below is the generated params shape it names, so a member the
facade reads that the wire does not carry would fail ``mypy --strict`` here
rather than at runtime against a real host.
"""

from __future__ import annotations

from contextlib import aclosing
from typing import Any, AsyncIterator, List, TypeVar

import pytest

from muse_code import (
    DiscardedSessions,
    MuseClient,
    MuseClientOptions,
    MuseForeignSessionError,
    MuseHostDiedError,
    MuseSessionDiscardedError,
    ResumeSessionOptions,
    SendUserTurnOptions,
    Session,
    StartSessionOptions,
    is_launch_failure,
    read_session_durability,
)
from muse_code.connection import Connection
from muse_code.connection.spawn import ExitClassification
from muse_code.facade.host_death import TransportEof
from muse_code.fold.session_fold import (
    IgnoredMissingParams,
    IgnoredUnrecognizedMethod,
)
from muse_code.pending.pending_command_set import (
    MaterializedRetirement,
    ReclaimedRetirement,
    TerminalUnknownRetirement,
)

_T = TypeVar("_T")

SESSION = "s-1"
SOURCE: dict[str, Any] = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}

CRASH = ExitClassification(
    kind="crash", exit_code=77, exit_signal=None, stderr_tail=("thread 'main' panicked",)
)
CLEAN = ExitClassification(kind="cleanShutdown")


def _handshake(session_durability: str | None = None) -> dict[str, Any]:
    result: dict[str, Any] = {
        "experimentalApi": False,
        "grantedCapabilities": [],
        "museHome": "/home/agent/.muse",
        "platformFamily": "unix",
        "platformOs": "linux",
        "schema": {"fingerprint": "sha256:0", "version": 1},
        "serverInfo": {"name": "muse-session-server", "version": "0.9.4"},
        "userAgent": "muse-session-server/0.9.4",
    }
    if session_durability is not None:
        result["sessionDurability"] = session_durability
    return result


def session(session_durability: str | None = "durable") -> "Session[str]":
    return Session(SESSION, read_session_durability(_handshake(session_durability)))


def turn_started(turn_id: str, view_cursor: str) -> dict[str, Any]:
    return {
        "method": "turn/started",
        "params": {
            "commandId": turn_id,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "turnId": turn_id,
            "viewCursor": view_cursor,
        },
    }


def turn_completed(
    turn_id: str, terminal: str, view_cursor: str, error: dict[str, Any] | None = None
) -> dict[str, Any]:
    params: dict[str, Any] = {
        "sessionId": SESSION,
        "sourceRange": SOURCE,
        "terminal": terminal,
        "turnId": turn_id,
        "viewCursor": view_cursor,
    }
    if error is not None:
        params["error"] = error
    return {"method": "turn/completed", "params": params}


def turn_unqueued(
    turn_id: str, view_cursor: str, command_id: str | None = None
) -> dict[str, Any]:
    return {
        "method": "turn/unqueued",
        "params": {
            "commandId": command_id if command_id is not None else turn_id,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "turnId": turn_id,
            "viewCursor": view_cursor,
        },
    }


def turn_retry_scheduled(turn_id: str, view_cursor: str) -> dict[str, Any]:
    return {
        "method": "turn/retryScheduled",
        "params": {
            "attempt": 1,
            "maxAttempts": 3,
            "nextAttempt": 2,
            "reason": "provider stream disconnected",
            "retryDelayMs": 2_000,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "turnId": turn_id,
            "viewCursor": view_cursor,
        },
    }


def item(item_id: str, revision: int, **extra: Any) -> dict[str, Any]:
    return {
        "itemId": item_id,
        "kind": "agentMessage",
        "revision": revision,
        "status": "inProgress",
        **extra,
    }


def item_started(payload: dict[str, Any], view_cursor: str) -> dict[str, Any]:
    return {
        "method": "item/started",
        "params": {"item": payload, "sessionId": SESSION, "viewCursor": view_cursor},
    }


def item_updated(payload: dict[str, Any], view_cursor: str) -> dict[str, Any]:
    return {
        "method": "item/updated",
        "params": {
            "item": payload,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "viewCursor": view_cursor,
        },
    }


def item_completed(payload: dict[str, Any], view_cursor: str) -> dict[str, Any]:
    return {
        "method": "item/completed",
        "params": {
            "item": payload,
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "viewCursor": view_cursor,
        },
    }


def item_delta(item_id: str, delta: str, view_cursor: str) -> dict[str, Any]:
    return {
        "method": "item/delta",
        "params": {
            "delta": delta,
            "itemId": item_id,
            "sessionId": SESSION,
            "viewCursor": view_cursor,
        },
    }


async def drain(source: AsyncIterator[_T]) -> List[_T]:
    """Drain an async iterator that a settled turn has already closed."""
    out: List[_T] = []
    async for value in source:
        out.append(value)
    return out


async def wait_until(predicate: "Any", *, turns: int = 400) -> None:
    """Yield the loop until ``predicate()`` holds, bounded.

    Syncs on a real receipt (the observable state change), not a tuned tick
    budget: it returns the instant the predicate is true and the bound is only
    a suite-safety cap, exactly the shape of ``helpers_connection.wait_for_writes``.
    """
    import asyncio

    for _ in range(turns):
        if predicate():
            return
        await asyncio.sleep(0)
    assert predicate(), "predicate never held within the bound"


# ---- the governing rule: the turn wait settles on every no-run exit -------------------


@pytest.mark.asyncio
async def test_the_wait_settles_on_turn_completed_carrying_the_terminal() -> None:
    s = session()
    turn = s.turn("t-1")
    s.apply(turn_started("t-1", "v:1"))
    s.apply(turn_completed("t-1", "completed", "v:2"))

    outcome = await turn.completed
    assert outcome.kind == "completed"
    assert outcome.kind == "completed" and outcome.params["terminal"] == "completed"
    assert outcome.kind == "completed" and outcome.observed_start is True


@pytest.mark.asyncio
async def test_the_wait_settles_on_turn_unqueued_the_reclaim() -> None:
    s = session()
    turn = s.turn("t-queued")
    # A queued submit's turn is pre-minted at admission and never launches: no
    # turn/started precedes it and no turn/completed follows. A wait folding
    # only turn/completed hangs forever here.
    s.apply(turn_unqueued("t-queued", "v:1"))

    outcome = await turn.completed
    assert outcome.kind == "unqueued"
    assert outcome.kind == "unqueued" and outcome.params["turnId"] == "t-queued"


@pytest.mark.asyncio
async def test_the_wait_settles_on_the_launch_failure_no_preceding_started() -> None:
    s = session()
    turn = s.turn("t-launch-failed")
    # "deferred_start_failed": the launch errored at the
    # terminal boundary, so the runtime writes the pre-minted turn's terminal.
    error = {"kind": "launchError", "message": "workflow entry not found", "retryable": True}
    s.apply(turn_completed("t-launch-failed", "failed", "v:1", error))

    outcome = await turn.completed
    assert outcome.kind == "completed"
    assert outcome.kind == "completed" and outcome.params["terminal"] == "failed"
    # The discriminator is the WIRE marker, not local observation.
    assert is_launch_failure(outcome) is True
    assert outcome.kind == "completed" and outcome.observed_start is False


@pytest.mark.asyncio
async def test_observed_start_false_alone_is_not_a_launch_failure() -> None:
    s = session()
    turn = s.turn("t-single-shot")
    # A single-shot turn or a mid-stream attach produces a terminal-first
    # turn/completed for a turn that really DID run.
    s.apply(turn_completed("t-single-shot", "completed", "v:1"))

    outcome = await turn.completed
    assert outcome.kind == "completed" and outcome.observed_start is False
    assert is_launch_failure(outcome) is False


@pytest.mark.asyncio
async def test_a_plain_failed_turn_is_not_a_launch_failure() -> None:
    s = session()
    turn = s.turn("t-1")
    s.apply(turn_started("t-1", "v:1"))
    s.apply(
        turn_completed(
            "t-1",
            "failed",
            "v:2",
            {"kind": "modelError", "message": "provider refused", "retryable": False},
        )
    )
    assert is_launch_failure(await turn.completed) is False


@pytest.mark.asyncio
async def test_turn_retry_scheduled_never_settles_the_wait() -> None:
    s = session()
    turn = s.turn("t-1")
    s.apply(turn_started("t-1", "v:1"))
    s.apply(turn_retry_scheduled("t-1", "v:2"))

    settled = False

    async def watch() -> None:
        nonlocal settled
        await turn.completed
        settled = True

    import asyncio

    watcher = asyncio.ensure_future(watch())
    for _ in range(5):
        await asyncio.sleep(0)
    assert settled is False, "a scheduled retry is a fact about a RUNNING turn"

    s.apply(turn_completed("t-1", "completed", "v:3"))
    assert (await turn.completed).kind == "completed"
    await watcher


@pytest.mark.asyncio
async def test_a_wait_registered_after_settlement_resolves_from_fold_state() -> None:
    s = session()
    s.apply(turn_started("t-1", "v:1"))
    s.apply(turn_completed("t-1", "completed", "v:2"))
    # A late waiter must not hang for an event that has come and gone.
    assert (await s.turn("t-1").completed).kind == "completed"


@pytest.mark.asyncio
async def test_two_handles_for_the_same_turn_are_the_same_handle() -> None:
    s = session()
    first = s.turn("t-1")
    second = s.turn("t-1")
    assert first is second
    s.apply(turn_unqueued("t-1", "v:1"))
    assert (await second.completed).kind == "unqueued"


# ---- the governing rule: the iterators ride the fold ------------------------------


@pytest.mark.asyncio
async def test_items_yields_this_turns_items_and_closes_on_settle() -> None:
    s = session()
    turn = s.turn("t-1")
    items = turn.items()

    s.apply(turn_started("t-1", "v:1"))
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:2"))
    # Another turn's item never enters this turn's iterator.
    s.apply(item_started(item("i-other", 1, turnId="t-2"), "v:3"))
    # A stale re-emission mutates nothing, so it yields nothing.
    s.apply(item_completed(item("i-1", 1, turnId="t-1", status="completed"), "v:4"))
    s.apply(item_completed(item("i-1", 2, turnId="t-1", status="completed"), "v:5"))
    s.apply(turn_completed("t-1", "completed", "v:6"))

    seen = await drain(items)
    assert [(e["itemId"], e["revision"], e["status"]) for e in seen] == [
        ("i-1", 1, "inProgress"),
        ("i-1", 2, "completed"),
    ]


@pytest.mark.asyncio
async def test_items_replays_folded_items_before_the_live_tail() -> None:
    s = session()
    s.apply(turn_started("t-1", "v:1"))
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:2"))

    # Created AFTER i-1 folded: a mid-turn attach must not be handed a hole.
    items = s.turn("t-1").items()
    s.apply(item_started(item("i-2", 1, turnId="t-1"), "v:3"))
    s.apply(turn_completed("t-1", "completed", "v:4"))

    assert [e["itemId"] for e in await drain(items)] == ["i-1", "i-2"]


@pytest.mark.asyncio
async def test_deltas_yields_this_turns_deltas_and_closes_on_settle() -> None:
    s = session()
    turn = s.turn("t-1")
    deltas = turn.deltas()

    s.apply(turn_started("t-1", "v:1"))
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:2"))
    s.apply(item_delta("i-1", "All ", "v:3"))
    s.apply(item_delta("i-1", "214 tests pass", "v:4"))
    s.apply(item_started(item("i-other", 1, turnId="t-2"), "v:5"))
    s.apply(item_delta("i-other", "not mine", "v:6"))
    s.apply(turn_completed("t-1", "completed", "v:7"))

    seen = await drain(deltas)
    assert [e["delta"] for e in seen] == ["All ", "214 tests pass"]
    # the governing rule: what the iterator emitted concatenates to what the fold holds.
    assert "".join(e["delta"] for e in seen) == s.fold.items.accumulated("i-1")


@pytest.mark.asyncio
async def test_a_delta_before_its_item_is_attributed_on_arrival() -> None:
    s = session()
    turn = s.turn("t-1")
    deltas = turn.deltas()

    s.apply(turn_started("t-1", "v:1"))
    # Delta before started: the store buffers it against the item's arrival.
    s.apply(item_delta("i-1", "early", "v:2"))
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:3"))
    s.apply(item_delta("i-1", " late", "v:4"))
    s.apply(turn_completed("t-1", "completed", "v:5"))

    assert [e["delta"] for e in await drain(deltas)] == ["early", " late"]


@pytest.mark.asyncio
async def test_two_deltas_before_their_item_both_come_out() -> None:
    s = session()
    turn = s.turn("t-1")
    deltas = turn.deltas()

    s.apply(turn_started("t-1", "v:1"))
    s.apply(item_delta("i-1", "ear", "v:2"))
    s.apply(item_delta("i-1", "ly", "v:3"))
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:4"))
    s.apply(turn_completed("t-1", "completed", "v:5"))

    assert [e["delta"] for e in await drain(deltas)] == ["ear", "ly"]


@pytest.mark.asyncio
async def test_an_iterator_opened_on_a_settled_turn_closes() -> None:
    s = session()
    s.apply(turn_started("t-1", "v:1"))
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:2"))
    s.apply(turn_completed("t-1", "completed", "v:3"))

    assert [e["itemId"] for e in await drain(s.turn("t-1").items())] == ["i-1"]
    assert await drain(s.turn("t-1").deltas()) == []


@pytest.mark.asyncio
async def test_an_unqueued_turns_iterators_close() -> None:
    s = session()
    turn = s.turn("t-queued")
    items = turn.items()
    deltas = turn.deltas()
    s.apply(turn_unqueued("t-queued", "v:1"))

    assert await drain(items) == []
    assert await drain(deltas) == []


@pytest.mark.asyncio
async def test_item_updated_fans_out_every_mid_turn_revision() -> None:
    s = session()
    turn = s.turn("t-1")
    items = turn.items()

    s.apply(turn_started("t-1", "v:1"))
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:2"))
    s.apply(item_updated(item("i-1", 2, turnId="t-1"), "v:3"))
    s.apply(turn_completed("t-1", "completed", "v:4"))

    assert [e["revision"] for e in await drain(items)] == [1, 2]


@pytest.mark.asyncio
async def test_a_usershell_null_turn_id_mints_no_phantom_turn() -> None:
    s = session()
    turn = s.turn("t-1")
    items = turn.items()

    s.apply(turn_started("t-1", "v:1"))
    shell = item("i-shell", 1, kind="userShell", turnId=None)
    s.apply(item_started(shell, "v:2"))
    s.apply(item_delta("i-shell", "output", "v:3"))
    s.apply(turn_completed("t-1", "completed", "v:4"))

    assert await drain(items) == [], "a turn-less item belongs to no turn's iterator"
    assert s.known_turn_count == 1, "no phantom turn minted for the null turnId"
    got = s.fold.items.get("i-shell")
    assert got is not None and got["itemId"] == "i-shell"


@pytest.mark.asyncio
async def test_closing_an_iterator_deregisters_it() -> None:
    s = session()
    turn = s.turn("t-1")
    s.apply(turn_started("t-1", "v:1"))

    # The TS twin relies on ``for await ... break`` calling the iterator's
    # ``return()``. Python's ``async for ... break`` does NOT call ``aclose``
    # on a manual async iterator, so the deregistration contract is fulfilled
    # through the async-close path — ``async with aclosing(...)`` — which the
    # facade's iterators support and which is the Python idiom for a
    # deterministically-closed stream (see the port note in ``turn_handle``).
    for round_index in range(50):
        s.apply(item_started(item(f"i-{round_index}", 1, turnId="t-1"), f"v:{round_index + 2}"))
        async with aclosing(turn.items()) as items:
            async for _first in items:
                break
    # Reaches the concrete handle deliberately: live_stream_count is test-only.
    assert turn.live_stream_count == 0  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_two_concurrent_next_calls_both_settle_in_order() -> None:
    import asyncio

    s = session()
    turn = s.turn("t-1")
    s.apply(turn_started("t-1", "v:1"))
    items = turn.items()

    both = asyncio.gather(items.__anext__(), items.__anext__())
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:2"))
    s.apply(item_started(item("i-2", 1, turnId="t-1"), "v:3"))

    first, second = await both
    assert [first["itemId"], second["itemId"]] == ["i-1", "i-2"]


# ---- the protocol: apply() drives the pending set's ordinary retirements ---------


def test_a_command_id_bearing_user_message_materializes_its_entry() -> None:
    s: "Session[str]" = session()
    s.pending.submitted("c-1", "fix the test")
    s.apply(turn_started("t-1", "v:1"))
    user_message = item("i-user", 1, turnId="t-1", commandId="c-1", kind="userMessage")
    outcome = s.apply(item_started(user_message, "v:2"))

    assert outcome.retirements == (
        MaterializedRetirement(command_id="c-1", matched_by="userMessage", item_id="i-user"),
    )
    assert s.pending.has("c-1") is False


def test_a_user_message_from_another_client_retires_nothing() -> None:
    s: "Session[str]" = session()
    foreign = item("i-user", 1, turnId="t-1", commandId="c-someone-else", kind="userMessage")
    assert s.apply(item_started(foreign, "v:1")).retirements == ()


@pytest.mark.asyncio
async def test_turn_unqueued_retires_its_entry_as_reclaimed() -> None:
    s: "Session[str]" = session()
    # DISTINCT ids: a commandId (client-minted) and a turnId (server-minted)
    # never collide on the wire, so the join key must be the commandId.
    s.pending.submitted("c-q", "and the lint")
    outcome = s.apply(turn_unqueued("t-queued", "v:1", command_id="c-q"))

    assert outcome.retirements == (
        ReclaimedRetirement(command_id="c-q", input="and the lint"),
    )
    assert s.pending.has("c-q") is False
    # And the wait on the TURN still settles — two independent obligations.
    assert (await s.turn("t-queued").completed).kind == "unqueued"


def test_a_materialized_entry_is_not_re_retired_by_a_later_death() -> None:
    s: "Session[str]" = session("ephemeral")
    s.pending.submitted("c-1", "fix the test")
    user_message = item("i-user", 1, turnId="t-1", commandId="c-1", kind="userMessage")
    s.apply(item_started(user_message, "v:1"))

    discharge = s.host_exited(CRASH)
    assert discharge.kind == "discharged"
    assert discharge.kind == "discharged" and discharge.retired_commands == ()


# ---- the protocol tolerance survives the foreign-session guard ------------------


def test_an_unknown_notification_without_session_id_is_tolerated() -> None:
    s = session()
    unknown = {"method": "view/somethingNew", "params": {"viewCursor": "v:1"}}
    assert isinstance(s.apply(unknown).fold, IgnoredUnrecognizedMethod)
    bare = {"method": "view/bare"}
    assert isinstance(s.apply(bare).fold, IgnoredMissingParams)


def test_a_frame_naming_a_foreign_session_is_refused() -> None:
    s = session()
    foreign = {
        "method": "item/started",
        "params": {"item": item("i-x", 1), "sessionId": "other", "viewCursor": "v:1"},
    }
    with pytest.raises(MuseForeignSessionError):
        s.apply(foreign)
    assert s.fold.items.size == 0


# ---- the governing rule: host-death discharge ------------------------------


def test_reading_the_profile_off_the_handshake() -> None:
    assert read_session_durability(_handshake()).kind == "durable"
    assert read_session_durability(_handshake("durable")).kind == "durable"
    assert read_session_durability(_handshake("ephemeral")).kind == "ephemeral"
    unrecognized = read_session_durability(_handshake("degraded"))
    assert unrecognized.kind == "unrecognized"
    assert unrecognized.kind == "unrecognized" and unrecognized.value == "degraded"


def test_a_clean_shutdown_is_not_a_death() -> None:
    assert session("ephemeral").host_exited(CLEAN).kind == "notADeath"


def test_the_three_outcomes_are_distinguishable() -> None:
    assert session("ephemeral").host_exited(CLEAN).kind == "notADeath"
    assert session("durable").host_exited(CRASH).kind == "durableDeath"
    assert session("ephemeral").host_exited(CRASH).kind == "discharged"


def test_a_durable_death_leaves_both_stores_as_observed() -> None:
    s: "Session[str]" = session("durable")
    s.apply(item_started(item("i-1", 1), "v:1"))
    s.pending.submitted("c-1", "x")

    assert s.host_exited(CRASH).kind == "durableDeath"
    got = s.fold.items.get("i-1")
    assert got is not None and got["status"] == "inProgress"
    assert s.fold.items.is_terminal_unknown("i-1") is False
    assert s.pending.size == 1
    assert s.pending.discarded is False


def test_ephemeral_death_marks_in_progress_items_unknown() -> None:
    s: "Session[str]" = session("ephemeral")
    s.apply(item_started(item("i-running", 1), "v:1"))
    s.apply(item_started(item("i-done", 1, status="completed"), "v:2"))

    discharge = s.host_exited(CRASH)
    assert discharge.kind == "discharged"
    assert discharge.kind == "discharged" and [
        a.item_id for a in discharge.terminal_unknown_items
    ] == ["i-running"]
    assert s.fold.items.is_terminal_unknown("i-running") is True
    assert s.fold.items.is_terminal_unknown("i-done") is False


def test_pending_commands_retire_terminal_unknown_no_restore() -> None:
    s: "Session[str]" = session("ephemeral")
    s.pending.submitted("c-1", "fix the test")
    s.pending.submitted("c-2", "and the lint")

    discharge = s.host_exited(CRASH)
    assert discharge.kind == "discharged"
    assert discharge.kind == "discharged" and discharge.retired_commands == (
        TerminalUnknownRetirement(command_id="c-1", input="fix the test"),
        TerminalUnknownRetirement(command_id="c-2", input="and the lint"),
    )
    assert s.pending.size == 0
    # This retirement carries no restore_to_composer: the client does not know
    # whether the work ran, and offering it back invites double execution.
    for retirement in discharge.retired_commands:
        assert not hasattr(retirement, "restore_to_composer")


def test_a_discarded_session_refuses_further_submits() -> None:
    s: "Session[str]" = session("ephemeral")
    s.pending.submitted("c-1", "x")
    s.host_exited(CRASH)
    with pytest.raises(MuseSessionDiscardedError):
        s.pending.submitted("c-1", "x")
    with pytest.raises(MuseSessionDiscardedError):
        s.pending.submitted("c-new", "y")


def test_a_discarded_session_refuses_further_inbound_events() -> None:
    s: "Session[str]" = session("ephemeral")
    s.apply(item_started(item("i-1", 1), "v:1"))
    s.host_exited(CRASH)
    assert s.apply(item_started(item("i-2", 1), "v:2")).fold.kind == "refusedSessionDiscarded"
    assert s.fold.items.has("i-2") is False


def test_a_discarded_session_refuses_non_item_events_too() -> None:
    s: "Session[str]" = session("ephemeral")
    s.host_exited(CRASH)
    zombie = turn_completed("t-zombie", "completed", "v:9")
    assert s.apply(zombie).fold.kind == "refusedSessionDiscarded"
    assert s.fold.turn("t-zombie") is None


def test_the_discharge_is_latched_second_notification_replays_the_first() -> None:
    s: "Session[str]" = session("ephemeral")
    s.apply(item_started(item("i-1", 1), "v:1"))
    s.pending.submitted("c-1", "x")

    first = s.host_exited(CRASH)
    second = s.host_exited(CRASH)
    assert first.kind == "discharged" and second.kind == "discharged"
    assert second.kind == "discharged" and first.kind == "discharged"
    assert second.terminal_unknown_items == first.terminal_unknown_items
    assert second.retired_commands == first.retired_commands
    assert len(second.retired_commands) == 1


def test_the_discharge_carries_the_exit_classification() -> None:
    discharge = session("ephemeral").host_exited(CRASH)
    assert discharge.kind == "discharged" and discharge.exit is CRASH
    assert discharge.kind == "discharged" and discharge.profile.kind == "ephemeral"


@pytest.mark.asyncio
async def test_clause_1_a_live_turn_wait_settles_terminal_unknown() -> None:
    s: "Session[str]" = session("ephemeral")
    turn = s.turn("t-1")
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:1"))
    s.host_exited(CRASH)
    outcome = await turn.completed
    assert outcome.kind == "terminalUnknown"


@pytest.mark.asyncio
async def test_an_ephemeral_deaths_iterators_close() -> None:
    s: "Session[str]" = session("ephemeral")
    turn = s.turn("t-1")
    items = turn.items()
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:1"))
    s.host_exited(CRASH)
    assert [e["itemId"] for e in await drain(items)] == ["i-1"]


@pytest.mark.asyncio
async def test_a_durable_death_rejects_the_wait_with_the_classification() -> None:
    s: "Session[str]" = session()
    turn = s.turn("t-1")
    s.host_exited(CRASH)
    with pytest.raises(MuseHostDiedError) as excinfo:
        await turn.completed
    assert excinfo.value.exit.kind == "crash"
    assert "exit code 77" in str(excinfo.value)


@pytest.mark.asyncio
async def test_an_iterator_opened_after_a_durable_death_replays_then_reports() -> None:
    s: "Session[str]" = session()
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:1"))
    s.turn("t-1")
    s.host_exited(CRASH)

    seen: List[dict[str, Any]] = []
    with pytest.raises(MuseHostDiedError):
        async for entry in s.turn("t-1").items():
            seen.append(entry)
    assert [e["itemId"] for e in seen] == ["i-1"]


@pytest.mark.asyncio
async def test_a_turn_minted_after_an_ephemeral_death_settles() -> None:
    s: "Session[str]" = session("ephemeral")
    s.host_exited(CRASH)
    assert (await s.turn("t-late").completed).kind == "terminalUnknown"


@pytest.mark.asyncio
async def test_a_turn_minted_after_a_durable_death_rejects() -> None:
    s: "Session[str]" = session()
    s.host_exited(CRASH)
    with pytest.raises(MuseHostDiedError):
        await s.turn("t-late").completed


@pytest.mark.asyncio
async def test_a_durable_death_into_an_open_iterator_drains_then_reports() -> None:
    s: "Session[str]" = session()
    turn = s.turn("t-1")
    items = turn.items()
    s.apply(item_started(item("i-1", 1, turnId="t-1"), "v:1"))
    s.host_exited(CRASH)

    first = await items.__anext__()
    assert first["itemId"] == "i-1"
    with pytest.raises(MuseHostDiedError):
        await items.__anext__()


@pytest.mark.asyncio
async def test_a_signal_kill_names_the_signal() -> None:
    s: "Session[str]" = session()
    turn = s.turn("t-1")
    s.host_exited(
        ExitClassification(kind="crash", exit_code=None, exit_signal="SIGKILL", stderr_tail=())
    )
    with pytest.raises(MuseHostDiedError) as excinfo:
        await turn.completed
    assert "signal SIGKILL" in str(excinfo.value)


def test_a_transport_eof_is_an_abnormal_death_for_an_ephemeral_session() -> None:
    s: "Session[str]" = session("ephemeral")
    s.pending.submitted("c-1", "x")
    discharge = s.host_exited(TransportEof())
    assert discharge.kind == "discharged"


# ---- the governing rule: MuseClient session verbs over a transport ---------
#
# The arms above drive a fold-only ``Session`` directly; these drive a wired
# ``MuseClient`` over the loopback ``FakeDuplex`` the S2 connection suites use,
# so the session verbs, ``send_user_turn``, and the client's inbound routing
# are exercised end to end.

from helpers_connection import FakeDuplex, frame, wait_for_writes  # noqa: E402


def _client(durability: str = "durable") -> "tuple[MuseClient[Any], FakeDuplex]":
    transport = FakeDuplex()
    connection = Connection(transport)
    client: MuseClient[Any] = MuseClient(
        connection,
        MuseClientOptions(durability=read_session_durability(_handshake(durability))),
    )
    return client, transport


async def _read_last_frame(transport: FakeDuplex, count: int) -> dict[str, Any]:
    import json

    await wait_for_writes(transport, count)
    return json.loads(transport.writes[count - 1])  # type: ignore[no-any-return]


@pytest.mark.asyncio
async def test_start_session_sends_the_verb_and_keys_by_the_servers_id() -> None:
    import asyncio

    client, transport = _client()
    pending = asyncio.ensure_future(
        client.start_session(StartSessionOptions(workspace_root="/repo"))
    )
    sent = await _read_last_frame(transport, 1)
    assert sent["method"] == "session/start"
    assert sent["params"]["workspaceRoot"] == "/repo"
    # session/start result may omit the redundant commandId echo.
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": sent["id"],
                "result": {"session": {"sessionId": SESSION}, "viewCursor": "v:0"},
            }
        )
    )
    session_obj = await pending
    assert session_obj.session_id == SESSION
    await client.close()


@pytest.mark.asyncio
async def test_send_user_turn_then_routed_events_reach_the_turn_handle() -> None:
    import asyncio

    client, transport = _client()
    start = asyncio.ensure_future(client.start_session())
    started = await _read_last_frame(transport, 1)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": started["id"],
                "result": {"session": {"sessionId": SESSION}, "viewCursor": "v:0"},
            }
        )
    )
    session_obj = await start

    turn_future = asyncio.ensure_future(
        session_obj.send_user_turn(
            SendUserTurnOptions(input=[{"type": "text", "text": "hello"}])
        )
    )
    turn_start = await _read_last_frame(transport, 2)
    assert turn_start["method"] == "turn/start"
    command_id = turn_start["params"]["commandId"]
    # turn/start result DOES carry commandId and must echo it exactly.
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": turn_start["id"],
                "result": {
                    "commandId": command_id,
                    "turnId": "t-1",
                    "disposition": "started",
                },
            }
        )
    )
    turn = await turn_future
    assert turn.turn_id == "t-1"

    # The client routes a view NOTIFICATION to the session that names it. Over
    # the wire these carry the JSON-RPC envelope (the fold-only arms above hand
    # bare method/params straight to ``apply``; the connection requires 2.0).
    def notify(event: dict[str, Any]) -> str:
        return frame({"jsonrpc": "2.0", **event})

    transport.chunks.push(notify(turn_started("t-1", "v:1")))
    transport.chunks.push(notify(item_started(item("i-1", 1, turnId="t-1"), "v:2")))
    transport.chunks.push(notify(turn_completed("t-1", "completed", "v:3")))

    outcome = await turn.completed
    assert outcome.kind == "completed"
    got = session_obj.fold.items.get("i-1")
    assert got is not None and got["itemId"] == "i-1"
    await client.close()


@pytest.mark.asyncio
async def test_a_frame_for_an_unknown_session_is_dropped_by_the_router() -> None:
    import asyncio

    client, transport = _client()
    start = asyncio.ensure_future(client.start_session())
    started = await _read_last_frame(transport, 1)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": started["id"],
                "result": {"session": {"sessionId": SESSION}, "viewCursor": "v:0"},
            }
        )
    )
    session_obj = await start
    # A notification naming ANOTHER session must not reach this session (which
    # would trip its foreign-frame guard); the router drops it.
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "method": "item/started",
                "params": {
                    "item": item("i-x", 1),
                    "sessionId": "other-session",
                    "viewCursor": "v:1",
                },
            }
        )
    )
    # Distinguish a correct DROP from a connection blown up by a broadcast: a
    # valid frame for the known session still folds afterward. Both frames ride
    # the read loop FIFO, so once the second has folded the first was already
    # processed — syncing on that receipt (i-mine folded) also proves the
    # foreign frame did not fold. With the router guard removed (broadcast), the
    # foreign frame would reach this session and raise MuseForeignSessionError
    # in the read loop.
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "method": "item/started",
                "params": {
                    "item": item("i-mine", 1),
                    "sessionId": SESSION,
                    "viewCursor": "v:2",
                },
            }
        )
    )
    await wait_until(lambda: session_obj.fold.items.has("i-mine"))
    assert session_obj.fold.items.has("i-x") is False
    await client.close()


@pytest.mark.asyncio
async def test_a_transport_eof_the_client_did_not_cause_discharges_its_sessions() -> None:
    import asyncio

    # its task SECOND host-death notification, through the client wiring: an EOF
    # the client did NOT cause (not from close()) reaches every open session as
    # a TransportEof, and an ephemeral session discharges.
    client, transport = _client("ephemeral")
    start = asyncio.ensure_future(client.start_session())
    started = await _read_last_frame(transport, 1)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": started["id"],
                "result": {"session": {"sessionId": SESSION}, "viewCursor": "v:0"},
            }
        )
    )
    session_obj = await start
    turn = session_obj.turn("t-open")

    # The host closes its stdout: an abnormal EOF, not an orderly close().
    transport.chunks.end()
    outcome = await turn.completed
    assert outcome.kind == "terminalUnknown"
    assert session_obj.fold.items.ephemeral_session_discarded is True


# ---- P0 (client.py): fail-closed reattach-withhold and discharge -----------
#
# Port of the facade-client.test.ts fail-closed arms. Mutation
# testing at the skeleton head showed these behaviours had ZERO failing tests;
# these arms red the mutants: reattach no-op'd (the resume-withhold arms), the
# `_closing` guard deleted (the orderly-close arm), and — through the CLIENT
# wiring — `_open_session` passing a fresh `DiscardedSessions()` instead of
# `self._discarded` (the shared-store arm below).


async def _open_ephemeral_client_session() -> "tuple[MuseClient[Any], FakeDuplex, Session[Any]]":
    import asyncio

    client, transport = _client("ephemeral")
    start = asyncio.ensure_future(client.start_session())
    started = await _read_last_frame(transport, 1)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": started["id"],
                "result": {"session": {"sessionId": SESSION}, "viewCursor": "v:0"},
            }
        )
    )
    return client, transport, await start


@pytest.mark.asyncio
async def test_resume_is_withheld_after_an_ephemeral_death_no_wire_frame() -> None:
    import asyncio

    client, transport, _session_obj = await _open_ephemeral_client_session()
    # The ephemeral host dies (EOF the client did not cause).
    transport.chunks.end()
    # Sync on the exact receipt, not a tick budget: _closed_watch is
    # the client's task that awaits the connection's EOF and then runs
    # _transport_closed, so awaiting it means the discharge has happened.
    await client._closed_watch
    writes_before = len(transport.writes)
    # the protocol clause 2: reattach is refused on THIS side of the transport,
    # both for the discarded session id and for a never-seen one (the client's
    # own ephemeral host is gone). No session/resume frame reaches the wire.
    with pytest.raises(MuseSessionDiscardedError):
        await client.resume_session(ResumeSessionOptions(session_id=SESSION))
    with pytest.raises(MuseSessionDiscardedError):
        await client.resume_session(ResumeSessionOptions(session_id="never-seen"))
    assert len(transport.writes) == writes_before


@pytest.mark.asyncio
async def test_resume_after_a_durable_death_is_not_withheld() -> None:
    import asyncio

    client, transport = _client("durable")
    start = asyncio.ensure_future(client.start_session())
    started = await _read_last_frame(transport, 1)
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": started["id"],
                "result": {"session": {"sessionId": SESSION}, "viewCursor": "v:0"},
            }
        )
    )
    await start
    transport.chunks.end()
    # Sync on the exact receipt, not a tick budget: _closed_watch is
    # the client's task that awaits the connection's EOF and then runs
    # _transport_closed, so awaiting it means the discharge has happened.
    await client._closed_watch
    # A DURABLE session survives its host, so the withhold must NOT
    # fire — resume gets past the client-side gate to the wire (where the dead
    # connection then errors). The point is the error is not the withhold.
    with pytest.raises(Exception) as excinfo:
        await client.resume_session(ResumeSessionOptions(session_id=SESSION))
    assert not isinstance(excinfo.value, MuseSessionDiscardedError)


@pytest.mark.asyncio
async def test_an_orderly_close_discharges_no_session() -> None:
    client, transport, session_obj = await _open_ephemeral_client_session()
    # An orderly close() is not a host death: the EOF it produces must not
    # discharge the session (the _closing guard). With that guard deleted the
    # ephemeral session would discard here.
    await client.close()
    assert session_obj.fold.items.ephemeral_session_discarded is False


def test_a_discarded_command_id_is_refused_by_a_sibling_session() -> None:
    # The shared DiscardedSessions SEMANTICS at the Session level: a commandId
    # an ephemeral discharge retired in one session must be refused by a FRESH
    # sibling session that shares the store (the exactly-once violation
    # the protocol prevents). The CLIENT-wiring arm below proves MuseClient
    # actually hands each session that shared store.
    shared = DiscardedSessions()
    ephemeral = read_session_durability(_handshake("ephemeral"))
    first: "Session[str]" = Session(SESSION, ephemeral, discarded=shared)
    first.pending.submitted("c-1", "x")
    first.host_exited(CRASH)
    assert "c-1" in shared.command_ids

    sibling: "Session[str]" = Session("s-2", ephemeral, discarded=shared)
    with pytest.raises(MuseSessionDiscardedError):
        sibling.pending.submitted("c-1", "x")


@pytest.mark.asyncio
async def test_the_client_wires_its_shared_discard_store_into_each_session() -> None:
    import asyncio

    # The CLIENT half the Session-level arm above cannot reach: MuseClient's
    # `_open_session` must pass `self._discarded` (not a fresh set) into each
    # session, so an ephemeral discharge accumulates into the ONE client-scoped
    # store the protocol's cross-session clauses read. Mutating that argument to a
    # fresh `DiscardedSessions()` leaves the store empty here — this arm reds it.
    client, transport, session_obj = await _open_ephemeral_client_session()
    session_obj.pending.submitted("c-1", "x")
    transport.chunks.end()  # ephemeral EOF the client did not cause
    # Sync on the exact receipt, not a tick budget: _closed_watch runs
    # _transport_closed, which discharges every session into the shared store.
    await client._closed_watch
    assert "c-1" in client._discarded.command_ids
    assert session_obj.session_id in client._discarded.session_ids


# ---- P1 (session.py): the durable end-of-drain sweep -----------------------


@pytest.mark.asyncio
async def test_durable_end_of_drain_sweep_settles_drain_minted_turns() -> None:
    import asyncio

    s: "Session[str]" = session("durable")
    assert s.host_exited(CRASH).kind == "durableDeath"
    # the governing rule: a durable death does not stop the fold, so a turn/started arriving
    # after the FIRST notification mints a handle (via routing, never
    # pre-failed) whose terminal never comes.
    s.apply(turn_started("t-drain", "v:1"))
    completed = s.turn("t-drain").completed
    # The SECOND notification is end-of-drain and MUST sweep that handle, or its
    # wait hangs forever. wait_for fails fast under the
    # sweep-removed mutant instead of hanging the suite.
    s.host_exited(CRASH)
    with pytest.raises(MuseHostDiedError):
        await asyncio.wait_for(completed, timeout=1.0)


# ---- P1 (session.py): the protocol queue-movement drives a replay on the wire ----


@pytest.mark.asyncio
async def test_queue_movement_drives_a_replay_on_the_wire() -> None:
    import asyncio

    transport = FakeDuplex()
    conn = Connection(transport)
    s: "Session[str]" = Session(
        SESSION, read_session_durability(_handshake("durable")), connection=conn
    )

    # Submit c-1; its ack says it was QUEUED behind turn t-1.
    turn_fut = asyncio.ensure_future(
        s.send_user_turn(SendUserTurnOptions(input=[{"type": "text", "text": "hi"}]))
    )
    sent = await _read_last_frame(transport, 1)
    command_id = sent["params"]["commandId"]
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": sent["id"],
                "result": {
                    "commandId": command_id,
                    "turnId": "t-1",
                    "disposition": "queued",
                },
            }
        )
    )
    await turn_fut

    # A turn/started for ANOTHER turn decides c-1's fate at a launch boundary:
    # the protocol queue movement, so the SDK MUST replay c-1 — a turn/start on the
    # wire carrying the SAME commandId. Mutating _queue_moved to `return` emits
    # no second frame and this arm times out.
    outcome = s.apply(
        {
            "method": "turn/started",
            "params": {
                "commandId": "t-other",
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "turnId": "t-other",
                "viewCursor": "v:9",
            },
        }
    )
    replay = await _read_last_frame(transport, 2)
    assert replay["method"] == "turn/start"
    assert replay["params"]["commandId"] == command_id
    transport.chunks.push(
        frame(
            {
                "jsonrpc": "2.0",
                "id": replay["id"],
                "result": {
                    "commandId": command_id,
                    "turnId": "t-1",
                    "disposition": "queued",
                },
            }
        )
    )
    await outcome.io
    await conn.close()
