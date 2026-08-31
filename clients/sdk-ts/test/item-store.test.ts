/**
 * TEST-003 `delta_concat_equals_final_and_revision_guard` — spec 14990
 * FR-007, INV-003/INV-004; plus the seed half of TEST-006 and the
 * determinism property of TEST-002 over the item store.
 *
 * The payload type here is a TEST fixture, not a protocol type: the concrete
 * `Item` enters the generated declarations in #14953 and `SessionFold` binds
 * to it there. INV-001 is why this file declares its own fixture rather than
 * hand-writing the wire shape into `src/`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ItemStore } from "../src/index.js";

interface FixtureItem {
  readonly itemId: string;
  readonly revision: number;
  readonly status: string;
  readonly text?: string;
}

const item = (
  itemId: string,
  revision: number,
  status: string,
  text?: string,
): FixtureItem => ({ itemId, revision, status, ...(text !== undefined ? { text } : {}) });

test("an item replaces only at a strictly higher revision (INV-003)", () => {
  const store = new ItemStore<FixtureItem>();

  assert.deepEqual(store.apply(item("i1", 1, "inProgress")), {
    kind: "inserted",
    itemId: "i1",
  });
  assert.deepEqual(store.apply(item("i1", 2, "completed", "done")), {
    kind: "replaced",
    itemId: "i1",
    from: 1,
    to: 2,
  });
  assert.equal(store.get("i1")?.status, "completed");

  // A stale re-emission (a gap fill replaying an older revision) mutates
  // nothing — the store keeps revision 2.
  assert.deepEqual(store.apply(item("i1", 1, "inProgress")), {
    kind: "ignoredStaleRevision",
    itemId: "i1",
    held: 2,
    offered: 1,
  });
  assert.equal(store.get("i1")?.status, "completed");

  // An equal revision is also not higher: idempotent replay, no mutation.
  assert.deepEqual(store.apply(item("i1", 2, "failed")), {
    kind: "ignoredStaleRevision",
    itemId: "i1",
    held: 2,
    offered: 2,
  });
  assert.equal(store.get("i1")?.status, "completed");
});

test("delta concatenation equals the final committed value (INV-004)", () => {
  const store = new ItemStore<FixtureItem>();
  store.apply(item("m1", 1, "inProgress", ""));

  for (const chunk of ["All 214 ", "tests pass", " except two"]) {
    store.applyDelta("m1", chunk);
  }
  const final = item("m1", 2, "completed", "All 214 tests pass except two");
  store.apply(final);

  assert.equal(store.accumulated("m1"), final.text);
  assert.equal(store.get("m1")?.text, final.text);
});

test("deltas are per field path and bump no revision (tdd SS4.3.1)", () => {
  const store = new ItemStore<FixtureItem>();
  store.apply(item("r1", 3, "inProgress"));

  store.applyDelta("r1", "Scanning ", "summary.0");
  store.applyDelta("r1", "the list", "summary.0");
  store.applyDelta("r1", "Choosing two", "summary.1");
  store.applyDelta("r1", "tool bytes", "output");

  assert.equal(store.accumulated("r1", "summary.0"), "Scanning the list");
  assert.equal(store.accumulated("r1", "summary.1"), "Choosing two");
  assert.equal(store.accumulated("r1", "output"), "tool bytes");
  assert.deepEqual(store.accumulatedFields("r1"), ["output", "summary.0", "summary.1"]);
  assert.equal(store.get("r1")?.revision, 3, "a delta must not bump the revision");
});

test("a delta for an absent item is buffered, not dropped (tdd SS4.7.3)", () => {
  const store = new ItemStore<FixtureItem>();

  const outcome = store.applyDelta("late", "first bytes");
  assert.deepEqual(outcome, {
    kind: "bufferedForAbsentItem",
    itemId: "late",
    field: "text",
  });

  store.apply(item("late", 1, "inProgress", ""));
  store.applyDelta("late", " and more");
  assert.equal(store.accumulated("late"), "first bytes and more");
});

test("item/completed for an id never started is an upsert (tdd SS4.4.1)", () => {
  const store = new ItemStore<FixtureItem>();
  // Single-record items (e.g. reminderChild) emit only item/completed, and a
  // gap fill can land a completion for an item this connection never opened.
  assert.deepEqual(store.apply(item("single", 1, "completed")), {
    kind: "inserted",
    itemId: "single",
  });
  assert.equal(store.size, 1);
});

test("items keep first-opened order and expose the last opened id", () => {
  const store = new ItemStore<FixtureItem>();
  store.apply(item("a", 1, "inProgress"));
  store.apply(item("b", 1, "inProgress"));
  store.apply(item("a", 2, "completed"));
  store.apply(item("c", 1, "inProgress"));

  assert.deepEqual(
    store.list().map((i) => i.itemId),
    ["a", "b", "c"],
    "a later revision must not move an item to the end",
  );
  assert.equal(store.lastOpenedItemId(), "c");
});

test("seeding from a snapshot replaces wholesale (tdd SS4.9)", () => {
  const store = new ItemStore<FixtureItem>();
  store.apply(item("stale", 9, "completed"));
  store.applyDelta("stale", "old bytes");

  store.seed([item("s1", 1, "completed"), item("s2", 4, "inProgress")]);

  assert.deepEqual(
    store.list().map((i) => i.itemId),
    ["s1", "s2"],
  );
  assert.equal(store.get("stale"), undefined);
  assert.equal(store.accumulated("stale"), undefined, "seeding clears accumulators");
});

test("the fold is deterministic over the same sequence (TEST-002, INV-002)", () => {
  const sequence: Array<(s: ItemStore<FixtureItem>) => void> = [
    (s) => s.apply(item("x", 1, "inProgress", "")),
    (s) => s.applyDelta("x", "one "),
    (s) => s.applyDelta("x", "two"),
    (s) => s.apply(item("y", 1, "completed")),
    (s) => s.apply(item("x", 1, "inProgress")),
    (s) => s.apply(item("x", 2, "completed", "one two")),
  ];

  const runOnce = () => {
    const store = new ItemStore<FixtureItem>();
    for (const step of sequence) step(store);
    return {
      items: store.list(),
      text: store.accumulated("x"),
    };
  };

  assert.deepEqual(runOnce(), runOnce());
});

test("ephemeral host death annotates only in-progress items and discards the session", () => {
  const store = new ItemStore<FixtureItem>();
  store.apply(item("open", 1, "inProgress", "partial bytes"));
  store.apply(item("done", 2, "completed", "complete"));

  assert.deepEqual(
    store.markEphemeralHostDeath((candidate) => candidate.status === "inProgress"),
    [{ kind: "terminalUnknown", itemId: "open" }],
  );
  assert.equal(store.isTerminalUnknown("open"), true);
  assert.equal(store.isTerminalUnknown("done"), false);
  assert.equal(
    store.get("open")?.status,
    "inProgress",
    "terminal-unknown is client annotation; no item/completed is synthesized",
  );
  assert.throws(
    () => store.apply(item("late", 1, "completed")),
    /ephemeral session was discarded/,
    "a discarded ephemeral session cannot accept replacement-host events",
  );
  assert.throws(
    () => store.applyDelta("open", "late"),
    /ephemeral session was discarded/,
    "late deltas cannot pile onto a discarded ephemeral session (FM-002)",
  );
  assert.throws(
    () => store.seed([item("replayed", 1, "completed")]),
    /ephemeral session was discarded/,
    "a discarded ephemeral session cannot be resumed",
  );
});
