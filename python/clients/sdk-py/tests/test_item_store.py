"""PY-TEST-003's item-store arms (specs/638-muse-sdk-python FR-638-007,
carrying 14990 INV-003/INV-004): port of ``clients/sdk-ts/test/item-store.test.ts``,
every case, same sequences.
"""

from __future__ import annotations

from typing import Any, Callable

import pytest

from muse_code.errors import MuseSessionDiscardedError
from muse_code.fold import (
    BufferedForAbsentItem,
    IgnoredStaleRevision,
    Inserted,
    ItemStore,
    Replaced,
    TerminalUnknownItemAnnotation,
)


def item(item_id: str, revision: int, status: str, text: str | None = None) -> dict[str, Any]:
    fixture: dict[str, Any] = {"itemId": item_id, "revision": revision, "status": status}
    if text is not None:
        fixture["text"] = text
    return fixture


def test_an_item_replaces_only_at_a_strictly_higher_revision() -> None:
    store = ItemStore()

    assert store.apply(item("i1", 1, "inProgress")) == Inserted("i1")
    assert store.apply(item("i1", 2, "completed", "done")) == Replaced(
        "i1", from_revision=1, to_revision=2
    )
    held = store.get("i1")
    assert held is not None and held["status"] == "completed"

    # A stale re-emission (a gap fill replaying an older revision) mutates
    # nothing — the store keeps revision 2.
    assert store.apply(item("i1", 1, "inProgress")) == IgnoredStaleRevision(
        "i1", held=2, offered=1
    )
    held = store.get("i1")
    assert held is not None and held["status"] == "completed"

    # An equal revision is also not higher: idempotent replay, no mutation.
    assert store.apply(item("i1", 2, "failed")) == IgnoredStaleRevision("i1", held=2, offered=2)
    held = store.get("i1")
    assert held is not None and held["status"] == "completed"


def test_delta_concatenation_equals_the_final_committed_value() -> None:
    store = ItemStore()
    store.apply(item("m1", 1, "inProgress", ""))

    for chunk in ["All 214 ", "tests pass", " except two"]:
        store.apply_delta("m1", chunk)
    final = item("m1", 2, "completed", "All 214 tests pass except two")
    store.apply(final)

    assert store.accumulated("m1") == final["text"]
    held = store.get("m1")
    assert held is not None and held["text"] == final["text"]


def test_deltas_are_per_field_path_and_bump_no_revision() -> None:
    store = ItemStore()
    store.apply(item("r1", 3, "inProgress"))

    store.apply_delta("r1", "Scanning ", "summary.0")
    store.apply_delta("r1", "the list", "summary.0")
    store.apply_delta("r1", "Choosing two", "summary.1")
    store.apply_delta("r1", "tool bytes", "output")

    assert store.accumulated("r1", "summary.0") == "Scanning the list"
    assert store.accumulated("r1", "summary.1") == "Choosing two"
    assert store.accumulated("r1", "output") == "tool bytes"
    assert store.accumulated_fields("r1") == ["output", "summary.0", "summary.1"]
    held = store.get("r1")
    assert held is not None and held["revision"] == 3, "a delta must not bump the revision"


def test_a_delta_for_an_absent_item_is_buffered_not_dropped() -> None:
    store = ItemStore()

    outcome = store.apply_delta("late", "first bytes")
    assert outcome == BufferedForAbsentItem("late", "text")

    store.apply(item("late", 1, "inProgress", ""))
    store.apply_delta("late", " and more")
    assert store.accumulated("late") == "first bytes and more"


def test_item_completed_for_an_id_never_started_is_an_upsert() -> None:
    store = ItemStore()
    # Single-record items (e.g. reminderChild) emit only item/completed, and a
    # gap fill can land a completion for an item this connection never opened.
    assert store.apply(item("single", 1, "completed")) == Inserted("single")
    assert store.size == 1


def test_items_keep_first_opened_order_and_expose_the_last_opened_id() -> None:
    store = ItemStore()
    store.apply(item("a", 1, "inProgress"))
    store.apply(item("b", 1, "inProgress"))
    store.apply(item("a", 2, "completed"))
    store.apply(item("c", 1, "inProgress"))

    assert [held["itemId"] for held in store.list()] == [
        "a",
        "b",
        "c",
    ], "a later revision must not move an item to the end"
    assert store.last_opened_item_id() == "c"


def test_seeding_from_a_snapshot_replaces_wholesale() -> None:
    store = ItemStore()
    store.apply(item("stale", 9, "completed"))
    store.apply_delta("stale", "old bytes")

    store.seed([item("s1", 1, "completed"), item("s2", 4, "inProgress")])

    assert [held["itemId"] for held in store.list()] == ["s1", "s2"]
    assert store.get("stale") is None
    assert store.accumulated("stale") is None, "seeding clears accumulators"


def test_the_fold_is_deterministic_over_the_same_sequence() -> None:
    sequence: list[Callable[[ItemStore], object]] = [
        lambda s: s.apply(item("x", 1, "inProgress", "")),
        lambda s: s.apply_delta("x", "one "),
        lambda s: s.apply_delta("x", "two"),
        lambda s: s.apply(item("y", 1, "completed")),
        lambda s: s.apply(item("x", 1, "inProgress")),
        lambda s: s.apply(item("x", 2, "completed", "one two")),
    ]

    def run_once() -> tuple[list[Any], str | None]:
        store = ItemStore()
        for step in sequence:
            step(store)
        return (store.list(), store.accumulated("x"))

    assert run_once() == run_once()


def test_ephemeral_host_death_annotates_only_in_progress_items_and_discards_the_session() -> None:
    store = ItemStore()
    store.apply(item("open", 1, "inProgress", "partial bytes"))
    store.apply(item("done", 2, "completed", "complete"))

    assert store.mark_ephemeral_host_death(
        lambda candidate: candidate["status"] == "inProgress"
    ) == [TerminalUnknownItemAnnotation("open")]
    assert store.is_terminal_unknown("open") is True
    assert store.is_terminal_unknown("done") is False
    held = store.get("open")
    assert held is not None and held["status"] == "inProgress", (
        "terminal-unknown is client annotation; no item/completed is synthesized"
    )
    with pytest.raises(MuseSessionDiscardedError, match="ephemeral session was discarded"):
        store.apply(item("late", 1, "completed"))
    with pytest.raises(MuseSessionDiscardedError, match="ephemeral session was discarded"):
        store.apply_delta("open", "late")
    with pytest.raises(MuseSessionDiscardedError, match="ephemeral session was discarded"):
        store.seed([item("replayed", 1, "completed")])
