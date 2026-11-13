/**
 * `session.events()`: an async stream of what each folded event changed, so
 * an incremental renderer reads each event's effect instead of re-folding
 * frames or diffing the fold (FR-97336-1).
 *
 * The contract under test: live from the moment the iterator is created, so
 * "read `session.fold`, then subscribe" in one tick misses nothing (the frames
 * held while start/resume was in flight are already in the fold); each folded
 * event is yielded once, in wire order, including what a gap fill splices in;
 * each event is self-contained; break/return() or the signal unsubscribes; the
 * stream finishes as a turn's `items()` does when the host dies; and a reclaim
 * held for an in-flight `unqueue()` rides no event.
 *
 * Causal, never time-based: every wait is a bounded microtask pump.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MuseClient, MuseHostDiedError, Session } from "../src/index.js";
import type { MuseClientOptions, SessionApplyOutcome, SessionEvent, ViewFrame } from "../src/index.js";
import { answer, FakeDuplex, frame, sentFrame, sentParams, settleMicrotasks, waitForWrites } from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
const EPHEMERAL: MuseClientOptions = { durability: { kind: "ephemeral" } };
const SESSION = "s-1";
const TURN = "t-1";
const SOURCE = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: "str-1", kind: "session" },
};

type Applied = [ViewFrame, SessionApplyOutcome<unknown>];

/**
 * Record every `Session.apply` call with the outcome it returned, so the test
 * can check that an event carries that very frame and outcome.
 */
function spyOnApply(): { calls: Applied[]; restore: () => void } {
  const original = Session.prototype.apply;
  const calls: Applied[] = [];
  Session.prototype.apply = function (this: Session, event: ViewFrame) {
    const outcome = original.call(this, event);
    calls.push([event, outcome]);
    return outcome;
  } as typeof original;
  return { calls, restore: () => (Session.prototype.apply = original) };
}

function client(options: MuseClientOptions = DURABLE): {
  client: MuseClient;
  connection: Connection;
  transport: FakeDuplex;
} {
  const transport = new FakeDuplex();
  let next = 0;
  const connection = new Connection(transport, { mintCommandId: () => `mint-${next++}` });
  return { client: new MuseClient(connection, options), connection, transport };
}

function ack(id: unknown, result: Record<string, unknown>): string {
  return frame({ jsonrpc: "2.0", id, result });
}

function view(method: string, params: Record<string, unknown>, sessionId = SESSION): string {
  return frame({ jsonrpc: "2.0", method, params: { sessionId, sourceRange: SOURCE, ...params } });
}

/** One element of a `view/page` result: the unframed view notification. */
function pagedEvent(method: string, params: Record<string, unknown>): Record<string, unknown> {
  return { method, params: { sessionId: SESSION, sourceRange: SOURCE, ...params } };
}

function gap(after: string, next: string): string {
  return frame({ jsonrpc: "2.0", method: "view/gap", params: { after, next, sessionId: SESSION } });
}

function turnStarted(): string {
  return view("turn/started", { commandId: "c-1", turnId: TURN, viewCursor: "v:1" });
}

function itemStarted(): string {
  return view("item/started", {
    viewCursor: "v:2",
    item: { itemId: "i-1", kind: "agentMessage", revision: 1, sessionId: SESSION, status: "inProgress", turnId: TURN },
  });
}

function itemDelta(text: string, viewCursor: string): string {
  return view("item/delta", { viewCursor, itemId: "i-1", delta: text, field: "text" });
}

function approvalRequest(id: number): string {
  return frame({
    jsonrpc: "2.0",
    id,
    method: "approval/request",
    params: {
      approvalId: "a-1",
      availableChoices: [{ choiceId: "deny", decision: "denied", label: "Deny", scope: "once" }],
      currentRequirementId: { approvalId: "a-1", sourceIndex: 0 },
      itemId: "i-1",
      judgeEscalated: false,
      protectedWrite: false,
      rawArgs: "{}",
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      taskId: "task-1",
      toolCallId: "call-1",
      toolName: "shell",
      turnId: TURN,
      viewCursor: "v:0",
    },
  });
}

function userInputRequest(id: number): string {
  return frame({
    jsonrpc: "2.0",
    id,
    method: "userInput/request",
    params: {
      itemId: "i-2",
      questions: [],
      sessionId: SESSION,
      toolCallId: "call-2",
      toolName: "ask",
      turnId: TURN,
      userInputId: "input-1",
      viewCursor: "v:0",
    },
  });
}

function resumeResult(): Record<string, unknown> {
  return {
    session: { sessionId: SESSION, status: "idle" },
    history: { mode: "none", items: [] },
    pendingRequests: [],
    viewCursor: "v:2",
  };
}

function itemUpdated(revision: number, viewCursor: string, status = "inProgress"): string {
  return view("item/updated", {
    viewCursor,
    item: { itemId: "i-1", kind: "agentMessage", revision, sessionId: SESSION, status, turnId: TURN },
  });
}

/** Open `SESSION`; `beforeReply` is read in the same chunk, ahead of the reply. */
async function started(
  c: MuseClient,
  transport: FakeDuplex,
  beforeReply = "",
): Promise<Session> {
  const opening = c.startSession();
  await waitForWrites(transport, transport.writes.length + 1);
  const index = transport.writes.length - 1;
  transport.chunks.push(
    beforeReply +
      ack(sentFrame(transport, index)["id"], { session: { sessionId: SESSION, status: "idle" }, viewCursor: "v:1" }),
  );
  return opening;
}

/**
 * What `next()` did within a bounded microtask pump: the result, or "pending".
 * A stream that should have something (or have ended) and does not fails the
 * arm instead of wedging the file.
 */
async function poll<T>(work: Promise<IteratorResult<T>>): Promise<IteratorResult<T> | "pending" | { rejected: unknown }> {
  let seen: IteratorResult<T> | "pending" | { rejected: unknown } = "pending";
  work.then(
    (result) => (seen = result),
    (error: unknown) => (seen = { rejected: error }),
  );
  await settleMicrotasks();
  return seen;
}

/** The next `count` events, each of which must already be available. */
async function take(events: AsyncIterator<SessionEvent>, count: number): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (let i = 0; i < count; i++) {
    const result = await poll(events.next());
    if (result === "pending" || "rejected" in result || result.done === true) {
      assert.fail(`event ${i} of ${count} was not available: ${JSON.stringify(result)}`);
    }
    out.push(result.value);
  }
  return out;
}

const methods = (events: readonly SessionEvent[]): string[] => events.map((event) => event.frame.method);

/** The event an earlier, still-waiting `next()` resolved to, within a bounded pump. */
async function yielded(waiting: Promise<IteratorResult<SessionEvent>>): Promise<SessionEvent> {
  const result = await poll(waiting);
  if (result === "pending" || "rejected" in result || result.done === true) {
    assert.fail(`expected an event, got ${JSON.stringify(result)}`);
  }
  return result.value;
}

const DONE = { done: true, value: undefined };

test("read the fold, then subscribe: nothing is missed, including frames folded while startSession was in flight", async () => {
  const { client: c, transport } = client();
  // The replay a host flushes ahead of the reply folds inside startSession.
  const session = await started(c, transport, turnStarted() + itemStarted());
  // Same tick: the state, then the stream.
  assert.deepEqual(session.fold.turns().map((turn) => turn.turnId), [TURN]);
  assert.ok(session.fold.items.get("i-1") !== undefined, "the held frames are in the fold");
  const events = session.events();
  const waiting = events.next();
  assert.equal(await poll(waiting), "pending", "the stream is live-only: the held frames are not repeated");

  transport.chunks.push(itemDelta("hel", "v:3") + itemDelta("lo", "v:4"));
  const live = [await yielded(waiting), ...(await take(events, 1))];
  assert.deepEqual(methods(live), ["item/delta", "item/delta"]);
  assert.deepEqual(live.map((event) => event.outcome.fold.kind), ["itemDelta", "itemDelta"]);
  assert.equal(session.fold.items.accumulated("i-1"), "hello");
  await c.close();
});

test("each event carries the very frame and outcome session.apply saw and returned", async () => {
  const spy = spyOnApply();
  try {
    const { client: c, transport } = client();
    const session = await started(c, transport);
    const before = spy.calls.length;
    const events = session.events();
    transport.chunks.push(turnStarted() + itemStarted() + itemDelta("hi", "v:3"));
    const seen = await take(events, 3);
    const applied = spy.calls.slice(before);
    assert.equal(applied.length, 3);
    seen.forEach((event, index) => {
      const [appliedFrame, appliedOutcome] = applied[index] as Applied;
      assert.equal(event.frame, appliedFrame, `frame ${index} is the one apply folded`);
      assert.equal(event.outcome, appliedOutcome, `outcome ${index} is the one apply returned`);
    });
    await c.close();
  } finally {
    spy.restore();
  }
});

test("re-sent requests arrive as the frames the session folded", async () => {
  const { client: c, transport } = client();
  const opening = c.resumeSession({ sessionId: SESSION });
  await waitForWrites(transport, 1);
  transport.chunks.push(ack(sentFrame(transport, 0)["id"], resumeResult()));
  const session = await opening;
  const events = session.events();
  transport.chunks.push(approvalRequest(7) + userInputRequest(8));
  const seen = await take(events, 2);
  assert.deepEqual(methods(seen), ["approval/request", "userInput/requested"]);
  assert.equal(seen[0]?.outcome.fold.kind, "ignoredUnrecognizedMethod", "a re-sent approval skips the fold");
  assert.deepEqual(session.fold.pendingUserInputs().map((input) => input.userInputId), ["input-1"]);
  await c.close();
});

test("an item event carries the item as it stood at that event, even when later revisions folded first", async () => {
  // The loop body can run after later frames folded, so the event, not the
  // fold, is the source of truth for what that event changed.
  const { client: c, transport } = client();
  const session = await started(c, transport);
  const events = session.events();
  transport.chunks.push(itemStarted() + itemUpdated(2, "v:3") + itemUpdated(3, "v:4", "completed"));
  await settleMicrotasks();
  assert.equal(session.fold.items.get("i-1")?.revision, 3, "the fold is already at the last revision");
  const seen = await take(events, 3);
  assert.deepEqual(seen.map((event) => event.item?.revision), [1, 2, 3]);
  assert.deepEqual(seen.map((event) => event.item?.status), ["inProgress", "inProgress", "completed"]);
  await c.close();
});

test("a gap fill's paged and buffered frames are yielded once each, in order, when spliced in", async () => {
  const { client: c, transport } = client();
  const session = await started(c, transport, turnStarted());
  const events = session.events();
  transport.chunks.push(gap("v:1", "v:2"));
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "view/page");
  // A live frame behind the hole: held while the fill runs, not yielded yet.
  transport.chunks.push(itemDelta("hi", "v:3"));
  const [gapEvent] = await take(events, 1);
  assert.equal(gapEvent?.outcome.fold.kind, "deliveryGap");
  const waiting = events.next();
  assert.equal(await poll(waiting), "pending", "a held frame is yielded when spliced in, not before");
  answer(transport, 1, {
    events: [
      pagedEvent("item/started", {
        viewCursor: "v:2",
        item: { itemId: "i-1", kind: "agentMessage", revision: 1, sessionId: SESSION, status: "inProgress", turnId: TURN },
      }),
    ],
    nextCursor: "v:2",
  });
  const spliced = [await yielded(waiting), ...(await take(events, 1))];
  assert.deepEqual(methods(spliced), ["item/started", "item/delta"]);
  assert.equal(spliced[0]?.outcome.fold.kind, "item", "the paged frame comes with its fold outcome");
  assert.equal(spliced[0]?.item?.itemId, "i-1");
  assert.equal(await poll(events.next()), "pending", "each frame once");
  assert.equal(session.fold.items.accumulated("i-1"), "hi");
  await c.close();
});

test("break, return() and the signal unsubscribe; an already-aborted signal yields nothing", async () => {
  const { client: c, transport } = client();
  const session = await started(c, transport);

  const broken = session.events();
  transport.chunks.push(turnStarted());
  for await (const event of broken) {
    assert.equal(event.frame.method, "turn/started");
    break;
  }
  assert.deepEqual(await poll(broken.next()), DONE);

  const controller = new AbortController();
  const signalled = session.events({ signal: controller.signal });
  const kept = session.events();
  controller.abort();
  transport.chunks.push(itemStarted());
  await settleMicrotasks();
  assert.deepEqual(await poll(signalled.next()), DONE, "an abort ends the stream");
  assert.deepEqual(methods(await take(kept, 1)), ["item/started"], "other streams are unaffected");

  const late = session.events({ signal: controller.signal });
  assert.deepEqual(await poll(late.next()), DONE);
  await c.close();
});

test("each stream hears every event of its own session only, and an unread stream holds nothing up", async () => {
  const { client: c, transport } = client();
  const one = await started(c, transport);
  const opening = c.startSession();
  await waitForWrites(transport, 2);
  transport.chunks.push(ack(sentFrame(transport, 1)["id"], { session: { sessionId: "s-2", status: "idle" }, viewCursor: "v:0" }));
  const two = await opening;
  const unread = one.events();
  const first = one.events();
  const other = two.events();
  transport.chunks.push(
    view("turn/started", { commandId: "c-a", turnId: "a", viewCursor: "v:a" }) +
      view("turn/started", { commandId: "c-b", turnId: "b", viewCursor: "v:b" }, "s-2") +
      view("turn/started", { commandId: "c-c", turnId: "c", viewCursor: "v:c" }),
  );
  const turnIds = (events: SessionEvent[]) => events.map((event) => (event.frame.params as { turnId: string }).turnId);
  assert.deepEqual(turnIds(await take(first, 2)), ["a", "c"]);
  assert.deepEqual(turnIds(await take(other, 1)), ["b"]);
  assert.deepEqual(one.fold.turns().map((turn) => turn.turnId), ["a", "c"], "folding never waits on a reader");
  assert.deepEqual(turnIds(await take(unread, 2)), ["a", "c"], "an unread stream buffers");
  await c.close();
});

test("an ephemeral host death ends the stream after what it buffered; a later stream ends at once", async () => {
  const { client: c, connection, transport } = client(EPHEMERAL);
  const session = await started(c, transport);
  const events = session.events();
  transport.chunks.push(turnStarted());
  await settleMicrotasks();
  transport.chunks.end();
  await connection.closed;
  await settleMicrotasks();
  assert.deepEqual(methods(await take(events, 1)), ["turn/started"], "buffered events come first");
  assert.deepEqual(await poll(events.next()), DONE);
  assert.deepEqual(await poll(session.events().next()), DONE);
});

test("a durable host death rejects the stream with MuseHostDiedError, as a turn's items() does", async () => {
  const { client: c, connection, transport } = client(DURABLE);
  const session = await started(c, transport);
  const events = session.events();
  transport.chunks.push(turnStarted());
  await settleMicrotasks();
  transport.chunks.end();
  await connection.closed;
  await settleMicrotasks();
  assert.deepEqual(methods(await take(events, 1)), ["turn/started"], "buffered events come first");
  const failed = await poll(events.next());
  assert.ok(typeof failed === "object" && "rejected" in failed && failed.rejected instanceof MuseHostDiedError);
  const late = await poll(session.events().next());
  assert.ok(typeof late === "object" && "rejected" in late && late.rejected instanceof MuseHostDiedError);
});

/** A started session holding one acked queued submit for turn `t-2`. */
async function queuedTurn() {
  const { client: c, transport } = client();
  const session = await started(c, transport);
  const events = session.events();
  const submitting = session.sendUserTurn({ composerInput: "draft", input: [{ type: "text", text: "q" }] });
  await waitForWrites(transport, 2);
  const queued = sentParams(transport, 1)["commandId"] as string;
  transport.chunks.push(
    ack(sentFrame(transport, 1)["id"], {
      commandId: queued,
      disposition: "queued",
      startedNewTurn: true,
      status: "accepted",
      turnId: "t-2",
    }),
  );
  return { client: c, events, queued, session, transport, turn: await submitting };
}

function unqueuedFrame(queued: string): string {
  return view("turn/unqueued", { commandId: queued, turnId: "t-2", viewCursor: "v:9" });
}

function reclaim(queued: string): unknown {
  return { commandId: queued, input: "draft", kind: "reclaimed", restoreToComposer: true };
}

function unqueueAck(transport: FakeDuplex, index: number): string {
  return ack(sentFrame(transport, index)["id"], {
    commandId: sentParams(transport, index)["commandId"],
    status: "accepted",
    turnId: "t-2",
  });
}

test("events change nothing else: a reclaim folded first still comes back from unqueue(), once", async () => {
  const { client: c, events, queued, transport, turn } = await queuedTurn();
  const unqueuing = turn.unqueue();
  await waitForWrites(transport, 3);
  transport.chunks.push(unqueuedFrame(queued) + unqueueAck(transport, 2));
  const outcome = await unqueuing;
  assert.deepEqual(outcome.retirement, reclaim(queued), "unqueue() returns the reclaim");
  const [event] = await take(events, 1);
  assert.equal(event?.frame.method, "turn/unqueued", "the event is still yielded");
  assert.deepEqual(event?.outcome.retirements, [], "without the reclaim unqueue() returns");
  await c.close();
});

test("a reclaim spliced in by a gap fill while unqueue() is in flight rides no event or io", async () => {
  const { client: c, events, queued, transport, turn } = await queuedTurn();
  const unqueuing = turn.unqueue();
  await waitForWrites(transport, 3);
  transport.chunks.push(gap("v:1", "v:9"));
  await waitForWrites(transport, 4);
  answer(transport, 3, {
    events: [pagedEvent("turn/unqueued", { commandId: queued, turnId: "t-2", viewCursor: "v:9" })],
    nextCursor: "v:9",
  });
  await settleMicrotasks();
  transport.chunks.push(unqueueAck(transport, 2));
  assert.deepEqual((await unqueuing).retirement, reclaim(queued));
  const seen = await take(events, 2);
  assert.deepEqual(methods(seen), ["view/gap", "turn/unqueued"]);
  assert.deepEqual(seen.flatMap((event) => event.outcome.retirements), []);
  assert.deepEqual((await Promise.all(seen.map((event) => event.outcome.io))).flat(), [], "no io carries it either");
  await c.close();
});

test("a reclaim no unqueue() waits for rides its event", async () => {
  const { client: c, events, queued, transport } = await queuedTurn();
  transport.chunks.push(unqueuedFrame(queued));
  const [event] = await take(events, 1);
  assert.equal(event?.frame.method, "turn/unqueued");
  assert.deepEqual(event?.outcome.retirements, [reclaim(queued)]);
  await c.close();
});
