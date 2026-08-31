/**
 * The recorder: drive one real host through the SDK's PUBLIC surface while the
 * tap records the wire, then hand both halves to the oracle.
 *
 * Everything this file touches is exported from `@muse/sdk`'s barrel. That is
 * the external-integrator lens (charter decision 1) made structural rather
 * than aspirational — `qa-discipline.test.ts` fails the build if a deeper
 * import ever appears.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnMspConnection } from "../src/index.js";
import type { MspHandshake, SpawnedMspConnection } from "../src/index.js";
import type { InitializeParams } from "@muse/msp";

import { readTapPids, readWireLog, tappedSpawnOptions } from "./tap.js";
import type { ApiObservation, ObservedRun } from "./oracle.js";

/** The client an external integrator would present. `[a-z0-9_]+` (SS1.4.1). */
export const QA_CLIENT_INFO: InitializeParams = {
  clientInfo: { name: "auto_qa_sdk", title: "auto-qa --area sdk", version: "0.0.0" },
};

/**
 * A hermetic host environment: no inherited HOME, no keychain, no telemetry,
 * no remote feature-config fetch. An inherited HOME would let a dogfood
 * machine's persisted state decide the verdict, which is how a QA harness
 * starts reporting the operator's config as a product defect.
 */
export function hermeticEnv(home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    MUSE_EXPERIMENTAL_SDK_ENABLED: "on",
    TBH_CREDENTIAL_BACKEND: "file",
    TBH_DISABLE_TELEMETRY: "1",
    TBH_DISABLE_FEATURE_CONFIG: "1",
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_DATA_HOME: join(home, "data"),
  };
}

export interface OpenHostOptions {
  readonly museBin: string;
  readonly serveArgs?: readonly string[];
  /**
   * Replace the whole argv, for the replay host used by facade-vs-binary
   * attribution. Real scenarios never set this: their host is `tbh serve`.
   */
  readonly argv?: readonly string[];
  /** Root for this host's HOME and tap file. */
  readonly workDir: string;
  /** Label distinguishing several hosts inside one scenario. */
  readonly label: string;
  /** Override the hermetic env wholesale (the gate-closed scenario needs to). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Select a provider in this host's settings before it starts (#23537).
   *
   * Opt-in per scenario, and deliberately NOT the default: an unconfigured
   * home is the correct subject for the fallback arms, where the logged-out
   * provider is the specified behaviour (spec 19535 FR-005/FM-017) rather
   * than a defect. Scenarios whose subject is a RUNNING TURN must set this,
   * because an unconfigured host terminalizes every turn at the pinned
   * credential failure and the subject behaviour never occurs.
   *
   * Only `echo` is admitted: it is credential-free and offline, so a
   * configured host costs no secret and no network — and any wider value
   * (notably `meta`) would silently compose the logged-out fallback in a
   * credential-free home, recreating the false positive this exists to
   * remove. Widen the union only when a scenario really needs another
   * provider. This writes a provider SELECTION only — it never writes a
   * credential.
   */
  readonly configureProvider?: "echo";
}

/**
 * One tapped host, plus the public-API observations taken while driving it.
 *
 * `finish()` is the only way to get an `ObservedRun`: the wire log can only be
 * read once the child is gone, and reading it early would compare the public
 * API against a truncated transcript — a silent source of phantom findings.
 */
export class RecordedHost {
  readonly handshake: MspHandshake;
  readonly #observations: ApiObservation[] = [];
  readonly #requestedMethods = new Set<string>();
  readonly #waiters = new Set<
    (method: string, params: Record<string, unknown> | undefined) => void
  >();
  readonly #tapFile: string;
  readonly stderr: string[] = [];
  #connection: SpawnedMspConnection | undefined;
  #closed = false;

  private constructor(handshake: MspHandshake, tapFile: string, stderr: string[]) {
    this.handshake = handshake;
    this.#tapFile = tapFile;
    this.stderr = stderr;
    handshake.onNotification((notification) => {
      this.#observations.push({
        kind: "notification",
        method: notification.method,
        params: notification.params ?? null,
      });
      for (const waiter of [...this.#waiters]) {
        waiter(notification.method, notification.params as Record<string, unknown> | undefined);
      }
    });
    handshake.onProtocolError((error) => {
      this.#observations.push({ kind: "protocolError", message: error.message });
    });
  }

  static async open(options: OpenHostOptions): Promise<RecordedHost> {
    const home = join(options.workDir, `${options.label}-home`);
    await mkdir(home, { recursive: true });
    const env = options.env ?? hermeticEnv(home);
    if (options.configureProvider !== undefined) {
      // Key off the EFFECTIVE env, not `home`: the across-restart helper points
      // its second host at the FIRST host's home, so provisioning the computed
      // path would write settings the host never reads. No guessed fallback:
      // a config home the env does not name is one the spawned host will not
      // resolve, so writing there is the silent misconfiguration this option
      // exists to remove — fail loudly instead.
      const configHome = env["XDG_CONFIG_HOME"];
      if (configHome === undefined) {
        throw new Error("configureProvider requires XDG_CONFIG_HOME in the effective env");
      }
      const museConfig = join(configHome, "muse");
      await mkdir(museConfig, { recursive: true });
      await writeFile(
        join(museConfig, "settings.json"),
        `${JSON.stringify({ schema_version: 1, provider: options.configureProvider }, null, 2)}\n`,
      );
    }
    const tapFile = join(options.workDir, `${options.label}.tap.jsonl`);
    const stderr: string[] = [];
    const handshake = spawnMspConnection(
      tappedSpawnOptions({
        tapFile,
        command: options.museBin,
        args: options.argv ?? ["serve", ...(options.serveArgs ?? [])],
        env,
        onStderr: (chunk) => stderr.push(chunk),
      }),
    );
    return new RecordedHost(handshake, tapFile, stderr);
  }

  get connection(): SpawnedMspConnection {
    if (this.#connection === undefined) throw new Error("initialize() has not resolved yet");
    return this.#connection;
  }

  async initialize(
    capabilities?: NonNullable<InitializeParams["capabilities"]>,
  ): Promise<SpawnedMspConnection> {
    const connection = await this.handshake.initialize(
      capabilities === undefined ? QA_CLIENT_INFO : { ...QA_CLIENT_INFO, capabilities },
    );
    this.#connection = connection;
    this.#observations.push({
      kind: "initializeResult",
      result: connection.initializeResult as unknown as Record<string, unknown>,
      fingerprintWarning: connection.fingerprintWarning ?? null,
    });
    return connection;
  }

  /** A plain request. Errors are recorded, never thrown: an MSP error is data. */
  async request(step: string, method: string, params: Record<string, unknown> = {}): Promise<void> {
    this.#requestedMethods.add(method);
    await this.#settle(step, method, () => this.connection.connection.request(method, params));
  }

  /**
   * A command-plane call. The SDK mints the UUIDv7 `commandId` (INV-013)
   * unless the scenario pins one — which the cross-restart replay and
   * fabricated-ack classes both must, because the commandId IS their subject.
   */
  async command(
    step: string,
    method: string,
    params: Record<string, unknown> = {},
    commandId?: string,
  ): Promise<void> {
    this.#requestedMethods.add(method);
    await this.#settle(step, method, () =>
      this.connection.connection.command(
        method,
        params,
        commandId === undefined ? undefined : { commandId },
      ),
    );
  }

  /**
   * Wait for one server notification, or give up.
   *
   * The SDK has no local timeout by design (INV-006), so a scenario that
   * waits for a terminal frame must own its own bound — otherwise a host that
   * never emits one hangs the whole QA run instead of reporting a blocked
   * scenario.
   */
  async waitForNotification(
    method: string,
    timeoutMs = 15_000,
  ): Promise<Record<string, unknown> | undefined> {
    const already = this.notificationsOf(method).at(-1);
    if (already !== undefined) return already;
    return await new Promise<Record<string, unknown> | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        resolve(undefined);
      }, timeoutMs);
      timer.unref();
      const waiter = (seen: string, params: Record<string, unknown> | undefined): void => {
        if (seen !== method) return;
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        resolve(params);
      };
      this.#waiters.add(waiter);
    });
  }

  /** The params of every notification with this method, in arrival order. */
  notificationsOf(method: string): readonly Record<string, unknown>[] {
    return this.#observations
      .filter((entry) => entry.kind === "notification" && entry.method === method)
      .map((entry) => ((entry as { params: unknown }).params ?? {}) as Record<string, unknown>);
  }

  /** The last recorded result for a step, so a scenario can chain on it. */
  resultOf(step: string): Record<string, unknown> | undefined {
    for (let index = this.#observations.length - 1; index >= 0; index -= 1) {
      const entry = this.#observations[index];
      if (entry?.kind === "requestOk" && entry.step === step) return entry.result;
    }
    return undefined;
  }

  /** The typed error kind a step settled with, if it settled as an error. */
  errorKindOf(step: string): string | undefined {
    for (let index = this.#observations.length - 1; index >= 0; index -= 1) {
      const entry = this.#observations[index];
      if (entry?.kind === "requestError" && entry.step === step) {
        return entry.error.kind ?? entry.error.name;
      }
    }
    return undefined;
  }

  /** The recorded notification methods, in arrival order. */
  notificationMethods(): readonly string[] {
    return this.#observations
      .filter((entry) => entry.kind === "notification")
      .map((entry) => (entry as { method: string }).method);
  }

  async #settle(
    step: string,
    method: string,
    call: () => Promise<Record<string, unknown>>,
  ): Promise<void> {
    try {
      this.#observations.push({ kind: "requestOk", step, method, result: await call() });
    } catch (error) {
      const shaped = error as { name?: string; message?: string; code?: unknown; kind?: unknown };
      this.#observations.push({
        kind: "requestError",
        step,
        method,
        error: {
          name: shaped.name ?? "Error",
          message: shaped.message ?? String(error),
          ...(typeof shaped.code === "number" ? { code: shaped.code } : {}),
          ...(typeof shaped.kind === "string" ? { kind: shaped.kind } : {}),
        },
      });
    }
  }

  /**
   * Close and read the tap.
   *
   * The close is raced against a wall-clock bound the HARNESS owns. Bounded
   * termination of a spawned host is spec 14990's business (#15943), not this
   * driver's; the bound here exists only so a host that never exits reports a
   * blocked scenario instead of hanging the QA run forever.
   */
  async finish(closeTimeoutMs = 20_000): Promise<ObservedRun> {
    if (!this.#closed) {
      this.#closed = true;
      const closing =
        this.#connection === undefined ? this.handshake.close() : this.#connection.close();
      let timer: NodeJS.Timeout | undefined;
      const timedOut = Symbol("timedOut");
      const bound = new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), closeTimeoutMs);
        timer.unref();
      });
      // The SS2.11 CLASSIFICATION, not the raw {code, signal}: that table is
      // what the public surface offers an integrator, so it is what the
      // oracle and the scenarios must compare against.
      const outcome = await Promise.race([
        closing.then(async () => await this.handshake.child.exit),
        bound,
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (outcome === timedOut) {
        // Recording `hostDidNotExit` is not the same as ending it. The shim
        // never kills the real host, so a wedged pair keeps its stdio handles
        // open, the event loop never empties, and `node dist/qa/bin.js` prints
        // its report and then hangs forever — the exact hang FM-QA-004 exists
        // to prevent. Terminating here also restores this class's own "read
        // the tap only once the child is gone" rule, which a live shim breaks.
        await this.#terminate();
      }
      this.#observations.push(
        outcome === timedOut
          ? { kind: "exit", classification: { kind: "hostDidNotExit", closeTimeoutMs } }
          : { kind: "exit", classification: outcome as unknown as Record<string, unknown> },
      );
    }
    return {
      api: [...this.#observations],
      wire: await readWireLog(this.#tapFile),
      requestedMethods: [...this.#requestedMethods],
    };
  }

  /**
   * Signal the wedged shim and host, then give the pair a moment to go.
   *
   * The pids come from the tap's `#` header because the SDK's public barrel
   * offers no pid and no kill, and the harness may not reach past it (charter
   * decision 4). They are signalled individually rather than as a process
   * group: the shim is spawned into THIS process's group, so a group signal
   * would take the QA run down with it.
   */
  async #terminate(graceMs = 2_000): Promise<void> {
    const { shim, child } = await readTapPids(this.#tapFile);
    const signal = (pid: number | undefined, sig: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        process.kill(pid, sig);
      } catch {
        // Already gone between the read and the signal — the desired state.
      }
    };
    signal(child, "SIGTERM");
    signal(shim, "SIGTERM");
    const gone = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, graceMs);
      timer.unref();
    });
    await Promise.race([this.handshake.child.exit.then(() => undefined), gone]);
    signal(child, "SIGKILL");
    signal(shim, "SIGKILL");
  }
}

/**
 * The same projections, over a finished run.
 *
 * Attribution needs to read the SAME observable out of the live run and the
 * replayed one, and the replayed one is only ever an `ObservedRun` — so the
 * projection cannot live on the host object alone. The result projection is
 * `resultOfStep` in `scenario-kit.ts`; there is deliberately only one.
 */
export function errorKindOfRun(run: ObservedRun, step: string): string | undefined {
  for (let index = run.api.length - 1; index >= 0; index -= 1) {
    const entry = run.api[index];
    if (entry?.kind === "requestError" && entry.step === step) {
      return entry.error.kind ?? entry.error.name;
    }
  }
  return undefined;
}

/** How a step settled, as one comparable string: `ok:<json>` or `err:<kind>`. */
export function settlementOfRun(run: ObservedRun, step: string): string {
  for (let index = run.api.length - 1; index >= 0; index -= 1) {
    const entry = run.api[index];
    if (entry?.kind === "requestOk" && entry.step === step) return `ok:${JSON.stringify(entry.result)}`;
    if (entry?.kind === "requestError" && entry.step === step) {
      return `err:${entry.error.kind ?? entry.error.name}`;
    }
  }
  return "<never settled>";
}

/** A fresh per-scenario scratch root. Callers remove it; nothing here persists. */
export async function scenarioWorkDir(id: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `muse-qa-sdk-${id}-`));
}
