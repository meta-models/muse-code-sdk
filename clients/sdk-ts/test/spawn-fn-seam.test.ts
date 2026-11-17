/**
 * The `spawnFn` seam reaches the spawn call from BOTH public launchers:
 * `spawnMspConnection` and `MuseClient.spawn` forward it to
 * `MuseServeChild.spawn`, so an embedder can run its handshake and sessions
 * against an in-memory fake host instead of a real process. A dropped
 * forward launches the real `child_process.spawn` on a binary that does not
 * exist, and the handshake fails with ENOENT instead of answering.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MuseClient, spawnMspConnection } from "../src/index.js";
import { countingSignal } from "./helpers/abort-signal.js";
import { settleMicrotasks } from "./helpers/fake-duplex.js";
import { inMemoryHostSpawn } from "./helpers/in-memory-host.js";

const MISSING_BIN = "/nonexistent/muse-spawn-fn-seam";

test("spawnMspConnection launches its host through a provided spawnFn", async () => {
  const host = inMemoryHostSpawn();
  const handshake = spawnMspConnection({
    command: MISSING_BIN,
    args: ["serve", "--stdio"],
    spawnFn: host.spawnFn,
  });
  const spawned = await handshake.initialize({
    clientInfo: { name: "sdk_test", version: "0.0.0" },
  });
  assert.equal(spawned.initializeResult.serverInfo.name, "in-memory");
  assert.deepEqual(host.calls, [{ cmd: MISSING_BIN, args: ["serve", "--stdio"] }]);
  assert.deepEqual(await spawned.close(), { code: 0, signal: null });
  assert.deepEqual(host.methods, ["initialize", "initialized"]);
});

test("MuseClient.spawn launches its host through a provided spawnFn", async () => {
  const host = inMemoryHostSpawn();
  const client = await MuseClient.spawn({
    museBin: MISSING_BIN,
    args: ["serve", "--stdio"],
    clientInfo: { name: "sdk_test", version: "0.0.0" },
    spawnFn: host.spawnFn,
  });
  try {
    assert.equal(client.initializeResult.serverInfo.name, "in-memory");
    assert.deepEqual(client.durability, { kind: "ephemeral" });
    const session = await client.startSession({ workspaceRoot: "/w" });
    assert.equal(session.sessionId, "s-1");
  } finally {
    await client.close();
  }
  assert.deepEqual(host.calls, [{ cmd: MISSING_BIN, args: ["serve", "--stdio"] }]);
  assert.deepEqual(await client.exit, { kind: "cleanShutdown" });
  assert.deepEqual(host.methods, ["initialize", "initialized", "session/start"]);
});

test("an orderly close of a spawned client ends its sessions' event streams and their abort listeners", async () => {
  // The child branch of MuseClient.close(): the path every MuseClient.spawn app takes.
  const host = inMemoryHostSpawn();
  const client = await MuseClient.spawn({
    museBin: MISSING_BIN,
    args: ["serve", "--stdio"],
    clientInfo: { name: "sdk_test", version: "0.0.0" },
    spawnFn: host.spawnFn,
  });
  const session = await client.startSession({ workspaceRoot: "/w" });
  const signalled = countingSignal();
  const events = session.events({ signal: signalled.signal });
  assert.equal(signalled.listeners(), 1);
  await client.close();
  assert.deepEqual(await client.exit, { kind: "cleanShutdown" });
  assert.equal(signalled.listeners(), 0, "close() removes the stream's abort listener");
  // Bounded: a stream close() failed to end fails the arm instead of hanging the file.
  const ended = async (next: Promise<IteratorResult<unknown>>): Promise<unknown> => {
    let seen: unknown = "pending";
    void next.then((result) => (seen = result));
    await settleMicrotasks();
    return seen;
  };
  assert.deepEqual(await ended(events.next()), { done: true, value: undefined }, "the live stream ends");
  assert.deepEqual(await ended(session.events().next()), { done: true, value: undefined }, "a later stream ends at once");
});
