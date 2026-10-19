/**
 * A question still open at resume is re-sent as a `userInput/request` server
 * request (tdd SS5.6, SS5.10). The client that owns the connection routes it
 * to its session as the `userInput/requested` twin it shares params with, so
 * the session lists it, and answers with the SS5.3.3 receipt `{}`. Every other
 * server-request method except `approval/request` (FR-53910-1), and every
 * request on a bare `Connection`, keeps `-32601`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Connection,
  MuseClient,
  MuseSessionDiscardedError,
  ProtocolError,
  Session,
} from "../src/index.js";
import type { ExitClassification, MuseClientOptions } from "../src/index.js";
import { FakeDuplex, frame, sentFrame, settleMicrotasks, waitForWrites } from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };

function question(viewCursor: string): Record<string, unknown> {
  return {
    itemId: "i-2",
    questions: [],
    sessionId: "s-9",
    toolCallId: "call-2",
    toolName: "ask",
    turnId: "turn-1",
    userInputId: "input-1",
    viewCursor,
  };
}

/** Resume `s-9`; `tail` is read in the same chunk as the resume reply. */
async function resumed(transport: FakeDuplex, tail = ""): Promise<Session> {
  const client = new MuseClient(new Connection(transport), DURABLE);
  const pending = client.resumeSession({ sessionId: "s-9" });
  await waitForWrites(transport, 1);
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: sentFrame(transport, 0)["id"],
      result: {
        session: { sessionId: "s-9", status: "idle" },
        history: { mode: "none", items: [] },
        pendingRequests: [],
        viewCursor: "cursor-1",
      },
    }) + tail,
  );
  return pending;
}

function listed(session: Session): string[] {
  return session.fold.pendingUserInputs().map((input) => input.userInputId);
}

test("a question re-sent only as userInput/request after resume is listed and receipted", async () => {
  const transport = new FakeDuplex();
  const session = await resumed(transport);

  // The host re-sends the params it folded, so the request keeps the
  // question's own cursor, behind the resume cursor.
  transport.chunks.push(
    frame({ jsonrpc: "2.0", id: 7, method: "userInput/request", params: question("cursor-0") }),
  );
  await waitForWrites(transport, 2);

  assert.deepEqual(sentFrame(transport, 1), { jsonrpc: "2.0", id: 7, result: {} });
  assert.deepEqual(listed(session), ["input-1"]);
});

test("a question re-sent in the same read as the resume reply is listed and receipted", async () => {
  const transport = new FakeDuplex();
  // The host re-sends right after the resume reply, so a real client often
  // reads both in one chunk: the request is held until the session exists.
  const session = await resumed(
    transport,
    frame({ jsonrpc: "2.0", id: 7, method: "userInput/request", params: question("cursor-0") }),
  );
  await waitForWrites(transport, 2);

  assert.deepEqual(sentFrame(transport, 1), { jsonrpc: "2.0", id: 7, result: {} });
  assert.deepEqual(listed(session), ["input-1"]);
});

for (const requestFirst of [false, true]) {
  test(`a question sent as both frames is listed once (${requestFirst ? "request" : "notification"} first)`, async () => {
    const transport = new FakeDuplex();
    const session = await resumed(transport);
    const notification = frame({
      jsonrpc: "2.0",
      method: "userInput/requested",
      params: question("cursor-2"),
    });
    const request = frame({
      jsonrpc: "2.0",
      id: 7,
      method: "userInput/request",
      params: question("cursor-2"),
    });

    // One chunk: the connection reads every line of it before the asserts.
    transport.chunks.push(requestFirst ? request + notification : notification + request);
    await waitForWrites(transport, 2);

    assert.deepEqual(sentFrame(transport, 1), { jsonrpc: "2.0", id: 7, result: {} });
    assert.deepEqual(listed(session), ["input-1"]);
  });
}

test("a re-sent request is listed in arrival order with the notifications read after it", async () => {
  const transport = new FakeDuplex();
  const session = await resumed(transport);
  const second = { ...question("cursor-2"), itemId: "i-3", toolCallId: "call-3", userInputId: "input-2" };

  transport.chunks.push(
    frame({ jsonrpc: "2.0", id: 7, method: "userInput/request", params: question("cursor-0") }) +
      frame({ jsonrpc: "2.0", method: "userInput/requested", params: second }),
  );
  await waitForWrites(transport, 2);

  assert.deepEqual(listed(session), ["input-1", "input-2"]);
});

test("a re-sent request naming no session or an unknown one still gets the {} receipt", async () => {
  const transport = new FakeDuplex();
  const session = await resumed(transport);
  const { sessionId: _unnamed, ...unnamed } = question("cursor-0");

  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: 7,
      method: "userInput/request",
      params: { ...question("cursor-0"), sessionId: "s-other" },
    }) + frame({ jsonrpc: "2.0", id: 8, method: "userInput/request", params: unnamed }),
  );
  await waitForWrites(transport, 3);

  const replies = [sentFrame(transport, 1), sentFrame(transport, 2)].sort(
    (left, right) => (left["id"] as number) - (right["id"] as number),
  );
  assert.deepEqual(replies, [
    { jsonrpc: "2.0", id: 7, result: {} },
    { jsonrpc: "2.0", id: 8, result: {} },
  ]);
  assert.deepEqual(listed(session), []);
});

test("a client-owned connection still answers an unrouted server request with -32601", async () => {
  const transport = new FakeDuplex();
  const session = await resumed(transport);

  transport.chunks.push(
    frame({ jsonrpc: "2.0", id: 8, method: "test/unroutedRequest", params: { sessionId: "s-9" } }),
  );
  await waitForWrites(transport, 2);

  const reply = sentFrame(transport, 1);
  const error = reply["error"] as Record<string, unknown>;
  assert.equal(reply["id"], 8);
  assert.equal(error["code"], -32601);
  assert.equal((error["data"] as Record<string, unknown>)["kind"], "methodNotFound");
  assert.deepEqual(listed(session), []);
});

test("a bare Connection still answers userInput/request with -32601", async () => {
  const transport = new FakeDuplex();
  const bare = new Connection(transport);

  transport.chunks.push(
    frame({ jsonrpc: "2.0", id: 7, method: "userInput/request", params: question("cursor-0") }),
  );
  await waitForWrites(transport, 1);

  const reply = sentFrame(transport, 0);
  const error = reply["error"] as Record<string, unknown>;
  assert.equal(reply["id"], 7);
  assert.equal(error["code"], -32601);
  assert.equal((error["data"] as Record<string, unknown>)["kind"], "methodNotFound");
  await bare.close();
});

test("a listed question is answered with Session.answerUserInput", async () => {
  const transport = new FakeDuplex();
  const session = await resumed(transport);
  transport.chunks.push(
    frame({ jsonrpc: "2.0", id: 7, method: "userInput/request", params: question("cursor-0") }),
  );
  await waitForWrites(transport, 2);

  const answers = [{ questionId: "q-1", selectedLabel: "Yes" }];
  const answering = session.answerUserInput("input-1", answers);
  await waitForWrites(transport, 3);
  const sent = sentFrame(transport, 2);
  const { commandId, ...params } = sent["params"] as Record<string, unknown>;
  assert.equal(sent["method"], "userInput/answer");
  assert.ok(typeof commandId === "string" && commandId.length > 0);
  assert.deepEqual(params, { sessionId: "s-9", userInputId: "input-1", answers });

  const result = { commandId, status: "accepted", userInputId: "input-1" };
  transport.chunks.push(frame({ jsonrpc: "2.0", id: sent["id"], result }));
  assert.deepEqual(await answering, result);
  // The question settles only on the server's userInput/settled.
  assert.deepEqual(listed(session), ["input-1"]);
});

test("answerUserInput rejects an answer acknowledged for another question", async () => {
  const transport = new FakeDuplex();
  const session = await resumed(transport);

  const answering = session.answerUserInput("input-1", [{ questionId: "q-1", freeText: "ok" }]);
  await waitForWrites(transport, 2);
  const sent = sentFrame(transport, 1);
  const { commandId } = sent["params"] as Record<string, unknown>;
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: sent["id"],
      result: { commandId, status: "accepted", userInputId: "input-2" },
    }),
  );
  await assert.rejects(answering, ProtocolError);
});

test("a fold-only Session refuses answerUserInput instead of dropping the answer", async () => {
  const session = new Session({ sessionId: "s-9", durability: { kind: "durable" } });
  await assert.rejects(
    session.answerUserInput("input-1", [{ questionId: "q-1", freeText: "ok" }]),
    /connection/i,
  );
});

test("a question settled in the same read as its re-sent request is not listed", async () => {
  const transport = new FakeDuplex();
  const session = await resumed(transport);
  const settled = frame({
    jsonrpc: "2.0",
    method: "userInput/settled",
    params: {
      answers: [],
      clarification: null,
      decidedAt: "2025-08-07T18:23:20.100Z",
      decidedByCommandId: null,
      outcome: "answered",
      reason: null,
      sessionId: "s-9",
      userInputId: "input-1",
      viewCursor: "cursor-2",
    },
  });
  transport.chunks.push(
    frame({ jsonrpc: "2.0", id: 7, method: "userInput/request", params: question("cursor-0") }) +
      settled,
  );
  await waitForWrites(transport, 2);

  assert.deepEqual(sentFrame(transport, 1), { jsonrpc: "2.0", id: 7, result: {} });
  assert.deepEqual(listed(session), []);
});

test("answerUserInput rejects an answer acknowledged with no command id", async () => {
  const transport = new FakeDuplex();
  const session = await resumed(transport);

  const answering = session.answerUserInput("input-1", [{ questionId: "q-1", freeText: "ok" }]);
  await waitForWrites(transport, 2);
  const sent = sentFrame(transport, 1);
  transport.chunks.push(
    frame({ jsonrpc: "2.0", id: sent["id"], result: { status: "accepted", userInputId: "input-1" } }),
  );
  await assert.rejects(answering, ProtocolError);
});

test("a discarded session refuses answerUserInput before sending anything", async () => {
  const transport = new FakeDuplex();
  const crash: ExitClassification = {
    exitCode: 77,
    exitSignal: null,
    kind: "crash",
    stderrTail: ["thread 'main' panicked"],
  };
  const session = new Session({
    sessionId: "s-9",
    durability: { kind: "ephemeral" },
    connection: new Connection(transport),
  });
  assert.equal(session.hostExited(crash).kind, "discharged");

  const answering = session.answerUserInput("input-1", [{ questionId: "q-1", freeText: "ok" }]);
  await settleMicrotasks();
  assert.equal(transport.writes.length, 0);
  await assert.rejects(answering, MuseSessionDiscardedError);
});
