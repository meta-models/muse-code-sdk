/** Node stdio binding and type-state handshake for the MSP connection. */

import { spawn } from "node:child_process";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio,
} from "node:child_process";
import type { InitializeParams, InitializeResult } from "@muse-code/msp";

import {
  Connection,
  ProtocolError,
  submissionTail,
} from "./connection.js";
import type {
  ConnectionOptions,
  DuplexTransport,
  NotificationHandler,
  ProtocolErrorHandler,
  ServerRequestHandler,
} from "./connection.js";
import { checkServedFingerprint } from "../fingerprint.js";
import type { FingerprintWarning } from "../fingerprint.js";

/**
 * What `spawnMspConnection` needs to launch a host: the command to run, plus
 * optional arguments, working directory, environment, connection tuning, a
 * stderr tap, and the shutdown drain budget.
 */
export interface SpawnMspConnectionOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly connection?: ConnectionOptions;
  /** Raw stderr chunks, drained from process birth and never parsed. */
  readonly onStderr?: (chunk: string) => void;
  /** See {@link MuseServeChildOptions.shutdownTimeoutMs}. */
  readonly shutdownTimeoutMs?: number;
}

/**
 * How the host process ended: its exit code, or the signal that ended it.
 * Exactly one of the two is non-null.
 */
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * The SDK's reading of a host exit. Branch on `kind`: a clean shutdown, a
 * crash, an unhandled error, or one of the documented error exits. Every arm
 * but `cleanShutdown` carries its exit evidence (code or signal plus a
 * bounded stderr tail), and, where the meaning is known, whether retrying
 * can help.
 */
export type ExitClassification =
  | { readonly kind: "cleanShutdown" }
  | {
      // SS2.11 makes no retry claim for exit 1: an unhandled error may or may
      // not recur, so the classification carries evidence only (review round
      // 2026-08-15: only 2/5 are never-retry, 3 is fix-config, 4 clears when
      // the holding client exits).
      readonly kind: "unhandledError";
      readonly exitCode: number;
      readonly stderrTail: readonly string[];
    }
  | {
      readonly kind:
        | "usageError"
        | "configError"
        | "leaseUnavailable"
        | "sdkSurfaceUnavailable";
      readonly exitCode: number;
      readonly stderrTail: readonly string[];
      readonly retry: "never" | "fix-config" | "after-lease-release";
    }
  | {
      readonly kind: "crash";
      readonly exitCode: number | null;
      readonly exitSignal: string | null;
      readonly stderrTail: readonly string[];
    };

/**
 * Options for launching an SDK-owned host process: the binary to run, plus
 * optional arguments, working directory, environment, a stderr tap, and the
 * shutdown drain budget.
 */
export interface MuseServeChildOptions {
  readonly museBin: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Raw evidence callback for consumers that also keep a full diagnostic log. */
  readonly onStderr?: (chunk: string) => void;
  /**
   * How long `close()` lets the host drain after stdin EOF before the SDK
   * ends the process it owns. Defaults to SS2.1.2's 30 s host drain timeout;
   * set it to match a host configured with a different one. `0` skips the
   * drain window (SIGTERM at once) — it is NOT an instant kill: the fixed
   * SIGTERM→SIGKILL grace still runs. Must be an integer in
   * `0..2147483647`; anything else throws `RangeError` at spawn.
   */
  readonly shutdownTimeoutMs?: number;
}

const DEFAULT_STDERR_MAX_BYTES = 8 * 1024;
const DEFAULT_STDERR_MAX_LINES = 100;
/** SS2.1.2's default host drain timeout: the whole EOF sequence's budget. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;
/**
 * SIGTERM → SIGKILL grace. Not a knob: by the time it runs the host has
 * already had its whole drain window, so this covers only a signal handler's
 * final flush. Codex's stdio launcher uses the same two seconds.
 */
const SIGTERM_GRACE_MS = 2_000;
/** Node's own `setTimeout` ceiling; past it a delay silently clamps to 1 ms. */
const MAX_SHUTDOWN_TIMEOUT_MS = 2_147_483_647;
const ownedTransport = Symbol("MuseServeChild.transport");
const adoptFlushSource = Symbol("ChildStdioTransport.adoptFlushSource");

/**
 * Shutdown deadline contract: `expired` resolves and never rejects; after
 * `clear()` it may remain pending forever.
 */
interface ShutdownDeadline {
  readonly expired: Promise<void>;
  clear(): void;
}

type ShutdownDeadlineFactory = (budgetMs: number) => ShutdownDeadline;

function makeShutdownDeadline(budgetMs: number): ShutdownDeadline {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  return {
    expired,
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** A client-local evidence budget. Its contents never influence behavior. */
class StderrTail {
  #text = "";

  push(chunk: string): void {
    this.#text += chunk;
    this.#trimLines();
    this.#trimBytes();
  }

  lines(): readonly string[] {
    if (this.#text.length === 0) return [];
    const lines = this.#text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  #trimLines(): void {
    let lineCount = this.#text.split("\n").length;
    if (this.#text.endsWith("\n")) lineCount -= 1;
    while (lineCount > DEFAULT_STDERR_MAX_LINES) {
      const firstBreak = this.#text.indexOf("\n");
      if (firstBreak < 0) break;
      this.#text = this.#text.slice(firstBreak + 1);
      lineCount -= 1;
    }
  }

  #trimBytes(): void {
    const bytes = Buffer.from(this.#text, "utf8");
    if (bytes.byteLength <= DEFAULT_STDERR_MAX_BYTES) return;
    let start = bytes.byteLength - DEFAULT_STDERR_MAX_BYTES;
    // If the byte budget cuts through a UTF-8 scalar, advance to its first
    // complete successor rather than manufacturing replacement text.
    while (start < bytes.byteLength && (bytes[start]! & 0xc0) === 0x80) start += 1;
    this.#text = bytes.subarray(start).toString("utf8");
  }
}

function classifyExit(
  processExit: ProcessExit,
  stderrTail: readonly string[],
): ExitClassification {
  const evidence = [...stderrTail];
  switch (processExit.code) {
    case 0:
      return { kind: "cleanShutdown" };
    case 1:
      return { kind: "unhandledError", exitCode: 1, stderrTail: evidence };
    case 2:
      return { kind: "usageError", exitCode: 2, stderrTail: evidence, retry: "never" };
    case 3:
      return { kind: "configError", exitCode: 3, stderrTail: evidence, retry: "fix-config" };
    case 4:
      // Exit 4 is `sessionInUse` arriving early: another live client holds the
      // lease, and the lease frees itself once that client exits (SS2.11).
      return {
        kind: "leaseUnavailable",
        exitCode: 4,
        stderrTail: evidence,
        retry: "after-lease-release",
      };
    case 5:
      return {
        kind: "sdkSurfaceUnavailable",
        exitCode: 5,
        stderrTail: evidence,
        retry: "never",
      };
    default:
      return {
        kind: "crash",
        exitCode: processExit.code,
        exitSignal: processExit.signal,
        stderrTail: evidence,
      };
  }
}

/**
 * Is this `stdin.end()` error the benign close race — the child exited
 * between the liveness check and the end() call, so its stdin is already
 * gone? That IS the closed end-state close() wants (SS2.11: the caller
 * still awaits `exited` and gates on the exit code); anything else is a
 * real failure. `ECANCELED` is the same owned-teardown race one stage later:
 * the SIGTERM->SIGKILL backstop destroys stdin while a wedged write is still
 * queued, and libuv cancels that write instead of erroring it. Exported only
 * for its deterministic unit test.
 */
export function isBenignCloseRace(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ERR_STREAM_DESTROYED" || code === "EPIPE" || code === "ECANCELED";
}

/**
 * Node clamps a `setTimeout` delay that is non-finite or > 2^31-1 down to
 * 1 ms, so an out-of-range budget would silently become "kill almost
 * immediately" and fabricate a crash row for a host that was draining
 * normally — a row FM-002's ephemeral discard then acts on (PR #22819
 * review). Refuse it at the owning boundary instead of clamping.
 */
function assertShutdownTimeout(shutdownTimeoutMs: number): void {
  if (
    !Number.isInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs < 0 ||
    shutdownTimeoutMs > MAX_SHUTDOWN_TIMEOUT_MS
  ) {
    throw new RangeError(
      `shutdownTimeoutMs must be an integer in 0..${MAX_SHUTDOWN_TIMEOUT_MS}, got ${String(shutdownTimeoutMs)}`,
    );
  }
}

/**
 * Internal transport over an already-spawned child's stdio. Exported from
 * this MODULE only (never the package barrel) so the deterministic
 * close()-race tests can construct it around a stub child — the live arm
 * awaits `exited` first and cannot reach the race branch (PR #15641 review).
 */
export class ChildStdioTransport implements DuplexTransport {
  readonly child: ChildProcessWithoutNullStreams;
  readonly incoming: AsyncIterable<string>;
  readonly exited: Promise<ProcessExit>;
  readonly #shutdownTimeoutMs: number;
  readonly #makeShutdownDeadline: ShutdownDeadlineFactory;
  // True only when the boundary that SPAWNED this child made it a process-
  // group leader (FR-017b). Never inferred from the child itself: a test
  // handing the transport an ordinary child keeps the direct-kill path.
  readonly #ownsProcessGroup: boolean;
  #closing: Promise<void> | undefined;
  // The default `flushed` for closes routed AROUND the connection — notably
  // the public `child.close()`. Without it, step 0 existed only for
  // Connection-routed closes while the contract claimed all three surfaces
  // behaved identically, and `#closing ??=` let whichever call won the race
  // discard the other's submission promise (PR #22819 round 4).
  #defaultFlushed: (() => Promise<void>) | undefined;

  constructor(
    child: ChildProcessWithoutNullStreams,
    onStderr?: (chunk: string) => void,
    shutdownTimeoutMs: number = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    ownsProcessGroup = false,
    /** Deterministic-test seam; production always uses `makeShutdownDeadline`. */
    deadlineFactory: ShutdownDeadlineFactory = makeShutdownDeadline,
  ) {
    this.child = child;
    assertShutdownTimeout(shutdownTimeoutMs);
    this.#shutdownTimeoutMs = shutdownTimeoutMs;
    this.#ownsProcessGroup = ownsProcessGroup;
    this.#makeShutdownDeadline = deadlineFactory;
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => onStderr?.(chunk));
    // Node delivers a failed stdin write to BOTH the write callback and a
    // later 'error' event; with no listener that event kills the embedding
    // process (FM-001). The permanent no-op absorbs it — the write/end
    // callbacks below carry the same error to the real rejection path.
    this.child.stdin.on("error", () => {});
    this.incoming = this.#stdoutChunks();
    this.exited = new Promise<ProcessExit>((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("close", (code, signal) => resolve({ code, signal }));
    });
    // Mark handled at birth: a spawn failure (e.g. ENOENT) rejects `exited`
    // before anyone can await it, and the default unhandled-rejection policy
    // would kill the consumer. Later awaiters still receive the rejection.
    this.exited.catch(() => {});
  }

  async write(chunk: string): Promise<void> {
    if (this.child.stdin.destroyed) throw new ProtocolError("spawned MSP host stdin is closed");
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(chunk, "utf8", (error) => (error ? reject(error) : resolve()));
    });
  }

  /**
   * The single owner of shutdown (#15943). EOF first, then bounded: SS2.1.2
   * gives the host a drain window and says the remainder past it has crash
   * semantics, so past the window the SDK ends the process it owns rather
   * than waiting on an EOF that may never come. Memoized, so concurrent and
   * repeated calls share one attempt and one set of timers.
   */
  /** Module-private friend seam used by the handshake that owns both sides. */
  [adoptFlushSource](source: () => Promise<void>): void {
    this.#defaultFlushed = source;
  }

  async close(flushed?: Promise<void>): Promise<void> {
    this.#closing ??= this.#shutdown(flushed ?? this.#defaultFlushed?.());
    await this.#closing;
  }

  async #shutdown(flushed?: Promise<void>): Promise<void> {
    // ONE budget covers the whole shutdown, flush wait included, so handing
    // the connection's submission promise in here cannot double the bound.
    const deadline = this.#makeShutdownDeadline(this.#shutdownTimeoutMs);
    try {
      // Frames the connection accepted before close() must reach the stream
      // ahead of EOF (PR #22819 round 3); a peer that never drains simply
      // spends the drain window here instead of after EOF.
      if (flushed !== undefined) await this.#beforeDeadline(flushed, deadline.expired);
      return await this.#shutdownAfterFlush(deadline.expired);
    } finally {
      deadline.clear();
    }
  }

  async #shutdownAfterFlush(deadline: Promise<void>): Promise<void> {
    // The EOF attempt must NEVER gate the ladder (PR #22819 review, P0). Two
    // reachable paths leave it unsettled forever, and both are the #15943
    // wedge itself: a host that stopped READING stdin never flushes a filled
    // pipe, so `end()`'s callback never fires; and a non-benign end() error
    // would reject here, before a single signal is sent — memoized, so every
    // later close() replays that rejection with the child still alive. Start
    // the clock regardless and await the EOF outcome AFTER the child is gone,
    // where a pending write settles as the benign EPIPE race and a real error
    // still surfaces to the caller.
    const eof = this.#endStdin();
    eof.catch(() => {});
    await this.#awaitExitOrTerminate(deadline);
    await eof;
  }

  async #endStdin(): Promise<void> {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    await new Promise<void>((resolve, reject) => {
      // The destroyed/writableEnded guard above is racy: the child can exit
      // between it and end(), and Node then reports ERR_STREAM_DESTROYED
      // asynchronously (seen on the slower CI runners driving the real
      // serve-fixture child, PR #15641). That race is the end-state close()
      // wants, so it resolves; a real error still rejects.
      this.child.stdin.end((error?: Error | null) =>
        error === null || error === undefined || isBenignCloseRace(error)
          ? resolve()
          : reject(error),
      );
    });
  }

  /**
   * Escalate only as far as the host forces. Every stage ends at the child's
   * REAL exit, so `exited` — and every classification derived from it — stays
   * a function of the observed `(code, signal)` pair (INV-011). A signal is a
   * way to reach an exit, never a substitute for observing one.
   */
  async #awaitExitOrTerminate(deadline: Promise<void>): Promise<void> {
    if (await this.#beforeDeadline(this.#settled(), deadline)) return;
    this.#signal("SIGTERM");
    if (await this.#settledWithin(SIGTERM_GRACE_MS)) return;
    // Past SIGTERM, drop our end of the pipe ourselves (PR #22819 round 3).
    // Nothing else does, so a write the host never drained keeps `stdin`
    // open — and the child's `close` event, which `exited` and the trailing
    // EOF await both wait on, needs the stdio closed. Waiting for that write
    // to error out on its own is the last unbounded stage; this removes it.
    this.child.stdin.destroy();
    this.#signal("SIGKILL");
    await this.#settled();
  }

  /**
   * One signal per escalation stage, delivered to the whole owned process
   * group where this spawn created one (FR-017b, #22777). The child PID
   * alone is not enough: a grandchild that inherited the host's stdout
   * keeps the `close` event — which `exited` and every stage here wait
   * on — from firing even after the child itself is gone, and it never
   * receives a child-targeted signal at all. A group signal that fails for
   * any reason (expected: `ESRCH`, the whole group already exited between
   * stages) falls through to the direct path, which Node makes a no-op on
   * an exited child — the ladder must never rethrow out of a stage.
   */
  #signal(signal: NodeJS.Signals): void {
    const pid = this.child.pid;
    if (this.#ownsProcessGroup && pid !== undefined) {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fall through to the direct-child path, safe on every failure here.
      }
    }
    this.child.kill(signal);
  }

  /** True once `exited` settles either way — a rejection means no live child. */
  async #settledWithin(budgetMs: number): Promise<boolean> {
    return await this.#within(this.#settled(), budgetMs);
  }

  /** True if `work` settles before the one shared shutdown deadline fires. */
  async #beforeDeadline(work: Promise<unknown>, deadline: Promise<void>): Promise<boolean> {
    return await Promise.race([
      work.then(() => true, () => true),
      deadline.then(() => false),
    ]);
  }

  /** True if `work` settles inside `budgetMs`; false when the budget expires. */
  async #within(work: Promise<unknown>, budgetMs: number): Promise<boolean> {
    // Deliberately ambient (NOT this.#makeShutdownDeadline): the SIGTERM grace
    // window is outside the one shared shutdown budget the injected seam models.
    const deadline = makeShutdownDeadline(budgetMs);
    try {
      return await this.#beforeDeadline(work, deadline.expired);
    } finally {
      deadline.clear();
    }
  }

  /**
   * `exited` REJECTS when the spawn itself failed (ENOENT). There is no
   * process to end and no exit to observe, so shutdown is complete; the
   * rejection still reaches the caller through its own `await exited`
   * (`MuseServeChild.close()`, `MspHandshake.close()`), unchanged.
   */
  async #settled(): Promise<void> {
    await this.exited.catch(() => {});
  }

  async *#stdoutChunks(): AsyncIterable<string> {
    for await (const chunk of this.child.stdout) yield String(chunk);
  }
}

/** One owned MSP host process with SS2.11 diagnostics and total exit mapping. */
export class MuseServeChild {
  readonly #tail = new StderrTail();
  readonly #transport: ChildStdioTransport;
  readonly exit: Promise<ExitClassification>;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    onStderr?: (chunk: string) => void,
    shutdownTimeoutMs?: number,
    ownsProcessGroup = false,
  ) {
    this.#transport = new ChildStdioTransport(
      child,
      (chunk) => {
        this.#tail.push(chunk);
        onStderr?.(chunk);
      },
      shutdownTimeoutMs,
      ownsProcessGroup,
    );
    this.exit = this.#transport.exited.then((status) => classifyExit(status, this.#tail.lines()));
    // A spawn error can reject before a consumer attaches its await. Mark the
    // derived promise handled at birth without changing what later awaiters see.
    this.exit.catch(() => {});
  }

  static spawn(options: MuseServeChildOptions): MuseServeChild {
    // Validate BEFORE spawning: a throw from the transport constructor would
    // otherwise leave the child it was meant to own already running.
    if (options.shutdownTimeoutMs !== undefined) assertShutdownTimeout(options.shutdownTimeoutMs);
    // POSIX: own a whole process group, not just the child (FR-017b,
    // #22777). `detached` makes the host the leader of a new group (and
    // session), so escalation can end a grandchild holding the inherited
    // stdout; stdio stays piped, so nothing else about ownership changes.
    // Windows keeps the child-only path — group signalling via a negative
    // PID is a POSIX primitive, and pretending otherwise would fake
    // subtree containment there.
    const ownsProcessGroup = process.platform !== "win32";
    const spawnOptions: SpawnOptionsWithoutStdio = {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      detached: ownsProcessGroup,
    };
    return new MuseServeChild(
      spawn(options.museBin, [...(options.args ?? [])], spawnOptions),
      options.onStderr,
      options.shutdownTimeoutMs,
      ownsProcessGroup,
    );
  }

  get stderrTail(): readonly string[] {
    return this.#tail.lines();
  }

  /** Module-private friend seam used by the handshake machine for this child. */
  [ownedTransport](): ChildStdioTransport {
    return this.#transport;
  }

  async close(): Promise<ExitClassification> {
    await this.#transport.close();
    return await this.exit;
  }
}

/** The only public state before `initialized`: callers cannot send traffic. */
export class MspHandshake {
  readonly #connection: Connection;
  readonly child: MuseServeChild;
  readonly #transport: ChildStdioTransport;
  #started = false;

  constructor(options: SpawnMspConnectionOptions) {
    this.child = MuseServeChild.spawn({
      museBin: options.command,
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      ...(options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    });
    this.#transport = this.child[ownedTransport]();
    this.#connection = new Connection(this.#transport, options.connection);
    // Make step 0 true on ALL THREE close surfaces, not only this class's:
    // `child.close()` and `spawned.child.close()` are public, and without
    // this they ended the host's input while a just-accepted frame was still
    // queued on a microtask (PR #22819 round 4).
    this.#transport[adoptFlushSource](() => this.#connection[submissionTail]());
  }

  get exited(): Promise<ProcessExit> {
    return this.#transport.exited;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.#connection.onServerRequest(handler);
  }

  onNotification(handler: NotificationHandler): void {
    this.#connection.onNotification(handler);
  }

  onProtocolError(handler: ProtocolErrorHandler): void {
    this.#connection.onProtocolError(handler);
  }

  async close(): Promise<ProcessExit> {
    await this.#connection.close();
    return await this.#transport.exited;
  }

  async initialize(params: InitializeParams): Promise<SpawnedMspConnection> {
    if (this.#started) throw new ProtocolError("initialize may be sent only once per connection");
    this.#started = true;
    const raw = await this.#connection.request(
      "initialize",
      params as unknown as Record<string, unknown>,
    );
    const result = raw as unknown as InitializeResult;
    if (typeof result.schema?.fingerprint !== "string") {
      throw new ProtocolError("initialize result has no schema fingerprint");
    }
    const fingerprintWarning = checkServedFingerprint(result.schema.fingerprint);
    this.#connection.notify("initialized");
    await this.#connection.flush();
    return new SpawnedMspConnection(
      this.#connection,
      this.#transport,
      this.child,
      result,
      fingerprintWarning,
    );
  }
}

/** A fully initialized connection plus its owned process boundary. */
export class SpawnedMspConnection {
  readonly connection: Connection;
  readonly child: MuseServeChild;
  readonly initializeResult: InitializeResult;
  readonly fingerprintWarning: FingerprintWarning | undefined;
  readonly exited: Promise<ProcessExit>;
  readonly #transport: ChildStdioTransport;

  constructor(
    connection: Connection,
    transport: ChildStdioTransport,
    child: MuseServeChild,
    initializeResult: InitializeResult,
    fingerprintWarning: FingerprintWarning | undefined,
  ) {
    this.connection = connection;
    this.#transport = transport;
    this.child = child;
    this.initializeResult = initializeResult;
    this.fingerprintWarning = fingerprintWarning;
    this.exited = transport.exited;
  }

  async close(): Promise<ProcessExit> {
    await this.connection.close();
    return await this.#transport.exited;
  }
}

/** Spawn one owned host and begin its SS1.4 handshake state machine. */
export function spawnMspConnection(options: SpawnMspConnectionOptions): MspHandshake {
  return new MspHandshake(options);
}
