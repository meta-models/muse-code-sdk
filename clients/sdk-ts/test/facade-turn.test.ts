/**
 * TEST-012 `facade_turn_iterators_and_waits` — spec 14990 FR-018, INV-014
 * (tasks.md T030, slice 3).
 *
 * The two arms the task names explicitly are the two SS3.1.4 no-run exits of a
 * PRE-MINTED turn, and they are the whole reason this test exists:
 *
 *  - `turn/unqueued` — the reclaim. No `turn/completed` will EVER carry that
 *    `turnId` (tdd SS3.6), so a wait that folds only `turn/completed` hangs
 *    forever. SS3.1.4: "An SDK's turn-wait MUST settle on `turn/unqueued` too."
 *  - the LAUNCH FAILURE (`"deferred_start_failed"`) — `turn/completed` with
 *    terminal `"failed"`, `error.kind: "launchError"`, and NO preceding
 *    `turn/started`. The ordinary wait resolves on it; the arm exists so a
 *    client does not read the reclaim as the only no-run exit, and so a wait
 *    gated on having observed a start cannot pass.
 *
 * Every event below is typed as the GENERATED params type it names, so a
 * member the facade reads that the wire does not carry fails `tsc` here rather
 * than at runtime against a real host (INV-001).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  Item,
  Notification,
  ItemCompletedParams,
  ItemDeltaParams,
  ItemStartedParams,
  ItemUpdatedParams,
  SourceRange,
  TurnCompletedParams,
  TurnError,
  TurnRetractedParams,
  TurnRetryScheduledParams,
  TurnStartedParams,
  TurnUnqueuedParams,
} from "@muse/msp";

import { isLaunchFailure, MuseForeignSessionError, MuseHostDiedError, Session } from "../src/index.js";
import type { PendingCommandView, SessionFoldView } from "../src/index.js";
import type { TurnHandle } from "../src/facade/turn-handle.js";
import type { ViewEvent } from "../src/index.js";

const SOURCE: SourceRange = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: "str-1", kind: "session" },
};
const SESSION = "s-1";

function session(): Session {
  return new Session({ sessionId: SESSION, durability: { kind: "durable" } });
}

function turnStarted(turnId: string, viewCursor: string): ViewEvent {
  const params: TurnStartedParams = {
    commandId: turnId,
    sessionId: SESSION,
    sourceRange: SOURCE,
    turnId,
    viewCursor,
  };
  return { method: "turn/started", params };
}

function turnCompleted(
  turnId: string,
  terminal: string,
  viewCursor: string,
  error?: TurnError,
): ViewEvent {
  const params: TurnCompletedParams = {
    sessionId: SESSION,
    sourceRange: SOURCE,
    terminal,
    turnId,
    viewCursor,
    ...(error === undefined ? {} : { error }),
  };
  return { method: "turn/completed", params };
}

function turnUnqueued(turnId: string, viewCursor: string): ViewEvent {
  const params: TurnUnqueuedParams = {
    commandId: turnId,
    sessionId: SESSION,
    sourceRange: SOURCE,
    turnId,
    viewCursor,
  };
  return { method: "turn/unqueued", params };
}

function turnRetracted(turnId: string, viewCursor: string): ViewEvent {
  const params: TurnRetractedParams = {
    commandId: turnId,
    sessionId: SESSION,
    sourceRange: SOURCE,
    turnId,
    viewCursor,
  };
  return { method: "turn/retracted", params };
}

function turnRetryScheduled(turnId: string, viewCursor: string): ViewEvent {
  const params: TurnRetryScheduledParams = {
    attempt: 1,
    maxAttempts: 3,
    nextAttempt: 2,
    reason: "provider stream disconnected",
    retryDelayMs: 2_000,
    sessionId: SESSION,
    sourceRange: SOURCE,
    turnId,
    viewCursor,
  };
  return { method: "turn/retryScheduled", params };
}

function item(itemId: string, revision: number, extra: Partial<Item> = {}): Item {
  return { itemId, kind: "agentMessage", revision, status: "inProgress", ...extra };
}

function itemStarted(payload: Item, viewCursor: string): ViewEvent {
  const params: ItemStartedParams = { item: payload, sessionId: SESSION, viewCursor };
  return { method: "item/started", params };
}

function itemCompleted(payload: Item, viewCursor: string): ViewEvent {
  const params: ItemCompletedParams = {
    item: payload,
    sessionId: SESSION,
    sourceRange: SOURCE,
    viewCursor,
  };
  return { method: "item/completed", params };
}

function itemUpdated(payload: Item, viewCursor: string): ViewEvent {
  const params: ItemUpdatedParams = {
    item: payload,
    sessionId: SESSION,
    sourceRange: SOURCE,
    viewCursor,
  };
  return { method: "item/updated", params };
}

function itemDelta(itemId: string, delta: string, viewCursor: string): ViewEvent {
  const params: ItemDeltaParams = { delta, itemId, sessionId: SESSION, viewCursor };
  return { method: "item/delta", params };
}

/** Drain an async iterator that a settled turn has already closed. */
async function drain<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const value of source) out.push(value);
  return out;
}

// ---- INV-014: the turn wait settles on every no-run exit -------------------

test("TEST-012: the wait settles on turn/completed, carrying the server's terminal verbatim", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  s.apply(turnStarted("t-1", "v:1"));
  s.apply(turnCompleted("t-1", "completed", "v:2"));

  const outcome = await turn.completed;
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.kind === "completed" && outcome.params.terminal, "completed");
  // The start WAS observed here; the launch-failure arm below is its twin.
  assert.equal(outcome.kind === "completed" && outcome.observedStart, true);
});

test("TEST-012: the wait settles on turn/unqueued — the reclaim that no turn/completed ever follows (SS3.1.4)", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-queued");
  // A queued submit's turn is pre-minted at admission and never launches: no
  // turn/started precedes this and no turn/completed will follow it. A wait
  // folding only turn/completed hangs forever here.
  s.apply(turnUnqueued("t-queued", "v:1"));

  const outcome = await turn.completed;
  assert.equal(outcome.kind, "unqueued");
  assert.equal(outcome.kind === "unqueued" && outcome.params.turnId, "t-queued");
  // The reclaim is NOT a TurnTerminal and is never rendered as one (INV-006).
  assert.equal(Object.hasOwn(outcome, "terminal"), false);
});

test("TEST-012: the wait settles on the launch failure — turn/completed with NO preceding turn/started", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-launch-failed");
  // "deferred_start_failed" (SS3.1.4/SS3.2): the launch errored at the terminal
  // boundary, so the runtime writes the pre-minted turn's terminal directly.
  const error: TurnError = {
    kind: "launchError",
    message: "workflow entry not found",
    retryable: true,
  };
  s.apply(turnCompleted("t-launch-failed", "failed", "v:1", error));

  const outcome = await turn.completed;
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.kind === "completed" && outcome.params.terminal, "failed");
  assert.equal(outcome.kind === "completed" && outcome.params.error?.kind, "launchError");
  // The discriminator is the WIRE marker, not local observation.
  assert.equal(isLaunchFailure(outcome), true);
  assert.equal(outcome.kind === "completed" && outcome.observedStart, false);
});

test("TEST-012: observedStart:false alone is NOT a launch failure — terminal-first folds are legitimate", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-single-shot");
  // A single-shot turn, a gap fill, or any consumer that attached mid-stream
  // produces a terminal-first `turn/completed` for a turn that really DID run.
  // It is indistinguishable from a launch failure by `observedStart` alone —
  // which is why the launch failure is identified by its wire marker.
  s.apply(turnCompleted("t-single-shot", "completed", "v:1"));

  const outcome = await turn.completed;
  assert.equal(outcome.kind === "completed" && outcome.observedStart, false);
  assert.equal(isLaunchFailure(outcome), false, "no launchError marker, so not a launch failure");
});

test("TEST-012: a plain failed turn is not a launch failure either — the error kind decides", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  s.apply(turnStarted("t-1", "v:1"));
  s.apply(
    turnCompleted("t-1", "failed", "v:2", {
      kind: "modelError",
      message: "provider refused",
      retryable: false,
    }),
  );
  assert.equal(isLaunchFailure(await turn.completed), false);
});

test("TEST-012: turn/retryScheduled is non-terminal and never settles the wait (SS4.5.1)", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  s.apply(turnStarted("t-1", "v:1"));
  s.apply(turnRetryScheduled("t-1", "v:2"));

  let settled = false;
  void turn.completed.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "a scheduled retry is a fact about a RUNNING turn, not an exit");

  s.apply(turnCompleted("t-1", "completed", "v:3"));
  assert.equal((await turn.completed).kind, "completed");
});

test("TEST-012: turn/retracted does not settle the wait — SS3.1.4 names exactly two resolutions", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  s.apply(turnStarted("t-1", "v:1"));
  s.apply(turnRetracted("t-1", "v:2"));

  let settled = false;
  void turn.completed.then(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  // A retract settles an interrupt-paired retract of a turn that RAN; the turn
  // still reaches its own terminal, which is what the waiter is waiting for.
  assert.equal(settled, false);

  s.apply(turnCompleted("t-1", "cancelled", "v:3"));
  assert.equal((await turn.completed).kind, "completed");
});

test("TEST-012: a wait registered AFTER the turn already settled resolves from fold state", { timeout: 5_000 }, async () => {
  const s = session();
  s.apply(turnStarted("t-1", "v:1"));
  s.apply(turnCompleted("t-1", "completed", "v:2"));
  // The facade holds no durable state, but the fold it rides already knows the
  // answer: a late waiter must not hang for an event that has come and gone.
  assert.equal((await s.turn("t-1").completed).kind, "completed");
});

test("TEST-012: two handles for the same turn are the same handle, and both settle", { timeout: 5_000 }, async () => {
  const s = session();
  const first = s.turn("t-1");
  const second = s.turn("t-1");
  assert.equal(first, second);
  s.apply(turnUnqueued("t-1", "v:1"));
  assert.equal((await second.completed).kind, "unqueued");
});

// ---- FR-018: the iterators ride the fold ----------------------------------

test("TEST-012: items() yields this turn's items and closes when the turn settles", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  const items = turn.items();

  s.apply(turnStarted("t-1", "v:1"));
  s.apply(itemStarted(item("i-1", 1, { turnId: "t-1" }), "v:2"));
  // Another turn's item never enters this turn's iterator.
  s.apply(itemStarted(item("i-other", 1, { turnId: "t-2" }), "v:3"));
  // A stale re-emission mutates nothing (INV-003), so it yields nothing.
  s.apply(itemCompleted(item("i-1", 1, { turnId: "t-1", status: "completed" }), "v:4"));
  s.apply(itemCompleted(item("i-1", 2, { turnId: "t-1", status: "completed" }), "v:5"));
  s.apply(turnCompleted("t-1", "completed", "v:6"));

  const seen = await drain(items);
  assert.deepEqual(
    seen.map((entry) => [entry.itemId, entry.revision, entry.status]),
    [
      ["i-1", 1, "inProgress"],
      ["i-1", 2, "completed"],
    ],
    "one yield per fold-observed revision change; the stale revision 1 replay yields nothing",
  );
});

test("TEST-012: items() replays the turn's already-folded items before its live tail", { timeout: 5_000 }, async () => {
  const s = session();
  s.apply(turnStarted("t-1", "v:1"));
  s.apply(itemStarted(item("i-1", 1, { turnId: "t-1" }), "v:2"));

  // The iterator is created AFTER i-1 folded: a consumer that attaches mid-turn
  // must not be handed a transcript with a hole in front of it.
  const items = s.turn("t-1").items();
  s.apply(itemStarted(item("i-2", 1, { turnId: "t-1" }), "v:3"));
  s.apply(turnCompleted("t-1", "completed", "v:4"));

  assert.deepEqual((await drain(items)).map((entry) => entry.itemId), ["i-1", "i-2"]);
});

test("TEST-012: deltas() yields this turn's deltas and closes when the turn settles", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  const deltas = turn.deltas();

  s.apply(turnStarted("t-1", "v:1"));
  s.apply(itemStarted(item("i-1", 1, { turnId: "t-1" }), "v:2"));
  s.apply(itemDelta("i-1", "All ", "v:3"));
  s.apply(itemDelta("i-1", "214 tests pass", "v:4"));
  s.apply(itemStarted(item("i-other", 1, { turnId: "t-2" }), "v:5"));
  s.apply(itemDelta("i-other", "not mine", "v:6"));
  s.apply(turnCompleted("t-1", "completed", "v:7"));

  const seen = await drain(deltas);
  assert.deepEqual(seen.map((entry) => entry.delta), ["All ", "214 tests pass"]);
  // INV-004: what the iterator emitted concatenates to what the fold holds.
  assert.equal(seen.map((entry) => entry.delta).join(""), s.fold.items.accumulated("i-1"));
});

test("TEST-012: a delta that arrives BEFORE its item is attributed on the item's arrival, never dropped", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  const deltas = turn.deltas();

  s.apply(turnStarted("t-1", "v:1"));
  // Delta before started, or after a gap: the store buffers it against the
  // item's arrival (spec Edge Cases, SS4.7.3). Its TURN is unknowable until the
  // item lands, so the iterator must attribute it then rather than drop it —
  // a dropped delta is exactly the silent hole FR-020 forbids elsewhere.
  s.apply(itemDelta("i-1", "early", "v:2"));
  s.apply(itemStarted(item("i-1", 1, { turnId: "t-1" }), "v:3"));
  s.apply(itemDelta("i-1", " late", "v:4"));
  s.apply(turnCompleted("t-1", "completed", "v:5"));

  assert.deepEqual((await drain(deltas)).map((entry) => entry.delta), ["early", " late"]);
});

test("TEST-012: an unattributed delta whose item belongs to ANOTHER turn stays out of this iterator", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  const deltas = turn.deltas();

  s.apply(turnStarted("t-1", "v:1"));
  s.apply(itemDelta("i-other", "early", "v:2"));
  s.apply(itemStarted(item("i-other", 1, { turnId: "t-2" }), "v:3"));
  s.apply(turnCompleted("t-1", "completed", "v:4"));

  assert.deepEqual(await drain(deltas), []);
});

test("TEST-012: an iterator opened on an already-settled turn closes instead of hanging", { timeout: 5_000 }, async () => {
  const s = session();
  s.apply(turnStarted("t-1", "v:1"));
  s.apply(itemStarted(item("i-1", 1, { turnId: "t-1" }), "v:2"));
  s.apply(turnCompleted("t-1", "completed", "v:3"));

  // The turn is over. The replay is still owed, but the iterator must END.
  assert.deepEqual((await drain(s.turn("t-1").items())).map((e) => e.itemId), ["i-1"]);
  assert.deepEqual(await drain(s.turn("t-1").deltas()), []);
});

test("TEST-012: an unqueued turn's iterators close — the reclaim ends them exactly as a terminal does", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-queued");
  const items = turn.items();
  const deltas = turn.deltas();
  s.apply(turnUnqueued("t-queued", "v:1"));

  assert.deepEqual(await drain(items), []);
  assert.deepEqual(await drain(deltas), []);
});

// ---- fan-out inputs that were previously unprotected -----------------------

test("TEST-012: item/updated fans out too — every mid-turn revision reaches items()", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  const items = turn.items();

  s.apply(turnStarted("t-1", "v:1"));
  s.apply(itemStarted(item("i-1", 1, { turnId: "t-1" }), "v:2"));
  // `item/updated` is the third fan-out input and the only one that was
  // untested: deleting its case from the switch left the whole suite green
  // while `turn.items()` silently dropped every mid-turn revision.
  s.apply(itemUpdated(item("i-1", 2, { turnId: "t-1" }), "v:3"));
  s.apply(turnCompleted("t-1", "completed", "v:4"));

  assert.deepEqual((await drain(items)).map((entry) => entry.revision), [1, 2]);
});

test("TEST-012: a buffered delta flushes when its item arrives via item/updated", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  const deltas = turn.deltas();

  s.apply(turnStarted("t-1", "v:1"));
  s.apply(itemDelta("i-1", "early", "v:2"));
  // Post-gap fills arrive as `item/updated` rather than `item/started`, so the
  // unattributed-delta flush has to hang off this arm too.
  s.apply(itemUpdated(item("i-1", 1, { turnId: "t-1" }), "v:3"));
  s.apply(turnCompleted("t-1", "completed", "v:4"));

  assert.deepEqual((await drain(deltas)).map((entry) => entry.delta), ["early"]);
});

test("TEST-012: a userShell item's null turnId mints no phantom turn", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  const items = turn.items();

  s.apply(turnStarted("t-1", "v:1"));
  // `userShell` is the one kind carrying `turnId: null` (spec Edge Cases; tdd
  // SS4.5.6 wire example). The generated type says `turnId?: string`, so tsc
  // cannot catch a `!== undefined` guard letting null through — which minted a
  // turn keyed `null` and attributed the item and its deltas to it.
  const shell = { ...item("i-shell", 1), kind: "userShell", turnId: null } as unknown as Item;
  s.apply(itemStarted(shell, "v:2"));
  s.apply(itemDelta("i-shell", "output", "v:3"));
  s.apply(turnCompleted("t-1", "completed", "v:4"));

  assert.deepEqual(await drain(items), [], "a turn-less item belongs to no turn's iterator");
  // Only t-1. A `!== undefined` guard lets null through and mints a SECOND
  // handle keyed `null`, attributing the userShell item and its deltas to it.
  assert.equal(s.knownTurnCount, 1, "no phantom turn was minted for the null turnId");
  assert.equal(s.fold.items.get("i-shell")?.itemId, "i-shell", "but the item still folded");
});

test("TEST-012: an unattributed delta whose item turns out turn-less is dropped from every turn", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  const deltas = turn.deltas();

  s.apply(turnStarted("t-1", "v:1"));
  s.apply(itemDelta("i-shell", "early", "v:2"));
  const shell = { ...item("i-shell", 1), kind: "userShell", turnId: null } as unknown as Item;
  s.apply(itemStarted(shell, "v:3"));
  s.apply(turnCompleted("t-1", "completed", "v:4"));

  assert.deepEqual(await drain(deltas), []);
  assert.equal(s.knownTurnCount, 1, "the buffered delta minted no phantom turn either");
});

test("TEST-012: breaking out of an iterator deregisters it instead of leaking for the turn", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  s.apply(turnStarted("t-1", "v:1"));

  for (let round = 0; round < 50; round += 1) {
    s.apply(itemStarted(item(`i-${round}`, 1, { turnId: "t-1" }), `v:${round + 2}`));
    // The pattern this facade invites: re-attach per render, read one, drop it.
    // The fold replay makes the first `next()` resolve immediately, so the
    // `break` runs and `return()` deregisters — the behaviour under test.
    for await (const _first of turn.items()) break;
  }
  // Reaches the concrete handle deliberately: `liveStreamCount` is test-only
  // observability and stays off the public `Turn` surface.
  assert.equal(
    (turn as TurnHandle).liveStreamCount,
    0,
    "no dropped iterator is still being fanned out to",
  );
});

test("TEST-012: TWO deltas before their item both come out, not just the first", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  const deltas = turn.deltas();

  s.apply(turnStarted("t-1", "v:1"));
  // One early delta was covered; dropping the SECOND and later ones passed the
  // whole suite. A regression there silently loses chunks — the FR-020 hole.
  s.apply(itemDelta("i-1", "ear", "v:2"));
  s.apply(itemDelta("i-1", "ly", "v:3"));
  s.apply(itemStarted(item("i-1", 1, { turnId: "t-1" }), "v:4"));
  s.apply(turnCompleted("t-1", "completed", "v:5"));

  assert.deepEqual((await drain(deltas)).map((entry) => entry.delta), ["ear", "ly"]);
});

test("TEST-012: deltas() does not replay to a mid-turn attach — the asymmetry is enforced", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  s.apply(turnStarted("t-1", "v:1"));
  s.apply(itemStarted(item("i-1", 1, { turnId: "t-1" }), "v:2"));
  s.apply(itemDelta("i-1", "All ", "v:3"));
  s.apply(itemDelta("i-1", "214 ", "v:4"));

  // Attach AFTER two deltas folded. A "helpful" replay-on-attach — the second
  // copy of state the module doc rules out — would yield all three here.
  const deltas = turn.deltas();
  s.apply(itemDelta("i-1", "tests pass", "v:5"));
  s.apply(turnCompleted("t-1", "completed", "v:6"));

  assert.deepEqual((await drain(deltas)).map((entry) => entry.delta), ["tests pass"]);
  // The full text is still recoverable from the fold, which is the point.
  assert.equal(s.fold.items.accumulated("i-1"), "All 214 tests pass");
});

test("TEST-012: two concurrent next() calls both settle, in order", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  s.apply(turnStarted("t-1", "v:1"));
  const items = turn.items();

  // `Promise.all([it.next(), it.next()])` prefetch is reasonable on a plain
  // AsyncIterableIterator. A single waiter slot let the second call overwrite
  // the first, so the first promise never settled and its value went to the
  // second caller — a silently never-settling promise.
  const both = Promise.all([items.next(), items.next()]);
  s.apply(itemStarted(item("i-1", 1, { turnId: "t-1" }), "v:2"));
  s.apply(itemStarted(item("i-2", 1, { turnId: "t-1" }), "v:3"));

  const [first, second] = await both;
  assert.equal(first.done, false);
  assert.equal(second.done, false);
  assert.deepEqual(
    [(first.value as Item).itemId, (second.value as Item).itemId],
    ["i-1", "i-2"],
    "FIFO: the older waiter gets the older item",
  );
});

test("TEST-012: end() drains EVERY queued waiter, not just the oldest", { timeout: 5_000 }, async () => {
  const s = session();
  const turn = s.turn("t-1");
  s.apply(turnStarted("t-1", "v:1"));
  const items = turn.items();

  const both = Promise.all([items.next(), items.next()]);
  s.apply(turnCompleted("t-1", "completed", "v:2"));

  assert.deepEqual(await both, [
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);
});

// ---- SS4.13: apply() drives the pending set's ordinary retirements ---------

test("TEST-012: a commandId-bearing userMessage materializes its pending entry", { timeout: 5_000 }, async () => {
  const s = new Session<string>({ sessionId: SESSION, durability: { kind: "durable" } });
  s.pending.submitted({ commandId: "c-1", input: "fix the test" });
  s.apply(turnStarted("t-1", "v:1"));

  // SS4.13 "Materialized": the real item replaces the optimistic entry. Left
  // unwired, the entry lingers as the durable-looking echo SS4.13 forbids.
  const userMessage = {
    ...item("i-user", 1, { turnId: "t-1" }),
    commandId: "c-1",
    kind: "userMessage",
  } as Item;
  const outcome = s.apply(itemStarted(userMessage, "v:2"));

  assert.deepEqual(outcome.retirements, [
    { commandId: "c-1", itemId: "i-user", kind: "materialized", matchedBy: "userMessage" },
  ]);
  assert.equal(s.pending.has("c-1"), false);
});

test("TEST-012: a userMessage from ANOTHER client retires nothing (echo dedup)", { timeout: 5_000 }, async () => {
  const s = new Session<string>({ sessionId: SESSION, durability: { kind: "durable" } });
  const foreign = {
    ...item("i-user", 1, { turnId: "t-1" }),
    commandId: "c-someone-else",
    kind: "userMessage",
  } as Item;
  assert.deepEqual(s.apply(itemStarted(foreign, "v:1")).retirements, []);
});

test("TEST-012: turn/unqueued retires its pending entry as reclaimed, input restored", { timeout: 5_000 }, async () => {
  const s = new Session<string>({ sessionId: SESSION, durability: { kind: "durable" } });
  // DISTINCT ids. On the wire a commandId (client-minted UUIDv7) and a turnId
  // (server pre-minted) never collide, so reusing one string here left the join
  // key unpinned: routing `observedReclaim(turnId)` instead of
  // `observedReclaim(commandId)` kept the whole suite green while, on a real
  // host, the entry would never match and would linger as the durable-looking
  // echo SS4.13 forbids.
  s.pending.submitted({ commandId: "c-q", input: "and the lint" });

  const params: TurnUnqueuedParams = {
    commandId: "c-q",
    sessionId: SESSION,
    sourceRange: SOURCE,
    turnId: "t-queued",
    viewCursor: "v:1",
  };
  const outcome = s.apply({ method: "turn/unqueued", params });

  assert.deepEqual(outcome.retirements, [
    { commandId: "c-q", input: "and the lint", kind: "reclaimed", restoreToComposer: true },
  ]);
  assert.equal(s.pending.has("c-q"), false);
  // And the wait on the TURN still settles — two independent obligations.
  assert.equal((await s.turn("t-queued").completed).kind, "unqueued");
});

test("TEST-012: a materialized entry is NOT re-retired as terminal-unknown by a later death", { timeout: 5_000 }, () => {
  const s = new Session<string>({
    sessionId: SESSION,
    durability: { kind: "ephemeral" },
  });
  s.pending.submitted({ commandId: "c-1", input: "fix the test" });
  const userMessage = {
    ...item("i-user", 1, { turnId: "t-1" }),
    commandId: "c-1",
    kind: "userMessage",
  } as Item;
  s.apply(itemStarted(userMessage, "v:1"));

  // Without the wiring the entry was still pending here, so the discharge
  // annotated a command whose fate the client already knew — exactly the
  // fabricated terminal-unknown SS2.13.3b forbids.
  const discharge = s.hostExited({
    exitCode: 77,
    exitSignal: null,
    kind: "crash",
    stderrTail: [],
  });
  assert.equal(discharge.kind, "discharged");
  assert.deepEqual(discharge.kind === "discharged" ? discharge.retiredCommands : null, []);
});

// ---- SS1.5.4 tolerance survives the foreign-session guard ------------------

test("TEST-012: an unknown notification without sessionId is tolerated, not rejected", { timeout: 5_000 }, () => {
  const s = session();
  // A newer host's additive notification reaches `apply` at runtime even
  // though `ViewEvent`'s members all declare `sessionId`. SS1.5.4 makes it
  // tolerated losslessly; an unconditional guard read threw
  // MuseForeignSessionError ("belongs to session undefined") instead.
  const unknown = { method: "view/somethingNew", params: { viewCursor: "v:1" } } as unknown as ViewEvent;
  assert.equal(s.apply(unknown).fold.kind, "ignoredUnrecognizedMethod");

  // And one with no `params` at all must not throw a raw TypeError. The fold
  // drops it as `ignoredMissingParams` (its own SS1.5.4 arm, PR #23087) — the
  // point of THIS arm is that the session guard lets it reach the fold at all.
  const bare = { method: "view/bare" } as unknown as ViewEvent;
  assert.equal(s.apply(bare).fold.kind, "ignoredMissingParams");
});

test("TEST-012: a frame that DOES name a foreign session is still refused", { timeout: 5_000 }, () => {
  const s = session();
  const foreign = {
    method: "item/started",
    params: { item: item("i-x", 1), sessionId: "other", viewCursor: "v:1" },
  } as ViewEvent;
  assert.throws(() => s.apply(foreign), MuseForeignSessionError);
});

/**
 * Compile-time: nothing on the fold view can mutate the fold.
 *
 * The store mutators are already unreachable — `SessionFold` narrows `items`
 * to the `FoldItems` allowlist and `sessionState` to `FoldSessionState`
 * (PR #23087 review round) — so what this pins is the fold's OWN pair:
 * `apply`, which would fold an event while skipping turn routing and the
 * discard latch, `markEphemeralHostDeath`, which is `Session.hostExited`'s to
 * call, and `gapFilled`, which is the SS4.8 fill's to call — a consumer
 * calling it would report a hole closed that nothing filled, and the fold
 * would go back to claiming it is current over a transcript with a hole in it.
 * These resolve to `true` only while all three stay off the view, and the
 * `items`/`sessionState` rows fail if the upstream narrowing is ever undone.
 */
type Hides<T, K extends string> = K extends keyof T ? never : true;
const _foldViewIsReadOnly: [
  Hides<SessionFoldView, "apply">,
  Hides<SessionFoldView, "markEphemeralHostDeath">,
  Hides<SessionFoldView, "gapFilled">,
  Hides<SessionFoldView["items"], "apply">,
  Hides<SessionFoldView["items"], "applyDelta">,
  Hides<SessionFoldView["items"], "seed">,
  Hides<SessionFoldView["items"], "markEphemeralHostDeath">,
  Hides<SessionFoldView["sessionState"], "apply">,
  Hides<SessionFoldView["sessionState"], "seed">,
] = [true, true, true, true, true, true, true, true, true];
void _foldViewIsReadOnly;

/**
 * The same discipline for the pending set, over FIVE keys and two rationales.
 * `discardEphemeral`, `observedReclaim` and `observedUserMessage` are
 * `Session`'s to DRIVE from folded events: a consumer calling
 * `discardEphemeral()` on a live session drains the set and latches it, so the
 * later real `hostExited` reports `retiredCommands: []` — silently losing the
 * inputs the discharge exists to hand back. `stopRetrying` and
 * `replayAnswered` are consumer verbs re-exposed on `Session` so the
 * retirement also prunes the submitter's replay memory.
 */
/**
 * The guard that actually closes "Omit fails open on the NEXT mutator".
 *
 * A `Hides<>` row can only name a mutator that already exists, so reverting
 * either view to `Omit` and adding a new fold method compiles clean — verified.
 * Pinning the EXACT key set catches it: any member arriving on the view widens
 * `keyof` and fails here, which is what makes the `Pick` allowlists load-bearing
 * rather than decorative.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _foldViewKeysAreExact: Exactly<
  keyof SessionFoldView,
  | "activeTurnId"
  // The FM-003 currency pair, added with the FR-020 fill (T032). Both are
  // getters, so the read-only allowlist keeps its meaning: `gapFilled` — the
  // mutator that would let a consumer report a hole closed that nothing
  // filled — stays off this view, and this exactness pin is what proves it.
  | "current"
  | "pendingGap"
  | "items"
  | "pendingApprovals"
  | "pendingUserInputs"
  | "resolvedApprovals"
  | "sessionState"
  | "settledUserInputs"
  | "turn"
  | "turns"
> = true;
void _foldViewKeysAreExact;

const _pendingViewKeysAreExact: Exactly<
  keyof PendingCommandView<string>,
  | "ackErrored"
  | "acked"
  | "discarded"
  | "get"
  | "has"
  | "joinSnapshot"
  | "list"
  | "observedQueueMovement"
  | "reconnectedWithoutSnapshot"
  | "resolveReplayAtJoin"
  | "size"
  | "submitted"
> = true;
void _pendingViewKeysAreExact;

const _pendingViewIsNarrowed: [
  Hides<PendingCommandView<string>, "discardEphemeral">,
  Hides<PendingCommandView<string>, "observedReclaim">,
  Hides<PendingCommandView<string>, "observedUserMessage">,
  // Retirement-producing consumer verbs live on `Session` (which prunes the
  // submitter's replay memory), never on the raw view.
  Hides<PendingCommandView<string>, "stopRetrying">,
  Hides<PendingCommandView<string>, "replayAnswered">,
] = [true, true, true, true, true];
void _pendingViewIsNarrowed;


// ---- SS1.5.4: a params-less KNOWN method must not kill the pump ------------

test("TEST-012: a params-less known-method frame is dropped, never thrown", { timeout: 5_000 }, () => {
  const s = session();
  // The fold drops these as `ignoredMissingParams`. `Session.apply` is the ONLY
  // event entry point, and its switch reads `params` on the turn and delta
  // arms — so before the early return a single empty frame threw a raw
  // TypeError straight out of the consumer's notification pump.
  const methods = ["turn/started", "turn/completed", "turn/unqueued", "item/delta", "item/started"];
  // Absent, explicit null, and non-object. `params: null` is a very common
  // sloppy JSON-RPC spelling of "no params" and threw the same TypeError one
  // value over; a non-object got further and minted a phantom turn keyed
  // `undefined`. Classified once in the fold so both entry points inherit it.
  for (const method of methods) {
    // `params: []` needs its own row: JSON-RPC 2.0 permits POSITIONAL params
    // and `typeof [] === "object"`, so an array slipped both earlier clauses
    // and settled a turn keyed `undefined`.
    for (const frame of [
      { method },
      { method, params: null },
      { method, params: 42 },
      { method, params: [] },
    ]) {
      const outcome = s.apply(frame);
      assert.equal(
        outcome.fold.kind,
        "ignoredMissingParams",
        `${method} with params=${JSON.stringify(frame.params)} must drop, not throw`,
      );
      assert.deepEqual(outcome.retirements, []);
    }
  }
  assert.equal(s.knownTurnCount, 0, "a dropped frame mints no turn");
});

test("TEST-012: apply() takes the wire's Notification shape with no cast", { timeout: 5_000 }, () => {
  const s = session();
  // The frame a real wiring site holds is the generated `Notification`, not a
  // `ViewEvent`. Before the wide overload this needed `as unknown as ViewEvent`
  // at every seam — the fold already grew the same overload pair for this.
  const notification: Notification = {
    jsonrpc: "2.0",
    method: "turn/started",
    params: { commandId: "t-1", sessionId: SESSION, sourceRange: SOURCE, turnId: "t-1", viewCursor: "v:1" },
  };
  assert.equal(s.apply(notification).fold.kind, "turn");
});

test("TEST-012: after a DURABLE death, started-THEN-completed settles too (order-independent)", { timeout: 5_000 }, async () => {
  const s = session();
  s.hostExited({ exitCode: 77, exitSignal: null, kind: "crash", stderrTail: [] });

  // A post-crash drain usually delivers BOTH frames. Pre-failing a
  // server-minted handle made the answer depend on arrival order:
  // terminal-first settled, started-first pre-failed the handle and
  // first-settlement-wins then dropped the real terminal one frame later.
  s.apply(turnStarted("t-3", "v:1"));
  s.apply(turnCompleted("t-3", "completed", "v:2"));

  assert.equal(s.fold.turn("t-3")?.terminal, "completed");
  const outcome = await s.turn("t-3").completed;
  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.kind === "completed" && outcome.observedStart, true);
});

test("TEST-012: after a DURABLE death a real turn/unqueued still settles its turn", { timeout: 5_000 }, async () => {
  const s = session();
  s.hostExited({ exitCode: 77, exitSignal: null, kind: "crash", stderrTail: [] });

  // The reclaim twin of the terminal arm. Without it, re-routing just this
  // arm through the death latch stayed green: the pre-failed handle wins
  // first-settlement and the real server-authored `turn/unqueued` is dropped.
  s.apply(turnUnqueued("t-3", "v:1"));

  assert.equal((await s.turn("t-3").completed).kind, "unqueued");
});

test("TEST-012: after a DURABLE death a turn with NO news still rejects", { timeout: 5_000 }, async () => {
  const s = session();
  s.hostExited({ exitCode: 77, exitSignal: null, kind: "crash", stderrTail: [] });
  // The other half of the ordering rule: a consumer asking about a turn this
  // session has heard nothing about has no answer coming, so it must reject
  // rather than hang.
  await assert.rejects(s.turn("t-unheard-of").completed, MuseHostDiedError);
});

test("TEST-012: after a DURABLE death a real terminal still settles its turn", { timeout: 5_000 }, async () => {
  const s = session();
  s.hostExited({ exitCode: 77, exitSignal: null, kind: "crash", stderrTail: [] });

  // FM-001 keeps `apply()` folding after a durable death, so a terminal can
  // arrive for a turn no handle exists for yet. Minting that handle through the
  // death latch failed it first, and first-settlement-wins then DROPPED the
  // real server-authored terminal sitting right here in the fold.
  s.apply(turnCompleted("t-2", "completed", "v:1"));

  assert.equal(s.fold.turn("t-2")?.terminal, "completed");
  const outcome = await s.turn("t-2").completed;
  assert.equal(outcome.kind, "completed");
});
