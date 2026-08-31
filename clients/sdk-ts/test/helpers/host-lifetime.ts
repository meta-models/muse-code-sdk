/**
 * Shared probes for the bounded-shutdown arms (#15943, TEST-15943-1).
 *
 * The two misbehaving hosts below are throwaway `node -e` children for the
 * same reason the FM-001 arms in `spawn-handshake.test.ts` are: serve-fixture
 * always drains stdin and always exits, so it structurally cannot ignore EOF
 * or trap SIGTERM. serve-fixture stays the CONTROL — the real host whose
 * graceful drain must keep classifying `cleanShutdown` with no signal.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { TestContext } from "node:test";

/** The child announces its own pid on stderr; the SDK exposes no `pid`. */
export const PID_MARKER = "child_pid=";

function hostSource(body: readonly string[]): string {
  return [
    `process.stderr.write("${PID_MARKER}" + process.pid + "\\n")`,
    "process.stdin.resume()",
    ...body,
    // A live interval keeps the host running past stdin EOF for good.
    "setInterval(() => {}, 1000)",
  ].join(";");
}

/** A host that sees stdin EOF and keeps running. Exits on SIGTERM. */
export const IGNORES_EOF = hostSource([]);

/** The same host, with SIGTERM trapped: only SIGKILL can end it. */
export const IGNORES_EOF_AND_SIGTERM = hostSource([
  'process.on("SIGTERM", () => {})',
]);

/**
 * A host that NEVER READS stdin — no `resume()`, no `data` handler. Fill the
 * pipe and `stdin.end()`'s callback never fires, which is the leg every
 * resume()-calling host above is blind to (PR #22819 review, P0).
 */
export const NEVER_READS_STDIN = [
  `process.stderr.write("${PID_MARKER}" + process.pid + "\\n")`,
  "setInterval(() => {}, 1000)",
].join(";");

/**
 * Traps SIGTERM and reports EVERY delivery, so a test can count signals
 * rather than only observing the end state — the discriminator the
 * idempotence arm needs against a deleted memoization.
 */
export const COUNTS_SIGTERM = hostSource([
  'process.on("SIGTERM", () => process.stderr.write("sigterm_seen\\n"))',
]);

/** Bytes that comfortably exceed a pipe buffer, so a write cannot flush. */
export const UNFLUSHABLE_WRITE = "x".repeat(2 * 1024 * 1024);

/** Capture stderr and resolve when the child announces its pid. */
export function announcedPidProbe(budgetMs = 10_000): {
  readonly stderr: string[];
  readonly onStderr: (chunk: string) => void;
  readonly pid: Promise<number>;
} {
  const stderr: string[] = [];
  let onStderr!: (chunk: string) => void;
  const pid = new Promise<number>((resolve, reject) => {
    let buffered = "";
    // Failure-only cap: a missing marker must fail with its own diagnosis.
    const timeout = setTimeout(
      () =>
        reject(
          new Error(`failure-only missing-marker cap (${budgetMs} ms): child_pid not announced`),
        ),
      budgetMs,
    );
    onStderr = (chunk) => {
      stderr.push(chunk);
      buffered += chunk;
      const match = /child_pid=(\d+)/.exec(buffered);
      if (match === null) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    };
  });
  // Marked handled at birth (like `this.exited.catch` in spawn.ts): a caller
  // using only stderr/onStderr must not die to the cap's unhandled rejection.
  // Awaiters still observe the rejection.
  pid.catch(() => {});
  return { stderr, onStderr, pid };
}

/**
 * A duck-typed stub child for the deterministic call-site arms. The
 * EventEmitter base, the stdout/stderr PassThroughs, and the single cast live
 * here, so each arm states only its stdin shape — plus its `kill`, when the
 * arm expects escalation. `kill` stays OMITTABLE on purpose: an arm whose
 * contract forbids escalation passes none, so an unexpected kill() throws
 * instead of passing.
 */
export function makeStubChild(parts: {
  readonly stdin: Record<string, unknown>;
  readonly kill?: (signal: string) => boolean;
}): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child["stdout"] = new PassThrough({ encoding: "utf8" });
  child["stderr"] = new PassThrough({ encoding: "utf8" });
  child["stdin"] = parts.stdin;
  if (parts.kill !== undefined) child["kill"] = parts.kill;
  return child as unknown as ChildProcessWithoutNullStreams;
}

/** Signal 0 probes existence without delivering anything. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export type Settlement<T> =
  | { readonly settled: true; readonly value: T }
  | { readonly settled: false };

/**
 * Failure-only cap: race `work` against `budgetMs` and report which won.
 * A termination test whose failure mode is "the suite wedges" produces no
 * diagnostics (the round-3 EOF-arm lesson in contracts/test-evidence.md).
 */
export async function settledWithin<T>(
  work: Promise<T>,
  budgetMs: number,
): Promise<Settlement<T>> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<Settlement<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), budgetMs);
  });
  try {
    return await Promise.race([
      work.then((value): Settlement<T> => ({ settled: true, value })),
      deadline,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Last-resort reaper so a RED arm cannot leave the suite holding a child. */
export function reap(pid: number | undefined): void {
  if (pid === undefined || !isAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone between the probe and the signal: that is the goal state.
  }
}

/**
 * Register an arm's two shutdown hooks in the one order that is safe. Reap
 * FIRST: `t.after` hooks run in registration order, and a close() that wedges
 * re-awaits the same memoized promise forever — a reaper registered behind it
 * would never run. Reaping is also what un-wedges that close. The order IS
 * the contract, so it lives here instead of being hand-copied at every arm
 * (PR #24422 review: six copies drifted while five were fixed).
 */
export function reapThenClose(
  t: TestContext,
  announcedPid: Promise<number>,
  close: () => unknown,
): void {
  t.after(async () => reap(await announcedPid.catch(() => undefined)));
  t.after(() => close());
}

/**
 * Echoes every complete line it receives to stderr, then exits on EOF. A
 * HEALTHY peer: the control for "did the frame actually get delivered".
 */
export const ECHOES_TO_STDERR = [
  `process.stderr.write("${PID_MARKER}" + process.pid + "\\n")`,
  'process.stdin.setEncoding("utf8")',
  'let buffered = ""',
  'process.stdin.on("data", (chunk) => {',
  "  buffered += chunk;",
  "  let newline;",
  '  while ((newline = buffered.indexOf("\\n")) >= 0) {',
  '    process.stderr.write("got:" + buffered.slice(0, newline) + "\\n");',
  "    buffered = buffered.slice(newline + 1);",
  "  }",
  "})",
  'process.stdin.on("end", () => process.exit(0))',
].join(";");

/**
 * Writes its pid to `path` at birth. A test can then prove NO child was ever
 * spawned — which an `onStderr` probe cannot, because a constructor that
 * throws does so before the stderr listener is attached.
 */
export function sentinelHost(path: string): string {
  return [
    `require("node:fs").writeFileSync(${JSON.stringify(path)}, String(process.pid))`,
    "setInterval(() => {}, 1000)",
  ].join(";");
}
