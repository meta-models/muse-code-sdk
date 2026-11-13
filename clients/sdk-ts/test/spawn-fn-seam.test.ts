/**
 * The `spawnFn` seam reaches the spawn call from BOTH public launchers:
 * `spawnMspConnection` and `MuseClient.spawn` forward it to
 * `MuseServeChild.spawn`, so an embedder can run its handshake and sessions
 * against an in-memory fake host instead of a real process. A dropped
 * forward launches the real `child_process.spawn` on a binary that does not
 * exist, and the handshake fails with ENOENT instead of answering.
 */

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { EXPECTED_SCHEMA_FINGERPRINT, MuseClient, spawnMspConnection } from "../src/index.js";

const MISSING_BIN = "/nonexistent/muse-spawn-fn-seam";

/**
 * A `spawnFn` whose children are in-memory MSP hosts: each answers
 * `initialize` and `session/start` on stdout, and exits 0 once its stdin
 * ends, as an orderly host does at SS2.1.2 EOF.
 */
function inMemoryHostSpawn(): {
  readonly spawnFn: typeof spawn;
  readonly calls: Array<{ readonly cmd: string; readonly args: readonly string[] }>;
  readonly methods: string[];
} {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const methods: string[] = [];
  const spawnFn = (cmd: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
    calls.push({ cmd, args: [...args] });
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const send = (value: Record<string, unknown>): void => {
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
    };
    const respond = (frame: { id?: unknown; method?: string }): void => {
      if (frame.method !== undefined) methods.push(frame.method);
      if (frame.method === "initialize") {
        send({
          id: frame.id,
          result: {
            experimentalApi: false,
            grantedCapabilities: [],
            museHome: "/nonexistent",
            platformFamily: "unix",
            platformOs: "linux",
            schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT, version: 1 },
            serverInfo: { name: "in-memory", version: "0.0.0" },
            sessionDurability: "ephemeral",
            userAgent: "in-memory-host/0.0.0",
          },
        });
      } else if (frame.method === "session/start") {
        send({
          id: frame.id,
          result: { session: { sessionId: "s-1", status: "idle" }, viewCursor: "c-0" },
        });
      }
    };
    let buffered = "";
    const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit("close", code, signal));
    };
    child["stdout"] = stdout;
    child["stderr"] = stderr;
    child["stdin"] = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        buffered += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          respond(JSON.parse(buffered.slice(0, newline)) as { id?: unknown; method?: string });
          buffered = buffered.slice(newline + 1);
        }
        callback();
      },
      final(callback) {
        callback();
        exit(0, null);
      },
    });
    child["kill"] = (signal: NodeJS.Signals = "SIGTERM") => {
      exit(null, signal);
      return true;
    };
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnFn: spawnFn as unknown as typeof spawn, calls, methods };
}

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
