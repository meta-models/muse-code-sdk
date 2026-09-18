"""PY-the governing rule ``pending_command_full_arms``.

Every arm of the protocol spec, driven by the same
synthetic ack/launch/reject/join sequences as the TS suite
(``clients/sdk-ts/test/pending-command-set.test.ts``) — the parity source
this file ports case for case.
"""

from __future__ import annotations

import pytest

from muse_code.errors import MuseSessionDiscardedError
from muse_code.pending import (
    AbandonedRetirement,
    CommandErrorResponse,
    MaterializedRetirement,
    PendingCommandSet,
    ReclaimedRetirement,
    RejectedRetirement,
    ReplayAck,
    ReplayError,
    RetryAbandonedByClientRetirement,
    SnapshotJoinFacts,
    TurnRef,
    UserMessageRef,
)
from muse_code.pending.pending_command_set import PendingCommandAck


def rejected(reason: str) -> CommandErrorResponse:
    return CommandErrorResponse(code=-32030, kind="commandRejected", reason=reason)


def ack(turn_id: str, disposition: str) -> PendingCommandAck:
    return {"turnId": turn_id, "disposition": disposition}


def test_an_entry_renders_after_the_last_item_at_submission_in_submission_order() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "first", anchor_after_item_id="itemA")
    s.submitted("c2", "second", anchor_after_item_id="itemA")
    assert [
        (e.command_id, e.anchor_after_item_id, e.submission_index) for e in s.list()
    ] == [("c1", "itemA", 0), ("c2", "itemA", 1)]


def test_the_anchor_is_fixed_at_insertion_never_relocated_by_server_events() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "queued input", anchor_after_item_id="itemA")
    s.acked("c1", ack("t9", "queued"))
    # A running-turn item folds in BETWEEN the ack and the launch. This is
    # the arm that discriminates the fixed anchor from float-to-bottom.
    s.observed_queue_movement("tRunning")
    entry = s.get("c1")
    assert entry is not None and entry.anchor_after_item_id == "itemA"


def test_ack_then_launch_the_command_id_bearing_user_message_retires() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "fix the test", anchor_after_item_id=None)
    s.acked("c1", ack("t1", "queued"))
    retirement = s.observed_user_message("c1", "item-user-1")
    assert retirement == MaterializedRetirement(
        command_id="c1", matched_by="userMessage", item_id="item-user-1"
    )
    assert s.size == 0


def test_a_user_message_with_no_local_entry_is_another_clients_echo() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("mine", "x", anchor_after_item_id=None)
    assert s.observed_user_message("theirs", "item-9") is None
    assert s.size == 1, "our entry must survive another client's message"


def test_ack_then_reject_a_durable_command_rejected_retires_and_restores() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "restore me", anchor_after_item_id=None)
    s.acked("c1", ack("t1", "queued"))
    retirement = s.replay_answered(
        "c1", ReplayError(error=rejected("deferred_start_failed"))
    )
    assert retirement == RejectedRetirement(
        command_id="c1", reason="deferred_start_failed", input="restore me"
    )
    assert s.size == 0


def test_a_reason_abandoned_answer_retires_via_the_abandoned_arm() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "never ran", anchor_after_item_id=None)
    s.acked("c1", ack("t1", "queued"))
    retirement = s.replay_answered("c1", ReplayError(error=rejected("abandoned")))
    assert isinstance(retirement, AbandonedRetirement)
    assert s.size == 0


def test_nothing_admitted_errors_are_not_settlements_the_entry_holds() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "retry me", anchor_after_item_id=None)

    # backpressured (-32031): nothing was admitted.
    assert s.ack_errored("c1", CommandErrorResponse(code=-32031, kind="overloaded")) == "held"
    assert s.size == 1

    # An oversized frame: also admits nothing.
    assert (
        s.ack_errored("c1", CommandErrorResponse(code=-32002, kind="inputTooLarge"))
        == "held"
    )
    assert s.size == 1

    # The same commandId retried is the sanctioned exactly-once retry and
    # must not create a second entry or move the anchor.
    s.submitted("c1", "retry me", anchor_after_item_id="moved")
    assert s.size == 1
    entry = s.get("c1")
    assert entry is not None and entry.anchor_after_item_id is None


def test_a_client_that_stops_retrying_retires_the_entry_to_its_composer() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "give up on me", anchor_after_item_id=None)
    s.ack_errored("c1", CommandErrorResponse(code=-32031, kind="overloaded"))
    retirement = s.stop_retrying("c1")
    assert retirement == RetryAbandonedByClientRetirement(
        command_id="c1", input="give up on me"
    )
    assert s.size == 0


def test_queue_movement_reverifies_acked_queued_entries_and_only_those() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("queued", "q", anchor_after_item_id=None)
    s.acked("queued", ack("tQueued", "queued"))
    s.submitted("steered", "s", anchor_after_item_id=None)
    s.acked("steered", ack("tRunning", "steered"))
    s.submitted("unacked", "u", anchor_after_item_id=None)

    assert s.observed_queue_movement("tOther") == ("queued",)
    # The entry's OWN turn moving is not a re-verify trigger.
    assert s.observed_queue_movement("tQueued") == ()


def test_a_still_pending_ack_on_replay_keeps_the_entry_never_promote() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "still waiting", anchor_after_item_id=None)
    s.acked("c1", ack("t1", "queued"))
    outcome = s.replay_answered("c1", ReplayAck(ack=ack("t1", "queued")))
    assert outcome == "held"
    assert s.size == 1


def test_an_observed_reclaim_retires_immediately_without_a_snapshot_join() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "reclaim me", anchor_after_item_id=None)
    s.acked("c1", ack("t1", "queued"))
    retirement = s.observed_reclaim("c1")
    assert retirement == ReclaimedRetirement(command_id="c1", input="reclaim me")


def test_snapshot_join_all_five_arms_with_queued_turns_reordering() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()

    # Arm 1 — materialized (its userMessage is in the snapshot's items).
    s.submitted("materialized", "m", anchor_after_item_id=None)
    s.acked("materialized", ack("tM", "started"))

    # Arm 2 — two kept queued entries whose SUBMISSION order diverges from
    # the server's queuedTurns order (the backpressured-then-retried
    # divergence).
    s.submitted("queuedSecond", "q2", anchor_after_item_id=None)
    s.acked("queuedSecond", ack("tQ2", "queued"))
    s.submitted("queuedFirst", "q1", anchor_after_item_id=None)
    s.acked("queuedFirst", ack("tQ1", "queued"))

    # Arm 3 — an acked steer, pending on the running turn's
    # PendingSteerQueue.
    s.submitted("steer", "s", anchor_after_item_id="itemEarly")
    s.acked("steer", ack("tActive", "steered"))

    # Arm 4 — acked, matching nothing: must be resolved by a replay.
    s.submitted("noMatch", "n", anchor_after_item_id=None)
    s.acked("noMatch", ack("tGone", "queued"))

    # Arm 5 — unacked and unmatched: must resubmit the SAME commandId once.
    s.submitted("unacked", "u", anchor_after_item_id=None)

    plan = s.join_snapshot(
        SnapshotJoinFacts(
            active_turn=TurnRef(turn_id="tActive", command_id="someoneElse"),
            # Server order is the reverse of submission order.
            queued_turns=[
                TurnRef(turn_id="tQ1", command_id="queuedFirst"),
                TurnRef(turn_id="tQ2", command_id="queuedSecond"),
            ],
            user_message_command_ids=[
                UserMessageRef(command_id="materialized", item_id="item-m")
            ],
            last_item_id="itemLast",
        )
    )

    assert plan.retirements == (
        MaterializedRetirement(
            command_id="materialized", matched_by="userMessage", item_id="item-m"
        ),
    )
    assert plan.must_replay == ("noMatch",)
    assert plan.must_resubmit == ("unacked",)

    # The steer keeps its submission anchor; kept queued entries re-anchor to
    # the end of the reconciled fold, ordered among themselves by
    # queuedTurns.
    steer = s.get("steer")
    assert steer is not None and steer.anchor_after_item_id == "itemEarly"
    queued_first = s.get("queuedFirst")
    assert queued_first is not None and queued_first.anchor_after_item_id == "itemLast"
    assert [e.command_id for e in s.list()] == [
        "steer",
        "noMatch",
        "unacked",
        "queuedFirst",
        "queuedSecond",
    ], "server-confirmed queue order wins among kept queued entries"


def test_join_arm_1_active_turn_match_materializes_with_no_invented_item_id() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("cActive", "running now", anchor_after_item_id=None)
    s.acked("cActive", ack("tActive", "started"))

    plan = s.join_snapshot(
        SnapshotJoinFacts(
            active_turn=TurnRef(turn_id="tActive", command_id="cActive"),
            queued_turns=[],
            user_message_command_ids=[],
            last_item_id=None,
        )
    )

    # No user-message item id is in the join facts for this arm; the
    # retirement must say so (matched_by) rather than alias the commandId
    # into the item-id field — item ids and command ids are separate
    # namespaces.
    assert plan.retirements == (
        MaterializedRetirement(command_id="cActive", matched_by="activeTurn"),
    )
    assert s.size == 0


def test_is_settlement_a_32030_code_settles_even_when_the_kind_disagrees() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "typed", anchor_after_item_id=None)

    # The the protocol registry binds -32030 <-> commandRejected one-to-one, so a
    # disagreeing pair is a server fault where the CODE still asserts the
    # durable rejection; the taxonomy's bias for unfamiliar vocabulary is
    # toward terminal. Retire, never hold forever.
    outcome = s.ack_errored(
        "c1", CommandErrorResponse(code=-32030, kind="overloaded", reason="run_active")
    )

    # Pin the FULL disposition, not just "not held": the rejection must
    # carry the typed input back to the composer.
    assert outcome == RejectedRetirement(
        command_id="c1", reason="run_active", input="typed"
    )
    assert s.size == 0


def test_is_settlement_a_command_rejected_kind_settles_even_when_code_disagrees() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "typed", anchor_after_item_id=None)
    outcome = s.ack_errored(
        "c1",
        CommandErrorResponse(code=-32000, kind="commandRejected", reason="run_active"),
    )
    assert outcome == RejectedRetirement(
        command_id="c1", reason="run_active", input="typed"
    )
    assert s.size == 0


def test_the_pending_fold_is_deterministic_over_the_same_sequence() -> None:
    def run_once() -> tuple[object, object]:
        s: PendingCommandSet[str] = PendingCommandSet()
        s.submitted("a", "1", anchor_after_item_id=None)
        s.submitted("b", "2", anchor_after_item_id="item1")
        s.submitted("c", "3", anchor_after_item_id=None)
        s.acked("a", ack("tA", "queued"))
        s.acked("b", ack("tB", "queued"))
        plan = s.join_snapshot(
            SnapshotJoinFacts(
                active_turn=None,
                # Server order reverses submission order — the sort under
                # _ordered().
                queued_turns=[
                    TurnRef(turn_id="tB", command_id="b"),
                    TurnRef(turn_id="tA", command_id="a"),
                ],
                user_message_command_ids=[],
                last_item_id="itemLast",
            )
        )
        return (plan, s.list())

    assert run_once() == run_once()


def test_join_arm_4_a_stale_queued_ack_with_no_queued_turns_entry_is_reclaimed() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "was reclaimed", anchor_after_item_id=None)
    s.acked("c1", ack("t1", "queued"))

    s.join_snapshot(
        SnapshotJoinFacts(
            active_turn=None,
            queued_turns=[],
            user_message_command_ids=[],
            last_item_id=None,
        )
    )

    retirement = s.resolve_replay_at_join(
        "c1",
        ReplayAck(ack=ack("t1", "queued")),
        [],  # the snapshot's queuedTurns did not list it
    )
    assert retirement == ReclaimedRetirement(command_id="c1", input="was reclaimed")


def test_join_arm_4_a_still_pending_started_answer_holds_rather_than_retiring() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "started", anchor_after_item_id=None)
    s.acked("c1", ack("t1", "queued"))
    outcome = s.resolve_replay_at_join("c1", ReplayAck(ack=ack("t1", "started")), [])
    assert outcome == "held"
    assert s.size == 1


def test_one_join_plan_demands_each_unacked_entry_exactly_once_in_order() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "lost ack", anchor_after_item_id=None)
    s.submitted("c2", "also lost", anchor_after_item_id=None)

    plan = s.join_snapshot(
        SnapshotJoinFacts(
            active_turn=None,
            queued_turns=[],
            user_message_command_ids=[],
            last_item_id=None,
        )
    )

    # Once-per-plan is structural — the plan is built in one ordered pass —
    # so this pins the plan's SHAPE: each unacked entry appears exactly
    # once, in submission order, with no duplicates.
    assert plan.must_resubmit == ("c1", "c2")
    assert s.size == 2, "entries stay pending until a server fact settles them"


def test_across_joins_a_lost_resubmit_is_demanded_again_never_stranded() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "lost twice", anchor_after_item_id=None)

    facts = SnapshotJoinFacts(
        active_turn=None, queued_turns=[], user_message_command_ids=[], last_item_id=None
    )
    first = s.join_snapshot(facts)
    assert first.must_resubmit == ("c1",)

    # The demanded resubmit was lost to another disconnect before it ran. A
    # fresh join must demand it again (same-commandId resubmit is
    # idempotent, the protocol) — a once-per-lifetime latch would leave c1 in
    # `kept` forever with no path to settle, the durable-looking echo the protocol
    # forbids.
    second = s.join_snapshot(facts)
    assert second.must_resubmit == ("c1",)
    assert s.size == 1


def test_an_unacked_entry_the_join_matches_is_not_resubmitted() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "durable before ack", anchor_after_item_id=None)

    # The intake is durable BEFORE the ack, so a lost-ack entry
    # CAN appear in the snapshot. Retiring to the composer here and
    # re-sending with a fresh commandId is the double execution the join
    # order prevents.
    plan = s.join_snapshot(
        SnapshotJoinFacts(
            active_turn=None,
            queued_turns=[TurnRef(turn_id="t1", command_id="c1")],
            user_message_command_ids=[],
            last_item_id="itemLast",
        )
    )

    assert plan.must_resubmit == ()
    assert plan.retirements == ()
    assert s.size == 1


def test_reconnect_with_no_snapshot_replay_acked_resubmit_unacked_once() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("acked", "a", anchor_after_item_id=None)
    s.acked("acked", ack("t1", "queued"))
    s.submitted("unacked", "u", anchor_after_item_id=None)

    plan = s.reconnected_without_snapshot()

    assert plan.must_replay == ("acked",)
    assert plan.must_resubmit == ("unacked",)
    assert plan.retirements == (), "reconnect alone settles nothing"
    assert s.size == 2


def test_a_resubmit_lost_to_a_second_disconnect_is_demanded_again() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "lost twice", anchor_after_item_id=None)

    first = s.reconnected_without_snapshot()
    assert first.must_resubmit == ("c1",)

    # The demanded resubmit was itself lost to a second disconnect. A
    # once-per-lifetime latch would strand c1 as a permanent
    # durable-looking echo; same-commandId resubmit is
    # idempotent, so each new reconnect demands it again.
    second = s.reconnected_without_snapshot()
    assert second.must_resubmit == ("c1",)
    assert s.size == 1


def test_ephemeral_host_death_discards_every_entry_as_terminal_unknown() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "one", anchor_after_item_id=None)
    s.submitted("c2", "two", anchor_after_item_id=None)
    s.acked("c2", ack("t2", "queued"))

    retirements = s.discard_ephemeral()

    assert [r.kind for r in retirements] == ["terminalUnknown", "terminalUnknown"]
    assert s.size == 0
    # Terminal-unknown is not "failed" or "cancelled": inventing one is the
    # fabrication the carve-out exists to prevent.
    for retirement in retirements:
        assert retirement.kind not in ("rejected", "abandoned")

    with pytest.raises(
        MuseSessionDiscardedError,
        match=r"ephemeral host died; commandId `c1` cannot be replayed",
    ):
        s.submitted("c1", "replay", anchor_after_item_id=None)
    with pytest.raises(
        MuseSessionDiscardedError,
        match=r"ephemeral host died; commandId `c2` cannot be replayed",
    ):
        s.replay_answered("c2", ReplayAck(ack=ack("replacement", "started")))
    # A discarded commandId is never quietly answered "held" against a new
    # host.
    with pytest.raises(
        MuseSessionDiscardedError,
        match=r"ephemeral host died; commandId `c1` cannot be replayed",
    ):
        s.resolve_replay_at_join("c1", ReplayAck(ack=ack("replacement", "queued")), [])

    plan = s.reconnected_without_snapshot()
    assert (plan.retirements, plan.must_replay, plan.must_resubmit, plan.kept) == (
        (),
        (),
        (),
        (),
    )


def test_the_set_never_invents_a_terminal_on_its_own() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("c1", "waiting forever", anchor_after_item_id=None)
    s.acked("c1", ack("t1", "queued"))

    # Time passing, unrelated queue movement, and unrelated messages settle
    # nothing: there is no local timeout, failure, or completion.
    s.observed_queue_movement("tOther")
    s.observed_user_message("someoneElse", "item-x")

    assert s.size == 1
    entry = s.get("c1")
    assert entry is not None and entry.ack is not None
    assert entry.ack["disposition"] == "queued"


def test_a_client_that_renders_nothing_optimistically_holds_no_entries() -> None:
    s: PendingCommandSet[str] = PendingCommandSet()
    assert s.size == 0
    assert s.list() == ()
    # The degenerate mode is supported: the fold reduces to the protocol.
    assert s.reconnected_without_snapshot().must_replay == ()


def test_a_brand_new_submit_after_ephemeral_death_is_refused_not_annotated() -> None:
    # The whole SET closes, not just the retired ids: a fresh commandId
    # submitted after the discard would be retired terminalUnknown by a next
    # discharge — a fabricated "we don't know whether this ran" about input
    # provably never sent to any host.
    s: PendingCommandSet[str] = PendingCommandSet()
    s.submitted("old", "x", anchor_after_item_id=None)
    s.discard_ephemeral()
    with pytest.raises(MuseSessionDiscardedError, match=r"accepts no new submissions"):
        s.submitted("brand-new", "y", anchor_after_item_id=None)


def test_a_shared_discard_registry_blocks_replay_across_set_instances() -> None:
    # The injected-by-reference option: one client shares a single discard
    # registry across the sessions it opens, so a FRESH set cannot replay a
    # dead host's ids at a new host.
    shared: set[str] = set()
    first: PendingCommandSet[str] = PendingCommandSet(discarded_command_ids=shared)
    first.submitted("c1", "x", anchor_after_item_id=None)
    first.discard_ephemeral()

    fresh: PendingCommandSet[str] = PendingCommandSet(discarded_command_ids=shared)
    with pytest.raises(
        MuseSessionDiscardedError,
        match=r"commandId `c1` cannot be replayed against a new host",
    ):
        fresh.submitted("c1", "replay", anchor_after_item_id=None)
