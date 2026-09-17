/**
 * One owned `muse serve` host, plus the notification recorder the streaming
 * assertions wait on.
 *
 * Everything here goes through the shipped `@muse-code/sdk` public surface —
 * `spawnMspConnection`, `MspHandshake.initialize`, `Connection.command`,
 * `Connection.request`, `SpawnedMspConnection.close`. The journey never
 * reaches into an SDK internal, so what it proves is exactly what a consumer
 * gets.
 */

import { spawnMspConnection } from "@muse-code/sdk";
import type { SpawnedMspConnection } from "@muse-code/sdk";

/** A JSON-RPC notification the host pushed at us. */
export interface RecordedNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface HostOptions {
  /** Absolute path to the release-built binary. */
  readonly museBin: string;
  /** Isolated `HOME`. Every host in one journey shares it, so state persists. */
  readonly home: string;
  /** The workspace a session is started in. */
  readonly workspaceRoot: string;
  /**
   * The clientInfo the handshake announces to the host's session/audit
   * attribution. REQUIRED, matching {@link HostSpawnSpec}: this used to
   * default to the quickstart's identity, so a new release-host recipe that
   * forgot it announced itself as the quickstart and its sessions were
   * attributed to a journey it never ran (T-24225-6). Every caller names
   * itself.
   */
  readonly clientInfo: { readonly name: string; readonly version: string };
}

/**
 * The generic spawn shape behind {@link Host.start}. Cookbook recipes use it
 * to launch `muse-conformance serve-fixture` (the canned stdio host) with the
 * same recorder and bounded waits the quickstart journey uses for `muse serve`.
 */
export interface HostSpawnSpec {
  /** The host executable. */
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  /** The COMPLETE child environment: nothing else is inherited. */
  readonly env: Record<string, string>;
  /** The clientInfo the MSP handshake announces. */
  readonly clientInfo: { readonly name: string; readonly version: string };
}

/**
 * The `sdk_enabled` dev override, spelled out exactly as
 * `crates/cli/tests/msp_process_harness/mod.rs` does so a gate rename has to
 * be noticed here too. This is how the JOURNEY's own child is launched; it is
 * not reader guidance, and README.md says so.
 */
export const SDK_GATE_ENV = "MUSE_EXPERIMENTAL_SDK_ENABLED";

/** The pre-Seam-C placeholder cursor. A real session must never return it. */
export const STUB_VIEW_CURSOR = "pending:seam-c-session-view-fold";

/**
 * The isolated child environment every journey-spawned host gets — the
 * env_clear equivalent: nothing else is inherited, so a journey can never
 * read the developer's credentials, telemetry settings, or real muse state.
 * ONE builder, shared by `Host.start` and the release-host recipes that
 * spawn through the SDK facade, so a new isolation variable lands everywhere
 * at once (PR #26000 review).
 */
export function isolatedHostEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    TBH_CREDENTIAL_BACKEND: "file",
    TBH_DISABLE_TELEMETRY: "1",
    [SDK_GATE_ENV]: "on",
  };
}

export class TimeoutError extends Error {
  constructor(what: string, budgetMs: number) {
    super(`${what} did not happen within ${String(budgetMs)}ms`);
    this.name = "TimeoutError";
  }
}

/** A bounded wait. Never leaves a dangling timer behind. */
export async function within<T>(
  what: string,
  budgetMs: number,
  work: Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError(what, budgetMs));
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The drain window every cookbook host runs under — OWNED, not restated.
 *
 * `close()` takes no budget: the drain window is fixed when the host is
 * spawned. So instead of hand-copying the SDK's unexported
 * `DEFAULT_SHUTDOWN_TIMEOUT_MS` (a copy with no drift gate — the SDK raising
 * its default would have left the bound below flooring at a stale value, PR
 * #25986 review), every spawn in this cookbook except classify-serve-exits'
 * raw hosts passes THIS constant as `shutdownTimeoutMs`: `Host.spawn`
 * below, and the `MuseClient.spawn` calls in resume-and-verify and
 * survive-the-host-dying. Those hosts then drain for exactly this window,
 * whatever the SDK's internal default does. (classify-serve-exits spawns raw
 * hosts on the SDK default; their closes never reach this bound.)
 */
export const HOST_DRAIN_WINDOW_MS = 30_000;

/**
 * Slack over that window, so this helper's timer can only fire once the SDK
 * has ALREADY failed to reclaim the child — which is the only state worth a
 * warning. It covers the SDK's fixed post-drain SIGTERM→SIGKILL grace (2s,
 * not spawn-configurable) with margin: a bound equal to the drain window
 * expires while the escalation is still legitimately running, and reports a
 * leaked child seconds before the SDK kills it.
 */
const SHUTDOWN_ESCALATION_SLACK_MS = 10_000;

/**
 * The floor a drain bound must clear, whatever the caller asked for.
 *
 * Taking the MAX is what makes the coupling structural: the bound cleared the
 * SDK's ladder only because every recipe's close budget happens to equal the
 * drain window, so the first recipe to pass a smaller one would have warned
 * "did not drain cleanly" while the SDK was still mid-drain — the exact
 * misleading report this helper was rewritten to stop (PR #25986 review).
 * The floor is the same owned constant the spawns pass, so it cannot drift
 * from the window the SDK actually honours.
 */
function drainBoundMs(budgetMs: number): number {
  return Math.max(budgetMs, HOST_DRAIN_WINDOW_MS) + SHUTDOWN_ESCALATION_SLACK_MS;
}

/**
 * Ask a host to drain, and SAY SO rather than pretend when it will not.
 *
 * The failure path every journey needs. Since #15943 the SDK owns termination —
 * EOF, then a bounded drain, then SIGTERM/SIGKILL — so a host that ignores
 * stdin EOF is reclaimed rather than orphaned, and what this reports is that
 * the drain was not CLEAN, not that a child leaked. Saying otherwise sent a
 * reader hunting for a process the SDK had already killed (PR #25986 review).
 *
 * `close` is the RAW close; the bound is applied here, over the SDK's own via
 * {@link drainBoundMs}, so there is one timer and one warning sentence. Shared
 * rather than hand-copied because a recipe holding a `MuseClient` cannot reach
 * {@link Host.abandon}.
 */
export async function drainQuietly(
  what: string,
  budgetMs: number,
  close: () => Promise<unknown>,
): Promise<void> {
  try {
    // The label reaches the TIMEOUT text too, not just the warning. A journey
    // with two children alive would otherwise print one line naming two
    // subjects — "the resume host did not drain (TimeoutError: the host's
    // orderly drain and exit …)" — precisely when which child hung is the only
    // thing the reader needs (PR #25986 review).
    await within(`${what}'s orderly drain and exit`, drainBoundMs(budgetMs), close());
  } catch (error) {
    process.stderr.write(
      `warning: ${what} did not drain cleanly (${String(error)}); the SDK escalates to ` +
        `SIGTERM/SIGKILL, so the child is reclaimed even when the drain is not.\n`,
    );
  }
}

export class Host {
  readonly msp: SpawnedMspConnection;
  readonly stderr: string[];
  readonly #seen: RecordedNotification[] = [];
  readonly #waiters: Array<{
    match: (notification: RecordedNotification) => boolean;
    settle: (notification: RecordedNotification) => void;
  }> = [];

  // The SDK keeps appending to the array `start` handed the spawn, so this
  // holds the REFERENCE, never a copy: a snapshot taken at handshake time is
  // empty exactly when the host later dies and its stderr is the only evidence.
  private constructor(msp: SpawnedMspConnection, stderr: string[]) {
    this.msp = msp;
    this.stderr = stderr;
  }

  /** Spawn the release binary and complete the MSP handshake. */
  static async start(options: HostOptions, budgetMs: number): Promise<Host> {
    return await Host.spawn(
      {
        command: options.museBin,
        args: ["serve"],
        cwd: options.workspaceRoot,
        env: isolatedHostEnv(options.home),
        clientInfo: options.clientInfo,
      },
      budgetMs,
    );
  }

  /** Spawn any MSP host command and complete the handshake. */
  static async spawn(spec: HostSpawnSpec, budgetMs: number): Promise<Host> {
    const stderr: string[] = [];
    const handshake = spawnMspConnection({
      command: spec.command,
      args: [...spec.args],
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: spec.env,
      // The owned window, not the SDK's unexported default: see
      // HOST_DRAIN_WINDOW_MS.
      shutdownTimeoutMs: HOST_DRAIN_WINDOW_MS,
      onStderr: (chunk) => stderr.push(chunk),
    });

    let msp: SpawnedMspConnection;
    try {
      msp = await within(
        "the MSP handshake",
        budgetMs,
        handshake.initialize({ clientInfo: spec.clientInfo }),
      );
    } catch (error) {
      // BOUND this peek. `child.exit` only settles when the child actually
      // exits, so a host that accepted the spawn and then went silent would
      // swallow the TimeoutError above and hang the caller forever — past the
      // journey's own cleanup, leaking the child. A missing classification is
      // worth far less than a diagnosable failure.
      const exit = await within("the host's exit after a failed handshake", 2_000, handshake.child.exit)
        .catch(() => undefined);
      throw new Error(
        `handshake failed (exit ${exit === undefined ? "still running" : JSON.stringify(exit)}); stderr: ${stderr.join("")}`,
        { cause: error },
      );
    }

    const host = new Host(msp, stderr);
    msp.connection.onNotification((notification) => {
      host.#record({
        method: notification.method,
        params: (notification.params ?? {}) as Record<string, unknown>,
      });
    });
    msp.child.exit.catch(() => undefined);
    return host;
  }

  #record(notification: RecordedNotification): void {
    this.#seen.push(notification);
    for (let index = this.#waiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.#waiters[index];
      if (waiter !== undefined && waiter.match(notification)) {
        this.#waiters.splice(index, 1);
        waiter.settle(notification);
      }
    }
  }

  /** Every notification recorded so far, oldest first. */
  notifications(): readonly RecordedNotification[] {
    return [...this.#seen];
  }

  /**
   * Wait for the first notification matching `match`. Already-received
   * notifications count, so there is no race between sending a command and
   * subscribing to its stream.
   */
  async waitFor(
    what: string,
    budgetMs: number,
    match: (notification: RecordedNotification) => boolean,
  ): Promise<RecordedNotification> {
    const already = this.#seen.find(match);
    if (already !== undefined) return already;
    const arrival = new Promise<RecordedNotification>((resolve) => {
      this.#waiters.push({ match, settle: resolve });
    });
    // Racing the process exit turns "the host died" into that sentence
    // instead of an opaque timeout.
    const died = this.msp.exited.then((exit) => {
      throw new Error(
        `the host exited (code ${String(exit.code)}, signal ${String(exit.signal)}) while waiting for ${what}; stderr: ${this.stderr.join("")}`,
      );
    });
    died.catch(() => undefined);
    return await within(what, budgetMs, Promise.race([arrival, died]));
  }

  /** Close stdin and wait for the orderly drain (spec 14990 Scenario 4.4). */
  async close(budgetMs: number): Promise<{ code: number | null; signal: string | null }> {
    return await within("the host's orderly drain and exit", budgetMs, this.msp.close());
  }

  /**
   * Best-effort teardown for a failure path. Never throws.
   *
   * The whole behaviour lives in {@link drainQuietly}, which a `MuseClient`
   * recipe with no `Host` calls directly; this is the same drain under the
   * name the journeys already reach for. The raw `msp.close()` is handed over
   * rather than `this.close()` so the bound is applied once, by the helper.
   */
  async abandon(budgetMs: number): Promise<void> {
    await drainQuietly("the host", budgetMs, () => this.msp.close());
  }
}

/**
 * The owned-host guard every journey needs: a segment that runs after an
 * earlier one failed to produce a host says so, instead of dereferencing
 * `undefined`. Structural on purpose — each journey has its own context shape
 * and only the `host` slot is shared (PR #25153 review hoisted the fifth
 * byte-identical copy).
 */
export function requireHost(context: { readonly host?: Host }): Host {
  if (context.host === undefined) throw new Error("no host: an earlier segment did not finish");
  return context.host;
}

/** Narrow an untyped MSP result member to an object, with a useful message. */
export function objectAt(
  value: Record<string, unknown>,
  key: string,
  where: string,
): Record<string, unknown> {
  const member = value[key];
  if (member === null || typeof member !== "object" || Array.isArray(member)) {
    throw new Error(`${where}: "${key}" is not an object (got ${JSON.stringify(member)})`);
  }
  return member as Record<string, unknown>;
}

/** Narrow an untyped MSP result member to a non-empty string. */
export function stringAt(
  value: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const member = value[key];
  if (typeof member !== "string" || member.length === 0) {
    throw new Error(`${where}: "${key}" is not a non-empty string (got ${JSON.stringify(member)})`);
  }
  return member;
}

export function arrayAt(
  value: Record<string, unknown>,
  key: string,
  where: string,
): readonly unknown[] {
  const member = value[key];
  if (!Array.isArray(member)) {
    throw new Error(`${where}: "${key}" is not an array (got ${JSON.stringify(member)})`);
  }
  return member;
}

export function equals(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
