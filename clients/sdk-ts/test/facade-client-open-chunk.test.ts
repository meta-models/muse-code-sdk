/**
 * #49790 / TEST-49790-1: view events that arrive in the same read chunk as
 * the `session/resume` / `session/start` acknowledgement reach the `Session`.
 *
 * The host flushes the resume catch-up replay BEFORE the result (#26682), and
 * a transport hands over whatever is buffered as one chunk, so the frames a
 * late-joiner needs most routinely parse in the same `#ingest` pass as the
 * acknowledgement that names the session. `MuseClient.#route` dropped a frame
 * for a session not yet in `#sessions`, and the `Session` was registered only
 * after the awaited command returned — one microtask too late. The fold then
 * showed no turn, no items and no gap, and reported current.
 *
 * Python twin: `clients/sdk-py/tests/test_facade_open_same_chunk.py`.
 * Causal, never time-based: every wait is a bounded microtask pump.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MspError, MuseClient } from "../src/index.js";
import type { MuseClientOptions, Session } from "../src/index.js";
import { FakeDuplex, frame, sentFrame, settleMicrotasks, waitForWrites } from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
const SESSION = "s-1";
const OTHER = "s-other";
const TURN = "t-1";
const SOURCE = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: "str-1", kind: "session" },
};

function client(): { client: MuseClient; transport: FakeDuplex } {
  const transport = new FakeDuplex();
  return { client: new MuseClient(new Connection(transport), DURABLE), transport };
}

function ack(id: unknown, result: Record<string, unknown>): string {
  return frame({ jsonrpc: "2.0", id, result });
}

function resumeResult(sessionId: string): Record<string, unknown> {
  return {
    session: { sessionId, status: "idle" },
    history: { mode: "none", items: [] },
    pendingRequests: [],
    viewCursor: "v:2",
  };
}

function startResult(sessionId: string): Record<string, unknown> {
  return { session: { sessionId, status: "idle" }, viewCursor: "v:2" };
}

function view(method: string, sessionId: string, params: Record<string, unknown>): string {
  return frame({ jsonrpc: "2.0", method, params: { sessionId, sourceRange: SOURCE, ...params } });
}

function turnStarted(sessionId = SESSION, turnId = TURN): string {
  return view("turn/started", sessionId, { commandId: "c-1", turnId, viewCursor: "v:1" });
}

function itemStarted(sessionId = SESSION): string {
  return view("item/started", sessionId, {
    viewCursor: "v:2",
    item: {
      itemId: "i-1",
      kind: "agentMessage",
      revision: 1,
      sessionId,
      status: "inProgress",
      turnId: TURN,
    },
  });
}

function itemDelta(text: string, viewCursor: string, sessionId = SESSION): string {
  return view("item/delta", sessionId, { viewCursor, itemId: "i-1", delta: text, field: "text" });
}

function errorReply(id: unknown): string {
  return frame({
    jsonrpc: "2.0",
    id,
    error: { code: -32011, message: "gone", data: { kind: "notFound" } },
  });
}

function assertReplayFolded(session: Session): void {
  assert.deepEqual(
    session.fold.turns().map((turn) => turn.turnId),
    [TURN],
    "the turn/started delivered with the ack must fold",
  );
  assert.ok(session.fold.items.get("i-1") !== undefined, "the item/started delivered with the ack must fold");
  // No hole was reported, so the fold rightly says current — which is
  // exactly why a drop here was silent.
  assert.equal(session.fold.pendingGap, undefined);
  assert.equal(session.fold.current, true);
}

test("TEST-49790-1: resumeSession folds the view events written in the same chunk as the ack", async () => {
  const { client: c, transport } = client();
  const pending = c.resumeSession({ sessionId: SESSION });
  await waitForWrites(transport, 1);
  const sent = sentFrame(transport, 0);
  assert.equal(sent["method"], "session/resume");
  // ONE write: the ack, then the view frames behind it — two deltas last, so
  // a drain that folds the held frames backwards is caught by the text.
  transport.chunks.push(
    ack(sent["id"], resumeResult(SESSION)) +
      turnStarted() +
      itemStarted() +
      itemDelta("hel", "v:3") +
      itemDelta("lo", "v:4"),
  );
  const session = await pending;
  assert.equal(session.sessionId, SESSION);
  assertReplayFolded(session);
  assert.equal(session.fold.items.accumulated("i-1"), "hello", "held frames fold in arrival order");
  await c.close();
});

test("TEST-49790-1: resumeSession folds the replay the host flushes ahead of the result", async () => {
  // The shipped order (#26682): the `(cursor, head]` replay is flushed BEFORE
  // the result, so the frames precede the ack that names the session.
  const { client: c, transport } = client();
  const pending = c.resumeSession({ sessionId: SESSION });
  await waitForWrites(transport, 1);
  const sent = sentFrame(transport, 0);
  transport.chunks.push(turnStarted() + itemStarted() + ack(sent["id"], resumeResult(SESSION)));
  const session = await pending;
  assertReplayFolded(session);
  await c.close();
});

test("TEST-49790-1: startSession folds same-chunk events for the server-named session only", async () => {
  const { client: c, transport } = client();
  const pending = c.startSession();
  await waitForWrites(transport, 1);
  const sent = sentFrame(transport, 0);
  assert.equal(sent["method"], "session/start");
  // The SERVER names the session; its frames bracket the ack, and a frame for
  // an unrelated session rides the same chunk.
  transport.chunks.push(
    turnStarted() + ack(sent["id"], startResult(SESSION)) + itemStarted() + turnStarted(OTHER, "t-other"),
  );
  const session = await pending;
  assert.equal(session.sessionId, SESSION);
  assertReplayFolded(session);

  // The hold exists only while an open is in flight. The unrelated frame
  // above and one arriving now, with no open in flight, are both gone: a
  // later resume of that session starts from what ITS ack's chunk carries,
  // never from retained strays — the bound on what the client keeps.
  transport.chunks.push(turnStarted(OTHER, "t-stray"));
  await settleMicrotasks();
  const pendingOther = c.resumeSession({ sessionId: OTHER });
  await waitForWrites(transport, 2);
  transport.chunks.push(ack(sentFrame(transport, 1)["id"], resumeResult(OTHER)));
  const other = await pendingOther;
  assert.equal(other.sessionId, OTHER);
  assert.deepEqual(other.fold.turns(), [], "frames outside an open window are not retained");
  await c.close();
});

test("TEST-49790-1: an open that errors drops what it held", async () => {
  // The hold clears when the LAST open settles, result OR error. A rejected
  // resume that left the window open would make the client hold every
  // unknown-session frame forever — the growth the counter exists to stop.
  const { client: c, transport } = client();
  const pending = c.resumeSession({ sessionId: SESSION });
  await waitForWrites(transport, 1);
  transport.chunks.push(turnStarted() + itemStarted() + errorReply(sentFrame(transport, 0)["id"]));
  await assert.rejects(pending, MspError);

  // With no open in flight this frame is dropped, as before the hold existed…
  transport.chunks.push(turnStarted(SESSION, "t-stray"));
  await settleMicrotasks();
  // …so the next open of the same session starts from its own ack's chunk.
  const again = c.resumeSession({ sessionId: SESSION });
  await waitForWrites(transport, 2);
  transport.chunks.push(ack(sentFrame(transport, 1)["id"], resumeResult(SESSION)));
  const session = await again;
  assert.deepEqual(session.fold.turns(), [], "nothing held across a failed open survives");
  await c.close();
});

test("TEST-49790-1: two overlapping opens each fold only their own frames", async () => {
  // The window is COUNTED, not flagged: while two opens are in flight, the
  // first to settle must not clear what the second is still owed.
  const { client: c, transport } = client();
  const pendingA = c.resumeSession({ sessionId: "s-a" });
  await waitForWrites(transport, 1);
  const pendingB = c.resumeSession({ sessionId: "s-b" });
  await waitForWrites(transport, 2);
  const idA = sentFrame(transport, 0)["id"];
  const idB = sentFrame(transport, 1)["id"];
  // b settles first, with a's replay already in: a flag would clear it here.
  transport.chunks.push(turnStarted("s-a", "t-a") + ack(idB, resumeResult("s-b")));
  const b = await pendingB;
  transport.chunks.push(turnStarted("s-b", "t-b") + ack(idA, resumeResult("s-a")));
  const a = await pendingA;
  assert.deepEqual(
    a.fold.turns().map((turn) => turn.turnId),
    ["t-a"],
  );
  assert.deepEqual(
    b.fold.turns().map((turn) => turn.turnId),
    ["t-b"],
  );
  await c.close();
});
