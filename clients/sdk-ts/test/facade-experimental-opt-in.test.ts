/**
 * TEST-97527-1 (FR-97527-1) — the `experimentalApi` opt-in reaches the wire.
 *
 * A pin test, not a behavior change: both public launchers already forward
 * `capabilities` verbatim into `initialize`. These arms pin that contract so
 * the #97527 add-on can rely on it: with the opt-in set, the initialize
 * frame carries it; omitted, the frame carries no opt-in. The pin's strength
 * is proved by mutation (dropping spawn's forward fails the first arm).
 */

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { EXPECTED_SCHEMA_FINGERPRINT, MuseClient, spawnMspConnection } from "../src/index.js";

const MISSING_BIN = "/nonexistent/muse-experimental-opt-in";

/**
 * A `spawnFn` whose children answer `initialize` and record its params, and
 * exit 0 once stdin ends, as an orderly host does at SS2.1.2 EOF.
 */
function capturingHostSpawn(): {
  readonly spawnFn: typeof spawn;
  readonly initializes: Array<Record<string, unknown>>;
} {
  const initializes: Array<Record<string, unknown>> = [];
  const spawnFn = (cmd: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const send = (value: Record<string, unknown>): void => {
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
    };
    const respond = (frame: { id?: unknown; method?: string; params?: Record<string, unknown> }): void => {
      if (frame.method === "initialize") {
        initializes.push(frame.params ?? {});
        const capabilities = frame.params?.["capabilities"] as { experimentalApi?: unknown } | undefined;
        send({
          id: frame.id,
          result: {
            experimentalApi: capabilities?.experimentalApi ?? false,
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
      }
    };
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        for (const line of chunk
          .toString("utf-8")
          .split("\n")
          .filter((candidate) => candidate.length > 0)) {
          respond(JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> });
        }
        callback();
      },
      final(callback): void {
        callback();
        stdout.end();
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
      },
    });
    child["stdout"] = stdout;
    child["stderr"] = stderr;
    child["stdin"] = stdin;
    child["kill"] = () => {
      stdout.end();
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      });
      return true;
    };
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnFn: spawnFn as unknown as typeof spawn, initializes };
}

test("MuseClient.spawn forwards experimentalApi to initialize", async () => {
  const host = capturingHostSpawn();
  const client = await MuseClient.spawn({
    capabilities: { experimentalApi: true },
    clientInfo: { name: "sdk_test", version: "0.0.0" },
    museBin: MISSING_BIN,
    spawnFn: host.spawnFn,
  });
  try {
    assert.equal(host.initializes.length, 1);
    const capabilities = host.initializes[0]?.["capabilities"] as
      | { experimentalApi?: unknown; requestedCapabilities?: unknown }
      | undefined;
    assert.equal(capabilities?.experimentalApi, true);
    assert.deepEqual(capabilities?.requestedCapabilities, ["sessionMcp"]);
    assert.equal(client.initializeResult.experimentalApi, true);
  } finally {
    await client.close();
  }
});

test("spawnMspConnection.initialize forwards experimentalApi", async () => {
  const host = capturingHostSpawn();
  const handshake = spawnMspConnection({ args: ["serve", "--stdio"], command: MISSING_BIN, spawnFn: host.spawnFn });
  const spawned = await handshake.initialize({
    capabilities: { experimentalApi: true },
    clientInfo: { name: "sdk_test", version: "0.0.0" },
  });
  assert.equal(host.initializes.length, 1);
  const capabilities = host.initializes[0]?.["capabilities"] as { experimentalApi?: unknown } | undefined;
  assert.equal(capabilities?.experimentalApi, true);
  assert.deepEqual(await spawned.close(), { code: 0, signal: null });
});

test("omitted capabilities send no opt-in", async () => {
  const host = capturingHostSpawn();
  const client = await MuseClient.spawn({
    clientInfo: { name: "sdk_test", version: "0.0.0" },
    museBin: MISSING_BIN,
    spawnFn: host.spawnFn,
  });
  try {
    assert.equal(host.initializes.length, 1);
    const capabilities = host.initializes[0]?.["capabilities"] as { experimentalApi?: unknown } | undefined;
    assert.ok(capabilities?.experimentalApi === undefined || capabilities?.experimentalApi === false);
  } finally {
    await client.close();
  }
});
