/**
 * FR-79107-2 — `MuseClient.command` and `MuseClient.request` are the typed
 * escape hatches for wire methods the facade does not wrap, experimental ones
 * included. They send through `Connection.command()` (the one `commandId`
 * minter and its same-id retry) and `Connection.request()`, and refuse, before
 * anything is written, the methods whose state the facade owns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MspError, MuseClient, MuseFacadeOwnedMethodError, ProtocolError } from "../src/index.js";
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
  const { client, transport } = mintedClient();
  // The type refuses a facade-owned literal even though any other string,
  // experimental included, is accepted; the runtime check below is what binds
  // a plain-JS caller. Never called: it exists for the compiler.
  const compileTimeOnly = (): void => {
    // @ts-expect-error -- facade-owned
    void client.command("turn/start", {});
    // @ts-expect-error -- facade-owned
    void client.request("view/page", {});
  };
  void compileTimeOnly;

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

test("FR-79107-2: command sends an experimental method under the caller's commandId override", async () => {
  const { client, transport, minted } = mintedClient();

  const pending = client.command(
    "session/setPermissionProfile",
    { sessionId: "s-1", profileId: "read-only" },
    { commandId: "pinned-1" },
  );
  await waitForWrites(transport, 1);
  answer(transport, 0, { commandId: "pinned-1", status: "accepted" });

  assert.deepEqual(await pending, { commandId: "pinned-1", status: "accepted" });
  assert.equal(sentFrame(transport, 0)["method"], "session/setPermissionProfile");
  assert.deepEqual(sentParams(transport, 0), { sessionId: "s-1", profileId: "read-only", commandId: "pinned-1" });
  assert.deepEqual(minted, [], "an override is used instead of minting");
});

test("FR-79107-2: request round-trips an experimental query with no commandId", async () => {
  const { client, transport, minted } = mintedClient();

  const pending = client.request("permissionProfile/list");
  await waitForWrites(transport, 1);
  answer(transport, 0, { profiles: [{ id: "read-only" }] });

  assert.deepEqual(await pending, { profiles: [{ id: "read-only" }] });
  const sent = sentFrame(transport, 0);
  assert.equal(sent["method"], "permissionProfile/list");
  assert.equal(Object.hasOwn(sent, "params"), false, "omitted params stay off the frame");

  const withParams = client.request("mcpServer/list", { sessionId: "s-1" });
  await waitForWrites(transport, 2);
  answer(transport, 1, { servers: [] });
  assert.deepEqual(await withParams, { servers: [] });
  assert.deepEqual(sentParams(transport, 1), { sessionId: "s-1" }, "a request carries no commandId");
  assert.deepEqual(minted, [], "a request mints nothing");
});

test("FR-97527-5 (#99842): the experimental host stop is sent raw, like any experimental method", async () => {
  // The public build may name no experimental-only method (FR-97527-5's leak
  // gate), a refusal list included, so `host/shutdown` is not facade-owned
  // here: a caller that sends it raw owns the host exit that follows, and
  // `close()` is the orderly stop. The Python twin, which ships under no such
  // gate, keeps refusing it.
  const { client, transport, minted } = mintedClient();

  const pending = client.request("host/shutdown", { park: false });
  await waitForWrites(transport, 1);
  answer(transport, 0, { accepted: true });

  assert.deepEqual(await pending, { accepted: true });
  assert.equal(sentFrame(transport, 0)["method"], "host/shutdown");
  assert.deepEqual(sentParams(transport, 0), { park: false });
  assert.deepEqual(minted, [], "a request mints nothing");

  const command = client.command("host/shutdown", {});
  await waitForWrites(transport, 2);
  answer(transport, 1, { commandId: minted[0], status: "accepted" });
  assert.deepEqual(await command, { commandId: minted[0], status: "accepted" });
  assert.equal(sentFrame(transport, 1)["method"], "host/shutdown");
});

test("FR-79107-2: request surfaces the host's error unchanged, without retrying", async () => {
  const { client, transport } = mintedClient();

  const pending = client.request("account/read");
  await waitForWrites(transport, 1);
  answerError(transport, 0, { code: -32001, message: "busy", data: { kind: "overloaded", retryable: true } });

  await assert.rejects(pending, (error: unknown) => error instanceof MspError && error.kind === "overloaded");
  await settleMicrotasks();
  assert.equal(transport.writes.length, 1, "Connection.request does not retry");
});

test("FR-79107-2: every facade-owned method is refused by request, typed, before anything is written", async () => {
  const { client, transport } = mintedClient();
  for (const method of FACADE_OWNED) {
    const outcome = client.request(method as never).then(
      () => assert.fail(`${method} must be refused`),
      (caught: unknown) => caught,
    );
    await settleMicrotasks();
    assert.equal(transport.writes.length, 0, `${method} must never reach the wire`);
    const error = await outcome;
    assert.ok(error instanceof MuseFacadeOwnedMethodError, `${method}: got ${String(error)}`);
    assert.equal(error.method, method);
  }

  // The refusal is per call: the same client still sends an unwrapped query.
  const pending = client.request("permissionProfile/list");
  await waitForWrites(transport, 1);
  answer(transport, 0, { profiles: [] });
  await pending;
});

test("FR-79107-2: a closed client refuses request before anything is written", async () => {
  const { client, transport } = mintedClient();
  await client.close();

  await assert.rejects(client.request("permissionProfile/list"), ProtocolError);
  assert.equal(transport.writes.length, 0);
});
