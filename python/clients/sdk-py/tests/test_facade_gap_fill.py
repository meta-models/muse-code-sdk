"""PY-TEST-015 ``gap_splice_fill_inside_iterators`` — spec 638 FR-638-019c
(T032), carrying spec 14990 FR-020 / TEST-014; tdd SS4.8.

Port of ``clients/sdk-ts/test/facade-gap-fill.test.ts`` (spec 638 INV-638-04
parity). ``view/gap`` is the delivery-plane marker: push delivery dropped
everything in the open interval ``(after, next)``, and until the client fills
it the fold is not current. What a consumer sees is FR-638-019c's contract,
stated in terms of the ITERATORS: a gap is a PAUSE, then the filled sequence
in cursor order, and a fill that cannot complete is a typed error rather than
a silent hole. Every arm below drives a real ``view/page`` frame out of the
fake duplex, or asserts that none was written.

CURSORS ARE OPAQUE (tdd SS4.1). Nothing here — and nothing in the
implementation — orders two cursors relationally; the walk stops on cursor
EQUALITY with ``next`` or on the server's own end-of-view, and the overlap is
discarded by cursor equality against a set. The ``v:<n>`` spellings are
illustrative, exactly as they are in the tdd.
"""

from __future__ import annotations

import asyncio
from typing import Any, List

import pytest

from muse_code import MuseGapFillError, SendUserTurnOptions, Session, read_session_durability
from muse_code.connection import Connection
from muse_code.facade import Turn
from muse_code.connection.spawn import ExitClassification
from muse_code.fold.session_fold import DeliveryGap, TurnFold

from helpers_connection import (
    FakeDuplex,
    answer,
    answer_error,
    pump,
    sent_frame,
    sent_params,
    settled_io,
    wait_for_writes,
)

Params = dict[str, Any]

SESSION = "s-1"
TURN = "t-1"

SOURCE: Params = {
    "first": {"id": "e-1", "sequence": 1},
    "last": {"id": "e-1", "sequence": 1},
    "stream": {"id": "str-1", "kind": "session"},
}

QUEUED_ACK: Params = {
    "commandId": "mint-0",
    "disposition": "queued",
    "startedNewTurn": False,
    "status": "accepted",
    "turnId": "t-queued",
}

CRASH = ExitClassification(
    kind="crash", exit_code=1, exit_signal=None, stderr_tail=()
)


def wired(durability: str = "durable") -> tuple[FakeDuplex, "Session[str]"]:
    transport = FakeDuplex()
    connection = Connection(transport, mint_command_id=lambda: "mint-0")
    session: Session[str] = Session(
        SESSION,
        read_session_durability({"sessionDurability": durability}),
        connection=connection,
    )
    return transport, session


def fold_only() -> "Session[str]":
    return Session(SESSION, read_session_durability({"sessionDurability": "durable"}))


def item(item_id: str, revision: int, status: str = "inProgress") -> Params:
    return {
        "itemId": item_id,
        "kind": "agentMessage",
        "revision": revision,
        "sessionId": SESSION,
        "status": status,
        "turnId": TURN,
    }


def paged(method: str, view_cursor: str, **rest: Any) -> Params:
    """One element of a ``view/page`` result: the SS4.2.1 unframed view
    notification (nested ``{method, params}`` pairs, owner ruling #22785)."""
    return {
        "method": method,
        "params": {
            "sessionId": SESSION,
            "sourceRange": SOURCE,
            "viewCursor": view_cursor,
            **rest,
        },
    }


def item_event(method: str, view_cursor: str, value: Params) -> Params:
    return paged(method, view_cursor, item=value)


def gap_frame(after: str, next_cursor: str) -> Params:
    return {
        "method": "view/gap",
        "params": {"after": after, "next": next_cursor, "sessionId": SESSION},
    }


def turn_started_at(view_cursor: str, turn_id: str = "t-other") -> Params:
    return paged("turn/started", view_cursor, commandId="c-other", turnId=turn_id)


def start_turn(session: "Session[str]", view_cursor: str = "v:0") -> Turn:
    session.apply(
        {
            "method": "turn/started",
            "params": {
                "commandId": "c-1",
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "turnId": TURN,
                "viewCursor": view_cursor,
            },
        }
    )
    return session.turn(TURN)


def collect_items(turn: Turn) -> tuple[List[str], "asyncio.Task[None]"]:
    """Drain ``turn.items()`` in the background, recording ``itemId@revision``
    in yield order — ORDER is the assertion FR-638-019c turns on."""
    seen: List[str] = []

    async def run() -> None:
        async for held in turn.items():
            seen.append(f"{held['itemId']}@{held['revision']}")

    return seen, asyncio.get_running_loop().create_task(run())


async def end_turn(session: "Session[str]", done: "asyncio.Task[None]") -> None:
    session.apply(
        {
            "method": "turn/completed",
            "params": {
                "sessionId": SESSION,
                "sourceRange": SOURCE,
                "terminal": "completed",
                "turnId": TURN,
                "viewCursor": "v:99",
            },
        }
    )
    await done


async def answer_page(
    transport: FakeDuplex,
    index: int,
    events: List[Params],
    next_cursor: str | None,
) -> None:
    """Answer the ``index``-th outbound ``view/page``, asserting it IS one and
    is well formed."""
    await wait_for_writes(transport, index + 1)
    assert sent_frame(transport, index)["method"] == "view/page"
    params = sent_params(transport, index)
    assert params["sessionId"] == SESSION
    # The published bound is 1–1000 (`ViewPageParams.limit`), asserted as the
    # RANGE the schema states: the page size is an implementation choice, the
    # bound is the contract.
    limit = params["limit"]
    assert isinstance(limit, int) and 1 <= limit <= 1000
    answer(transport, index, {"events": events, "nextCursor": next_cursor})


async def submitted_queued(transport: FakeDuplex, session: "Session[str]") -> None:
    """One queued submit whose pending entry the queue-movement arms replay."""
    submit = asyncio.ensure_future(
        session.send_user_turn(
            SendUserTurnOptions(
                input=[{"text": "hi", "type": "text"}], composer_input="hi"
            )
        )
    )
    await wait_for_writes(transport, 1)
    answer(transport, 0, QUEUED_ACK)
    await submit


# ---- the recipe --------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_gap_is_a_pause_then_the_paged_prefix_then_the_buffered_tail() -> None:
    transport, session = wired()
    turn = start_turn(session)
    seen, done = collect_items(turn)
    session.apply(item_event("item/started", "v:1", item("i-1", 1)))
    await pump()
    assert seen == ["i-1@1"], "the pre-gap tail is live"

    # The hole: everything strictly between v:1 and v:5 was never delivered.
    gap = session.apply(gap_frame("v:1", "v:5"))
    assert isinstance(gap.fold, DeliveryGap)
    assert (gap.fold.after, gap.fold.next) == ("v:1", "v:5")
    assert session.fold.current is False, "not current until the hole is filled"

    # The live tail keeps arriving DURING the fill and must not fold ahead of
    # the paged prefix — it is buffered, and the consumer sees the pause.
    live = session.apply(item_event("item/completed", "v:5", item("i-3", 1, "completed")))
    assert live.fold.kind == "bufferedDuringGap"
    assert live.fold.kind == "bufferedDuringGap" and live.fold.method == "item/completed"
    await pump()
    assert seen == ["i-1@1"], "the pause: nothing folds ahead of the fill"

    await answer_page(
        transport,
        0,
        [
            item_event("item/started", "v:2", item("i-2", 1)),
            item_event("item/updated", "v:3", item("i-1", 2)),
        ],
        "v:3",
    )
    await answer_page(
        transport,
        1,
        [
            item_event("item/completed", "v:4", item("i-2", 2, "completed")),
            # The overlap: the page serves the very event the live tail buffered.
            item_event("item/completed", "v:5", item("i-3", 1, "completed")),
        ],
        "v:5",
    )
    assert await settled_io(gap.io) == ()

    assert seen == [
        "i-1@1",
        "i-2@1",
        "i-1@2",
        "i-2@2",
        "i-3@1",
    ], "the filled sequence reaches the iterator in cursor order"
    assert session.fold.current is True, "current only after the fill"
    assert session.fold.pending_gap is None
    # The first cursor asked for is `after` itself — the exclusive lower bound.
    assert sent_params(transport, 0)["cursor"] == "v:1"
    assert sent_params(transport, 1)["cursor"] == "v:3"
    assert len(transport.writes) == 2, "the walk stops at `next`; no third page"
    await end_turn(session, done)


@pytest.mark.asyncio
async def test_the_overlap_is_discarded_by_cursor_equality_routed_once() -> None:
    # tdd SS4.8's "discard paged events at cursors >= `next`", from the other
    # side: the buffered copy of an event the page also served is dropped.
    # OBSERVED THROUGH THE WIRE: for an item frame the INV-003 revision guard
    # would hide a double apply, but a `turn/started` for a turn that is not
    # the pending entry's own is SS4.13 queue movement, re-verified on EVERY
    # sighting — so folding the frame twice authors a second `turn/start`
    # replay for a command whose fate one already decides.
    transport, session = wired()
    await submitted_queued(transport, session)

    gap = session.apply(gap_frame("v:1", "v:3"))
    started = turn_started_at("v:3")
    session.apply(started)
    await answer_page(transport, 1, [started], "v:3")
    await pump()

    assert len(transport.writes) == 3, (
        "one submit, one page, ONE replay — the buffered duplicate authors no second"
    )
    assert sent_frame(transport, 2)["method"] == "turn/start"
    assert sent_params(transport, 2)["commandId"] == "mint-0"
    # Value-identical ack (INV-013/TEST-018), so the replay settles nothing
    # and the entry keeps waiting.
    answer(transport, 2, QUEUED_ACK)
    assert await settled_io(gap.io) == ()
    assert session.fold.current is True


@pytest.mark.asyncio
async def test_a_second_gap_mid_fill_coalesces_on_the_first_after_and_extends_the_walk() -> None:
    # D-16487-1's client mirror: a run of holes is one bracket keeping the
    # first `after`. Without the extension the walk stops at the first `next`,
    # reports itself current, and the SECOND hole is never filled.
    transport, session = wired()
    turn = start_turn(session)
    seen, done = collect_items(turn)

    gap = session.apply(gap_frame("v:1", "v:3"))
    assert session.fold.pending_gap == {"after": "v:1", "next": "v:3", "sessionId": SESSION}

    # A second overflow, learned while the first walk is still in flight.
    await wait_for_writes(transport, 1)
    second = session.apply(gap_frame("v:4", "v:7"))
    assert isinstance(second.fold, DeliveryGap)
    assert session.fold.pending_gap == {
        "after": "v:1",
        "next": "v:7",
        "sessionId": SESSION,
    }, "the first `after` is kept; the target extends"
    # No second walk was started beside the first.
    await pump()
    assert len(transport.writes) == 1

    answer(
        transport,
        0,
        {"events": [item_event("item/started", "v:3", item("i-1", 1))], "nextCursor": "v:3"},
    )
    # The walk continues past the old target toward the new one.
    await answer_page(transport, 1, [item_event("item/started", "v:7", item("i-2", 1))], "v:7")
    await settled_io(gap.io)

    assert seen == ["i-1@1", "i-2@1"]
    assert session.fold.current is True
    await end_turn(session, done)


@pytest.mark.asyncio
async def test_a_gap_arriving_after_a_completed_fill_starts_its_own_walk() -> None:
    # The TS twin guards a "clear window" here: its drain lowers the filling
    # flag a microtask after the walk cleared the hole, so a `view/gap`
    # folding in between must be picked up by a post-drain restart. That
    # window CANNOT exist in this port — the walk's final `gap_filled` and
    # the drain's flag-lowering run in one synchronous task step, with no
    # await a frame could fold inside (PR #32249 review round 1 proved the
    # restart block dead by mutation, so it was removed rather than kept as
    # unreachable defense). What remains load-bearing is the handover this
    # arm pins: a second hole opening AFTER a completed fill gets its own
    # walk from `apply`, never a bounce off a stale filling flag.
    transport, session = wired()
    gap = session.apply(gap_frame("v:1", "v:2"))
    await answer_page(
        transport, 0, [item_event("item/started", "v:2", item("i-1", 1))], "v:2"
    )
    assert await settled_io(gap.io) == ()
    assert session.fold.current is True, "the first hole filled"

    second = session.apply(gap_frame("v:2", "v:4"))
    await answer_page(
        transport, 1, [item_event("item/started", "v:4", item("i-2", 1))], "v:4"
    )
    assert await settled_io(second.io) == ()
    assert session.fold.current is True, "the second hole got its own walk"
    assert session.fold.pending_gap is None
    assert len(transport.writes) == 2, "one page per hole"


@pytest.mark.asyncio
async def test_the_live_twin_of_a_served_event_is_refused_once_even_after_the_fill() -> None:
    # The timing inversion of the overlap arm: the wire promises no order
    # between the marker and the frame at `next`, so the twin can land after
    # the drain, when the buffer is gone. Same damage as the buffered case: a
    # second SS4.13 queue-movement replay on the wire.
    transport, session = wired()
    await submitted_queued(transport, session)

    gap = session.apply(gap_frame("v:1", "v:3"))
    started = turn_started_at("v:3")
    await answer_page(transport, 1, [started], "v:3")
    await pump()
    assert len(transport.writes) == 3, "the paged copy authored the one replay"
    answer(transport, 2, QUEUED_ACK)
    await settled_io(gap.io)

    # NOW the live twin arrives, with the fill long finished.
    late = session.apply(started)
    assert late.fold.kind == "ignoredGapOverlap"
    assert late.fold.kind == "ignoredGapOverlap" and late.fold.view_cursor == "v:3"
    await pump()
    assert len(transport.writes) == 3, "no second replay for the same commandId"

    # Consuming, not permanent: a genuinely new frame at that cursor would be
    # a different event, and the entry is gone after the one refusal.
    assert isinstance(session.apply(started).fold, TurnFold), "the refusal is spent"


@pytest.mark.asyncio
async def test_a_coalesced_gap_still_discards_buffered_twins_across_the_page_boundary() -> None:
    # When a second `view/gap` extends the hole mid-walk, the walk restarts
    # toward the NEW target with `reached` false — so paged events between the
    # two targets never enter the persistent twin set. Their twins ARE in the
    # buffer, because a cursor at or after the FIRST target was delivered live
    # before the second hole opened. Claiming only on the persistent set folds
    # those a second time.
    transport, session = wired()
    await submitted_queued(transport, session)

    gap = session.apply(gap_frame("v:1", "v:3"))
    # Delivered live after the first hole, so buffered — and served by a LATER
    # page than the one that carries the first target.
    started = turn_started_at("v:4")
    session.apply(started)
    await wait_for_writes(transport, 2)
    # The second hole opens while the walk is in flight; the target extends.
    session.apply(gap_frame("v:4", "v:7"))

    # Page 1 carries the FIRST target and ends there.
    answer(
        transport,
        1,
        {"events": [item_event("item/started", "v:3", item("i-1", 1))], "nextCursor": "v:3"},
    )
    # Page 2 carries the buffered frame's cursor and the extended target.
    await answer_page(
        transport, 2, [started, item_event("item/started", "v:7", item("i-2", 1))], "v:7"
    )
    await pump()

    assert len(transport.writes) == 4, (
        "one submit, two pages, ONE replay — the buffered twin authored no second"
    )
    assert sent_frame(transport, 3)["method"] == "turn/start"
    answer(transport, 3, QUEUED_ACK)
    await settled_io(gap.io)
    assert session.fold.current is True


@pytest.mark.asyncio
async def test_a_twin_served_by_an_earlier_fill_is_still_refused_after_a_later_fill() -> None:
    # A cursor the previous fill served can sit at or AFTER a new gap's
    # `next`, so its live twin is still coming — clearing the persistent set
    # per fill would lose the only refusal that stops it folding twice.
    transport, session = wired()
    await submitted_queued(transport, session)

    # Fill 1 serves `v:9` — a cursor the wire has not delivered live yet.
    started = turn_started_at("v:9")
    first = session.apply(gap_frame("v:1", "v:3"))
    await answer_page(
        transport, 1, [item_event("item/started", "v:3", item("i-1", 1)), started], "v:9"
    )
    await pump()
    assert len(transport.writes) == 3, "the paged copy authored the one replay"
    answer(transport, 2, QUEUED_ACK)
    await settled_io(first.io)

    # A SECOND, unrelated hole below `v:9` — so `v:9` is still on its way.
    second = session.apply(gap_frame("v:4", "v:6"))
    await answer_page(transport, 3, [item_event("item/started", "v:6", item("i-2", 1))], "v:6")
    await settled_io(second.io)

    # Now the live twin of `v:9` finally lands.
    late = session.apply(started)
    assert late.fold.kind == "ignoredGapOverlap"
    assert late.fold.kind == "ignoredGapOverlap" and late.fold.view_cursor == "v:9"
    await pump()
    assert len(transport.writes) == 4, "no second replay for the same commandId"


@pytest.mark.asyncio
async def test_an_earlier_fills_twin_arriving_during_a_later_fill_is_refused_by_the_drain() -> None:
    # `Session.apply` buffers every live frame while a fill runs, BEFORE the
    # late-window claim can see it — so a twin an earlier fill served, arriving
    # mid-fill, reaches only the drain. The drain's local set holds this fill's
    # own pages, so it has to consult the persistent set too.
    transport, session = wired()
    await submitted_queued(transport, session)

    started = turn_started_at("v:9")
    first = session.apply(gap_frame("v:1", "v:3"))
    await answer_page(
        transport, 1, [item_event("item/started", "v:3", item("i-1", 1)), started], "v:9"
    )
    await pump()
    answer(transport, 2, QUEUED_ACK)
    await settled_io(first.io)

    # A second hole opens, and the `v:9` twin lands WHILE its fill is running.
    second = session.apply(gap_frame("v:4", "v:6"))
    await wait_for_writes(transport, 4)
    held = session.apply(started)
    assert held.fold.kind == "bufferedDuringGap", (
        "a fill is running, so the buffer takes it before the late-window claim"
    )
    answer(
        transport,
        3,
        {"events": [item_event("item/started", "v:6", item("i-2", 1))], "nextCursor": "v:6"},
    )
    # Asserted BEFORE awaiting `io`: a duplicate replay would leave `io`
    # waiting on an ack nobody sends, and this arm must fail on the extra
    # WRITE rather than on a hang.
    await pump()
    assert len(transport.writes) == 4, (
        "one submit, two pages, ONE replay — the drain refused the earlier twin"
    )
    await settled_io(second.io)


@pytest.mark.asyncio
async def test_a_later_fills_page_does_not_reapply_an_event_an_earlier_fill_folded() -> None:
    # A later walk may legally page through a range an earlier fill already
    # served — the durable copy is still there. Applying it again is the same
    # duplicate SS4.13 replay from the paged side instead of the live side.
    transport, session = wired()
    await submitted_queued(transport, session)

    started = turn_started_at("v:9")
    first = session.apply(gap_frame("v:1", "v:3"))
    await answer_page(
        transport, 1, [item_event("item/started", "v:3", item("i-1", 1)), started], "v:9"
    )
    await pump()
    answer(transport, 2, QUEUED_ACK)
    await settled_io(first.io)

    # A later hole whose fill pages straight back over `v:9`.
    second = session.apply(gap_frame("v:3", "v:B"))
    await answer_page(
        transport, 3, [started, item_event("item/started", "v:B", item("i-2", 1))], "v:B"
    )
    await pump()
    assert len(transport.writes) == 4, (
        "one submit, two pages, ONE replay — the re-served page copy authored no second"
    )
    await settled_io(second.io)


@pytest.mark.asyncio
async def test_a_coalesced_target_moving_past_a_buffered_twin_keeps_its_refusal() -> None:
    # The walk cannot see the buffer: a coalescing gap moves the target PAST a
    # cursor whose twin is sitting in it, and retiring the persistent entry in
    # the walk would delete the drain's only refusal. The walk deletes nothing.
    transport, session = wired()
    await submitted_queued(transport, session)

    started = turn_started_at("v:9")
    # Fill 1 serves `v:9`, so the persistent entry holds it.
    first = session.apply(gap_frame("v:1", "v:3"))
    await answer_page(
        transport, 1, [item_event("item/started", "v:3", item("i-1", 1)), started], "v:9"
    )
    await pump()
    answer(transport, 2, QUEUED_ACK)
    await settled_io(first.io)

    # Fill 2 opens; the `v:9` twin lands while it runs, so it is BUFFERED.
    second = session.apply(gap_frame("v:4", "v:6"))
    await wait_for_writes(transport, 4)
    session.apply(started)
    # …and now a coalescing gap moves the target PAST `v:9`.
    session.apply(gap_frame("v:6", "v:C"))
    answer(
        transport,
        3,
        {"events": [item_event("item/started", "v:6", item("i-2", 1))], "nextCursor": "v:6"},
    )
    # The extended walk pages over `v:9` on its way to `v:C`.
    await answer_page(
        transport, 4, [started, item_event("item/started", "v:C", item("i-3", 1))], "v:C"
    )
    await pump()

    assert len(transport.writes) == 5, (
        "one submit, three pages, ONE replay — the buffered twin kept its refusal"
    )
    await settled_io(second.io)


@pytest.mark.asyncio
async def test_a_target_the_walk_must_skip_is_still_a_target() -> None:
    # A new gap's `next` can name a cursor an earlier fill served while its
    # twin is still pending. The walk must stop there — `reached` is decided
    # BEFORE the already-applied skip — and the refusal survives the skip.
    transport, session = wired()
    await submitted_queued(transport, session)

    started = turn_started_at("v:9")
    first = session.apply(gap_frame("v:1", "v:3"))
    await answer_page(
        transport, 1, [item_event("item/started", "v:3", item("i-1", 1)), started], "v:9"
    )
    await pump()
    answer(transport, 2, QUEUED_ACK)
    await settled_io(first.io)

    # The new hole's `next` IS the cursor fill 1 already served.
    second = session.apply(gap_frame("v:4", "v:9"))
    await answer_page(
        transport, 3, [item_event("item/started", "v:6", item("i-2", 1)), started], "v:9"
    )
    await pump()
    assert len(transport.writes) == 4, (
        "the walk stopped at its skipped target instead of paging past it"
    )
    await settled_io(second.io)
    assert session.fold.current is True

    # The refusal survived the skip: the twin is still coming, and is refused.
    late = session.apply(started)
    assert late.fold.kind == "ignoredGapOverlap"
    await pump()
    assert len(transport.writes) == 4, "no second replay for the same commandId"


@pytest.mark.asyncio
async def test_a_retirement_produced_by_the_drain_rides_the_gap_frames_io() -> None:
    # A frame buffered during a fill reports `retirements: ()` by design, so
    # the gap frame's `io` is the consumer's ONLY channel for an SS4.13
    # retirement the splice produces.
    transport, session = wired()
    await submitted_queued(transport, session)
    assert session.pending.has("mint-0") is True

    gap = session.apply(gap_frame("v:1", "v:5"))
    # The reclaim of THIS session's own queued submit, delivered as live
    # traffic while the fill is in flight — so it is buffered, and its
    # retirement can only surface through the fill.
    reclaim = session.apply(
        paged("turn/unqueued", "v:5", commandId="mint-0", reason="superseded", turnId="t-queued")
    )
    assert reclaim.fold.kind == "bufferedDuringGap"
    assert reclaim.retirements == (), "nothing has folded yet"

    await answer_page(transport, 1, [], None)
    retirements = await settled_io(gap.io)

    assert len(retirements) == 1, "the reclaim's retirement rides the gap frame's io"
    assert retirements[0].command_id == "mint-0"
    assert retirements[0].kind == "reclaimed"
    assert session.pending.has("mint-0") is False


# ---- FR-638-019c: a fill failure is a typed error, never a silent hole ------


@pytest.mark.asyncio
async def test_an_empty_page_that_does_not_end_the_view_is_a_stall() -> None:
    # A host answering empty pages with ever-fresh cursors would spin the walk
    # in unbounded `view/page` traffic.
    transport, session = wired()
    failures: List[MuseGapFillError] = []
    session.on_gap_error(failures.append)

    gap = session.apply(gap_frame("v:1", "v:5"))
    await answer_page(transport, 0, [], "v:2")
    await settled_io(gap.io)

    assert failures[0].reason == "pageStalled"
    assert len(transport.writes) == 1, "no second page was requested"
    assert session.fold.current is False


@pytest.mark.asyncio
async def test_a_page_that_names_no_next_cursor_at_all_is_a_stall_not_an_end() -> None:
    # `nextCursor` is `string | null` and "never omitted" (tdd SS4.7.3), so an
    # absent one is a host defect. Treating it as end-of-view would report the
    # fold current over a hole nothing filled.
    transport, session = wired()
    failures: List[MuseGapFillError] = []
    session.on_gap_error(failures.append)

    gap = session.apply(gap_frame("v:1", "v:5"))
    await wait_for_writes(transport, 1)
    answer(transport, 0, {"events": [item_event("item/started", "v:2", item("i-1", 1))]})
    await settled_io(gap.io)

    assert failures[0].reason == "pageStalled"
    assert len(transport.writes) == 1
    assert session.fold.current is False


@pytest.mark.asyncio
async def test_end_of_view_ends_the_walk_a_hole_the_log_cannot_serve_is_a_fill() -> None:
    # `next` names a LIVE cursor; `view/page` serves durable-sourced events
    # only (tdd SS4.7.3), so a hole whose tail was ephemeral ends at
    # `nextCursor: null` and never at `target`. The walk must accept it and
    # splice, or the iterators wait on a cursor no page will ever carry.
    transport, session = wired()
    turn = start_turn(session)
    seen, done = collect_items(turn)

    gap = session.apply(gap_frame("v:1", "v:9"))
    session.apply(item_event("item/started", "v:9", item("i-2", 1)))
    await answer_page(transport, 0, [item_event("item/started", "v:2", item("i-1", 1))], None)
    await settled_io(gap.io)

    assert seen == ["i-1@1", "i-2@1"], "the paged prefix, then the buffered tail"
    assert session.fold.current is True
    await end_turn(session, done)


@pytest.mark.asyncio
async def test_deltas_lost_in_the_hole_stay_lost() -> None:
    # tdd SS4.8, stated as behaviour: `item/delta` is ephemeral-sourced and
    # `view/page` never replays it, so the fill lands the final item values and
    # the delta stream simply has a hole. Pinned so a later "helpful" synthesis
    # of deltas from the filled item text reds here.
    transport, session = wired()
    turn = start_turn(session)
    deltas: List[str] = []

    async def drain_deltas() -> None:
        async for delta in turn.deltas():
            deltas.append(str(delta["delta"]))

    drained = asyncio.get_running_loop().create_task(drain_deltas())

    gap = session.apply(gap_frame("v:1", "v:4"))
    await answer_page(
        transport, 0, [item_event("item/completed", "v:4", item("i-1", 3, "completed"))], "v:4"
    )
    await settled_io(gap.io)

    assert deltas == [], "no delta is synthesized for the hole"
    held = session.fold.items.get("i-1")
    assert held is not None and held["revision"] == 3, "the final landed"
    await end_turn(session, drained)


@pytest.mark.asyncio
async def test_a_failed_page_surfaces_a_typed_error_and_leaves_the_fold_not_current() -> None:
    transport, session = wired()
    turn = start_turn(session)
    seen, done = collect_items(turn)
    failures: List[MuseGapFillError] = []
    session.on_gap_error(failures.append)

    gap = session.apply(gap_frame("v:1", "v:5"))
    session.apply(item_event("item/started", "v:5", item("i-9", 1)))
    await wait_for_writes(transport, 1)
    answer_error(transport, 0, {"code": -32011, "data": {"kind": "notFound"}, "message": "gone"})
    await settled_io(gap.io)

    assert len(failures) == 1
    failure = failures[0]
    assert isinstance(failure, MuseGapFillError)
    assert failure.reason == "pageFailed"
    assert failure.after == "v:1"
    assert failure.next == "v:5"
    assert session.fold.current is False, "an unfilled hole never reports current"
    assert session.fold.pending_gap == {"after": "v:1", "next": "v:5", "sessionId": SESSION}
    # The buffer is RELEASED, not dropped: the live tail the client did
    # receive is still the client's, and swallowing it would add a second
    # hole to the one already reported.
    assert seen == ["i-9@1"]
    await end_turn(session, done)


@pytest.mark.asyncio
async def test_a_walk_that_does_not_advance_fails_as_page_stalled() -> None:
    # Bounded by PROGRESS, not by an invented attempt cap — a cap would
    # silently truncate a legitimate long walk.
    transport, session = wired()
    failures: List[MuseGapFillError] = []
    session.on_gap_error(failures.append)

    gap = session.apply(gap_frame("v:1", "v:5"))
    await answer_page(transport, 0, [item_event("item/started", "v:2", item("i-1", 1))], "v:1")
    await settled_io(gap.io)

    assert len(failures) == 1
    assert failures[0].reason == "pageStalled"
    assert len(transport.writes) == 1, "no second page was requested"
    assert session.fold.current is False


@pytest.mark.asyncio
async def test_a_page_serving_another_sessions_event_is_refused_not_folded() -> None:
    # The same check `apply` makes on a live frame, at the one OTHER place a
    # frame can enter the fold: the request named this `sessionId`, so there is
    # no reading under which the answer is right.
    transport, session = wired()
    failures: List[MuseGapFillError] = []
    session.on_gap_error(failures.append)

    gap = session.apply(gap_frame("v:1", "v:5"))
    await wait_for_writes(transport, 1)
    answer(
        transport,
        0,
        {
            "events": [
                {
                    "method": "item/started",
                    "params": {
                        "item": item("i-other", 1),
                        "sessionId": "s-other",
                        "sourceRange": SOURCE,
                        "viewCursor": "v:2",
                    },
                }
            ],
            # Ends the view, so a walk that did NOT refuse the page would run
            # to a clean, silent completion — the mutant this arm kills by
            # assertion rather than by a hang.
            "nextCursor": None,
        },
    )
    await settled_io(gap.io)

    assert len(failures) == 1
    assert failures[0].reason == "pageFailed"
    assert session.fold.items.get("i-other") is None
    assert session.fold.current is False


@pytest.mark.asyncio
async def test_a_fold_only_session_reports_no_connection_not_a_swallowed_gap() -> None:
    # A `Session` built with no connection cannot page, and pretending
    # otherwise would leave a consumer folding a transcript with a hole it was
    # never told about. Nothing is buffered either — there is no fill coming
    # to release it.
    session = fold_only()
    turn = start_turn(session)
    seen, done = collect_items(turn)
    failures: List[MuseGapFillError] = []
    session.on_gap_error(failures.append)

    gap = session.apply(gap_frame("v:1", "v:5"))
    session.apply(item_event("item/started", "v:5", item("i-1", 1)))
    await settled_io(gap.io)

    assert len(failures) == 1
    assert failures[0].reason == "noConnection"
    assert session.fold.current is False
    assert seen == ["i-1@1"], "the live tail keeps folding"
    await end_turn(session, done)


@pytest.mark.asyncio
async def test_a_raising_on_gap_error_observer_never_escapes_either_report_path() -> None:
    # The failure observer is a consumer entry point too, and `_report` runs on
    # BOTH planes: synchronously inside `Session.apply` (the fold-only
    # noConnection report) and inside the walk task (a failed page riding
    # `io`). An escape from the first raises out of the notification pump; an
    # escape from the second rejects the never-rejecting `io`. The approval
    # router ships this test's twin; this is gap-fill's (PR #32249 review
    # round 1).
    sync_deliveries: List[MuseGapFillError] = []

    def raising_observer(failure: MuseGapFillError) -> None:
        sync_deliveries.append(failure)
        raise RuntimeError("observer boom")

    # Sync path: fold-only noConnection, reported inside apply itself.
    session = fold_only()
    session.on_gap_error(raising_observer)
    outcome = session.apply(gap_frame("v:1", "v:5"))  # must NOT raise
    assert [f.reason for f in sync_deliveries] == ["noConnection"]
    assert await settled_io(outcome.io) == ()

    # Async path: a wired fill stalls, reported from the walk task onto io.
    transport, wired_session = wired()
    async_deliveries: List[MuseGapFillError] = []

    def raising_async_observer(failure: MuseGapFillError) -> None:
        async_deliveries.append(failure)
        raise RuntimeError("observer boom")

    wired_session.on_gap_error(raising_async_observer)
    gap = wired_session.apply(gap_frame("v:1", "v:5"))
    await answer_page(transport, 0, [], "v:2")
    assert await settled_io(gap.io) == ()  # must RESOLVE despite the raise
    assert [f.reason for f in async_deliveries] == ["pageStalled"]


def test_fold_only_gap_reports_no_connection_with_no_event_loop_at_all() -> None:
    # Deliberately NO asyncio marker: a fold-only consumer may apply events
    # outside any loop. The noConnection report fires synchronously and the
    # returned `io` is an already-settled loop-free awaitable — feeding a
    # settled stub into the io GATHER instead minted an orphan event loop and
    # made a later await raise "attached to a different loop" (PR #32249
    # review round 1).
    session = fold_only()
    failures: List[MuseGapFillError] = []
    session.on_gap_error(failures.append)

    outcome = session.apply(gap_frame("v:1", "v:5"))

    assert [f.reason for f in failures] == ["noConnection"]
    assert session.fold.current is False

    async def drain_io() -> tuple[Any, ...]:
        return await outcome.io

    assert asyncio.run(drain_io()) == ()


@pytest.mark.asyncio
async def test_an_ephemeral_discharge_during_the_fill_drops_the_buffer() -> None:
    # SS2.13.3b outranks the fill. `apply` already refuses frames after a
    # discharge; without the same check on the drain the buffered tail would
    # walk straight past that refusal and fold into a session the client was
    # told to discard.
    transport, session = wired(durability="ephemeral")
    start_turn(session)

    gap = session.apply(gap_frame("v:1", "v:5"))
    session.apply(item_event("item/started", "v:5", item("i-1", 1)))
    await wait_for_writes(transport, 1)
    session.host_exited(CRASH)
    answer(
        transport,
        0,
        {"events": [item_event("item/started", "v:2", item("i-2", 1))], "nextCursor": "v:5"},
    )
    await settled_io(gap.io)

    assert session.fold.items.get("i-1") is None, "the buffered tail never folded"
    assert session.fold.items.get("i-2") is None, "and neither did the paged prefix"
    # The walk stops rather than paging a host that is gone: a second request
    # would wait forever on an answer nobody is left to send.
    assert len(transport.writes) == 1, "no page was requested after the discharge"
    assert session.fold.current is False, "a discarded fold is never reported current"
