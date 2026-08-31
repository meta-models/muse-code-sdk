/** TEST-009: the typed handshake/spawn path against #210's real canned host. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, MspError, spawnMspConnection } from "../src/index.js";
import type { MspHandshake, SpawnedMspConnection } from "../src/index.js";
// Internal seams, deliberately NOT on the package barrel (PR #15641 review):
// the predicate and the transport are error-classification internals a
// consumer must not bind to; the tests reach them module-directly.
import { ChildStdioTransport, isBenignCloseRace } from "../src/connection/spawn.js";
import {
  announcedPidProbe,
  ECHOES_TO_STDERR,
  IGNORES_EOF,
  isAlive,
  makeStubChild,
  NEVER_READS_STDIN,
  PID_MARKER,
  reap,
  reapThenClose,
  settledWithin,
  STDIN_WEDGED_MARKER,
  TRAPS_SIGTERM_NEVER_READS_STDIN,
  UNFLUSHABLE_WRITE,
} from "./helpers/host-lifetime.js";
import type { InitializeParams } from "@muse-code/msp";

const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const transcriptRoot = resolve(projectRoot, "schema/msp/transcripts");

function fixture(
  scenario: string,
  stderr: string[],
  requestIds: Array<string | number> = [1],
  shutdownTimeoutMs?: number,
) {
  return spawnMspConnection({
    command: "cargo",
    ...(shutdownTimeoutMs === undefined ? {} : { shutdownTimeoutMs }),
    args: [
      "run",
      "--quiet",
      "-p",
      "tbh-conformance",
      "--no-default-features",
      "--bin",
      "muse-conformance",
      "--",
      "serve-fixture",
      "--transcript",
      resolve(transcriptRoot, scenario),
    ],
    connection: {
      mintRequestId: () => {
        const id = requestIds.shift();
        assert.notEqual(id, undefined, `no deterministic request id left for ${scenario}`);
        return id as string | number;
      },
    },
    onStderr: (chunk) => stderr.push(chunk),
  });
}

function initializeParams(requestUserShell: boolean): InitializeParams {
  return {
    clientInfo: { name: "conformance", version: "0.0.0" },
    ...(requestUserShell
      ? { capabilities: { requestedCapabilities: ["userShell"] } }
      : {}),
  };
}

async function expectFixtureExitZero(
  exited: Promise<{ readonly code: number | null }>,
  stderr: readonly string[],
): Promise<void> {
  const status = await exited;
  assert.equal(status.code, 0, stderr.join(""));
  assert.match(stderr.join(""), /"kind":"serveFixtureComplete"/);
}

async function initializeFixture(
  scenario: string,
  handshake: MspHandshake,
  params: InitializeParams,
  stderr: readonly string[],
): Promise<SpawnedMspConnection> {
  try {
    return await handshake.initialize(params);
  } catch (error) {
    const exit = await handshake.exited;
    throw new Error(
      `${scenario} handshake failed (exit ${String(exit.code)}): ${stderr.join("")}`,
      { cause: error },
    );
  }
}

// timeout: the missing-frame stall class (client never sends `initialized`,
// serve-fixture blocks, `exited` never settles) is otherwise unbounded; the
// green path runs in well under a minute, so the bound costs nothing.
test("TEST-009: handshake and typed errors over serve-fixture", { timeout: 120_000 }, async () => {
  const grantedStderr: string[] = [];
  const grantedHandshake = fixture("handshake-usershell-granted", grantedStderr);
  assert.equal("request" in grantedHandshake, false, "pre-initialized sends are unrepresentable");
  const granted = await initializeFixture(
    "handshake-usershell-granted",
    grantedHandshake,
    initializeParams(true),
    grantedStderr,
  );
  assert.deepEqual(granted.initializeResult.grantedCapabilities, ["userShell"]);
  assert.equal(granted.initializeResult.sessionDurability, "durable");
  assert.equal(granted.fingerprintWarning?.kind, "schemaFingerprintMismatch");
  await assert.rejects(grantedHandshake.initialize(initializeParams(true)), /only once/);
  await expectFixtureExitZero(granted.exited, grantedStderr);

  const deniedStderr: string[] = [];
  const deniedHandshake = fixture("handshake-usershell-not-granted", deniedStderr);
  const denied = await initializeFixture(
    "handshake-usershell-not-granted",
    deniedHandshake,
    initializeParams(true),
    deniedStderr,
  );
  assert.deepEqual(denied.initializeResult.grantedCapabilities, []);
  await expectFixtureExitZero(denied.exited, deniedStderr);

  const errorStderr: string[] = [];
  const errorHandshake = fixture("usershell-without-grant", errorStderr, [1, "a1"]);
  const errorConnection = await initializeFixture(
    "usershell-without-grant",
    errorHandshake,
    initializeParams(false),
    errorStderr,
  );
  const request = errorConnection.connection.command(
    "session/userShell",
    {
      sessionId: "0198f0aa-1111-7000-8000-0000000000aa",
      commandText: "git status",
    },
    {
      commandId: "018f6a24-9999-7bbb-8ccc-00000000feed",
      maxAttempts: 1,
    },
  );
  await assert.rejects(request, (error: unknown) => {
    assert.ok(error instanceof MspError);
    assert.equal(error.kind, "capabilityRequired");
    assert.equal(error.retryable, false);
    assert.equal(error.data["capability"], "userShell");
    return true;
  });
  await expectFixtureExitZero(errorConnection.exited, errorStderr);
});

test("close tolerates exactly the three benign owned-teardown end() races, and only those", async () => {
  // The deterministic structural half (never a timing race in a test): the
  // predicate that decides which stdin.end() errors are benign owned-teardown
  // races close() resolves (the exit code still gates in the caller) — the
  // child-already-exited pair (ERR_STREAM_DESTROYED, EPIPE) and the
  // SIGTERM→SIGKILL backstop's cancelled wedged write (ECANCELED) — versus a
  // real failure.
  const destroyed = Object.assign(new Error("Cannot call end after a stream was destroyed"), {
    code: "ERR_STREAM_DESTROYED",
  });
  const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
  const ecanceled = Object.assign(new Error("write ECANCELED"), { code: "ECANCELED" });
  const real = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  assert.equal(isBenignCloseRace(destroyed), true);
  assert.equal(isBenignCloseRace(epipe), true);
  assert.equal(isBenignCloseRace(ecanceled), true);
  assert.equal(isBenignCloseRace(real), false);
  assert.equal(isBenignCloseRace(new Error("no code")), false);
  assert.equal(isBenignCloseRace(undefined), false);

  // The live half on a real child that exits on its own: close() after the
  // child is gone must resolve (the guard arm), and the exit stays readable.
  const handshake = spawnMspConnection({ command: "node", args: ["-e", "process.exit(0)"] });
  const exit = await handshake.exited;
  assert.equal(exit.code, 0);
  await assert.doesNotReject(handshake.close());
});

// The CALL-SITE pin (PR #15641 review): the live arm above awaits `exited`
// first, so close() exits through the destroyed/writableEnded early-return
// and never reaches the end() callback — deleting the tolerance branch left
// every suite green. A real child cannot reproduce the race deterministically
// (closing fd 0 lets stdin.end() resolve cleanly), so a stub child drives the
// end() callback with the exact raced error.
function stubChild(endError: NodeJS.ErrnoException | null) {
  const child = makeStubChild({
    stdin: {
      destroyed: false,
      writableEnded: false,
      on() {},
      end(callback: (error?: Error | null) => void) {
        queueMicrotask(() => callback(endError));
        // The raced state this stub models is "the child already exited", so
        // its exit event lands too — which is what close()'s bounded wait
        // (#15943) observes. The stub deliberately has NO kill(): escalating
        // against an already-exited child would throw here instead of passing.
        queueMicrotask(() => child.emit("close", 0, null));
      },
    },
  });
  return child;
}

test("close() resolves the child-already-exited end() race at the call site", async () => {
  const destroyed = Object.assign(new Error("Cannot call end after a stream was destroyed"), {
    code: "ERR_STREAM_DESTROYED",
  });
  await assert.doesNotReject(new ChildStdioTransport(stubChild(destroyed)).close());
});

test("close() resolves the backstop's cancelled-write end() race at the call site", async () => {
  // The ECANCELED twin of the arm above (review round: the predicate arm
  // alone checks a hand-built constant against itself; this drives the raced
  // code through close()'s own end() callback path).
  const ecanceled = Object.assign(new Error("write ECANCELED"), { code: "ECANCELED" });
  await assert.doesNotReject(new ChildStdioTransport(stubChild(ecanceled)).close());
});

test("close() still rejects a real stdin.end() failure at the call site", async () => {
  const eacces = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  await assert.rejects(
    new ChildStdioTransport(stubChild(eacces)).close(),
    (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES",
  );
});

// FM-001: a dead host must surface as a connection error, never crash the
// embedding process. serve-fixture always drains stdin, so TEST-009 cannot
// exercise either failure below; both use throwaway node children instead.

// 60 s (like the sibling arms), NOT 30 s: the failure-only caps below can
// spend 10 s (marker) + 20 s (close) before the LAST labeled assert fires,
// so a 30 s arm let node:test's generic timeout win the race (#24422 round 2).
test("a host that closes stdin rejects initialize instead of crashing", { timeout: 60_000 }, async (t) => {
  const { stderr, onStderr, pid: announcedPid } = announcedPidProbe();
  let announceStdinClosed!: () => void;
  const stdinClosed = new Promise<void>((resolve) => {
    announceStdinClosed = resolve;
  });
  const handshake = spawnMspConnection({
    command: process.execPath,
    args: [
      "-e",
      // Close fd 0 (the read end of our stdin pipe), announce the pid, tell
      // the test via stderr, then stay alive until zero-timeout cleanup ends
      // it — a live-forever host, so the close below carries a failure-only
      // cap and the pid gets a last-resort reaper like every sibling arm.
      'require("fs").closeSync(0); ' +
        `process.stderr.write("${PID_MARKER}" + process.pid + "\\n"); ` +
        'process.stderr.write("stdin-closed\\n"); setInterval(() => {}, 1000);',
    ],
    shutdownTimeoutMs: 0,
    onStderr: (chunk) => {
      onStderr(chunk);
      if (stderr.join("").includes("stdin-closed")) announceStdinClosed();
    },
  });
  reapThenClose(t, announcedPid, () => handshake.close());
  const marker = await settledWithin(stdinClosed, 10_000);
  assert.ok(marker.settled, "failure-only cap: child did not report stdin-closed");
  await assert.rejects(handshake.initialize(initializeParams(false)));
  const outcome = await settledWithin(handshake.close(), 20_000);
  assert.ok(outcome.settled, "failure-only cap: close() must settle on the live-forever host");
});

// TEST-15943-1 (#15943): the public wrappers must inherit the bounded shutdown.
// `Connection` stays process-agnostic, so a fix applied only to
// `MuseServeChild.close()` would leave these two paths pending for good —
// this pair is what catches that partial fix.

test("MspHandshake.close() is bounded for a host that ignores EOF", { timeout: 60_000 }, async (t) => {
  const { onStderr, pid: announcedPid } = announcedPidProbe();
  const handshake = spawnMspConnection({
    command: process.execPath,
    args: ["-e", IGNORES_EOF],
    shutdownTimeoutMs: 0,
    onStderr,
  });
  reapThenClose(t, announcedPid, () => handshake.close());
  const pid = await announcedPid;

  const outcome = await settledWithin(handshake.close(), 20_000);
  assert.ok(outcome.settled, "the pre-initialize wrapper must not wait on EOF forever");
  assert.deepEqual(outcome.value, { code: null, signal: "SIGTERM" });
  assert.equal(isAlive(pid), false, "close() leaves no orphaned host process");
});

test("MspHandshake.close() is bounded when a write is stuck on backpressure", { timeout: 60_000 }, async (t) => {
  // The P0's named sibling (PR #22819 review): `Connection.close()` awaited
  // `#writeTail` BEFORE reaching the transport's bounded shutdown, so a peer
  // that stopped reading wedged close() one layer above the fix. A multi-MB
  // `initialize` to a host that never reads stdin fills the pipe, so that
  // write's callback never fires and initialize() never settles.
  const { onStderr, pid: announcedPid } = announcedPidProbe();
  const handshake = spawnMspConnection({
    command: process.execPath,
    args: ["-e", NEVER_READS_STDIN],
    shutdownTimeoutMs: 0,
    onStderr,
  });
  reapThenClose(t, announcedPid, () => handshake.close());
  const pid = await announcedPid;

  handshake
    .initialize({
      clientInfo: { name: "x".repeat(2 * 1024 * 1024), version: "0.0.0" },
    })
    .catch(() => {});

  const outcome = await settledWithin(handshake.close(), 20_000);
  assert.ok(outcome.settled, "a stuck write must not gate the bounded close");
  assert.deepEqual(outcome.value, { code: null, signal: "SIGTERM" });
  assert.equal(isAlive(pid), false, "close() leaves no orphaned host process");
});

test("a frame accepted just before close() still reaches a healthy peer", { timeout: 60_000 }, async (t) => {
  // The round-3 P0 regression pin. `notify()` hands its frame to the
  // transport on a LATER microtask, so a close() that reaches `stdin.end()`
  // synchronously dropped it and then rejected with a raw
  // ERR_STREAM_WRITE_AFTER_END — memoized, so every later close() rejected
  // too — against a perfectly healthy host. close() waits for SUBMISSION now.
  const { stderr, onStderr, pid: announcedPid } = announcedPidProbe();
  const child = spawnChild(process.execPath, ["-e", ECHOES_TO_STDERR]);
  const transport = new ChildStdioTransport(child, onStderr, 10_000);
  const connection = new Connection(transport);
  reapThenClose(t, announcedPid, () => transport.close());
  await announcedPid;

  connection.notify("ping", { seq: 1 });
  await assert.doesNotReject(connection.close(), "close() must not reject on a healthy peer");

  assert.match(stderr.join(""), /got:.*"method":"ping"/, "the accepted frame must be delivered");
  assert.deepEqual(await transport.exited, { code: 0, signal: null }, "and the host exits cleanly");
  // Idempotent, and still not rejecting: the memoized failure was the second
  // half of the defect.
  await assert.doesNotReject(connection.close());
});

test("close() on a close-less transport finishes instead of hanging", { timeout: 30_000 }, async () => {
  // Round-4 P1: the submission guarantee is SCOPED to transports that
  // implement close(). A close-less one has no budget, and submission of
  // frame N+1 waits on frame N COMPLETING — what a wedged peer withholds —
  // so awaiting it here hung teardown where `#finish` used to settle it.
  const connection = new Connection({
    incoming: (async function* (): AsyncIterable<string> {
      await new Promise<void>(() => {});
    })(),
    write: () => new Promise<void>(() => {}),
  });
  connection.notify("wedged");
  connection.notify("queued-behind-it");
  const inFlight = connection.request("never-answered");
  inFlight.catch(() => {});

  const outcome = await settledWithin(connection.close(), 10_000);
  assert.ok(outcome.settled, "close() must not wait on a peer that owns no budget");
  await assert.rejects(inFlight, /connection closed/);
  await connection.closed;
});

test("child.close() gets the connection's submission promise too", { timeout: 60_000 }, async (t) => {
  // Round-4 P1: `MuseServeChild.close()` passed no `flushed`, so step 0
  // existed only for Connection-routed closes while the contract claimed all
  // three surfaces were identical — and `child` is public. This is the
  // round-3 P0 reached through the other door. `initialize()` starts a real
  // frame on a microtask; closing through `child` in the SAME turn is the race.
  // `stderrTail` is a getter returning a FRESH array, so it cannot be polled;
  // accumulate through onStderr like the other arms.
  const { stderr, onStderr, pid: announcedPid } = announcedPidProbe();
  const handshake = spawnMspConnection({
    command: process.execPath,
    args: ["-e", ECHOES_TO_STDERR],
    shutdownTimeoutMs: 10_000,
    onStderr,
  });
  const child = handshake.child;
  child.exit.catch(() => {});
  reapThenClose(t, announcedPid, () => child.close());
  const pid = await announcedPid;

  handshake.initialize(initializeParams(false)).catch(() => {});
  const outcome = await settledWithin(child.close(), 20_000);

  assert.ok(outcome.settled, "child.close() must settle");
  assert.match(
    stderr.join(""),
    /got:.*"method":"initialize"/,
    "a frame accepted in the same turn must reach the host before EOF",
  );
  assert.deepEqual(outcome.value, { kind: "cleanShutdown" });
  assert.equal(isAlive(pid), false);
});

test("the flush wait SHARES the shutdown budget, never doubles it", { timeout: 60_000 }, async (t) => {
  // Round-4 P1: replacing the shared `endsAt`/`remaining()` with a fresh full
  // budget per half kept every test green, because nothing ever waited on a
  // never-settling `flushed`. Here the second notify's submission chains
  // behind a 2 MB write the host never drains, so `flushed` never settles:
  // one virtual second. A fresh second budget would not signal yet.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const signals: string[] = [];
  let writeCallback: ((error?: Error | null) => void) | undefined;
  let endCallback: ((error?: Error | null) => void) | undefined;
  const child = makeStubChild({
    stdin: {
      destroyed: false,
      writableEnded: false,
      on() {},
      write(_chunk: string, _encoding: string, callback: (error?: Error | null) => void) {
        writeCallback = callback;
        return false;
      },
      end(callback: (error?: Error | null) => void) {
        endCallback = callback;
      },
      destroy() {},
    },
    kill: (signal: string) => {
      signals.push(signal);
      queueMicrotask(() => {
        const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        writeCallback?.(epipe);
        endCallback?.(epipe);
        child.emit("close", null, signal);
      });
      return true;
    },
  });
  const transport = new ChildStdioTransport(child, undefined, 1_000);
  const connection = new Connection(transport);

  connection.notify("bulk", { pad: UNFLUSHABLE_WRITE });
  connection.notify("queued-behind-the-wedge");
  const closing = connection.close();
  await Promise.resolve();
  t.mock.timers.tick(999);
  await Promise.resolve();
  assert.deepEqual(signals, []);
  t.mock.timers.tick(1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(signals, ["SIGTERM"]);
  await closing;
});

test("one injected deadline drives a real wedged host through the SIGKILL backstop", { timeout: 60_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The #22261 conversion of the wedge, on the production seam: the stub arm
  // above pins the shared budget on virtual time; this arm proves the same
  // contract on a REAL wedged host. The injected `deadlineFactory` is the
  // only shutdown clock, so the test hand-fires the ONE shared deadline
  // instead of waiting out a wall-clock second. The second notify's
  // submission chains behind a 2 MB write the host never drains, so
  // `flushed` never settles; the child receipt and injected deadline make
  // both halves structural. The SIGKILL backstop's stdin destroy then
  // cancels the wedged write, so a real ECANCELED reaches close(): a
  // rejection there (the predicate losing ECANCELED) fails the settle assert.
  const stderr: string[] = [];
  let resolveWedged!: (pid: number) => void;
  const wedged = new Promise<number>((resolve) => {
    resolveWedged = resolve;
  });
  const child = spawnChild(process.execPath, ["-e", TRAPS_SIGTERM_NEVER_READS_STDIN]);
  // Reap BEFORE any receipt await (host-lifetime.ts: the order IS the
  // contract): a missing receipt must not leave the SIGTERM-trapping child
  // holding node --test open with no reaper registered.
  t.after(() => reap(child.pid));
  const signals: Array<NodeJS.Signals | number> = [];
  const kill = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals | number) => {
    signals.push(signal ?? "SIGTERM");
    // Causal backstop: production arms the mocked 2s SIGTERM grace in the
    // same synchronous continuation right after kill() returns, so a
    // microtask queued here runs after the arm and needs no timed poll
    // (#22261). The child traps SIGTERM, so the SIGKILL leg is this test's
    // only path.
    if ((signal ?? "SIGTERM") === "SIGTERM") {
      queueMicrotask(() => t.mock.timers.tick(2_000));
    }
    return kill(signal);
  }) as typeof child.kill;
  let deadlineCreations = 0;
  let deadlineClears = 0;
  let fireDeadline!: () => void;
  let markDeadlineReady!: () => void;
  const deadlineReady = new Promise<void>((resolve) => {
    markDeadlineReady = resolve;
  });
  const deadlineExpired = new Promise<void>((resolve) => {
    fireDeadline = resolve;
  });
  const transport = new ChildStdioTransport(
    child,
    (chunk) => {
      stderr.push(chunk);
      const match = new RegExp(`${PID_MARKER}(\\d+)\\n${STDIN_WEDGED_MARKER}\\n`).exec(
        stderr.join(""),
      );
      if (match !== null) resolveWedged(Number(match[1]));
    },
    1_000,
    // This arm spawned an ordinary (non-group-leader) child itself, so the
    // direct-kill path is the correct one (FR-017b).
    false,
    (budgetMs) => {
      deadlineCreations += 1;
      assert.equal(budgetMs, 1_000);
      markDeadlineReady();
      return {
        expired: deadlineExpired,
        clear: () => {
          deadlineClears += 1;
        },
      };
    },
  );
  const connection = new Connection(transport);
  const pidSettled = await settledWithin(wedged, 20_000);
  assert.ok(pidSettled.settled, `host never announced a wedged stdin: ${stderr.join("")}`);
  const pid = pidSettled.value;
  connection.notify("bulk", { pad: UNFLUSHABLE_WRITE });
  connection.notify("queued-behind-the-wedge");
  const closing = connection.close();
  assert.ok(
    (await settledWithin(deadlineReady, 20_000)).settled,
    "shutdown must request its deadline",
  );
  fireDeadline();
  assert.ok(
    (await settledWithin(closing, 20_000)).settled,
    `close() must settle (signals=${JSON.stringify(signals)}, childAlive=${isAlive(pid)})`,
  );

  assert.equal(deadlineCreations, 1, "flush wait and drain must consume one shared budget");
  assert.equal(deadlineClears, 1);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(await transport.exited, { code: null, signal: "SIGKILL" });
  assert.equal(isAlive(pid), false);
});

test("stdin is destroyed between SIGTERM and SIGKILL", { timeout: 30_000 }, async () => {
  // Round-4 P1 turned round 3's honest negative into an anchor: a stub whose
  // kill() records signals and only emits 'close' on SIGKILL forces the
  // escalation deterministically, where a real child cannot.
  const signals: string[] = [];
  let destroyed = false;
  const child = makeStubChild({
    stdin: {
      get destroyed() {
        return destroyed;
      },
      writableEnded: false,
      on() {},
      end(callback: (error?: Error | null) => void) {
        queueMicrotask(() => callback(null));
      },
      destroy() {
        destroyed = true;
      },
    },
    kill: (signal: string) => {
      signals.push(signal);
      assert.equal(
        destroyed,
        signal === "SIGKILL",
        `stdin must be dropped before SIGKILL and not before SIGTERM (at ${signal})`,
      );
      if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    },
  });

  const transport = new ChildStdioTransport(child, undefined, 0);
  await transport.close();
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(destroyed, true, "the SDK must drop its own end of the pipe");
});

test("TEST-15943-1 control: the real serve-fixture still closes clean and unsignalled", { timeout: 120_000 }, async () => {
  const stderr: string[] = [];
  // A 10 s deadline the real host clears by orders of magnitude: if the
  // bounded wait ever failed to observe a graceful exit, this control would
  // report a signal instead of `{code: 0, signal: null}`.
  const handshake = fixture("handshake-usershell-granted", stderr, [1], 10_000);
  const connection = await initializeFixture(
    "handshake-usershell-granted",
    handshake,
    initializeParams(true),
    stderr,
  );
  const outcome = await settledWithin(connection.close(), 60_000);
  assert.ok(outcome.settled, "the graceful path must settle");
  assert.deepEqual(outcome.value, { code: 0, signal: null });
  assert.match(stderr.join(""), /"kind":"serveFixtureComplete"/);
});

test("a spawn failure rejects initialize and exited without killing the process", async () => {
  const handshake = spawnMspConnection({
    command: "./definitely-missing-msp-host-binary",
  });
  await assert.rejects(handshake.initialize(initializeParams(false)));
  // The eagerly created exited promise must be marked handled at birth, so
  // this late await is the FIRST consumer and still receives the rejection.
  await assert.rejects(handshake.exited, (error: unknown) => {
    assert.ok(error instanceof Error);
    return true;
  });
});
