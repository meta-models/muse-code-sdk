/**
 * A call rejected because a spawned host died carries how it ended. The error
 * is unchanged (usually `ProtocolError`; the transport's own error when a write
 * failed); the exit classification rides `cause` as a `MuseHostDiedError`. The
 * wait for the exit is bounded: a host that closes stdout but stays alive gets
 * today's bare error. A clean exit, a bare-`Connection` client and a call after
 * the caller's own `close()` keep the bare error too.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { peerEndCause } from "../src/connection/connection.js";
import { Connection, EXPECTED_SCHEMA_FINGERPRINT, MuseClient, MuseHostDiedError, ProtocolError } from "../src/index.js";
import { AsyncChunks, FakeDuplex, settleMicrotasks, waitForWrites } from "./helpers/fake-duplex.js";

const ARM_TIMEOUT = 20_000;
const STDERR_MARKER = "host-exit-cause: dying";

/**
 * Answers `initialize`; on `task/stop` ends without answering, so that call
 * is pending: `exit3` writes a stderr line and exits 3, `exit0` exits 0, and
 * `closeStdout` closes stdout and keeps running until stdin closes. When stdin
 * closes the host exits `stdinCloseExit`.
 */
function hostSource(onStop: "exit3" | "exit0" | "closeStdout", stdinCloseExit: 0 | 3): string {
  const stop = {
    exit3: `process.stderr.write(${JSON.stringify(STDERR_MARKER + "\n")}, () => process.exit(3))`,
    exit0: "process.exit(0)",
    closeStdout: 'require("node:fs").closeSync(1); setInterval(() => {}, 1000)',
  }[onStop];
  return [
    'const {createInterface} = require("node:readline")',
    'const send = (f) => process.stdout.write(JSON.stringify(f) + "\\n")',
    'const rl = createInterface({input: process.stdin})',
    'rl.on("line", (line) => {',
    "  const frame = JSON.parse(line)",
    '  if (frame.method === "initialize") {',
    "    send({jsonrpc: '2.0', id: frame.id, result: {",
    "      experimentalApi: false, grantedCapabilities: [], museHome: '/nonexistent',",
    "      platformFamily: 'unix', platformOs: 'linux',",
    `      schema: {fingerprint: ${JSON.stringify(EXPECTED_SCHEMA_FINGERPRINT)}, version: 1},`,
    "      serverInfo: {name: 'inline', version: '0.0.0'}, sessionDurability: 'durable',",
    "      userAgent: 'inline-host/0.0.0'}})",
    "    return",
    "  }",
    '  if (frame.method === "task/stop") {',
    `    ${stop}`,
    "  }",
    "})",
    `rl.on("close", () => process.exit(${stdinCloseExit}))`,
  ].join("\n");
}

function spawnHost(
  onStop: "exit3" | "exit0" | "closeStdout" = "exit3",
  stdinCloseExit: 0 | 3 = 0,
): Promise<MuseClient> {
  return MuseClient.spawn({
    museBin: process.execPath,
    args: ["-e", hostSource(onStop, stdinCloseExit)],
    clientInfo: { name: "sdk_test", version: "0.0.0" },
  });
}

async function rejection(call: Promise<unknown>): Promise<unknown> {
  return call.then(
    () => assert.fail("the call must reject"),
    (error: unknown) => error,
  );
}

function assertExit3(error: unknown, message: string): void {
  assert.ok(error instanceof ProtocolError, `expected ProtocolError, got ${String(error)}`);
  assert.equal(error.message, message, "only the cause is new: the message stays as before");
  const cause = error.cause;
  assert.ok(cause instanceof MuseHostDiedError, `expected a MuseHostDiedError cause, got ${String(cause)}`);
  assert.equal(cause.exit.kind, "configError");
  assert.equal(cause.exit.exitCode, 3);
  assert.ok(
    cause.exit.stderrTail.some((line) => line.includes(STDERR_MARKER)),
    `stderr tail: ${JSON.stringify(cause.exit.stderrTail)}`,
  );
}

test("a pending call rejects with today's error class and the host's exit as its cause", { timeout: ARM_TIMEOUT }, async () => {
  const client = await spawnHost();
  const error = await rejection(client.command("task/stop", { sessionId: "s-1", taskId: "t-1" }));
  assertExit3(error, "connection reached EOF");
});

test("a call made after the host died rejects the same way, even after close()", { timeout: ARM_TIMEOUT }, async () => {
  const client = await spawnHost();
  await rejection(client.command("task/stop", { sessionId: "s-1", taskId: "t-1" }));
  await client.exit;
  // The cause is read once, at the end of the stream: a close() after the
  // death keeps it.
  await client.close();

  assertExit3(await rejection(client.command("task/stop", { sessionId: "s-1", taskId: "t-2" })), "connection is closed");
  assertExit3(await rejection(client.listSessions()), "connection is closed");
});

test("a call after the caller's own close() keeps today's error, with no cause", { timeout: ARM_TIMEOUT }, async () => {
  // The host exits 3 on stdin EOF: an abnormal exit, so only the close() guard
  // keeps the cause off.
  const client = await spawnHost("exit3", 3);
  await client.close();
  assert.equal((await client.exit).kind, "configError");

  const error = await rejection(client.command("task/stop", { sessionId: "s-1", taskId: "t-1" }));
  assert.ok(error instanceof ProtocolError, `expected ProtocolError, got ${String(error)}`);
  assert.equal(error.message, "connection is closed");
  assert.equal(error.cause, undefined);
});

test("a host that closes stdout but stays alive gets the bare error, without waiting for its exit", { timeout: ARM_TIMEOUT }, async () => {
  // Settles only after the real SIGTERM_GRACE_MS wait: that bound is the contract (FR-97948-1, ADR 97948 D1).
  const client = await spawnHost("closeStdout");
  let exited = false;
  void client.exit.then(() => {
    exited = true;
  });
  try {
    const error = await rejection(client.command("task/stop", { sessionId: "s-1", taskId: "t-1" }));
    assert.ok(error instanceof ProtocolError, `expected ProtocolError, got ${String(error)}`);
    assert.equal(error.cause, undefined);
    assert.equal(exited, false, "the call settled while the host was still running");
  } finally {
    await client.close();
  }
});

test("a host that exits 0 leaves the bare error", { timeout: ARM_TIMEOUT }, async () => {
  const client = await spawnHost("exit0");
  const error = await rejection(client.command("task/stop", { sessionId: "s-1", taskId: "t-1" }));
  assert.ok(error instanceof ProtocolError, `expected ProtocolError, got ${String(error)}`);
  assert.equal(error.cause, undefined);
});

test("a client built around a bare Connection keeps the bare error", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), { durability: { kind: "durable" } });
  const pending = rejection(client.command("task/stop", { sessionId: "s-1", taskId: "t-1" }));
  await waitForWrites(transport, 1);
  transport.chunks.end();

  const error = await pending;
  assert.ok(error instanceof ProtocolError, `expected ProtocolError, got ${String(error)}`);
  assert.equal(error.cause, undefined);
});

test("a write that fails as the host dies gets the end cause too", async () => {
  const writeError = new Error("write EPIPE");
  const connection = new Connection({
    incoming: new AsyncChunks(),
    write: async () => {
      throw writeError;
    },
  });
  const cause = new MuseHostDiedError({ kind: "transportEof" });
  let resolveCause!: (value: unknown) => void;
  connection[peerEndCause](() => new Promise((resolve) => (resolveCause = resolve)));
  let settled = false;
  const outcome = rejection(
    connection.request("task/list").finally(() => {
      settled = true;
    }),
  );

  await settleMicrotasks();
  assert.equal(settled, false, "the call waits for the end cause");
  resolveCause(cause);
  const error = await outcome;
  assert.equal(error, writeError, "the transport's own error, not a ProtocolError");
  assert.equal((error as Error).cause, cause);
});

test("a hook registered after the connection ended still gives later calls the cause", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  transport.chunks.end();
  await connection.closed;
  const cause = new MuseHostDiedError({ kind: "transportEof" });
  connection[peerEndCause](() => Promise.resolve(cause));

  const error = await rejection(connection.request("task/list"));
  assert.ok(error instanceof ProtocolError, `expected ProtocolError, got ${String(error)}`);
  assert.equal(error.message, "connection is closed");
  assert.equal(error.cause, cause);
});
