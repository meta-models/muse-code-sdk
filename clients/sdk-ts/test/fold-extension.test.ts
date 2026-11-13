/**
 * TEST-97527-3 (FR-97527-3, INV-97527-2) — the one fold extension hook.
 *
 * A neutral, method-name-keyed registration consulted for BOTH
 * connection-level state and the per-session fold. Extensions run inside the
 * single apply path (registration order) — never a second pump — so gap
 * buffering, twin-claiming and resume behave exactly as today. The hook
 * names no experimental feature: unknown methods the extension handles
 * report the generic `extension` outcome; everything else is untouched.
 */

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import {
  Connection,
  EXPECTED_SCHEMA_FINGERPRINT,
  MuseClient,
  Session,
  SessionFold,
} from "../src/index.js";
import type { FoldExtension } from "../src/index.js";
import { answer, FakeDuplex, sentFrame, settleMicrotasks, waitForWrites } from "./helpers/fake-duplex.js";

const SESSION = "s-1";
const ARM_TIMEOUT = 10_000;

/** Provenance the view plane requires on every paged (durable-sourced) event. */
const SOURCE_RANGE = {
  first: { recordId: "r-1", seq: 1 },
  last: { recordId: "r-1", seq: 1 },
  stream: { id: "run-1", kind: "run" },
};

/** A recording extension: every firing appends the params it saw. */
function recording(method: string): FoldExtension & { readonly seen: unknown[] } {
  const seen: unknown[] = [];
  return {
    apply(params: unknown): void {
      seen.push(params);
    },
    method,
    seen,
  };
}

/**
 * Poll a condition over immediate turns; fails loudly instead of hanging.
 * Immediate (not microtask) turns: the pump reads PassThrough bytes, which
 * settle on the immediate queue, the same reason the error-arm suites use
 * this shape.
 */
async function waitFor(narrative: string, ready: () => boolean): Promise<void> {
  for (let turn = 0; turn < 1000 && !ready(); turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(ready(), narrative);
}

test("SessionFold fires a registered extension for an unknown method", () => {
  const ext = recording("x/test");
  const fold = new SessionFold([ext]);
  const outcome = fold.apply({
    method: "x/test",
    params: { sessionId: SESSION, viewCursor: "v:1", x: 1 },
  });
  assert.deepEqual(outcome, { kind: "extension", method: "x/test" });
  assert.deepEqual(ext.seen, [{ sessionId: SESSION, viewCursor: "v:1", x: 1 }]);
});

test("SessionFold observes known methods without changing the stable outcome", () => {
  const ext = recording("turn/started");
  const fold = new SessionFold([ext]);
  const outcome = fold.apply({
    method: "turn/started",
    params: { commandId: "c-1", sessionId: SESSION, turnId: "t-1", viewCursor: "v:1" },
  });
  assert.equal(ext.seen.length, 1);
  assert.deepEqual(outcome, { kind: "turn", state: "running", turnId: "t-1" });
  assert.ok(fold.turn("t-1") !== undefined, "the stable arm still folds");
});

test("SessionFold fires same-method extensions in registration order", () => {
  const order: string[] = [];
  const first: FoldExtension = {
    apply(): void {
      order.push("first");
    },
    method: "x/test",
  };
  const second: FoldExtension = {
    apply(): void {
      order.push("second");
    },
    method: "x/test",
  };
  const fold = new SessionFold([first, second]);
  fold.apply({ method: "x/test", params: { sessionId: SESSION, viewCursor: "v:1" } });
  assert.deepEqual(order, ["first", "second"]);
});

test("SessionFold still folds a known method after a throwing observer", () => {
  const errors: unknown[] = [];
  let fired = 0;
  const bad: FoldExtension = {
    apply(): void {
      fired += 1;
      throw new Error("bad add-on");
    },
    method: "turn/started",
    onError(error: unknown): void {
      errors.push(error);
    },
  };
  const sibling = recording("turn/started");
  const fold = new SessionFold([bad, sibling]);
  const outcome = fold.apply({
    method: "turn/started",
    params: { commandId: "c-1", sessionId: SESSION, turnId: "t-1", viewCursor: "v:1" },
  });
  assert.deepEqual(outcome, { kind: "turn", state: "running", turnId: "t-1" });
  assert.ok(fold.turn("t-1") !== undefined, "the stable arm still folds");
  assert.equal(sibling.seen.length, 1, "the sibling still fires");
  assert.equal(errors.length, 1, "the throw is reported");
  assert.equal(fired, 1, "the observer fired exactly once");
});

test("SessionFold swallows a throwing onError and the pump survives", () => {
  let fired = 0;
  const bad: FoldExtension = {
    apply(): void {
      fired += 1;
      throw new Error("bad add-on");
    },
    method: "x/test",
    onError(): void {
      throw new Error("bad reporter");
    },
  };
  const fold = new SessionFold([bad]);
  const outcome = fold.apply({ method: "x/test", params: { sessionId: SESSION, viewCursor: "v:1" } });
  assert.deepEqual(outcome, { kind: "extension", method: "x/test" });
  const next = fold.apply({ method: "x/test", params: { sessionId: SESSION, viewCursor: "v:2" } });
  assert.deepEqual(next, { kind: "extension", method: "x/test" });
  assert.equal(fired, 2, "each frame fired the extension exactly once");
});

test("SessionFold still ignores unregistered unknown methods", () => {
  const ext = recording("x/other");
  const fold = new SessionFold([ext]);
  const outcome = fold.apply({ method: "x/test", params: { sessionId: SESSION, viewCursor: "v:1" } });
  assert.deepEqual(outcome, { kind: "ignoredUnrecognizedMethod", method: "x/test" });
  assert.deepEqual(ext.seen, []);
});

test("SessionFold reports a throwing extension and the pump survives", () => {
  const errors: unknown[] = [];
  let fired = 0;
  const bad: FoldExtension = {
    apply(): void {
      fired += 1;
      throw new Error("bad add-on");
    },
    method: "x/test",
    onError(error: unknown): void {
      errors.push(error);
    },
  };
  const fold = new SessionFold([bad]);
  const outcome = fold.apply({ method: "x/test", params: { sessionId: SESSION, viewCursor: "v:1" } });
  assert.deepEqual(outcome, { kind: "extension", method: "x/test" });
  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof Error);
  // The pump survives: the next frame folds normally.
  const next = fold.apply({ method: "x/test", params: { sessionId: SESSION, viewCursor: "v:2" } });
  assert.deepEqual(next, { kind: "extension", method: "x/test" });
  assert.equal(errors.length, 2);
  assert.equal(fired, 2, "each frame fired the extension exactly once");
});

test("SessionFold swallows a throwing extension without an onError", () => {
  let fired = 0;
  const bad: FoldExtension = {
    apply(): void {
      fired += 1;
      throw new Error("bad add-on");
    },
    method: "x/test",
  };
  const fold = new SessionFold([bad]);
  const outcome = fold.apply({ method: "x/test", params: { sessionId: SESSION, viewCursor: "v:1" } });
  assert.deepEqual(outcome, { kind: "extension", method: "x/test" });
  assert.equal(fired, 1, "the extension fired exactly once before its throw was swallowed");
});

test("SessionFold never fires extensions for params-less frames", () => {
  const ext = recording("x/test");
  const fold = new SessionFold([ext]);
  const outcome = fold.apply({ method: "x/test" });
  assert.deepEqual(outcome, { kind: "ignoredMissingParams", method: "x/test" });
  assert.deepEqual(ext.seen, []);
});

test("Session forwards options extensions through apply", () => {
  const ext = recording("x/test");
  const session = new Session<string>({
    durability: { kind: "durable" },
    extensions: [ext],
    sessionId: SESSION,
  });
  const outcome = session.apply({ method: "x/test", params: { sessionId: SESSION, viewCursor: "v:1" } });
  assert.deepEqual(outcome.fold, { kind: "extension", method: "x/test" });
  assert.equal(ext.seen.length, 1);
});

test(
  "an extension frame during a fill buffers, then fires once after the fill",
  { timeout: ARM_TIMEOUT },
  async () => {
    const ext = recording("x/test");
    const transport = new FakeDuplex();
    const connection = new Connection(transport, { mintCommandId: () => "mint-0" });
    const session = new Session<string>({
      connection,
      durability: { kind: "durable" },
      extensions: [ext],
      sessionId: SESSION,
    });
    const gap = session.apply({
      method: "view/gap",
      params: { after: "v:1", next: "v:5", sessionId: SESSION },
    });
    assert.deepEqual(gap.fold, { after: "v:1", kind: "deliveryGap", next: "v:5" });

    const live = session.apply({
      method: "x/test",
      params: { sessionId: SESSION, viewCursor: "v:5", x: 1 },
    });
    assert.deepEqual(live.fold, { kind: "bufferedDuringGap", method: "x/test" });
    await settleMicrotasks();
    assert.deepEqual(ext.seen, [], "buffered, not folded ahead of the fill");

    // The page serves the buffered frame's own twin (an empty page would
    // stall the walk): the extension fires once, from the page, and the
    // buffered twin is refused as overlap at the drain.
    await waitForWrites(transport, 1);
    assert.equal(sentFrame(transport, 0)["method"], "view/page");
    answer(transport, 0, {
      events: [{ method: "x/test", params: { sessionId: SESSION, sourceRange: SOURCE_RANGE, viewCursor: "v:5", x: 2 } }],
      nextCursor: "v:5",
    });
    assert.deepEqual(await gap.io, []);
    assert.deepEqual(ext.seen, [{ sessionId: SESSION, sourceRange: SOURCE_RANGE, viewCursor: "v:5", x: 2 }]);
    assert.equal(session.fold.current, true);
  },
);

const MISSING_BIN = "/nonexistent/muse-fold-extension";

/**
 * An in-memory host answering `initialize` and `session/start`, exposing
 * its stdout so the test can push server notifications into the client's
 * pump like a live host would.
 */
function notifyingHostSpawn(): {
  readonly spawnFn: typeof spawn;
  readonly stdout: () => PassThrough;
} {
  let stdout: PassThrough | undefined;
  const spawnFn = (cmd: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const out = new PassThrough();
    stdout = out;
    const stderr = new PassThrough();
    const send = (value: Record<string, unknown>): void => {
      out.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
    };
    const respond = (frame: { id?: unknown; method?: string }): void => {
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
      }
      if (frame.method === "session/start") {
        send({ id: frame.id, result: { session: { sessionId: SESSION } } });
      }
    };
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        for (const line of chunk
          .toString("utf-8")
          .split("\n")
          .filter((candidate) => candidate.length > 0)) {
          respond(JSON.parse(line) as { id?: unknown; method?: string });
        }
        callback();
      },
      final(callback): void {
        callback();
        out.end();
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
      },
    });
    child["stdout"] = out;
    child["stderr"] = stderr;
    child["stdin"] = stdin;
    child["kill"] = () => {
      out.end();
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      });
      return true;
    };
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return {
    spawnFn: spawnFn as unknown as typeof spawn,
    stdout: () => {
      assert.ok(stdout !== undefined, "expected the host to have spawned");
      return stdout;
    },
  };
}

test(
  "MuseClient reports a throwing connection extension and the pump survives",
  { timeout: ARM_TIMEOUT },
  async () => {
    const errors: unknown[] = [];
    const bad: FoldExtension = {
      apply(): void {
        throw new Error("bad add-on");
      },
      method: "x/host",
      onError(error: unknown): void {
        errors.push(error);
      },
    };
    const sessionExt = recording("x/session");
    const host = notifyingHostSpawn();
    const client = await MuseClient.spawn({
      clientInfo: { name: "sdk_test", version: "0.0.0" },
      extensions: [bad, sessionExt],
      museBin: MISSING_BIN,
      spawnFn: host.spawnFn,
    });
    try {
      await client.startSession({ workspaceRoot: "/w" });
      const out = host.stdout();
      out.write(`${JSON.stringify({ jsonrpc: "2.0", method: "x/host", params: { flag: true } })}\n`);
      await waitFor("the throw is reported", () => errors.length === 1);
      assert.ok(errors[0] instanceof Error);
      out.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "x/session", params: { sessionId: SESSION, flag: true } })}\n`,
      );
      await waitFor("the pump survived the throw", () => sessionExt.seen.length === 1);
    } finally {
      await client.close();
    }
  },
);

test(
  "MuseClient drops params-less session-less frames without firing",
  { timeout: ARM_TIMEOUT },
  async () => {
    const hostExt = recording("x/host");
    const host = notifyingHostSpawn();
    const client = await MuseClient.spawn({
      clientInfo: { name: "sdk_test", version: "0.0.0" },
      extensions: [hostExt],
      museBin: MISSING_BIN,
      spawnFn: host.spawnFn,
    });
    try {
      await client.startSession({ workspaceRoot: "/w" });
      const out = host.stdout();
      out.write(`${JSON.stringify({ jsonrpc: "2.0", method: "x/host" })}\n`);
      out.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "x/host", params: { flag: true } })}\n`,
      );
      await waitFor("the good frame fires", () => hostExt.seen.length === 1);
      assert.deepEqual(hostExt.seen, [{ flag: true }]);
    } finally {
      await client.close();
    }
  },
);

test(
  "MuseClient swallows a throwing connection onError and the pump survives",
  { timeout: ARM_TIMEOUT },
  async () => {
    const bad: FoldExtension = {
      apply(): void {
        throw new Error("bad add-on");
      },
      method: "x/host",
      onError(): void {
        throw new Error("bad reporter");
      },
    };
    const sessionExt = recording("x/session");
    const host = notifyingHostSpawn();
    const client = await MuseClient.spawn({
      clientInfo: { name: "sdk_test", version: "0.0.0" },
      extensions: [bad, sessionExt],
      museBin: MISSING_BIN,
      spawnFn: host.spawnFn,
    });
    try {
      await client.startSession({ workspaceRoot: "/w" });
      const out = host.stdout();
      out.write(`${JSON.stringify({ jsonrpc: "2.0", method: "x/host", params: { flag: true } })}\n`);
      out.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "x/session", params: { sessionId: SESSION, flag: true } })}\n`,
      );
      await waitFor("the pump survived both throws", () => sessionExt.seen.length === 1);
    } finally {
      await client.close();
    }
  },
);

test(
  "MuseClient routes session-less frames to connection extensions and session frames to the session",
  { timeout: ARM_TIMEOUT },
  async () => {
    const hostExt = recording("x/host");
    const sessionExt = recording("x/session");
    const host = notifyingHostSpawn();
    const client = await MuseClient.spawn({
      clientInfo: { name: "sdk_test", version: "0.0.0" },
      extensions: [hostExt, sessionExt],
      museBin: MISSING_BIN,
      spawnFn: host.spawnFn,
    });
    try {
      await client.startSession({ workspaceRoot: "/w" });
      const out = host.stdout();
      // Unmatched and session-less: dropped silently, like any frame no
      // extension and no session owns. Delivered first, so the assertions
      // below prove the pump survived it.
      out.write(`${JSON.stringify({ jsonrpc: "2.0", method: "x/nothing", params: { flag: true } })}\n`);
      out.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "x/host", params: { flag: true } })}\n`,
      );
      out.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "x/session", params: { sessionId: SESSION, flag: true } })}\n`,
      );
      await waitFor("the session-less frame reaches the connection extension", () => hostExt.seen.length === 1);
      await waitFor("the session frame reaches the forwarded session extension", () => sessionExt.seen.length === 1);
      assert.deepEqual(hostExt.seen, [{ flag: true }]);
      assert.deepEqual(sessionExt.seen, [{ flag: true, sessionId: SESSION }]);
    } finally {
      await client.close();
    }
  },
);
