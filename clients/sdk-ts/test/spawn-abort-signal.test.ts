/**
 * TEST-97922-1 (#97922): `signal` on `MuseClient.spawn` and
 * `spawnMspConnection`. A caller can cancel or time out startup, which
 * otherwise gives no handle until the handshake completes — a host that hangs
 * before answering `initialize` could neither be stopped nor reclaimed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawn } from "node:child_process";

import { MuseClient, MuseHostStartError, ProtocolError, spawnMspConnection } from "../src/index.js";
import {
  announcedPidProbe,
  isAlive,
  NEVER_ANSWERS_AND_IGNORES_EOF,
  NEVER_ANSWERS_INITIALIZE,
  reap,
  settledWithin,
} from "./helpers/host-lifetime.js";
import { inMemoryHostSpawn } from "./helpers/in-memory-host.js";

const MISSING_BIN = "/nonexistent/muse-spawn-abort-signal";
const clientInfo = { name: "sdk_test", version: "0.0.0" };

function isAbortErrorWithCause(reason: unknown): (error: unknown) => boolean {
  return (error) => error instanceof Error && error.name === "AbortError" && error.cause === reason;
}

test("aborting while initialize is pending closes the host and rejects with AbortError", { timeout: 60_000 }, async (t) => {
  const { stderr, onStderr, pid: announcedPid } = announcedPidProbe();
  let announceReceived!: () => void;
  const received = new Promise<void>((resolve) => {
    announceReceived = resolve;
  });
  const controller = new AbortController();
  const spawning = MuseClient.spawn({
    museBin: process.execPath,
    args: ["-e", NEVER_ANSWERS_INITIALIZE],
    clientInfo,
    signal: controller.signal,
    onStderr: (chunk) => {
      onStderr(chunk);
      if (stderr.join("").includes("initialize_received")) announceReceived();
    },
  });
  const outcome = spawning.then(() => "resolved" as const, (error: unknown) => error);
  t.after(async () => reap(await announcedPid.catch(() => undefined)));
  const pid = await announcedPid;
  const seen = await settledWithin(received, 10_000);
  assert.ok(seen.settled, "failure-only cap: the host never received initialize");

  const reason = new Error("startup timed out");
  controller.abort(reason);
  const settled = await settledWithin(outcome, 10_000);
  assert.ok(settled.settled, "failure-only cap: aborting must settle spawn");
  assert.ok(isAbortErrorWithCause(reason)(settled.value), `expected AbortError, got ${String(settled.value)}`);
  assert.equal(isAlive(pid), false, "the aborted host is closed before spawn rejects");
});

test("a direct handshake rejects an abort only after its host has exited", { timeout: 60_000 }, async (t) => {
  // MuseClient.spawn closes on failure itself, so only a bare handshake shows
  // that initialize() waits for the exit before rejecting.
  const { stderr, onStderr, pid: announcedPid } = announcedPidProbe();
  let announceReceived!: () => void;
  const received = new Promise<void>((resolve) => {
    announceReceived = resolve;
  });
  const controller = new AbortController();
  const handshake = spawnMspConnection({
    command: process.execPath,
    args: ["-e", NEVER_ANSWERS_INITIALIZE],
    signal: controller.signal,
    onStderr: (chunk) => {
      onStderr(chunk);
      if (stderr.join("").includes("initialize_received")) announceReceived();
    },
  });
  let hostExited = false;
  void handshake.exited.then(() => {
    hostExited = true;
  }, () => undefined);
  t.after(async () => reap(await announcedPid.catch(() => undefined)));
  const initializing = handshake.initialize({ clientInfo }).then(
    () => "resolved" as const,
    (error: unknown) => ({ error, hostExitedFirst: hostExited }),
  );
  const seen = await settledWithin(received, 10_000);
  assert.ok(seen.settled, "failure-only cap: the host never received initialize");

  const reason = new Error("startup timed out");
  controller.abort(reason);
  const settled = await settledWithin(initializing, 10_000);
  assert.ok(settled.settled, "failure-only cap: aborting must settle initialize");
  assert.notEqual(settled.value, "resolved");
  if (settled.value === "resolved") return;
  assert.ok(isAbortErrorWithCause(reason)(settled.value.error), `expected AbortError, got ${String(settled.value.error)}`);
  assert.equal(settled.value.hostExitedFirst, true, "initialize() rejects only once the host has exited");
});

test("a refused second initialize keeps the first call's abort listener", { timeout: 60_000 }, async (t) => {
  const { stderr, onStderr, pid: announcedPid } = announcedPidProbe();
  let announceReceived!: () => void;
  const received = new Promise<void>((resolve) => {
    announceReceived = resolve;
  });
  const controller = new AbortController();
  const handshake = spawnMspConnection({
    command: process.execPath,
    args: ["-e", NEVER_ANSWERS_INITIALIZE],
    signal: controller.signal,
    onStderr: (chunk) => {
      onStderr(chunk);
      if (stderr.join("").includes("initialize_received")) announceReceived();
    },
  });
  t.after(async () => reap(await announcedPid.catch(() => undefined)));
  const first = handshake.initialize({ clientInfo }).then(() => "resolved" as const, (error: unknown) => error);
  await assert.rejects(handshake.initialize({ clientInfo }), ProtocolError);
  const seen = await settledWithin(received, 10_000);
  assert.ok(seen.settled, "failure-only cap: the host never received initialize");

  const reason = new Error("startup timed out");
  controller.abort(reason);
  const settled = await settledWithin(first, 10_000);
  assert.ok(settled.settled, "failure-only cap: the abort must still settle the first initialize");
  assert.ok(isAbortErrorWithCause(reason)(settled.value), `expected AbortError, got ${String(settled.value)}`);
  assert.equal(isAlive(await announcedPid), false, "the aborted host is closed");
});

test("aborting a stuck host that ignores stdin EOF still ends it and rejects", { timeout: 60_000 }, async (t) => {
  // The case this option exists for: EOF alone cannot stop this host, so the
  // abort has to ride the SIGTERM stage of the shutdown ladder.
  const { stderr, onStderr, pid: announcedPid } = announcedPidProbe();
  let announceReceived!: () => void;
  const received = new Promise<void>((resolve) => {
    announceReceived = resolve;
  });
  const controller = new AbortController();
  const spawning = MuseClient.spawn({
    museBin: process.execPath,
    args: ["-e", NEVER_ANSWERS_AND_IGNORES_EOF],
    clientInfo,
    shutdownTimeoutMs: 150,
    signal: controller.signal,
    onStderr: (chunk) => {
      onStderr(chunk);
      if (stderr.join("").includes("initialize_received")) announceReceived();
    },
  });
  const outcome = spawning.then(() => "resolved" as const, (error: unknown) => error);
  t.after(async () => reap(await announcedPid.catch(() => undefined)));
  const pid = await announcedPid;
  const seen = await settledWithin(received, 10_000);
  assert.ok(seen.settled, "failure-only cap: the host never received initialize");

  const reason = new Error("startup timed out");
  controller.abort(reason);
  const settled = await settledWithin(outcome, 20_000);
  assert.ok(settled.settled, "failure-only cap: aborting a stuck host must settle spawn");
  assert.ok(isAbortErrorWithCause(reason)(settled.value), `expected AbortError, got ${String(settled.value)}`);
  assert.equal(isAlive(pid), false, "the ladder's SIGTERM ended the stuck host before spawn rejected");
});

test("closing a handshake before initialize stops listening to the signal", async () => {
  const host = inMemoryHostSpawn();
  const controller = new AbortController();
  const handshake = spawnMspConnection({ command: MISSING_BIN, spawnFn: host.spawnFn, signal: controller.signal });
  await handshake.close();
  assert.equal(
    getEventListeners(controller.signal, "abort").length,
    0,
    "a later abort must not reach a handshake that was already closed",
  );
});

test("an already-aborted signal never spawns", async () => {
  const calls: unknown[] = [];
  const spawnFn = ((...args: unknown[]) => {
    calls.push(args);
    throw new Error("spawnFn must not be called");
  }) as unknown as typeof spawn;
  const reason = new Error("cancelled");

  await assert.rejects(
    MuseClient.spawn({ museBin: MISSING_BIN, clientInfo, spawnFn, signal: AbortSignal.abort(reason) }),
    isAbortErrorWithCause(reason),
  );
  assert.throws(
    () => spawnMspConnection({ command: MISSING_BIN, spawnFn, signal: AbortSignal.abort(reason) }),
    isAbortErrorWithCause(reason),
  );
  assert.deepEqual(calls, []);
});

test("an already-aborted signal wins over host discovery", async (t) => {
  // A PATH with no `muse`: discovery would reject with MuseHostDiscoveryError.
  const emptyPath = await mkdtemp(join(tmpdir(), "muse-abort-no-host-"));
  const savedPath = process.env["PATH"];
  t.after(async () => {
    process.env["PATH"] = savedPath;
    await rm(emptyPath, { recursive: true, force: true });
  });
  process.env["PATH"] = emptyPath;
  const reason = new Error("cancelled");

  await assert.rejects(
    MuseClient.spawn({ clientInfo, signal: AbortSignal.abort(reason) }),
    isAbortErrorWithCause(reason),
  );
});

test("a live signal leaves a real spawn failure a MuseHostStartError", async () => {
  // Passing a signal that never aborts must not change how a lost host is reported.
  await assert.rejects(
    MuseClient.spawn({ museBin: MISSING_BIN, clientInfo, signal: new AbortController().signal }),
    MuseHostStartError,
  );
});

test("a handshake that fails on its own stops listening to the signal", async () => {
  // A binary that cannot start fails `initialize` with no abort involved.
  const controller = new AbortController();
  const handshake = spawnMspConnection({ command: MISSING_BIN, signal: controller.signal });
  await assert.rejects(handshake.initialize({ clientInfo }), (error) => error instanceof Error && error.name !== "AbortError");
  assert.equal(
    getEventListeners(controller.signal, "abort").length,
    0,
    "a later abort must not reach a handshake that already failed",
  );
});

test("an abort that lands after the host answered still rejects and closes it", async () => {
  // The answer is in, so only the post-handshake check can refuse the client.
  const controller = new AbortController();
  const reason = new Error("too slow");
  const host = inMemoryHostSpawn({
    onMethod: (method) => {
      if (method === "initialized") controller.abort(reason);
    },
  });

  await assert.rejects(
    MuseClient.spawn({ museBin: MISSING_BIN, clientInfo, spawnFn: host.spawnFn, signal: controller.signal }),
    isAbortErrorWithCause(reason),
  );
  assert.equal(host.stdinEnded(), true, "the host was closed before spawn rejected");
});

test("aborting after spawn resolved does nothing", async () => {
  const host = inMemoryHostSpawn();
  const controller = new AbortController();
  const client = await MuseClient.spawn({
    museBin: MISSING_BIN,
    clientInfo,
    spawnFn: host.spawnFn,
    signal: controller.signal,
  });
  controller.abort(new Error("too late"));

  const session = await client.startSession({ workspaceRoot: "/w" });
  assert.equal(session.sessionId, "s-1");
  assert.equal(host.stdinEnded(), false, "the late abort must not start the shutdown ladder");
  await client.close();
  // The in-memory host exits 0 only on stdin EOF; a kill would be a crash row.
  assert.deepEqual(await client.exit, { kind: "cleanShutdown" });
});
