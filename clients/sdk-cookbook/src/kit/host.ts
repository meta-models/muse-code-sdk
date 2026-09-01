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
   * There is no second move if the drain does not finish: the shipped SDK
   * surface has no kill path, so a host that ignores stdin EOF is left to the
   * operating system. #15943 owns giving `close()` a bound and a kill; until
   * it lands this prints what happened rather than pretending it cleaned up.
   */
  async abandon(budgetMs: number): Promise<void> {
    try {
      await this.close(budgetMs);
    } catch (error) {
      process.stderr.write(
        `warning: the host did not drain (${String(error)}). The SDK exposes no kill path, ` +
          `so this child may outlive the journey.\n`,
      );
    }
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
