/**
 * TEST-005 `pending_command_full_arms` — spec 14990 FR-009, INV-006/INV-007.
 *
 * Every arm of tdd SS4.13 (decision record D-032), driven by synthetic
 * ack/launch/reject/join sequences. The #210 fixture family (three golden
 * transcripts) replaces the synthetic driver when it lands; the arms asserted
 * here are the ones those fixtures will exercise, so the swap is a substrate
 * change and not an API change.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { PendingCommandSet } from "../src/index.js";
import type { PendingRetirement } from "../src/index.js";

const rejected = (reason: string) => ({
  code: -32030,
  kind: "commandRejected" as const,
  reason,
});

test("an entry renders after the last item at submission time, in submission order", () => {
  const set = new PendingCommandSet<string>();

  set.submitted({ commandId: "c1", input: "first", anchorAfterItemId: "itemA" });
  set.submitted({ commandId: "c2", input: "second", anchorAfterItemId: "itemA" });

  assert.deepEqual(
    set.list().map((e) => [e.commandId, e.anchorAfterItemId, e.submissionIndex]),
    [
      ["c1", "itemA", 0],
      ["c2", "itemA", 1],
    ],
  );
});

test("the anchor is fixed at insertion: later server events never relocate it", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "queued input", anchorAfterItemId: "itemA" });
  set.acked("c1", { turnId: "t9", disposition: "queued" });

  // A running-turn item folds in BETWEEN the ack and the launch. This is the
  // arm that discriminates the fixed anchor from float-to-bottom.
  set.observedQueueMovement("tRunning");

  assert.equal(set.get("c1")?.anchorAfterItemId, "itemA");
});

test("ack -> launch: the commandId-bearing userMessage retires the entry", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "fix the test", anchorAfterItemId: null });
  set.acked("c1", { turnId: "t1", disposition: "queued" });

  const retirement = set.observedUserMessage("c1", "item-user-1");

  assert.deepEqual(retirement, {
    kind: "materialized",
    commandId: "c1",
    matchedBy: "userMessage",
    itemId: "item-user-1",
  });
  assert.equal(set.size, 0);
});

test("a userMessage with no local entry is another client's echo, not ours", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "mine", input: "x", anchorAfterItemId: null });

  assert.equal(set.observedUserMessage("theirs", "item-9"), undefined);
  assert.equal(set.size, 1, "our entry must survive another client's message");
});

test("ack -> reject: a durable commandRejected retires and restores the input", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "restore me", anchorAfterItemId: null });
  set.acked("c1", { turnId: "t1", disposition: "queued" });

  const retirement = set.replayAnswered("c1", {
    kind: "error",
    error: rejected("deferred_start_failed"),
  });

  assert.deepEqual(retirement, {
    kind: "rejected",
    commandId: "c1",
    reason: "deferred_start_failed",
    input: "restore me",
    restoreToComposer: true,
  });
  assert.equal(set.size, 0);
});

test("a reason-'abandoned' answer retires via the Abandoned arm", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "never ran", anchorAfterItemId: null });
  set.acked("c1", { turnId: "t1", disposition: "queued" });

  const retirement = set.replayAnswered("c1", {
    kind: "error",
    error: rejected("abandoned"),
  });

  assert.equal((retirement as PendingRetirement<string>).kind, "abandoned");
  assert.equal(set.size, 0);
});

test("nothing-admitted errors are not settlements: the entry holds", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "retry me", anchorAfterItemId: null });

  // backpressured (-32031): nothing was admitted.
  assert.equal(set.ackErrored("c1", { code: -32031, kind: "overloaded" }), "held");
  assert.equal(set.size, 1);

  // An oversized frame: also admits nothing.
  assert.equal(set.ackErrored("c1", { code: -32002, kind: "inputTooLarge" }), "held");
  assert.equal(set.size, 1);

  // The same commandId retried is the sanctioned exactly-once retry and must
  // not create a second entry or move the anchor.
  set.submitted({ commandId: "c1", input: "retry me", anchorAfterItemId: "moved" });
  assert.equal(set.size, 1);
  assert.equal(set.get("c1")?.anchorAfterItemId, null);
});

test("a client that stops retrying must retire the entry to its composer", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "give up on me", anchorAfterItemId: null });
  set.ackErrored("c1", { code: -32031, kind: "overloaded" });

  const retirement = set.stopRetrying("c1");

  assert.deepEqual(retirement, {
    kind: "retryAbandonedByClient",
    commandId: "c1",
    input: "give up on me",
    restoreToComposer: true,
  });
  assert.equal(set.size, 0);
});

test("queue movement re-verifies acked-queued entries, and only those", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "queued", input: "q", anchorAfterItemId: null });
  set.acked("queued", { turnId: "tQueued", disposition: "queued" });
  set.submitted({ commandId: "steered", input: "s", anchorAfterItemId: null });
  set.acked("steered", { turnId: "tRunning", disposition: "steered" });
  set.submitted({ commandId: "unacked", input: "u", anchorAfterItemId: null });

  const toReplay = set.observedQueueMovement("tOther");
  assert.deepEqual(toReplay, ["queued"]);

  // The entry's OWN turn moving is not a re-verify trigger.
  assert.deepEqual(set.observedQueueMovement("tQueued"), []);
});

test("a still-pending ack on replay keeps the entry: never promote locally", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "still waiting", anchorAfterItemId: null });
  set.acked("c1", { turnId: "t1", disposition: "queued" });

  const outcome = set.replayAnswered("c1", {
    kind: "ack",
    ack: { turnId: "t1", disposition: "queued" },
  });

  assert.equal(outcome, "held");
  assert.equal(set.size, 1);
});

test("an observed reclaim retires immediately, without a snapshot join", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "reclaim me", anchorAfterItemId: null });
  set.acked("c1", { turnId: "t1", disposition: "queued" });

  const retirement = set.observedReclaim("c1");

  assert.deepEqual(retirement, {
    kind: "reclaimed",
    commandId: "c1",
    input: "reclaim me",
    restoreToComposer: true,
  });
});

test("snapshot join: all five arms, with queuedTurns reordering", () => {
  const set = new PendingCommandSet<string>();

  // Arm 1 — materialized (its userMessage is in the snapshot's items).
  set.submitted({ commandId: "materialized", input: "m", anchorAfterItemId: null });
  set.acked("materialized", { turnId: "tM", disposition: "started" });

  // Arm 2 — two kept queued entries whose SUBMISSION order diverges from the
  // server's queuedTurns order (the backpressured-then-retried divergence).
  set.submitted({ commandId: "queuedSecond", input: "q2", anchorAfterItemId: null });
  set.acked("queuedSecond", { turnId: "tQ2", disposition: "queued" });
  set.submitted({ commandId: "queuedFirst", input: "q1", anchorAfterItemId: null });
  set.acked("queuedFirst", { turnId: "tQ1", disposition: "queued" });

  // Arm 3 — an acked steer, pending on the running turn's PendingSteerQueue.
  set.submitted({ commandId: "steer", input: "s", anchorAfterItemId: "itemEarly" });
  set.acked("steer", { turnId: "tActive", disposition: "steered" });

  // Arm 4 — acked, matching nothing: must be resolved by a replay.
  set.submitted({ commandId: "noMatch", input: "n", anchorAfterItemId: null });
  set.acked("noMatch", { turnId: "tGone", disposition: "queued" });

  // Arm 5 — unacked and unmatched: must resubmit the SAME commandId once.
  set.submitted({ commandId: "unacked", input: "u", anchorAfterItemId: null });

  const plan = set.joinSnapshot({
    activeTurn: { turnId: "tActive", commandId: "someoneElse" },
    // Server order is the reverse of submission order.
    queuedTurns: [
      { turnId: "tQ1", commandId: "queuedFirst" },
      { turnId: "tQ2", commandId: "queuedSecond" },
    ],
    userMessageCommandIds: [{ commandId: "materialized", itemId: "item-m" }],
    lastItemId: "itemLast",
  });

  assert.deepEqual(plan.retirements, [
    {
      kind: "materialized",
      commandId: "materialized",
      matchedBy: "userMessage",
      itemId: "item-m",
    },
  ]);
  assert.deepEqual(plan.mustReplay, ["noMatch"]);
  assert.deepEqual(plan.mustResubmit, ["unacked"]);

  // The steer keeps its submission anchor; kept queued entries re-anchor to
  // the end of the reconciled fold, ordered among themselves by queuedTurns.
  assert.equal(set.get("steer")?.anchorAfterItemId, "itemEarly");
  assert.equal(set.get("queuedFirst")?.anchorAfterItemId, "itemLast");
  assert.deepEqual(
    set.list().map((e) => e.commandId),
    ["steer", "noMatch", "unacked", "queuedFirst", "queuedSecond"],
    "server-confirmed queue order wins among kept queued entries",
  );
});

test("join arm 1: an activeTurn.commandId match materializes with no invented itemId", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "cActive", input: "running now", anchorAfterItemId: null });
  set.acked("cActive", { turnId: "tActive", disposition: "started" });

  const plan = set.joinSnapshot({
    activeTurn: { turnId: "tActive", commandId: "cActive" },
    queuedTurns: [],
    userMessageCommandIds: [],
    lastItemId: null,
  });

  // No user-message item id is in the join facts for this arm; the
  // retirement must say so (matchedBy) rather than alias the commandId into
  // the itemId field — item ids and command ids are separate namespaces.
  assert.deepEqual(plan.retirements, [
    { kind: "materialized", commandId: "cActive", matchedBy: "activeTurn" },
  ]);
  assert.equal(set.size, 0);
});

test("isSettlement: a -32030 code settles even when the kind disagrees", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "typed", anchorAfterItemId: null });

  // The SS3.1.2 registry binds -32030 <-> commandRejected one-to-one, so a
  // disagreeing pair is a server fault where the CODE still asserts the
  // durable rejection; the taxonomy's bias for unfamiliar vocabulary is
  // toward terminal. Retire, never hold forever.
  const outcome = set.ackErrored("c1", { code: -32030, kind: "overloaded", reason: "run_active" });

  // Pin the FULL disposition, not just "not held": the rejection must carry
  // the typed input back to the composer (restoreToComposer) — a retirement
  // that silently drops the input passed the old assertion (review round 4).
  assert.deepEqual(outcome, {
    kind: "rejected",
    commandId: "c1",
    reason: "run_active",
    input: "typed",
    restoreToComposer: true,
  });
  assert.equal(set.size, 0);
});

test("isSettlement: a commandRejected kind settles even when the code disagrees", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "typed", anchorAfterItemId: null });

  const outcome = set.ackErrored("c1", { code: -32000, kind: "commandRejected", reason: "run_active" });

  // Same full-disposition pin as the code-disagrees arm above.
  assert.deepEqual(outcome, {
    kind: "rejected",
    commandId: "c1",
    reason: "run_active",
    input: "typed",
    restoreToComposer: true,
  });
  assert.equal(set.size, 0);
});

test("the pending fold is deterministic over the same sequence (TEST-002, INV-002)", () => {
  const runOnce = () => {
    const set = new PendingCommandSet<string>();
    set.submitted({ commandId: "a", input: "1", anchorAfterItemId: null });
    set.submitted({ commandId: "b", input: "2", anchorAfterItemId: "item1" });
    set.submitted({ commandId: "c", input: "3", anchorAfterItemId: null });
    set.acked("a", { turnId: "tA", disposition: "queued" });
    set.acked("b", { turnId: "tB", disposition: "queued" });
    const plan = set.joinSnapshot({
      activeTurn: null,
      // Server order reverses submission order — the sort under #ordered().
      queuedTurns: [
        { turnId: "tB", commandId: "b" },
        { turnId: "tA", commandId: "a" },
      ],
      userMessageCommandIds: [],
      lastItemId: "itemLast",
    });
    return { plan, entries: set.list() };
  };

  assert.deepEqual(runOnce(), runOnce());
});

test("join arm 4: a stale 'queued' ack with no queuedTurns entry is reclaimed", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "was reclaimed", anchorAfterItemId: null });
  set.acked("c1", { turnId: "t1", disposition: "queued" });

  set.joinSnapshot({
    activeTurn: null,
    queuedTurns: [],
    userMessageCommandIds: [],
    lastItemId: null,
  });

  const retirement = set.resolveReplayAtJoin(
    "c1",
    { kind: "ack", ack: { turnId: "t1", disposition: "queued" } },
    [], // the snapshot's queuedTurns did not list it
  );

  assert.deepEqual(retirement, {
    kind: "reclaimed",
    commandId: "c1",
    input: "was reclaimed",
    restoreToComposer: true,
  });
});

test("join arm 4: a still-pending 'started' answer holds rather than retiring", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "started", anchorAfterItemId: null });
  set.acked("c1", { turnId: "t1", disposition: "queued" });

  const outcome = set.resolveReplayAtJoin(
    "c1",
    { kind: "ack", ack: { turnId: "t1", disposition: "started" } },
    [],
  );

  assert.equal(outcome, "held");
  assert.equal(set.size, 1);
});

test("one join plan demands each unacked entry exactly once, in order (the single-pass shape)", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "lost ack", anchorAfterItemId: null });
  set.submitted({ commandId: "c2", input: "also lost", anchorAfterItemId: null });

  const plan = set.joinSnapshot({
    activeTurn: null,
    queuedTurns: [],
    userMessageCommandIds: [],
    lastItemId: null,
  });

  // Once-per-plan is structural — the plan is built in one ordered pass — so
  // this pins the plan's SHAPE: each unacked entry appears exactly once, in
  // submission order, with no duplicates.
  assert.deepEqual(plan.mustResubmit, ["c1", "c2"], "each entry demanded exactly once, in order");
  assert.equal(set.size, 2, "entries stay pending until a server fact settles them");
});

test("across joins, a lost resubmit is demanded again — never stranded", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "lost twice", anchorAfterItemId: null });

  const first = set.joinSnapshot({
    activeTurn: null,
    queuedTurns: [],
    userMessageCommandIds: [],
    lastItemId: null,
  });
  assert.deepEqual(first.mustResubmit, ["c1"]);

  // The demanded resubmit was lost to another disconnect before it ran. A
  // fresh join must demand it again (same-commandId resubmit is idempotent,
  // SS3.1.1) — a once-per-lifetime latch would leave c1 in `kept` forever
  // with no path to settle, the durable-looking echo SS4.13 forbids.
  const second = set.joinSnapshot({
    activeTurn: null,
    queuedTurns: [],
    userMessageCommandIds: [],
    lastItemId: null,
  });
  assert.deepEqual(second.mustResubmit, ["c1"], "a new join re-demands the lost resubmit");
  assert.equal(set.size, 1);
});

test("an unacked entry the join DOES match is not resubmitted (double-execution guard)", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "durable before ack", anchorAfterItemId: null });

  // The intake is durable BEFORE the ack (SS3.1.3), so a lost-ack entry CAN
  // appear in the snapshot. Retiring to the composer here and re-sending with
  // a fresh commandId is the double execution the join order prevents.
  const plan = set.joinSnapshot({
    activeTurn: null,
    queuedTurns: [{ turnId: "t1", commandId: "c1" }],
    userMessageCommandIds: [],
    lastItemId: "itemLast",
  });

  assert.deepEqual(plan.mustResubmit, []);
  assert.deepEqual(plan.retirements, []);
  assert.equal(set.size, 1);
});

test("reconnect with no snapshot: replay acked, resubmit unacked once", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "acked", input: "a", anchorAfterItemId: null });
  set.acked("acked", { turnId: "t1", disposition: "queued" });
  set.submitted({ commandId: "unacked", input: "u", anchorAfterItemId: null });

  const plan = set.reconnectedWithoutSnapshot();

  assert.deepEqual(plan.mustReplay, ["acked"]);
  assert.deepEqual(plan.mustResubmit, ["unacked"]);
  assert.deepEqual(plan.retirements, [], "reconnect alone settles nothing");
  assert.equal(set.size, 2);
});

test("a resubmit lost to a second disconnect is demanded again on the next reconnect", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "lost twice", anchorAfterItemId: null });

  const first = set.reconnectedWithoutSnapshot();
  assert.deepEqual(first.mustResubmit, ["c1"]);

  // The demanded resubmit was itself lost to a second disconnect. A
  // once-per-lifetime latch would strand c1 as a permanent durable-looking
  // echo (SS4.13 forbids); same-commandId resubmit is idempotent (SS3.1.1),
  // so each new reconnect demands it again.
  const second = set.reconnectedWithoutSnapshot();
  assert.deepEqual(second.mustResubmit, ["c1"], "a new reconnect re-demands the lost resubmit");
  assert.equal(set.size, 1);
});

test("ephemeral host death discards every entry as terminal-unknown", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "one", anchorAfterItemId: null });
  set.submitted({ commandId: "c2", input: "two", anchorAfterItemId: null });
  set.acked("c2", { turnId: "t2", disposition: "queued" });

  const retirements = set.discardEphemeral();

  assert.deepEqual(
    retirements.map((r) => r.kind),
    ["terminalUnknown", "terminalUnknown"],
  );
  assert.equal(set.size, 0);
  // Terminal-unknown is not "failed" or "cancelled": inventing one is the
  // fabrication the carve-out exists to prevent.
  for (const retirement of retirements) {
    assert.notEqual(retirement.kind, "rejected");
    assert.notEqual(retirement.kind, "abandoned");
  }

  assert.throws(
    () => set.submitted({ commandId: "c1", input: "replay", anchorAfterItemId: null }),
    /ephemeral host died.*commandId `c1` cannot be replayed/,
  );
  assert.throws(
    () =>
      set.replayAnswered("c2", {
        kind: "ack",
        ack: { turnId: "replacement", disposition: "started" },
      }),
    /ephemeral host died.*commandId `c2` cannot be replayed/,
  );
  assert.throws(
    () =>
      set.resolveReplayAtJoin(
        "c1",
        { kind: "ack", ack: { turnId: "replacement", disposition: "queued" } },
        [],
      ),
    /ephemeral host died.*commandId `c1` cannot be replayed/,
    "a discarded commandId is never quietly answered 'held' against a new host (FM-002)",
  );
  assert.deepEqual(set.reconnectedWithoutSnapshot(), {
    retirements: [],
    mustReplay: [],
    mustResubmit: [],
    kept: [],
  });
});

test("the set never invents a terminal on its own (INV-006)", () => {
  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "c1", input: "waiting forever", anchorAfterItemId: null });
  set.acked("c1", { turnId: "t1", disposition: "queued" });

  // Time passing, unrelated queue movement, and unrelated messages settle
  // nothing: there is no local timeout, failure, or completion.
  set.observedQueueMovement("tOther");
  set.observedUserMessage("someoneElse", "item-x");

  assert.equal(set.size, 1);
  assert.equal(set.get("c1")?.ack?.disposition, "queued");
});

test("a client that renders nothing optimistically holds no entries", () => {
  const set = new PendingCommandSet<string>();
  assert.equal(set.size, 0);
  assert.deepEqual(set.list(), []);
  // The degenerate mode is supported: the fold reduces to SS4.1.
  assert.deepEqual(set.reconnectedWithoutSnapshot().mustReplay, []);
});
