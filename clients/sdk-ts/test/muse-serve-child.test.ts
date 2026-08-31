/**
 * TEST-011: SS2.11 classification and opaque stderr over the real #210 fixture host.
 * TEST-15943-1: the bounded, escalating close path (#15943, Scenario 4.4/4.5).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as spawnChild } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MuseServeChild } from "../src/index.js";
import type { ExitClassification } from "../src/index.js";
// Module-only seam, deliberately off the package barrel: the unflushable-stdin
// arm needs a raw write the owning wrapper does not expose (PR #22819 review).
import { ChildStdioTransport } from "../src/connection/spawn.js";
import {
  announcedPidProbe,
  awaitAnnouncedGrandchildPid,
  awaitAnnouncedPid,
  COUNTS_SIGTERM,
  IGNORES_EOF,
  IGNORES_EOF_AND_SIGTERM,
  isAlive,
  NEVER_READS_STDIN,
  reap,
  reapThenClose,
  settledWithin,
  sentinelHost,
  UNFLUSHABLE_WRITE,
  WRAPPER_WITH_STDOUT_HOLDING_GRANDCHILD,
} from "./helpers/host-lifetime.js";

/** The built barrel, as a sub-process driver would import it. */
const sdkEntry = new URL("../src/index.js", import.meta.url).href;

const classifications = new Map<number, ExitClassification["kind"]>([
  [0, "cleanShutdown"],
  [1, "unhandledError"],
  [2, "usageError"],
  [3, "configError"],
  [4, "leaseUnavailable"],
  [5, "sdkSurfaceUnavailable"],
  [77, "crash"],
]);

function exitFixture(code: number, stderrLines = 3): MuseServeChild {
  return MuseServeChild.spawn({
    museBin: "cargo",
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
      "--exit-code",
      String(code),
      "--stderr-lines",
      String(stderrLines),
    ],
  });
}

test("TEST-011: stderr_tail_and_exit_code_table", { timeout: 120_000 }, async () => {
  for (const [code, expectedKind] of classifications) {
    // Identical opaque text drives every branch: classification can only
    // come from the exit status, never from parsing stderr (INV-010).
    const child = exitFixture(code);
    const classification = await child.exit;
    assert.equal(classification.kind, expectedKind, `SS2.11 exit ${code}`);
    assert.equal(child.stderrTail.length, 3, `exit ${code} retains all short evidence`);
    assert.ok(child.stderrTail.every((line) => line.length > 0));

    if (classification.kind !== "cleanShutdown") {
      assert.deepEqual(classification.stderrTail, child.stderrTail);
      assert.ok(classification.stderrTail.length > 0, `exit ${code} surfaces evidence`);
    }
    if (classification.kind === "unhandledError") {
      assert.equal(classification.exitCode, code);
      assert.ok(
        !("retry" in classification),
        "exit 1 makes no retry claim (SS2.11 marks no posture for it)",
      );
    } else if (
      classification.kind !== "cleanShutdown" &&
      classification.kind !== "crash"
    ) {
      assert.equal(classification.exitCode, code);
      assert.equal(
        classification.retry,
        code === 3 ? "fix-config" : code === 4 ? "after-lease-release" : "never",
        `exit ${code} carries its stable retry posture`,
      );
    }
    if (classification.kind === "crash") {
      assert.equal(classification.exitCode, 77);
      assert.equal(classification.exitSignal, null);
    }
  }
});

test("a signal is the crash row with stderr evidence", async () => {
  const child = MuseServeChild.spawn({
    museBin: process.execPath,
    args: [
      "-e",
      "process.stderr.write('before signal\\n', () => process.kill(process.pid, 'SIGTERM'))",
    ],
  });
  assert.deepEqual(await child.exit, {
    kind: "crash",
    exitCode: null,
    exitSignal: "SIGTERM",
    stderrTail: ["before signal"],
  });
});

test("stderr tail is bounded by both the 100-line and 8-KiB defaults", async () => {
  const child = exitFixture(3, 400);
  const classification = await child.exit;
  assert.equal(classification.kind, "configError");
  assert.equal(child.stderrTail.length, 100);
  assert.ok(Buffer.byteLength(child.stderrTail.join("\n"), "utf8") <= 8 * 1024);
  assert.match(child.stderrTail.at(-1) ?? "", /diagnostic line 400$/);
});

test("byte cap trims heavy lines before the line cap ever fires", async () => {
  // 80 lines of 100 two-byte scalars (~16 KB) stay under the 100-line cap, so
  // only #trimBytes can bound the tail — the branch the fixture-driven table
  // never reaches (its 100 surviving lines total ~3.3 KB). The write callback
  // sequences the exit after stderr is flushed.
  const child = MuseServeChild.spawn({
    museBin: process.execPath,
    args: [
      "-e",
      'const chunk = ("\\u00e9".repeat(100) + "\\n").repeat(80); process.stderr.write(chunk, () => process.exit(3));',
    ],
  });
  const classification = await child.exit;
  assert.equal(classification.kind, "configError");
  assert.ok(Buffer.byteLength(child.stderrTail.join("\n"), "utf8") <= 8 * 1024);
  assert.ok(
    child.stderrTail.length < 100,
    "the byte budget, not the line cap, did the trimming",
  );
  assert.ok(
    !(child.stderrTail[0] ?? "").includes("�"),
    "the cut advances past UTF-8 continuation bytes, never manufacturing U+FFFD",
  );
});

// TEST-15943-1 CONTROL (#15943): the graceful arm of the exact code path the
// escalation arms below drive. One variable differs — this host drains and
// exits inside the deadline — and the deadline is generous enough that any
// signal reaching a draining host would be a defect, not a race.
test("close sends stdin EOF and resolves only after the observed exit", async () => {
  const child = MuseServeChild.spawn({
    museBin: process.execPath,
    args: [
      "-e",
      [
        "process.stdin.resume()",
        "process.stdin.once('end', () => {",
        "  setTimeout(() => { process.stderr.write('drained\\n'); process.exit(0) }, 25)",
        "})",
      ].join(";"),
    ],
    shutdownTimeoutMs: 10_000,
  });

  let resolved = false;
  const closing = child.close().then((classification) => {
    resolved = true;
    return classification;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal(resolved, false, "close waits for host drain and process exit");
  assert.deepEqual(await closing, { kind: "cleanShutdown" });
  assert.deepEqual(child.stderrTail, ["drained"]);
});

// TEST-15943-1 (#15943). Before this slice `close()` awaited EOF with no deadline
// and the SDK never signalled: a host that ignores EOF left `close()` pending
// for good and the child outlived the embedding process. The two arms below
// pin the escalation AND the classification it must NOT flatten — SS4.4.3's
// abnormal-host-death probe (FM-002) reads exactly the `cleanShutdown` /
// crash-row distinction these three tests hold apart.

test("close terminates a host that ignores stdin EOF", { timeout: 60_000 }, async (t) => {
  const { onStderr, pid: announcedPid } = announcedPidProbe();
  const child = MuseServeChild.spawn({
    museBin: process.execPath,
    args: ["-e", IGNORES_EOF],
    // A NONZERO window that must expire: the only arm pinning "drain deadline
    // expires → SIGTERM → exit" (the 0-arm below covers the skipped window).
    shutdownTimeoutMs: 150,
    onStderr,
  });
  reapThenClose(t, announcedPid, () => child.close());
  const pid = await announcedPid;

  const outcome = await settledWithin(child.close(), 20_000);
  assert.ok(outcome.settled, "close() must settle once the drain deadline expires");
  assert.deepEqual(outcome.value, {
    kind: "crash",
    exitCode: null,
    exitSignal: "SIGTERM",
    stderrTail: [`child_pid=${pid}`],
  });
  assert.equal(isAlive(pid), false, "close() leaves no orphaned host process");
});

test("close escalates to SIGKILL when the host also traps SIGTERM", { timeout: 60_000 }, async (t) => {
  const { onStderr, pid: announcedPid } = announcedPidProbe();
  const child = MuseServeChild.spawn({
    museBin: process.execPath,
    args: ["-e", IGNORES_EOF_AND_SIGTERM],
    shutdownTimeoutMs: 150,
    onStderr,
  });
  reapThenClose(t, announcedPid, () => child.close());
  const pid = await announcedPid;

  const outcome = await settledWithin(child.close(), 30_000);
  assert.ok(outcome.settled, "close() must settle once the SIGTERM grace expires");
  assert.deepEqual(outcome.value, {
    kind: "crash",
    exitCode: null,
    exitSignal: "SIGKILL",
    stderrTail: [`child_pid=${pid}`],
  });
  assert.equal(isAlive(pid), false, "close() leaves no orphaned host process");
});

test("a late but voluntary exit keeps its own classification", { timeout: 60_000 }, async (t) => {
  // The host traps SIGTERM and exits 3 under it. The SDK reports the exit it
  // OBSERVED (SS2.11, INV-011) — escalation is a way to reach an exit, never
  // a classification of its own.
  const { onStderr, pid: announcedPid } = announcedPidProbe();
  const child = MuseServeChild.spawn({
    museBin: process.execPath,
    args: [
      "-e",
      [
        // The pid marker goes LAST: with shutdownTimeoutMs 0 the parent
        // signals about one tick after it, so the SIGTERM handler must
        // already be installed or a descheduled child dies to the default
        // disposition and flakes crash/SIGTERM instead of configError.
        "process.stdin.resume()",
        'process.on("SIGTERM", () => process.exit(3))',
        "setInterval(() => {}, 1000)",
        'process.stderr.write("child_pid=" + process.pid + "\\n")',
      ].join(";"),
    ],
    shutdownTimeoutMs: 0,
    onStderr,
  });
  reapThenClose(t, announcedPid, () => child.close());
  const pid = await announcedPid;

  const outcome = await settledWithin(child.close(), 20_000);
  assert.ok(outcome.settled, "close() must settle");
  assert.deepEqual(outcome.value, {
    kind: "configError",
    exitCode: 3,
    stderrTail: [`child_pid=${pid}`],
    retry: "fix-config",
  });
  assert.equal(isAlive(pid), false, "close() leaves no orphaned host process");
});

test("concurrent close() calls share ONE shutdown", { timeout: 60_000 }, async (t) => {
  // COUNTING the signals is the whole point (PR #22819 review): asserting the
  // two results are equal is trivially true either way, so with `#closing ??=`
  // changed to `=` the old arm still passed while the host took TWO SIGTERMs.
  // The host reports every delivery; exactly one must arrive.
  const { onStderr, pid: announcedPid } = announcedPidProbe();
  const child = MuseServeChild.spawn({
    museBin: process.execPath,
    args: ["-e", COUNTS_SIGTERM],
    shutdownTimeoutMs: 150,
    onStderr,
  });
  reapThenClose(t, announcedPid, () => child.close());
  const pid = await announcedPid;

  const concurrent = await settledWithin(
    Promise.all([child.close(), child.close()]),
    30_000,
  );
  assert.ok(concurrent.settled, "concurrent close() calls must both settle");
  assert.deepEqual(concurrent.value[0], concurrent.value[1]);
  assert.equal(concurrent.value[0].kind, "crash");

  const deliveries = child.stderrTail.filter((line) => line === "sigterm_seen").length;
  assert.equal(deliveries, 1, "two close() calls must not each run the ladder");

  const again = await settledWithin(child.close(), 20_000);
  assert.ok(again.settled, "close() after the host is gone must still settle");
  assert.deepEqual(again.value, concurrent.value[0]);
  assert.equal(isAlive(pid), false, "close() leaves no orphaned host process");
});

// TEST-22777-1 (#22777). The escalation used to signal the child PID only,
// and `exited` settles on Node's `close` event — which needs the child's
// stdio CLOSED. A wrapper that leaves a grandchild holding the inherited
// stdout therefore kept `close()` pending forever after the wrapper itself
// was SIGKILLed, and the grandchild was never signalled at all. On POSIX the
// SDK owns a process group for the host it spawns and escalates against the
// group, so the whole subtree ends inside the same bound (FR-017b).
test(
  "close terminates the spawned host process group",
  { timeout: 60_000, skip: process.platform === "win32" },
  async (t) => {
    const stderr: string[] = [];
    const child = MuseServeChild.spawn({
      museBin: process.execPath,
      args: ["-e", WRAPPER_WITH_STDOUT_HOLDING_GRANDCHILD],
      shutdownTimeoutMs: 150,
      onStderr: (chunk) => stderr.push(chunk),
    });
    const pid = await awaitAnnouncedPid(stderr);
    const grandchildPid = await awaitAnnouncedGrandchildPid(stderr);
    t.after(() => {
      reap(grandchildPid);
      reap(pid);
    });
    // Setup: the #22777 shape actually exists before close() runs.
    assert.ok(isAlive(pid), "setup: the wrapper host is alive");
    assert.ok(isAlive(grandchildPid), "setup: the stdout-holding grandchild is alive");

    const outcome = await settledWithin(child.close(), 20_000);
    assert.ok(
      outcome.settled,
      "close() must settle even when a grandchild holds the inherited stdout",
    );
    assert.deepEqual(outcome.value, {
      kind: "crash",
      exitCode: null,
      exitSignal: "SIGKILL",
      stderrTail: [`child_pid=${pid}`, `grandchild_pid=${grandchildPid}`],
    });
    assert.equal(isAlive(pid), false, "close() leaves no orphaned host process");
    assert.equal(
      isAlive(grandchildPid),
      false,
      "group escalation ends the stdout-holding grandchild too",
    );
  },
);

// TEST-22777-1's fallback arm (FR-017b). The bare catch in #signal is
// normative — a group signal that fails for ANY reason must fall back to the
// direct child, never rethrow out of the ladder. Only a scratch mutation
// exercised it before this arm (review round). Driven through the transport
// directly: the group capability is CLAIMED but the child was spawned
// without `detached`, so its pid is not a pgid (a pid in use cannot be a
// stale group's id either) and every group signal fails deterministically —
// only the fallback can end the child.
test(
  "a failed group signal falls back to the direct child",
  { timeout: 60_000, skip: process.platform === "win32" },
  async (t) => {
    const stderr: string[] = [];
    const transport = new ChildStdioTransport(
      spawnChild(process.execPath, ["-e", IGNORES_EOF]),
      (chunk) => stderr.push(chunk),
      150,
      true,
    );
    const pid = await awaitAnnouncedPid(stderr);
    t.after(() => reap(pid));

    const outcome = await settledWithin(transport.close(), 20_000);
    assert.ok(outcome.settled, "a failed group signal must not gate the ladder");
    assert.deepEqual(await transport.exited, { code: null, signal: "SIGTERM" });
    assert.equal(isAlive(pid), false, "the direct-child fallback still ends the host");
  },
);

test("close terminates a host that never reads stdin", { timeout: 60_000 }, async (t) => {
  // The P0 leg (PR #22819 review). Every arm above calls `process.stdin
  // .resume()`, so `stdin.end()`'s callback always fires; against a host that
  // never reads, a filled pipe means it never does. Gating the ladder on that
  // callback left close() pending for good and orphaned the child — the exact
  // #15943 defect, surviving inside the fix.
  // Driven through the transport directly (its module-only export) because
  // filling the pipe needs a raw write, which the owning wrapper does not
  // expose.
  const { onStderr, pid: announcedPid } = announcedPidProbe();
  const transport = new ChildStdioTransport(
    spawnChild(process.execPath, ["-e", NEVER_READS_STDIN]),
    onStderr,
    0,
  );
  reapThenClose(t, announcedPid, () => transport.close());
  const pid = await announcedPid;

  // Fill the pipe so the write cannot flush and end() cannot complete.
  transport.write(UNFLUSHABLE_WRITE).catch(() => {});

  const outcome = await settledWithin(transport.close(), 20_000);
  assert.ok(outcome.settled, "an unflushable stdin must not gate the ladder");
  assert.deepEqual(await transport.exited, { code: null, signal: "SIGTERM" });
  assert.equal(isAlive(pid), false, "close() leaves no orphaned host process");
});

test("shutdownTimeoutMs 0 skips the drain window but still grants the grace", { timeout: 60_000 }, async (t) => {
  // `0` is the contract's whole answer to "why no kill()/pid", so it needs a
  // test: a `|| DEFAULT` refactor would silently make it the 30 s default and
  // leave every other arm green. The failure-only close cap catches that.
  const { onStderr, pid: announcedPid } = announcedPidProbe();
  const child = MuseServeChild.spawn({
    museBin: process.execPath,
    args: ["-e", IGNORES_EOF],
    shutdownTimeoutMs: 0,
    onStderr,
  });
  reapThenClose(t, announcedPid, () => child.close());
  const pid = await announcedPid;

  const outcome = await settledWithin(child.close(), 20_000);
  assert.ok(outcome.settled, "close() must settle");
  assert.equal(outcome.value.kind, "crash");
  assert.equal(isAlive(pid), false, "close() leaves no orphaned host process");
});

test("a clean close() leaves no timer pinning the event loop", { timeout: 120_000 }, async (t) => {
  // The deadline timer is not unref()'d, so a dropped `finally { clearTimeout }`
  // keeps the embedding app alive for the whole remaining budget. Deleting it
  // left every other arm green (PR #22819 review) — only wall-clock sees it.
  // A sub-process is the instrument: it closes a fast-draining host under the
  // 30 s default and must EXIT, not merely resolve.
  const driver = [
    `const { MuseServeChild } = await import(${JSON.stringify(sdkEntry)});`,
    "const child = MuseServeChild.spawn({",
    `  museBin: ${JSON.stringify(process.execPath)},`,
    '  args: ["-e", "process.stdin.resume();process.stdin.once(\'end\', () => process.exit(0))"],',
    "  shutdownTimeoutMs: 30_000,",
    "});",
    "await child.close();",
  ].join("\n");

  let driverPid: number | undefined;
  t.after(() => reap(driverPid));
  const driverExit = new Promise<number | null>((resolve, reject) => {
    const proc = spawnChild(process.execPath, ["--input-type=module", "-e", driver], {
      stdio: "ignore",
    });
    driverPid = proc.pid;
    proc.once("error", reject);
    proc.once("close", resolve);
  });
  const outcome = await settledWithin(driverExit, 15_000);

  assert.ok(outcome.settled, "failure-only cap: close() pinned the driver process");
  assert.equal(outcome.value, 0, "the driver must exit cleanly");
});

test("an out-of-range shutdownTimeoutMs is refused BEFORE the child is spawned", { timeout: 60_000 }, async (t) => {
  // Node clamps a non-finite or >2^31-1 delay to 1 ms, which would fabricate a
  // crash row for a host that was draining normally (PR #22819 review). WHERE
  // the throw happens is the load-bearing half (round 3): the transport
  // constructor throws the identical RangeError, but by then the child is
  // running with no owner and no handle to kill it. A stderr probe cannot see
  // that — the constructor throws before the listener attaches — so the host
  // records its own birth in a sentinel file that must never appear.
  const sentinel = join(await mkdtemp(join(tmpdir(), "tbh-15943-")), "pid");
  t.after(async () => {
    const leaked = await readFile(sentinel, "utf8").catch(() => "");
    if (leaked !== "") reap(Number(leaked));
    await rm(dirname(sentinel), { recursive: true, force: true });
  });

  for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -1, 2_147_483_648, 1.5]) {
    assert.throws(
      () =>
        MuseServeChild.spawn({
          museBin: process.execPath,
          args: ["-e", sentinelHost(sentinel)],
          shutdownTimeoutMs: bad,
        }),
      RangeError,
      `shutdownTimeoutMs ${String(bad)} must be refused`,
    );
  }

  await new Promise<void>((resolve) => setTimeout(resolve, 250));
  assert.equal(
    await readFile(sentinel, "utf8").catch(() => ""),
    "",
    "a refused budget must spawn no child at all — validate before spawn(), not in the transport",
  );
});
