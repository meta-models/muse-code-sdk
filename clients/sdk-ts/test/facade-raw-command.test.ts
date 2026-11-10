/**
 * FR-79107-2 — `MuseClient.command` is the typed escape hatch for wire methods
 * the facade does not wrap. It sends through `Connection.command()` (the one
 * `commandId` minter and its same-id retry), and refuses, before anything is
 * written, the methods whose state the facade owns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MuseClient, MuseFacadeOwnedMethodError, ProtocolError } from "../src/index.js";
import type { MuseClientOptions } from "../src/index.js";
import {
  answer,
  answerError,
  FakeDuplex,
  sentFrame,
  sentParams,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };

/** Every method the facade owns, as the issue and the facade sources name them. */
const FACADE_OWNED = [
  "initialize",
  "session/start",
  "session/resume",
  "turn/start",
  "turn/steer",
  "turn/unqueue",
  "approval/decide",
  "userInput/answer",
  "view/page",
  "view/subscribe",
  "view/unsubscribe",
] as const;

function mintedClient(): { client: MuseClient; transport: FakeDuplex; minted: string[] } {
  const transport = new FakeDuplex();
  const minted: string[] = [];
  const connection = new Connection(transport, {
    mintCommandId: () => {
      const id = `mint-${minted.length}`;
      minted.push(id);
      return id;
    },
  });
  return { client: new MuseClient(connection, DURABLE), transport, minted };
}

test("FR-79107-2: command sends an unwrapped method with the connection's minted commandId", async () => {
  const { client, transport, minted } = mintedClient();

  const pending = client.command("task/stop", { sessionId: "s-1", taskId: "t-1" });
  await waitForWrites(transport, 1);
  answer(transport, 0, { commandId: "mint-0", status: "accepted" });

  assert.deepEqual(await pending, { commandId: "mint-0", status: "accepted" });
  assert.equal(sentFrame(transport, 0)["method"], "task/stop");
  assert.deepEqual(sentParams(transport, 0), { sessionId: "s-1", taskId: "t-1", commandId: "mint-0" });
  assert.deepEqual(minted, ["mint-0"], "the facade mints nothing of its own (INV-013)");
});

test("FR-79107-2: command keeps Connection.command's same-id retry on a nothing-admitted refusal", async () => {
  const { client, transport, minted } = mintedClient();
  const delays: number[] = [];

  const pending = client.command(
    "task/stop",
    { sessionId: "s-1", taskId: "t-1" },
    { retryDelay: async (attempt) => void delays.push(attempt) },
  );
  await waitForWrites(transport, 1);
  answerError(transport, 0, { code: -32001, message: "busy", data: { kind: "overloaded", retryable: true } });
  await waitForWrites(transport, 2);
  answer(transport, 1, { commandId: "mint-0", status: "accepted" });

  await pending;
  assert.deepEqual(delays, [1]);
  assert.equal(sentParams(transport, 0)["commandId"], "mint-0");
  assert.equal(sentParams(transport, 1)["commandId"], "mint-0", "the retry reuses the same commandId");
  assert.deepEqual(minted, ["mint-0"]);
});

test("FR-79107-2: every facade-owned method is refused, typed, before anything is written", async () => {
  // @ts-expect-error -- the type excludes facade-owned methods; the runtime
  // check below is what binds a plain-JS caller.
  const ownedIsNotAccepted: Parameters<MuseClient["command"]>[0] = "turn/start";
  void ownedIsNotAccepted;

  const { client, transport } = mintedClient();
  for (const method of FACADE_OWNED) {
    const outcome = client.command(method as never, {}).then(
      () => assert.fail(`${method} must be refused`),
      (caught: unknown) => caught,
    );
    // Checked before awaiting, so a method that is sent fails here instead
    // of waiting on an ack the fake never gives.
    await settleMicrotasks();
    assert.equal(transport.writes.length, 0, `${method} must never reach the wire`);
    const error = await outcome;
    assert.ok(error instanceof MuseFacadeOwnedMethodError, `${method}: got ${String(error)}`);
    assert.equal(error.method, method);
  }

  // The refusal is per call: the same client still sends an unwrapped method.
  const pending = client.command("task/stop", { sessionId: "s-1", taskId: "t-1" });
  await waitForWrites(transport, 1);
  answer(transport, 0, { commandId: "mint-0", status: "accepted" });
  await pending;
});

test("FR-79107-2: a closed client refuses command before anything is written", async () => {
  const { client, transport } = mintedClient();
  await client.close();

  await assert.rejects(
    client.command("task/stop", { sessionId: "s-1", taskId: "t-1" }),
    ProtocolError,
  );
  assert.equal(transport.writes.length, 0);
});
