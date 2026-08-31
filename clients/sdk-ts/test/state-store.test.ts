/**
 * TEST-004 `state_families_last_write_wins` — spec 14990 FR-007, INV-005.
 *
 * Session-state events are replace-wholesale, cursor-ordered, latest-wins
 * (tdd SS4.6). An explicit `null` clears a family and is a fact, never
 * "unchanged"; absent is never fabricated.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SessionStateStore } from "../src/index.js";

test("latest value wins per family, in arrival order", () => {
  const store = new SessionStateStore();

  store.apply("session/modelChanged", { modelId: "muse-large" }, "v:s:10");
  store.apply("session/modelChanged", { modelId: "muse-small" }, "v:s:20");

  assert.deepEqual(store.get("session/modelChanged"), { modelId: "muse-small" });
});

test("an explicit null clears a family and is not 'unchanged'", () => {
  const store = new SessionStateStore();

  store.apply("session/goalChanged", { objective: "green the suite" }, "v:s:30");
  assert.deepEqual(store.get("session/goalChanged"), { objective: "green the suite" });

  store.apply("session/goalChanged", null, "v:s:40");
  assert.equal(store.get("session/goalChanged"), null, "null is a value, not a no-op");
  assert.ok(store.has("session/goalChanged"), "the family still holds a fact");
});

test("a family with no fact reads undefined, distinct from a cleared null", () => {
  const store = new SessionStateStore();

  assert.equal(store.get("session/branchChanged"), undefined);
  assert.equal(store.has("session/branchChanged"), false);

  store.apply("session/branchChanged", null, "v:s:50");
  assert.equal(store.get("session/branchChanged"), null);
  assert.equal(store.has("session/branchChanged"), true);
});

test("a replayed cursor is refused; any other arrival applies (cursors are opaque)", () => {
  const store = new SessionStateStore();

  store.apply("session/todoListChanged", { revision: 7 }, "v:s:60");

  const replay = store.apply("session/todoListChanged", { revision: 7 }, "v:s:60");
  assert.equal(replay.applied, false, "the same cursor replayed is idempotent");
  assert.deepEqual(store.get("session/todoListChanged"), { revision: 7 });

  // A DIFFERENT cursor always applies: arrival order is the LWW truth, and
  // cursors must not be relationally compared (SS4.1) — the server emits in
  // cursor order, so a later arrival IS the newer fact.
  const next = store.apply("session/todoListChanged", { revision: 8 }, "v:s:55");
  assert.equal(next.applied, true, "arrival order wins; no string comparison exists");
  assert.deepEqual(store.get("session/todoListChanged"), { revision: 8 });
});

test("dedup remembers only the LATEST cursor: a non-latest replay applies (the doc's narrowed promise)", () => {
  const store = new SessionStateStore();

  store.apply("session/goalChanged", { objective: "A" }, "v:s:5");
  store.apply("session/goalChanged", { objective: "B" }, "v:s:6");

  // Replaying A (an older, no-longer-latest cursor) is NOT refused — the
  // store keeps one cursor per family, so only a back-to-back replay of the
  // latest event is idempotent. The SS4.8 splice caller never re-delivers an
  // older event (it pages from `after` and discards paged events at cursors
  // >= `next`), so this regression window is unreachable on a sanctioned
  // path; this test pins the narrowed module-doc promise, not a bug.
  const replayOfOlder = store.apply("session/goalChanged", { objective: "A" }, "v:s:5");
  assert.equal(replayOfOlder.applied, true, "only the latest cursor is remembered");
  assert.deepEqual(store.get("session/goalChanged"), { objective: "A" });
});

test("a digit rollover still applies: cursors are opaque, never string-ordered", () => {
  const store = new SessionStateStore();

  // "v:s:10" < "v:s:9" as strings; ordering by string drops every genuinely
  // newer event after a 9->10 rollover (tdd SS4.1: cursors MUST NOT be
  // parsed or ordered). Arrival order is the truth.
  store.apply("session/modelChanged", { modelId: "old" }, "v:s:9");
  const next = store.apply("session/modelChanged", { modelId: "new" }, "v:s:10");

  assert.equal(next.applied, true, "a newer in-order event must apply across a rollover");
  assert.deepEqual(store.get("session/modelChanged"), { modelId: "new" });
});

test("families are independent: one overflow never disturbs another", () => {
  const store = new SessionStateStore();

  store.apply("session/modelChanged", { modelId: "m" }, "v:s:70");
  store.apply("session/tokenUsage", { totalTokens: 100 }, "v:s:71");
  store.apply("session/modelChanged", { modelId: "m2" }, "v:s:72");

  assert.deepEqual(store.get("session/tokenUsage"), { totalTokens: 100 });
  assert.deepEqual(store.get("session/modelChanged"), { modelId: "m2" });
});

test("tokenUsage cumulative totals replace, never sum (tdd SS4.6.5)", () => {
  const store = new SessionStateStore();

  // The running totals arrive server-computed in `cumulative`: the client
  // STORES the newer fact. 100 then 250 reads 250 — a summing client would
  // read 350.
  store.apply("session/tokenUsage", { cumulative: { totalTokens: 100 } }, "v:s:71");
  store.apply("session/tokenUsage", { cumulative: { totalTokens: 250 } }, "v:s:72");

  assert.deepEqual(store.get("session/tokenUsage"), { cumulative: { totalTokens: 250 } });
});

test("the state fold is deterministic over the same sequence (TEST-002, INV-002)", () => {
  const runOnce = () => {
    const store = new SessionStateStore();
    store.apply("session/modelChanged", { modelId: "m1" }, "v:s:1");
    store.apply("session/goalChanged", { objective: "g" }, "v:s:2");
    store.apply("session/goalChanged", null, "v:s:3");
    store.apply("session/tokenUsage", { cumulative: { totalTokens: 9 } }, "v:s:4");
    store.apply("session/modelChanged", { modelId: "m2" }, "v:s:5");
    store.apply("session/modelChanged", { modelId: "m2" }, "v:s:5"); // replay
    return { families: store.families(), values: store.families().map((f) => store.get(f)) };
  };

  assert.deepEqual(runOnce(), runOnce());
});

test("an additively-added family folds with no code change (tdd SS1.5.4)", () => {
  const store = new SessionStateStore();
  // A family this SDK has never heard of must still fold: the key is opaque.
  store.apply("session/somethingNewChanged", { shape: "unknown" }, "v:s:80");
  assert.deepEqual(store.get("session/somethingNewChanged"), { shape: "unknown" });
});

test("seeding from a snapshot replaces the whole state block", () => {
  const store = new SessionStateStore();
  store.apply("session/modelChanged", { modelId: "stale" }, "v:s:90");

  store.seed(
    [
      ["session/modelChanged", { modelId: "fresh" }],
      ["session/goalChanged", null],
    ],
    "v:s:400",
  );

  assert.deepEqual(store.get("session/modelChanged"), { modelId: "fresh" });
  assert.equal(store.get("session/goalChanged"), null);
  assert.deepEqual(store.families(), ["session/modelChanged", "session/goalChanged"]);

  // A suffix event after the snapshot cursor still applies (SS4.9.2 splice).
  const applied = store.apply("session/modelChanged", { modelId: "newer" }, "v:s:401");
  assert.equal(applied.applied, true);
  assert.deepEqual(store.get("session/modelChanged"), { modelId: "newer" });
});
