/**
 * T032 / TEST-014 — FR-020: SS4.8 gap recovery, spliced INSIDE the iterators.
 *
 * `view/gap` is the delivery-plane marker: push delivery dropped everything in
 * the open interval `(after, next)`, and until the client fills it the fold is
 * not current. tdd SS4.8's splice-fill recipe is the path this suite pins:
 * buffer the live tail, page forward from `after` with `view/page` until the
 * walk reaches `next`, discard the overlap, splice the buffer after the paged
 * prefix.
 *
 * WHAT A CONSUMER SEES is the contract FR-020 states, and it is stated in
 * terms of the iterators rather than of `apply`'s return: a gap is a PAUSE,
 * then the filled sequence in cursor order, and a fill that cannot complete is
 * a typed error rather than a silent hole. Every arm below drives a real
 * `view/page` frame out of a fake duplex, or asserts that none was written.
 *
 * CURSORS ARE OPAQUE (tdd SS4.1). Nothing here — and nothing in the
 * implementation — orders two cursors relationally. The walk stops on cursor
 * EQUALITY with `next`, or on the server's own end-of-view (`nextCursor:
 * null`), and the overlap is discarded by cursor equality against a set. The
 * `v:<n>` spellings below are illustrative, exactly as they are in the tdd.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MuseGapFillError, Session } from "../src/index.js";
import type { Turn } from "../src/index.js";
import {
  answer,
  answerError,
  FakeDuplex,
  sentFrame,
  sentParams,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";
import type { Item } from "@muse/msp";

/**
 * Every arm carries its own timeout. A settle-path hang here — a fill that
 * never resolves, an iterator that never yields — must fail its own NAMED arm
 * rather than run to the CI wall (T030's stated hang rule).
 */
const ARM_TIMEOUT = 10_000;

const SESSION = "s-1";
const TURN = "t-1";

/** Provenance the view plane requires on every paged (durable-sourced) event. */
const SOURCE_RANGE = {
  first: { recordId: "r-1", seq: 1 },
  last: { recordId: "r-1", seq: 1 },
  stream: { id: "run-1", kind: "run" },
};

function wired(): {
  readonly transport: FakeDuplex;
  readonly session: Session<string>;
} {
  const transport = new FakeDuplex();
  const connection = new Connection(transport, { mintCommandId: () => "mint-0" });
  const session = new Session<string>({
    connection,
    durability: { kind: "durable" },
    sessionId: SESSION,
  });
  return { session, transport };
}

/** A `Session` with no host at all — the transport-less composition. */
function foldOnly(): Session<string> {
  return new Session<string>({ durability: { kind: "durable" }, sessionId: SESSION });
}

function item(itemId: string, revision: number, status = "inProgress"): Item {
  return {
    itemId,
    kind: "agentMessage",
    revision,
    sessionId: SESSION,
    status,
    turnId: TURN,
  } as unknown as Item;
}

/** One element of a `view/page` result: the SS4.2.1 unframed view notification. */
function paged(method: string, viewCursor: string, rest: Record<string, unknown>) {
  return { method, params: { sessionId: SESSION, sourceRange: SOURCE_RANGE, viewCursor, ...rest } };
}

function itemEvent(method: string, viewCursor: string, value: Item) {
  return paged(method, viewCursor, { item: value });
}

function gapFrame(after: string, next: string) {
  return { method: "view/gap", params: { after, next, sessionId: SESSION } } as const;
}

/** Start the turn so its handle exists and its iterators have a live turn. */
function startTurn(session: Session<string>, viewCursor = "v:0"): Turn {
  session.apply({
    method: "turn/started",
    params: {
      commandId: "c-1",
      sessionId: SESSION,
      sourceRange: SOURCE_RANGE,
      turnId: TURN,
      viewCursor,
    },
  });
  return session.turn(TURN);
}

/**
 * Drain `turn.items()` in the background, recording `itemId@revision` in yield
 * order. ORDER is the assertion FR-020 turns on: the paged prefix must reach a
 * consumer before the buffered live tail, or the "filled sequence" it promises
 * is delivered backwards.
 */
function collectItems(turn: Turn): { readonly seen: string[]; readonly done: Promise<void> } {
  const seen: string[] = [];
  const done = (async () => {
    for await (const held of turn.items()) seen.push(`${held.itemId}@${String(held.revision)}`);
  })();
  return { done, seen };
}

/** Settle the turn so the background iterator finishes with the arm. */
async function endTurn(session: Session<string>, done: Promise<void>): Promise<void> {
  session.apply({
    method: "turn/completed",
    params: {
      sessionId: SESSION,
      sourceRange: SOURCE_RANGE,
      terminal: "completed",
      turnId: TURN,
      viewCursor: "v:99",
    },
  });
  await done;
}

/** Answer the nth outbound `view/page`, asserting it IS one and is well formed. */
async function answerPage(
  transport: FakeDuplex,
  index: number,
  events: readonly unknown[],
  nextCursor: string | null,
): Promise<void> {
  await waitForWrites(transport, index + 1);
  assert.equal(sentFrame(transport, index)["method"], "view/page");
  const params = sentParams(transport, index);
  assert.equal(params["sessionId"], SESSION);
  // The published bound is 1–1000 (`ViewPageParams.limit`). Asserted as the
  // RANGE the schema states rather than as an exact value: the page size is an
  // implementation choice, the bound is the contract.
  const limit = params["limit"];
  assert.ok(
    typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= 1000,
    `view/page limit must be an integer in 1..1000, got ${String(limit)}`,
  );
  answer(transport, index, { events: events as Record<string, unknown>[], nextCursor });
}

// ---- the recipe ------------------------------------------------------------

test(
  "TEST-014 gap_splice_fill_inside_iterators: a gap is a pause, then the paged prefix, then the buffered live tail",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    const turn = startTurn(session);
    const { done, seen } = collectItems(turn);
    session.apply(itemEvent("item/started", "v:1", item("i-1", 1)));
    await settleMicrotasks();
    assert.deepEqual(seen, ["i-1@1"], "the pre-gap tail is live");

    // The hole: everything strictly between v:1 and v:5 was never delivered.
    const gap = session.apply(gapFrame("v:1", "v:5"));
    assert.deepEqual(gap.fold, { after: "v:1", kind: "deliveryGap", next: "v:5" });
    assert.equal(session.fold.current, false, "the fold is not current until the hole is filled");

    // The live tail keeps arriving DURING the fill and must not fold ahead of
    // the paged prefix — it is buffered, and the consumer sees the pause.
    const live = session.apply(itemEvent("item/completed", "v:5", item("i-3", 1, "completed")));
    assert.deepEqual(live.fold, { kind: "bufferedDuringGap", method: "item/completed" });
    await settleMicrotasks();
    assert.deepEqual(seen, ["i-1@1"], "the pause: nothing folds ahead of the fill");

    await answerPage(
      transport,
      0,
      [itemEvent("item/started", "v:2", item("i-2", 1)), itemEvent("item/updated", "v:3", item("i-1", 2))],
      "v:3",
    );
    await answerPage(
      transport,
      1,
      [
        itemEvent("item/completed", "v:4", item("i-2", 2, "completed")),
        // The overlap: the page serves the very event the live tail buffered.
        itemEvent("item/completed", "v:5", item("i-3", 1, "completed")),
      ],
      "v:5",
    );
    assert.deepEqual(await gap.io, []);

    assert.deepEqual(
      seen,
      ["i-1@1", "i-2@1", "i-1@2", "i-2@2", "i-3@1"],
      "the filled sequence reaches the iterator in cursor order",
    );
    assert.equal(session.fold.current, true, "current only after the fill");
    assert.equal(session.fold.pendingGap, undefined);
    // The first cursor asked for is `after` itself — the exclusive lower bound,
    // so the page starts strictly after the last event actually delivered.
    assert.equal(sentParams(transport, 0)["cursor"], "v:1");
    assert.equal(sentParams(transport, 1)["cursor"], "v:3");
    assert.equal(transport.writes.length, 2, "the walk stops at `next`; no third page");
    await endTurn(session, done);
  },
);

test(
  "the overlap is discarded by cursor EQUALITY: an event served by both the page and the live tail is routed once",
  { timeout: ARM_TIMEOUT },
  async () => {
    // tdd SS4.8's "discard paged events at cursors >= `next` (they duplicate
    // the buffer)", from the other side: the buffered copy of an event the
    // page also served is dropped.
    //
    // OBSERVED THROUGH THE WIRE, not through the fold, and that is the point.
    // For an item frame the INV-003 revision guard would hide a double apply,
    // so a fold-level assertion here proves nothing and a mutant that deletes
    // the discard survives it. A `turn/started` for a turn that is not the
    // pending entry's own is SS4.13 queue movement, and queue movement
    // re-verifies on EVERY sighting — so folding the frame twice authors a
    // second `turn/start` replay for a command whose fate one already decides.
    const { session, transport } = wired();
    const submit = session.sendUserTurn({ composerInput: "hi", input: [{ text: "hi", type: "text" }] });
    await waitForWrites(transport, 1);
    const queuedAck = {
      commandId: "mint-0",
      disposition: "queued",
      startedNewTurn: false,
      status: "accepted",
      turnId: "t-queued",
    };
    answer(transport, 0, queuedAck);
    await submit;

    const gap = session.apply(gapFrame("v:1", "v:3"));
    // A DIFFERENT turn launching is the queue movement; it arrives live, so it
    // is buffered, and the page serves the very same cursor.
    const started = {
      method: "turn/started",
      params: {
        commandId: "c-other",
        sessionId: SESSION,
        sourceRange: SOURCE_RANGE,
        turnId: "t-other",
        viewCursor: "v:3",
      },
    };
    session.apply(started);
    await answerPage(transport, 1, [started], "v:3");
    await settleMicrotasks();

    assert.equal(
      transport.writes.length,
      3,
      "one submit, one page, ONE replay — the buffered duplicate authors no second replay",
    );
    assert.equal(sentFrame(transport, 2)["method"], "turn/start");
    assert.equal(sentParams(transport, 2)["commandId"], "mint-0");
    // Value-identical ack (INV-013/TEST-018), so the replay settles nothing
    // and the entry keeps waiting.
    answer(transport, 2, queuedAck);
    assert.deepEqual(await gap.io, []);
    assert.equal(session.fold.current, true);
  },
);

test(
  "a second view/gap during the fill coalesces on the FIRST after and extends the walk to the newest next",
  { timeout: ARM_TIMEOUT },
  async () => {
    // D-16487-1's client mirror: a run of holes is one bracket keeping the
    // first `after`. Without the extension the walk stops at the first `next`,
    // reports itself current, and the SECOND hole is never filled — a silent
    // hole created by the very machinery that exists to prevent one.
    const { session, transport } = wired();
    const turn = startTurn(session);
    const { done, seen } = collectItems(turn);

    const gap = session.apply(gapFrame("v:1", "v:3"));
    assert.deepEqual(session.fold.pendingGap, { after: "v:1", next: "v:3", sessionId: SESSION });

    // A second overflow, learned while the first walk is still in flight.
    await waitForWrites(transport, 1);
    const second = session.apply(gapFrame("v:4", "v:7"));
    assert.deepEqual(second.fold, { after: "v:4", kind: "deliveryGap", next: "v:7" });
    assert.deepEqual(
      session.fold.pendingGap,
      { after: "v:1", next: "v:7", sessionId: SESSION },
      "the first `after` is kept; the target extends",
    );
    // No second walk was started beside the first.
    await settleMicrotasks();
    assert.equal(transport.writes.length, 1);

    answer(transport, 0, {
      events: [itemEvent("item/started", "v:3", item("i-1", 1))],
      nextCursor: "v:3",
    });
    // The walk continues past the old target toward the new one.
    await answerPage(transport, 1, [itemEvent("item/started", "v:7", item("i-2", 1))], "v:7");
    await gap.io;

    assert.deepEqual(seen, ["i-1@1", "i-2@1"]);
    assert.equal(session.fold.current, true);
    await endTurn(session, done);
  },
);

test(
  "a gap folding in the CLEAR WINDOW is picked up, not stranded (review round 1, P0)",
  { timeout: ARM_TIMEOUT },
  async () => {
    // `#walk` clears the hole and returns; `#drain` lowers the filling flag a
    // microtask later. A `view/gap` folding in between skips the buffer (a
    // marker must, or it could not extend a live walk), finds the flag still
    // up, and its `start()` returns early — leaving no second `view/page`, no
    // failure report, and `pendingGap` set forever.
    //
    // Timing is what makes the window, so the arm does not guess ONE offset:
    // it runs the scenario across a span of microtask offsets and requires the
    // hole to close at EVERY one, then asserts that at least one offset really
    // landed inside the window. Without that second assertion the arm could
    // pass by never reaching the window at all.
    let insideWindow = 0;
    for (let offset = 0; offset < 12; offset += 1) {
      const { session, transport } = wired();
      const gap = session.apply(gapFrame("v:1", "v:2"));
      await answerPage(transport, 0, [itemEvent("item/started", "v:2", item("i-1", 1))], "v:2");
      for (let turn = 0; turn < offset; turn += 1) await Promise.resolve();

      const before = transport.writes.length;
      session.apply(gapFrame("v:2", "v:4"));
      // No page yet means `start()` bounced: this offset is inside the window.
      if (transport.writes.length === before) insideWindow += 1;

      await settleMicrotasks();
      // The restart's page, whenever it was issued.
      if (transport.writes.length > 1) {
        answer(transport, 1, {
          events: [itemEvent("item/started", "v:4", item("i-2", 1))],
          nextCursor: "v:4",
        });
      }
      await gap.io;
      await settleMicrotasks();

      assert.equal(
        session.fold.current,
        true,
        `offset ${String(offset)}: the second hole must be filled, not stranded`,
      );
      assert.equal(session.fold.pendingGap, undefined, `offset ${String(offset)}`);
    }
    assert.ok(
      insideWindow > 0,
      "no offset landed inside the clear window — the arm proved nothing",
    );
  },
);

test(
  "the live twin of a served event is refused ONCE even when it arrives after the fill",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The timing inversion of the overlap arm above (review round 1, P1). The
    // wire promises no order between the marker and the frame at `next`, so
    // the twin can land after the drain, when the buffer is gone. Same damage
    // as the buffered case: a second SS4.13 queue-movement replay on the wire.
    const { session, transport } = wired();
    const submit = session.sendUserTurn({ composerInput: "hi", input: [{ text: "hi", type: "text" }] });
    await waitForWrites(transport, 1);
    const queuedAck = {
      commandId: "mint-0",
      disposition: "queued",
      startedNewTurn: false,
      status: "accepted",
      turnId: "t-queued",
    };
    answer(transport, 0, queuedAck);
    await submit;

    const gap = session.apply(gapFrame("v:1", "v:3"));
    const started = {
      method: "turn/started",
      params: {
        commandId: "c-other",
        sessionId: SESSION,
        sourceRange: SOURCE_RANGE,
        turnId: "t-other",
        viewCursor: "v:3",
      },
    };
    await answerPage(transport, 1, [started], "v:3");
    await settleMicrotasks();
    assert.equal(transport.writes.length, 3, "the paged copy authored the one replay");
    answer(transport, 2, queuedAck);
    await gap.io;

    // NOW the live twin arrives, with the fill long finished.
    const late = session.apply(started);
    assert.deepEqual(late.fold, {
      kind: "ignoredGapOverlap",
      method: "turn/started",
      viewCursor: "v:3",
    });
    await settleMicrotasks();
    assert.equal(transport.writes.length, 3, "no second replay for the same commandId");

    // Consuming, not permanent: a genuinely new frame at that cursor would be
    // a different event, and the entry is gone after the one refusal.
    assert.equal(
      session.apply(started).fold.kind,
      "turn",
      "the refusal is spent after one twin",
    );
  },
);

test(
  "a COALESCED gap still discards its buffered twins across the page boundary",
  { timeout: ARM_TIMEOUT },
  async () => {
    // Review round 2, P0. When a second `view/gap` extends the hole mid-walk,
    // the walk restarts toward the NEW target with `reached` false — so paged
    // events between the two targets never enter the persistent twin set. Their
    // twins ARE in the buffer, because a cursor at or after the FIRST target
    // was delivered live before the second hole opened. Claiming only on the
    // persistent set folded those a second time: for a `turn/started` that is a
    // duplicate SS4.13 replay of the same commandId.
    //
    // The page boundary between the two targets is the whole point of the
    // fixture; without it the first target's page carries both and the bug
    // hides.
    const { session, transport } = wired();
    const submit = session.sendUserTurn({ composerInput: "hi", input: [{ text: "hi", type: "text" }] });
    await waitForWrites(transport, 1);
    const queuedAck = {
      commandId: "mint-0",
      disposition: "queued",
      startedNewTurn: false,
      status: "accepted",
      turnId: "t-queued",
    };
    answer(transport, 0, queuedAck);
    await submit;

    const gap = session.apply(gapFrame("v:1", "v:3"));
    // Delivered live after the first hole, so buffered — and served by a LATER
    // page than the one that carries the first target.
    const started = {
      method: "turn/started",
      params: {
        commandId: "c-other",
        sessionId: SESSION,
        sourceRange: SOURCE_RANGE,
        turnId: "t-other",
        viewCursor: "v:4",
      },
    };
    session.apply(started);
    await waitForWrites(transport, 2);
    // The second hole opens while the walk is in flight; the target extends.
    session.apply(gapFrame("v:4", "v:7"));

    // Page 1 carries the FIRST target and ends there.
    answer(transport, 1, {
      events: [itemEvent("item/started", "v:3", item("i-1", 1))],
      nextCursor: "v:3",
    });
    // Page 2 carries the buffered frame's cursor and the extended target.
    await answerPage(
      transport,
      2,
      [started, itemEvent("item/started", "v:7", item("i-2", 1))],
      "v:7",
    );
    await settleMicrotasks();

    assert.equal(
      transport.writes.length,
      4,
      "one submit, two pages, ONE replay — the buffered twin authored no second",
    );
    assert.equal(sentFrame(transport, 3)["method"], "turn/start");
    answer(transport, 3, queuedAck);
    await gap.io;
    assert.equal(session.fold.current, true);
  },
);

test(
  "a twin served by an EARLIER fill is still refused after a later fill runs",
  { timeout: ARM_TIMEOUT },
  async () => {
    // Review round 2, P1. An earlier draft cleared the twin set at the start of
    // each fill, reasoning that a surviving entry's twin must lie inside the new
    // hole. That conflated "not delivered yet" with "inside the new hole": a
    // cursor the previous fill served can sit at or AFTER the new gap's `next`,
    // so its live twin is still coming and clearing loses the only refusal that
    // stops it folding twice.
    const { session, transport } = wired();
    const submit = session.sendUserTurn({ composerInput: "hi", input: [{ text: "hi", type: "text" }] });
    await waitForWrites(transport, 1);
    const queuedAck = {
      commandId: "mint-0",
      disposition: "queued",
      startedNewTurn: false,
      status: "accepted",
      turnId: "t-queued",
    };
    answer(transport, 0, queuedAck);
    await submit;

    // Fill 1 serves `v:9` — a cursor the wire has not delivered live yet.
    const started = {
      method: "turn/started",
      params: {
        commandId: "c-other",
        sessionId: SESSION,
        sourceRange: SOURCE_RANGE,
        turnId: "t-other",
        viewCursor: "v:9",
      },
    };
    const first = session.apply(gapFrame("v:1", "v:3"));
    await answerPage(
      transport,
      1,
      [itemEvent("item/started", "v:3", item("i-1", 1)), started],
      "v:9",
    );
    await settleMicrotasks();
    assert.equal(transport.writes.length, 3, "the paged copy authored the one replay");
    answer(transport, 2, queuedAck);
    await first.io;

    // A SECOND, unrelated hole below `v:9` — so `v:9` is still on its way.
    const second = session.apply(gapFrame("v:4", "v:6"));
    await answerPage(transport, 3, [itemEvent("item/started", "v:6", item("i-2", 1))], "v:6");
    await second.io;

    // Now the live twin of `v:9` finally lands.
    const late = session.apply(started);
    assert.deepEqual(late.fold, {
      kind: "ignoredGapOverlap",
      method: "turn/started",
      viewCursor: "v:9",
    });
    await settleMicrotasks();
    assert.equal(transport.writes.length, 4, "no second replay for the same commandId");
  },
);

test(
  "an EARLIER fill's twin arriving DURING a later fill is refused by the drain",
  { timeout: ARM_TIMEOUT },
  async () => {
    // Review round 3, P0. `Session.apply` buffers every live frame while a fill
    // runs, BEFORE the late-window claim can see it — so a twin an earlier fill
    // served, arriving mid-fill, reaches only the drain. The drain's local set
    // holds this fill's own pages, so it has to consult the persistent set too
    // or the twin folds a second time: a duplicate SS4.13 replay of the same
    // commandId.
    const { session, transport } = wired();
    const submit = session.sendUserTurn({ composerInput: "hi", input: [{ text: "hi", type: "text" }] });
    await waitForWrites(transport, 1);
    const queuedAck = {
      commandId: "mint-0",
      disposition: "queued",
      startedNewTurn: false,
      status: "accepted",
      turnId: "t-queued",
    };
    answer(transport, 0, queuedAck);
    await submit;

    const started = {
      method: "turn/started",
      params: {
        commandId: "c-other",
        sessionId: SESSION,
        sourceRange: SOURCE_RANGE,
        turnId: "t-other",
        viewCursor: "v:9",
      },
    };
    const first = session.apply(gapFrame("v:1", "v:3"));
    await answerPage(
      transport,
      1,
      [itemEvent("item/started", "v:3", item("i-1", 1)), started],
      "v:9",
    );
    await settleMicrotasks();
    answer(transport, 2, queuedAck);
    await first.io;

    // A second hole opens, and the `v:9` twin lands WHILE its fill is running.
    const second = session.apply(gapFrame("v:4", "v:6"));
    await waitForWrites(transport, 4);
    const held = session.apply(started);
    assert.deepEqual(
      held.fold,
      { kind: "bufferedDuringGap", method: "turn/started" },
      "a fill is running, so the buffer takes it before the late-window claim",
    );
    answer(transport, 3, { events: [itemEvent("item/started", "v:6", item("i-2", 1))], nextCursor: "v:6" });
    // Asserted BEFORE awaiting `io`: a duplicate replay would leave `io`
    // waiting on an ack nobody sends, and this arm must fail on the extra
    // WRITE rather than on its own timeout.
    await settleMicrotasks();
    assert.equal(
      transport.writes.length,
      4,
      "one submit, two pages, ONE replay — the drain refused the earlier fill's twin",
    );
    await second.io;
  },
);

test(
  "a later fill's page does NOT re-apply an event an earlier fill already folded",
  { timeout: ARM_TIMEOUT },
  async () => {
    // Review round 3, P0. A later walk may legally page through a range an
    // earlier fill already served — the durable copy is still there. Applying
    // it again is the same duplicate SS4.13 replay from the paged side instead
    // of the live side. The walk only SKIPS it — an earlier draft also retired
    // the entry here, which review round 4 showed deletes a buffered twin's
    // only refusal, so nothing in the walk deletes now.
    const { session, transport } = wired();
    const submit = session.sendUserTurn({ composerInput: "hi", input: [{ text: "hi", type: "text" }] });
    await waitForWrites(transport, 1);
    const queuedAck = {
      commandId: "mint-0",
      disposition: "queued",
      startedNewTurn: false,
      status: "accepted",
      turnId: "t-queued",
    };
    answer(transport, 0, queuedAck);
    await submit;

    const started = {
      method: "turn/started",
      params: {
        commandId: "c-other",
        sessionId: SESSION,
        sourceRange: SOURCE_RANGE,
        turnId: "t-other",
        viewCursor: "v:9",
      },
    };
    const first = session.apply(gapFrame("v:1", "v:3"));
    await answerPage(
      transport,
      1,
      [itemEvent("item/started", "v:3", item("i-1", 1)), started],
      "v:9",
    );
    await settleMicrotasks();
    answer(transport, 2, queuedAck);
    await first.io;

    // A later hole whose fill pages straight back over `v:9`.
    const second = session.apply(gapFrame("v:3", "v:B"));
    await answerPage(transport, 3, [started, itemEvent("item/started", "v:B", item("i-2", 1))], "v:B");
    // Asserted before awaiting `io`, for the reason the arm above states.
    await settleMicrotasks();
    assert.equal(
      transport.writes.length,
      4,
      "one submit, two pages, ONE replay — the re-served page copy authored no second",
    );
    await second.io;
  },
);

test(
  "a COALESCED target moving past a BUFFERED twin does not delete its only refusal",
  { timeout: ARM_TIMEOUT },
  async () => {
    // Review round 4, P0. The walk cannot see the buffer. An earlier draft
    // retired the persistent entry when the walk met its cursor before the
    // walk's own target, calling that page-order proof the twin was swallowed —
    // but a coalescing gap moves the target PAST a cursor whose twin is sitting
    // in the buffer, and the entry was deleted out from under the drain. The
    // walk now deletes nothing, so the cursor simply STAYS in the persistent
    // set and the drain can still refuse the buffered twin.
    const { session, transport } = wired();
    const submit = session.sendUserTurn({ composerInput: "hi", input: [{ text: "hi", type: "text" }] });
    await waitForWrites(transport, 1);
    const queuedAck = {
      commandId: "mint-0",
      disposition: "queued",
      startedNewTurn: false,
      status: "accepted",
      turnId: "t-queued",
    };
    answer(transport, 0, queuedAck);
    await submit;

    const started = {
      method: "turn/started",
      params: {
        commandId: "c-other",
        sessionId: SESSION,
        sourceRange: SOURCE_RANGE,
        turnId: "t-other",
        viewCursor: "v:9",
      },
    };
    // Fill 1 serves `v:9`, so the persistent entry holds it.
    const first = session.apply(gapFrame("v:1", "v:3"));
    await answerPage(
      transport,
      1,
      [itemEvent("item/started", "v:3", item("i-1", 1)), started],
      "v:9",
    );
    await settleMicrotasks();
    answer(transport, 2, queuedAck);
    await first.io;

    // Fill 2 opens; the `v:9` twin lands while it runs, so it is BUFFERED.
    const second = session.apply(gapFrame("v:4", "v:6"));
    await waitForWrites(transport, 4);
    session.apply(started);
    // …and now a coalescing gap moves the target PAST `v:9`.
    session.apply(gapFrame("v:6", "v:C"));
    answer(transport, 3, { events: [itemEvent("item/started", "v:6", item("i-2", 1))], nextCursor: "v:6" });
    // The extended walk pages over `v:9` on its way to `v:C`.
    await answerPage(
      transport,
      4,
      [started, itemEvent("item/started", "v:C", item("i-3", 1))],
      "v:C",
    );
    await settleMicrotasks();

    assert.equal(
      transport.writes.length,
      5,
      "one submit, three pages, ONE replay — the buffered twin kept its refusal",
    );
    await second.io;
  },
);

test(
  "a target the walk must SKIP is still a target: it stops there and keeps the refusal",
  { timeout: ARM_TIMEOUT },
  async () => {
    // Review round 4, P1. This arm owns ONE mutant: setting `reached` below the
    // already-applied skip, which makes the walk skip its own stopping point
    // and page past it. The case is wire-legal — a new gap's `next` can name a
    // cursor an earlier fill served while its twin is still pending.
    //
    // It does NOT own the retire-on-`!reached` mutant, and saying so matters:
    // here the walk meets the cursor exactly AT its target, where `reached` is
    // already true, so that delete could never fire. The COALESCED arm above is
    // the one that kills it (review round 5).
    const { session, transport } = wired();
    const submit = session.sendUserTurn({ composerInput: "hi", input: [{ text: "hi", type: "text" }] });
    await waitForWrites(transport, 1);
    const queuedAck = {
      commandId: "mint-0",
      disposition: "queued",
      startedNewTurn: false,
      status: "accepted",
      turnId: "t-queued",
    };
    answer(transport, 0, queuedAck);
    await submit;

    const started = {
      method: "turn/started",
      params: {
        commandId: "c-other",
        sessionId: SESSION,
        sourceRange: SOURCE_RANGE,
        turnId: "t-other",
        viewCursor: "v:9",
      },
    };
    const first = session.apply(gapFrame("v:1", "v:3"));
    await answerPage(
      transport,
      1,
      [itemEvent("item/started", "v:3", item("i-1", 1)), started],
      "v:9",
    );
    await settleMicrotasks();
    answer(transport, 2, queuedAck);
    await first.io;

    // The new hole's `next` IS the cursor fill 1 already served.
    const second = session.apply(gapFrame("v:4", "v:9"));
    await answerPage(
      transport,
      3,
      [itemEvent("item/started", "v:6", item("i-2", 1)), started],
      "v:9",
    );
    // HOW THIS ARM REPORTS the `reached`-ordering mutant depends on the host:
    // a walk that skipped its own stopping point pages forever, and whether the
    // extra `view/page` lands before this count runs is a timing question. One
    // reviewer observed the count firing (`5 !== 4`); on this host it does not,
    // even at a 10x longer settle, and the arm dies at its own 10 s bound
    // instead. Both are the arm failing inside its own bound, which is the
    // property that matters; neither is load-bearing, so neither is pinned.
    await settleMicrotasks();
    assert.equal(
      transport.writes.length,
      4,
      "the walk stopped at its skipped target instead of paging past it",
    );
    await second.io;
    assert.equal(session.fold.current, true);

    // The refusal survived the skip: the twin is still coming, and is refused.
    assert.deepEqual(session.apply(started).fold, {
      kind: "ignoredGapOverlap",
      method: "turn/started",
      viewCursor: "v:9",
    });
    await settleMicrotasks();
    assert.equal(transport.writes.length, 4, "no second replay for the same commandId");
  },
);

test(
  "a retirement produced by the drain reaches the consumer on the gap frame's io",
  { timeout: ARM_TIMEOUT },
  async () => {
    // A frame buffered during a fill reports `retirements: []` by design, so
    // the gap frame's `io` is the consumer's ONLY channel for an SS4.13
    // retirement the splice produces (review round 1, P1). Nothing covered it:
    // every other arm here asserts `io` is empty.
    const { session, transport } = wired();
    const submit = session.sendUserTurn({ composerInput: "hi", input: [{ text: "hi", type: "text" }] });
    await waitForWrites(transport, 1);
    answer(transport, 0, {
      commandId: "mint-0",
      disposition: "queued",
      startedNewTurn: false,
      status: "accepted",
      turnId: "t-queued",
    });
    await submit;
    assert.equal(session.pending.has("mint-0"), true);

    const gap = session.apply(gapFrame("v:1", "v:5"));
    // The reclaim of THIS session's own queued submit, delivered as live
    // traffic while the fill is in flight — so it is buffered, and its
    // retirement can only surface through the fill.
    const reclaim = session.apply({
      method: "turn/unqueued",
      params: {
        commandId: "mint-0",
        reason: "superseded",
        sessionId: SESSION,
        sourceRange: SOURCE_RANGE,
        turnId: "t-queued",
        viewCursor: "v:5",
      },
    });
    assert.deepEqual(reclaim.fold, { kind: "bufferedDuringGap", method: "turn/unqueued" });
    assert.deepEqual(reclaim.retirements, [], "nothing has folded yet");

    await answerPage(transport, 1, [], null);
    const retirements = await gap.io;

    assert.equal(retirements.length, 1, "the reclaim's retirement rides the gap frame's io");
    assert.equal(retirements[0]?.commandId, "mint-0");
    assert.equal(retirements[0]?.kind, "reclaimed");
    assert.equal(session.pending.has("mint-0"), false);
  },
);

test(
  "an EMPTY page that does not end the view is a stall, not an invitation to page again",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The other clause of the progress bound (review round 1, P1): deleting
    // `result.events.length === 0` left the repeated-cursor arm green, so a
    // host answering empty pages with ever-fresh cursors would spin the walk
    // in unbounded `view/page` traffic.
    const { session, transport } = wired();
    const failures: MuseGapFillError[] = [];
    session.onGapError((failure) => failures.push(failure));

    const gap = session.apply(gapFrame("v:1", "v:5"));
    await answerPage(transport, 0, [], "v:2");
    await gap.io;

    assert.equal(failures[0]?.reason, "pageStalled");
    assert.equal(transport.writes.length, 1, "no second page was requested");
    assert.equal(session.fold.current, false);
  },
);

test(
  "a page that names NO next cursor at all is a stall, not an end of view",
  { timeout: ARM_TIMEOUT },
  async () => {
    // `nextCursor` is `string | null` and "never omitted" (tdd SS4.7.3), so an
    // absent one is a host defect. Failing loudly is the only honest reading:
    // treating it as end-of-view would report the fold current over a hole
    // nothing filled.
    const { session, transport } = wired();
    const failures: MuseGapFillError[] = [];
    session.onGapError((failure) => failures.push(failure));

    const gap = session.apply(gapFrame("v:1", "v:5"));
    await waitForWrites(transport, 1);
    answer(transport, 0, { events: [itemEvent("item/started", "v:2", item("i-1", 1))] });
    await gap.io;

    assert.equal(failures[0]?.reason, "pageStalled");
    assert.equal(transport.writes.length, 1);
    assert.equal(session.fold.current, false);
  },
);

test(
  "end-of-view ends the walk: a hole the durable log cannot serve is a fill, not a hang",
  { timeout: ARM_TIMEOUT },
  async () => {
    // `next` names a LIVE cursor; `view/page` serves durable-sourced events
    // only (tdd SS4.7.3), so a hole whose tail was ephemeral never yields an
    // event at `next`. `nextCursor: null` is the server saying "that is the
    // whole view" — the walk must accept it and splice, or the iterators wait
    // on a cursor no page will ever carry.
    const { session, transport } = wired();
    const turn = startTurn(session);
    const { done, seen } = collectItems(turn);

    const gap = session.apply(gapFrame("v:1", "v:9"));
    session.apply(itemEvent("item/started", "v:9", item("i-2", 1)));
    await answerPage(transport, 0, [itemEvent("item/started", "v:2", item("i-1", 1))], null);
    await gap.io;

    assert.deepEqual(seen, ["i-1@1", "i-2@1"], "the paged prefix, then the buffered tail");
    assert.equal(session.fold.current, true);
    await endTurn(session, done);
  },
);

test(
  "deltas lost in the hole stay lost: the fill lands finals and the deltas iterator gets nothing",
  { timeout: ARM_TIMEOUT },
  async () => {
    // tdd SS4.8, stated as behaviour rather than apologised for: `item/delta`
    // is ephemeral-sourced and `view/page` never replays it, so the fill lands
    // the final item values and the delta stream simply has a hole. Pinned so
    // a later "helpful" synthesis of deltas from the filled item text — a
    // fabricated event the server never sent — reds here.
    const { session, transport } = wired();
    const turn = startTurn(session);
    const deltas: string[] = [];
    const drained = (async () => {
      for await (const delta of turn.deltas()) deltas.push(delta.delta);
    })();

    const gap = session.apply(gapFrame("v:1", "v:4"));
    await answerPage(
      transport,
      0,
      [itemEvent("item/completed", "v:4", item("i-1", 3, "completed"))],
      "v:4",
    );
    await gap.io;

    assert.deepEqual(deltas, [], "no delta is synthesized for the hole");
    assert.equal(session.fold.items.get("i-1")?.revision, 3, "the final landed");
    await endTurn(session, drained);
  },
);

// ---- FR-020: a fill failure is a typed error, never a silent hole ----------

test(
  "a failed view/page surfaces a typed MuseGapFillError and leaves the fold NOT current",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    const turn = startTurn(session);
    const { done, seen } = collectItems(turn);
    const failures: MuseGapFillError[] = [];
    session.onGapError((failure) => failures.push(failure));

    const gap = session.apply(gapFrame("v:1", "v:5"));
    session.apply(itemEvent("item/started", "v:5", item("i-9", 1)));
    await waitForWrites(transport, 1);
    answerError(transport, 0, { code: -32011, data: { kind: "notFound" }, message: "gone" });
    await gap.io;

    assert.equal(failures.length, 1);
    const failure = failures[0];
    assert.ok(failure instanceof MuseGapFillError);
    assert.equal(failure.reason, "pageFailed");
    assert.equal(failure.after, "v:1");
    assert.equal(failure.next, "v:5");
    assert.equal(session.fold.current, false, "an unfilled hole never reports current");
    assert.deepEqual(session.fold.pendingGap, { after: "v:1", next: "v:5", sessionId: SESSION });
    // The buffer is RELEASED, not dropped: the live tail the client did
    // receive is still the client's, and swallowing it would add a second
    // hole to the one already reported.
    assert.deepEqual(seen, ["i-9@1"]);
    await endTurn(session, done);
  },
);

test(
  "a walk that does not advance fails as pageStalled instead of paging forever",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The wire is an external boundary: a host that answers every page with
    // the same `nextCursor` (or an empty page that does not end the view) would
    // spin this loop until the process died. Bounded by PROGRESS, not by an
    // invented attempt cap — a cap would silently truncate a legitimate long
    // walk.
    const { session, transport } = wired();
    const failures: MuseGapFillError[] = [];
    session.onGapError((failure) => failures.push(failure));

    const gap = session.apply(gapFrame("v:1", "v:5"));
    await answerPage(transport, 0, [itemEvent("item/started", "v:2", item("i-1", 1))], "v:1");
    await gap.io;

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.reason, "pageStalled");
    assert.equal(transport.writes.length, 1, "no second page was requested");
    assert.equal(session.fold.current, false);
  },
);

test(
  "a page that serves another session's event is refused, not folded into this transcript",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The same check `apply` makes on a live frame, at the one OTHER place a
    // frame can enter the fold. The request named this `sessionId`, so there
    // is no reading under which the answer is right — and folding it would
    // splice another session's history into this one under cover of a
    // recovery.
    const { session, transport } = wired();
    const failures: MuseGapFillError[] = [];
    session.onGapError((failure) => failures.push(failure));

    const gap = session.apply(gapFrame("v:1", "v:5"));
    await waitForWrites(transport, 1);
    answer(transport, 0, {
      events: [
        {
          method: "item/started",
          params: {
            item: item("i-other", 1),
            sessionId: "s-other",
            sourceRange: SOURCE_RANGE,
            viewCursor: "v:2",
          },
        },
      ],
      // Ends the view, so a walk that did NOT refuse the page would run to a
      // clean, silent completion — which is the mutant this arm has to kill by
      // assertion rather than by its own timeout.
      nextCursor: null,
    });
    await gap.io;

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.reason, "pageFailed");
    assert.equal(session.fold.items.has("i-other"), false);
    assert.equal(session.fold.current, false);
  },
);

test(
  "a fold-only Session reports noConnection rather than swallowing the gap",
  { timeout: ARM_TIMEOUT },
  async () => {
    // A `Session` built with no connection cannot page, and pretending
    // otherwise would leave a consumer folding a transcript with a hole it was
    // never told about. Nothing is buffered either — there is no fill coming
    // to release it.
    const session = foldOnly();
    const turn = startTurn(session);
    const { done, seen } = collectItems(turn);
    const failures: MuseGapFillError[] = [];
    session.onGapError((failure) => failures.push(failure));

    const gap = session.apply(gapFrame("v:1", "v:5"));
    session.apply(itemEvent("item/started", "v:5", item("i-1", 1)));
    await gap.io;

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.reason, "noConnection");
    assert.equal(session.fold.current, false);
    assert.deepEqual(seen, ["i-1@1"], "the live tail keeps folding");
    await endTurn(session, done);
  },
);

test(
  "an ephemeral discharge during the fill drops the buffer: a discarded session folds nothing",
  { timeout: ARM_TIMEOUT },
  async () => {
    // SS2.13.3b outranks the fill. `apply` already refuses frames after a
    // discharge; without the same check on the drain the buffered tail would
    // walk straight past that refusal and fold into a session the client was
    // told to discard.
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const session = new Session<string>({
      connection,
      durability: { kind: "ephemeral" },
      sessionId: SESSION,
    });
    startTurn(session);

    const gap = session.apply(gapFrame("v:1", "v:5"));
    session.apply(itemEvent("item/started", "v:5", item("i-1", 1)));
    await waitForWrites(transport, 1);
    session.hostExited({ exitCode: 1, kind: "unhandledError", stderrTail: [] });
    answer(transport, 0, {
      events: [itemEvent("item/started", "v:2", item("i-2", 1))],
      nextCursor: "v:5",
    });
    await gap.io;

    assert.equal(session.fold.items.has("i-1"), false, "the buffered tail never folded");
    assert.equal(session.fold.items.has("i-2"), false, "and neither did the paged prefix");
    // The walk stops rather than paging a host that is gone: a second request
    // would wait forever on an answer nobody is left to send. That hang is the
    // failure mode this arm's own timeout would report.
    assert.equal(transport.writes.length, 1, "no page was requested after the discharge");
    assert.equal(session.fold.current, false, "a discarded fold is never reported current");
  },
);
