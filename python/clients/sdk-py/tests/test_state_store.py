"""PY-the governing rule ``state_families_last_write_wins``: port of
``clients/sdk-ts/test/state-store.test.ts``, every case.

The absent-versus-cleared distinction the TS store spells as
``undefined``/``null`` is spelled here as ``has()``/``get()`` (the store's
module docstring, "Absent versus cleared").
"""

from __future__ import annotations

from muse_code.fold import SessionStateStore


def test_latest_value_wins_per_family_in_arrival_order() -> None:
    store = SessionStateStore()

    store.apply("session/modelChanged", {"modelId": "muse-large"}, "v:s:10")
    store.apply("session/modelChanged", {"modelId": "muse-small"}, "v:s:20")

    assert store.get("session/modelChanged") == {"modelId": "muse-small"}


def test_an_explicit_null_clears_a_family_and_is_not_unchanged() -> None:
    store = SessionStateStore()

    store.apply("session/goalChanged", {"objective": "green the suite"}, "v:s:30")
    assert store.get("session/goalChanged") == {"objective": "green the suite"}

    store.apply("session/goalChanged", None, "v:s:40")
    assert store.get("session/goalChanged") is None, "None is a value, not a no-op"
    assert store.has("session/goalChanged"), "the family still holds a fact"


def test_a_family_with_no_fact_reads_absent_distinct_from_a_cleared_null() -> None:
    store = SessionStateStore()

    assert store.get("session/branchChanged") is None
    assert store.has("session/branchChanged") is False

    store.apply("session/branchChanged", None, "v:s:50")
    assert store.get("session/branchChanged") is None
    assert store.has("session/branchChanged") is True


def test_a_replayed_cursor_is_refused_any_other_arrival_applies() -> None:
    store = SessionStateStore()

    store.apply("session/todoListChanged", {"revision": 7}, "v:s:60")

    replay = store.apply("session/todoListChanged", {"revision": 7}, "v:s:60")
    assert replay.applied is False, "the same cursor replayed is idempotent"
    assert store.get("session/todoListChanged") == {"revision": 7}

    # A DIFFERENT cursor always applies: arrival order is the LWW truth, and
    # cursors must not be relationally compared — the server emits in
    # cursor order, so a later arrival IS the newer fact.
    nxt = store.apply("session/todoListChanged", {"revision": 8}, "v:s:55")
    assert nxt.applied is True, "arrival order wins; no string comparison exists"
    assert store.get("session/todoListChanged") == {"revision": 8}


def test_dedup_remembers_only_the_latest_cursor_a_non_latest_replay_applies() -> None:
    store = SessionStateStore()

    store.apply("session/goalChanged", {"objective": "A"}, "v:s:5")
    store.apply("session/goalChanged", {"objective": "B"}, "v:s:6")

    # Replaying A (an older, no-longer-latest cursor) is NOT refused — the
    # store keeps one cursor per family, so only a back-to-back replay of the
    # latest event is idempotent. The the protocol splice caller never re-delivers an
    # older event, so this regression window is unreachable on a sanctioned
    # path; this test pins the narrowed module-doc promise, not a bug.
    replay_of_older = store.apply("session/goalChanged", {"objective": "A"}, "v:s:5")
    assert replay_of_older.applied is True, "only the latest cursor is remembered"
    assert store.get("session/goalChanged") == {"objective": "A"}


def test_a_digit_rollover_still_applies_cursors_are_opaque_never_string_ordered() -> None:
    store = SessionStateStore()

    # "v:s:10" < "v:s:9" as strings; ordering by string drops every genuinely
    # newer event after a 9->10 rollover. Arrival order is truth.
    store.apply("session/modelChanged", {"modelId": "old"}, "v:s:9")
    nxt = store.apply("session/modelChanged", {"modelId": "new"}, "v:s:10")

    assert nxt.applied is True, "a newer in-order event must apply across a rollover"
    assert store.get("session/modelChanged") == {"modelId": "new"}


def test_families_are_independent_one_overflow_never_disturbs_another() -> None:
    store = SessionStateStore()

    store.apply("session/modelChanged", {"modelId": "m"}, "v:s:70")
    store.apply("session/tokenUsage", {"totalTokens": 100}, "v:s:71")
    store.apply("session/modelChanged", {"modelId": "m2"}, "v:s:72")

    assert store.get("session/tokenUsage") == {"totalTokens": 100}
    assert store.get("session/modelChanged") == {"modelId": "m2"}


def test_token_usage_cumulative_totals_replace_never_sum() -> None:
    store = SessionStateStore()

    # The running totals arrive server-computed in `cumulative`: the client
    # STORES the newer fact. 100 then 250 reads 250 — a summing client would
    # read 350.
    store.apply("session/tokenUsage", {"cumulative": {"totalTokens": 100}}, "v:s:71")
    store.apply("session/tokenUsage", {"cumulative": {"totalTokens": 250}}, "v:s:72")

    assert store.get("session/tokenUsage") == {"cumulative": {"totalTokens": 250}}


def test_the_state_fold_is_deterministic_over_the_same_sequence() -> None:
    def run_once() -> tuple[list[str], list[object]]:
        store = SessionStateStore()
        store.apply("session/modelChanged", {"modelId": "m1"}, "v:s:1")
        store.apply("session/goalChanged", {"objective": "g"}, "v:s:2")
        store.apply("session/goalChanged", None, "v:s:3")
        store.apply("session/tokenUsage", {"cumulative": {"totalTokens": 9}}, "v:s:4")
        store.apply("session/modelChanged", {"modelId": "m2"}, "v:s:5")
        store.apply("session/modelChanged", {"modelId": "m2"}, "v:s:5")  # replay
        return (store.families(), [store.get(f) for f in store.families()])

    assert run_once() == run_once()


def test_an_additively_added_family_folds_with_no_code_change() -> None:
    store = SessionStateStore()
    # A family this SDK has never heard of must still fold: the key is opaque.
    store.apply("session/somethingNewChanged", {"shape": "unknown"}, "v:s:80")
    assert store.get("session/somethingNewChanged") == {"shape": "unknown"}


def test_seeding_from_a_snapshot_replaces_the_whole_state_block() -> None:
    store = SessionStateStore()
    store.apply("session/modelChanged", {"modelId": "stale"}, "v:s:90")

    store.seed(
        [
            ("session/modelChanged", {"modelId": "fresh"}),
            ("session/goalChanged", None),
        ],
        "v:s:400",
    )

    assert store.get("session/modelChanged") == {"modelId": "fresh"}
    assert store.get("session/goalChanged") is None
    assert store.has("session/goalChanged") is True
    assert store.families() == ["session/modelChanged", "session/goalChanged"]

    # A suffix event after the snapshot cursor still applies.
    applied = store.apply("session/modelChanged", {"modelId": "newer"}, "v:s:401")
    assert applied.applied is True
    assert store.get("session/modelChanged") == {"modelId": "newer"}
