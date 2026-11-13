/**
 * `MuseClient` — the SS7.1 facade's session-opening half (FR-018, T030).
 *
 * It turns the two v1 session verbs into correctly-shaped `session/start` /
 * `session/resume` params and hands back a WIRED `Session`. It frames nothing
 * and mints nothing: `Connection.command()` stamps the `commandId` from the
 * single injected mint, so INV-013's single-minter property is preserved by
 * DELEGATION rather than re-implemented here.
 *
 * IT OWNS TWO FACTS NO OTHER LAYER HOLDS, and that is why obligations (b) and
 * (c) of T030 live here rather than on `Session`:
 *
 *  - WHETHER A CLOSE WAS OURS. `Connection` is duplex-generic; a transport
 *    cannot tell a peer's hang-up from its own shutdown. SS2.13.3b counts
 *    "process exit **or transport EOF**" as a death, so somebody has to know
 *    the difference, and only the layer that owns `close()` does.
 *  - WHAT AN EARLIER DEATH DISCARDED. `DiscardedSessions` is client-scoped, so
 *    a `commandId` refusal and a withheld reattach survive the `Session` object
 *    that died — which is exactly what "do not replay the SESSION's commandIds"
 *    requires of a client that then opens a new session.
 *
 * OPTIONAL MEANS OMITTED, NEVER `null` (tdd SS1.2). Every member this module
 * can leave unset is optional-non-nullable in the generated params, so an
 * unset member is dropped from the frame rather than nulled. The guards below
 * are LOOSE (`!= null`) on purpose: the types only bind strict TypeScript
 * consumers, and a plain-JS caller reaching the built `dist` can pass an
 * explicit `null` that a `!== undefined` guard would forward verbatim. `false
 * != null` is true, so `excludeItems: false` still serializes.
 *
 * The params and the caller options are both COMPOSED from the generated
 * types rather than restated (INV-001: narrow and compose, never restate).
 * Composition alone does NOT stop drift, though: the guard chains below are
 * hand-listed, so a regenerated member would be settable by a caller and then
 * silently dropped on the way to the wire. The `AssertNever` pins next to each
 * chain close that gap — add a member upstream and the BUILD fails here until
 * it is forwarded (or explicitly allow-listed as unforwardable).
 */

import type {
  CommandOptions,
  Connection,
  ProtocolErrorHandler,
} from "../connection/connection.js";
import type { DeepReadonly } from "../fold/session-fold.js";
import { discoverMuseBin } from "../connection/discovery.js";
import { initializeAnswered, SIGTERM_GRACE_MS, spawnMspConnection } from "../connection/spawn.js";
import type {
  ExitClassification,
  MuseServeChild,
  MuseServeChildOptions,
  SpawnedMspConnection,
} from "../connection/spawn.js";
import {
  MuseCapabilityNotGrantedError,
  MuseFacadeOwnedMethodError,
  MuseSessionDiscardedError,
  PermissionProfileNotApplied,
} from "../errors.js";
import { DiscardedSessions } from "./discarded.js";
import type { FoldExtension } from "../fold/extension.js";
import { fireExtensions } from "../fold/extension.js";
import { isAbnormalHostDeath, MuseHostDiedError, readSessionDurability } from "./host-death.js";
import type { SessionDurabilityProfile } from "./host-death.js";
import { MspError, peerEndCause, ProtocolError } from "../connection/connection.js";
import { hostStartFailure } from "./host-start.js";
import type { ApprovalFailureHandler, ApprovalHandler } from "./approval.js";
import { pumpDropsApplyResults, Session } from "./session.js";
import type { SessionOpening } from "./session.js";
import type {
  InitializeParams,
  InitializeResult,
  Notification,
  ModelListParams,
  ModelListResult,
  MspMethod,
  SessionConfig,
  SessionListParams,
  SessionListResult,
  SessionResumeParams,
  SessionResumeResult,
  SessionStartParams,
  SessionStartResult,
  UsageReadResult,
} from "@muse-code/msp";

/**
 * The params this module builds. `commandId` is excluded because
 * `Connection.command()` is the single minter and stamps it (INV-013).
 */
type StartParams = Omit<SessionStartParams, "commandId">;
type ResumeParams = Omit<SessionResumeParams, "commandId">;

/**
 * Hears one server notification. Read-only: the frame is the one the session
 * folds, possibly after the listener runs.
 */
export type NotificationObserver = (notification: DeepReadonly<Notification>) => void;

/** Hears what an `onNotification` listener threw or rejected with, with the notification it was handed. */
export type NotificationFailureHandler = (error: unknown, notification: DeepReadonly<Notification>) => void;

/**
 * Run a caller's observer so neither its throw nor an async observer's
 * rejection escapes: in the read loop a throw ends the connection every session
 * shares, and an unhandled rejection kills the embedder.
 */
function observe(call: () => unknown, onFailure: (error: unknown) => void): void {
  let result: unknown;
  try {
    result = call();
  } catch (error) {
    onFailure(error);
    return;
  }
  if (typeof (result as PromiseLike<unknown> | undefined)?.then === "function") {
    (result as PromiseLike<unknown>).then(undefined, onFailure);
  }
}

/** Errors (TS2344) when `T` is inhabited — i.e. when a member is unforwarded. */
type AssertNever<T extends never> = T;

/** One inbound view notification as the connection hands it to `#route`. */
type ViewFrame = { readonly method: string; readonly params?: unknown };

/**
 * Every `StartParams` member `startSession` forwards. `config` is forwarded
 * only behind the `sessionMcp` grant check (`#forwardConfig`),
 * `previousSessionId` and `clear` are excluded because the facade starts root
 * sessions (the predecessor link and the `/clear` marker belong to a client
 * that switches sessions, as does the `switchPolicy` member), and `spawnedBy`
 * because the facade does not expose a spawner yet.
 */
const START_FORWARDED = [
  "approvalMode",
  "config",
  "providerId",
  "sessionId",
  "workspaceRoot",
  "workspaceRoots",
  "modelId",
  "permissionProfile",
  "recoveryMode",
] as const;
/** @internal */
export type _StartIsExhaustive = AssertNever<
  Exclude<
    keyof StartParams,
    (typeof START_FORWARDED)[number] | "previousSessionId" | "clear" | "switchPolicy" | "spawnedBy"
  >
>;

/**
 * Every `ResumeParams` member `resumeSession` forwards; `config` rides the
 * same `sessionMcp` grant check as the start facade above.
 */
const RESUME_FORWARDED = [
  "sessionId",
  "config",
  "cursor",
  "excludeItems",
  "history",
  "modelId",
  "permissionProfile",
  "recoveryMode",
] as const;
/** @internal */
export type _ResumeIsExhaustive = AssertNever<Exclude<keyof ResumeParams, (typeof RESUME_FORWARDED)[number]>>;

/**
 * The wire methods whose state the facade owns, refused by `command`
 * (FR-79107-2). `initialize` is the handshake `spawn` runs; `session/start` and
 * `session/resume` register the `Session` the pump routes to; `turn/start`,
 * `turn/steer`, `turn/unqueue`, `approval/decide`, and `userInput/answer`
 * carry the pending-command, approval, and answer state their verbs keep (a
 * steer is a pending submission and an accepted unqueue retires its queued
 * entry); `view/page` is the gap fill's; and
 * `view/subscribe`/`view/unsubscribe` change the subscription set the pump
 * routes by, so a raw unsubscribe would silently starve a live `Session`.
 */
const FACADE_OWNED_METHODS = [
  "initialize",
  "session/start",
  "session/resume",
  "turn/start",
  "turn/steer",
  "turn/unqueue",
  "approval/decide",
  "userInput/answer",
  "view/page",
  "view/subscribe",
  "view/unsubscribe",
] as const satisfies readonly MspMethod[];
type FacadeOwnedMethod = (typeof FACADE_OWNED_METHODS)[number];
/**
 * The stable facade-owned methods, and only those. The experimental host
 * stop (`host/shutdown`) is the orderly stop `close()` owns too, and the
 * Python twin refuses it, but this package names no experimental-only
 * method: FR-97527-5's leak gate derives that set from the two schema
 * bundles at check time, and a refusal list counts as naming (#99842). A
 * caller that sends it raw owns the host exit that follows.
 */
const FACADE_OWNED: ReadonlySet<string> = new Set(FACADE_OWNED_METHODS);

/**
 * The names `command`/`request` offer: the stable methods the facade does not
 * own, plus any other string, because the generated types this package ships
 * name stable methods only and experimental ones must still go through.
 */
type RawMethodName = Exclude<MspMethod, FacadeOwnedMethod> | (string & {});
/** `M`, or `never` when `M` is a facade-owned literal: keeps the compile-time refusal the `string` fallback would lose. */
type RawMethod<M extends string> = M & (M extends FacadeOwnedMethod ? never : unknown);

/** Every `SessionListParams` member `listSessions` forwards. */
const LIST_FORWARDED = ["cursor", "filter", "limit", "updatedAfter", "workspaceRoot"] as const;
/** @internal */
export type _ListIsExhaustive = AssertNever<Exclude<keyof SessionListParams, (typeof LIST_FORWARDED)[number]>>;

/**
 * The caller's capability posture with `sessionMcp` added to its requests,
 * each requested name once (ADR 32760 D3: the facade requests the grant its
 * `config` forwarding checks). A host grants only what was requested.
 */
function withSessionMcpRequested(
  capabilities: InitializeParams["capabilities"],
): NonNullable<InitializeParams["capabilities"]> {
  const requested = new Set(capabilities?.requestedCapabilities ?? []);
  requested.add("sessionMcp");
  return { ...capabilities, requestedCapabilities: [...requested] };
}

/**
 * The committed profile id a session snapshot claims, or null when the
 * snapshot is silent (the stable bundle strips the member; absent and null
 * both mean unknown, never applied). Structural on purpose: the stable
 * `Session` type carries no `permissionState`, and an unknown wire shape
 * must read as unknown rather than throw.
 */
function committedProfileId(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const state = (snapshot as { permissionState?: unknown }).permissionState;
  if (typeof state !== "object" || state === null) return null;
  const id = (state as { profileId?: unknown }).profileId;
  return typeof id === "string" ? id : null;
}

/**
 * Caller-facing options for `session/start` (tdd SS2.5.1).
 *
 * `commandId` is excluded because the connection mints it; `previousSessionId`,
 * `clear` and `switchPolicy` because the facade starts root sessions, and
 * `spawnedBy` because the facade does not expose a spawner yet.
 * `config.mcpServers` needs the host's `sessionMcp` grant (FR-79107-3).
 */
export type StartSessionOptions = Readonly<
  Omit<SessionStartParams, "commandId" | "previousSessionId" | "clear" | "switchPolicy" | "spawnedBy"> & {
    /**
     * Require the `permissionProfile` selection (TEST-42624-10): when set,
     * the client proves the committed selection equals the requested id —
     * from the start result's `session.permissionState`, else a
     * `session/read` read-back — and throws `PermissionProfileNotApplied`
     * instead of proceeding on the host default. Client-local: never sent
     * on the wire. Setting it without `permissionProfile` is a usage error.
     */
    requirePermissionProfile?: boolean;
  }
>;

/** The resume options' approval members, installed before held frames apply. */
type ResumeApprovalHandlers = Pick<ResumeSessionOptions, "onApproval" | "onApprovalError">;

/**
 * Caller-facing options for `session/resume` (tdd SS2.5.2). `config.mcpServers`
 * needs the host's `sessionMcp` grant, as at start (FR-79107-3).
 */
export type ResumeSessionOptions = Readonly<
  Omit<SessionResumeParams, "commandId"> & {
    /**
     * Answers this session's approvals from its first frame, so an approval
     * the host re-sends right after the resume reply reaches it. The same
     * contract as `session.onApproval`, installed before the frames that
     * arrived with the reply are applied.
     */
    onApproval?: ApprovalHandler;
    /**
     * Hears this session's approval failures from its first frame, as
     * `session.onApprovalError` does later. A failure for an approval that
     * arrived with the resume reply can happen before `resumeSession` returns,
     * so only this option is sure to hear it.
     */
    onApprovalError?: ApprovalFailureHandler;
  }
>;

/**
 * Options for building a `MuseClient` around a connection you already own.
 * `MuseClient.spawn` fills these in for you; supply them yourself only when
 * you compose the client with your own transport and handshake.
 */
export interface MuseClientOptions {
  /**
   * The handshake's `sessionDurability`, read through `readSessionDurability`.
   *
   * REQUIRED, for the same reason `SessionOptions.durability` is: it decides
   * what happens to every in-flight item and command when the host dies
   * (SS2.13.3b), and a default would let a caller skip reading the handshake
   * and silently inherit the wrong obligation. `MuseClient.spawn` supplies it.
   */
  readonly durability: SessionDurabilityProfile;
  /**
   * The owned host, set by `MuseClient.spawn`. A client built around a
   * connection somebody else owns has none, and says so by omitting it — which
   * is why `close()` falls back to closing just the connection.
   */
  readonly host?: SpawnedMspConnection;
  /**
   * Fold extensions (FR-97527-3), consulted for session-less frames here and
   * forwarded to every session this client opens — one registration covers
   * both connection-level state and the per-session fold.
   */
  readonly extensions?: readonly FoldExtension[];
}

/** What `MuseClient.spawn` needs: FR-018's `{ museBin?, args?, env? }`, plus the handshake. */
export interface MuseClientSpawnOptions {
  /**
   * The host binary. Omitted means the first executable `muse` on the
   * process's `PATH` (FR-79107-1); with neither, `spawn` rejects with
   * `MuseHostDiscoveryError` before starting anything.
   */
  readonly museBin?: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** REPLACES the child's environment (PATH included) — spread `process.env` to extend it. */
  readonly env?: NodeJS.ProcessEnv;
  /** Client identification, forwarded verbatim into `initialize` (SS1.4). */
  readonly clientInfo: InitializeParams["clientInfo"];
  /**
   * Capability posture; absent means all defaults. `spawn` adds `sessionMcp`
   * to `requestedCapabilities` (keeping yours) so per-session MCP servers can
   * be granted (ADR 32760 D3).
   */
  readonly capabilities?: InitializeParams["capabilities"];
  /** Raw stderr chunks, drained from process birth and never parsed (INV-010). */
  readonly onStderr?: (chunk: string) => void;
  /** See `MuseServeChildOptions.shutdownTimeoutMs`. */
  readonly shutdownTimeoutMs?: number;
  /**
   * See `MuseServeChildOptions.spawnFn`: lets an embedder run the handshake
   * and its sessions against an in-memory fake host. Host discovery still
   * runs first, so pass `museBin` (any string; it becomes `spawnFn`'s
   * command) when no `muse` is on `PATH`.
   */
  readonly spawnFn?: MuseServeChildOptions["spawnFn"];
  /**
   * Fold extensions (FR-97527-3): connection-level state plus every
   * session this client opens. See `MuseClientOptions.extensions`.
   */
  readonly extensions?: readonly FoldExtension[];
}

/**
 * Your entry point to the SDK.
 *
 * Spawn a host with `MuseClient.spawn`, then open conversations with
 * `startSession` or `resumeSession`. The client owns the connection: it
 * routes every server event to the session it belongs to and reports a host
 * death to all of them. Call `close` to shut the host down cleanly.
 */
export class MuseClient {
  readonly #connection: Connection;
  readonly #durability: SessionDurabilityProfile;
  readonly #discarded: DiscardedSessions;
  readonly #extensions: readonly FoldExtension[];
  /** Sessions this client opened, so one death notification reaches them all. */
  readonly #sessions = new Set<Session>();
  /** `onNotification` subscriptions, one entry each so a function added twice unsubscribes once per call. */
  readonly #listeners = new Set<{ readonly listener: NotificationObserver }>();
  readonly #notificationFailureHandlers = new Set<{ readonly handler: NotificationFailureHandler }>();
  readonly #protocolErrorHandlers = new Set<{ readonly handler: ProtocolErrorHandler }>();
  /**
   * Set on the first `onProtocolError`, which then claims the connection's one
   * handler: a client nobody observes leaves the caller's own handler alone.
   */
  #protocolErrorsClaimed = false;
  /**
   * Frames naming a session this client has not registered YET, held only
   * while a `session/start`/`session/resume` is in flight (#49790): the host
   * flushes the resume replay BEFORE the result, and the promise awaiting that
   * result resumes only after the whole chunk has been routed. `#route` holds,
   * `#openSession` drains, `#open` clears when the last open settles.
   */
  readonly #held = new Map<string, ViewFrame[]>();
  #opening = 0;
  /** The spawned host, when `spawn` built this client. */
  readonly #child: MuseServeChild | undefined;
  readonly #initializeResult: InitializeResult | undefined;
  /**
   * Set by `close()` BEFORE the connection is torn down.
   *
   * This flag is the entire discriminator for obligation (b): the same
   * transport EOF is an orderly SS2.1.2 shutdown when we caused it and an
   * abnormal death when we did not, and nothing below this layer can tell.
   */
  #closing = false;
  /** Latched by an abnormal EOF, so a later `resumeSession` can be withheld. */
  #hostDied = false;

  constructor(connection: Connection, options: MuseClientOptions) {
    this.#connection = connection;
    this.#durability = options.durability;
    // Client-owned, never injected: SS2.13.3b is a one-client obligation and
    // no current consumer spans two clients over one host lineage, so a
    // sharing knob would be declared-ahead surface (Constitution XI).
    this.#discarded = new DiscardedSessions();
    this.#extensions = options.extensions ?? [];
    this.#child = options.host?.child;
    this.#initializeResult = options.host?.initializeResult;
    // THE ONE INBOUND PUMP (FR-018/FR-019). `Session.apply` is the only event
    // entry point and `#connection` is private, so without this a spawn-built
    // consumer has no way to hear a single view frame: every turn wait hangs
    // (SS3.1.4) and `onApproval` can never fire. `Connection.onNotification`
    // holds ONE handler — this client claims it, which is part of what
    // "MuseClient owns the connection" means; a caller hears the feed through
    // `onNotification`, after `#route` has handed each frame to its session
    // (a frame held while that session's open is in flight is heard first).
    this.#connection.onNotification((notification) => {
      this.#route(notification);
      for (const entry of [...this.#listeners]) this.#notify(entry.listener, notification);
    });
    // A question or approval still open at resume is re-sent as a
    // `userInput/request` or `approval/request` server request (tdd SS5.6,
    // SS5.10). Each is routed in arrival order and answered with the SS5.3.3
    // receipt `{}`: a question as the `userInput/requested` twin it shares
    // params with, so its session lists it, and an approval as itself, which
    // the session routes to its approval handler. The receipt does not wait on
    // `#route` finding the session: a request read during an open is held
    // before that session exists. Every other server-request method keeps the
    // `-32601` a bare `Connection` answers.
    this.#connection.onServerRequest(async (request) => {
      if (request.method === "userInput/request") {
        this.#route({ method: "userInput/requested", params: request.params });
        return {};
      }
      if (request.method === "approval/request") {
        this.#route({ method: request.method, params: request.params });
        return {};
      }
      throw new MspError({
        code: -32601,
        message: `method not found: ${request.method}`,
        data: { kind: "methodNotFound", retryable: false },
      });
    });
    // Registered at construction, not at the first session: an EOF can land
    // before any session exists, and the flag has to be read at that moment.
    void this.#connection.closed.then(() => this.#transportClosed());
    // A call the connection fails because the host died says how it ended;
    // read at the EOF, so a close() of ours leaves the bare error.
    this.#connection[peerEndCause](() => this.#hostDeathCause());
  }

  /**
   * Deliver one view notification to the session(s) it names.
   *
   * A frame naming NO session goes to the connection extensions (FR-97527-3:
   * host-wide state names no session) rather than to every session:
   * `Session.apply` already tolerates unknown methods, but only the
   * frames that name a `sessionId` have a session owner to route to. A frame
   * naming an UNKNOWN session is dropped for the same reason — routing it
   * anywhere would trip the foreign-frame throw on a session it does not
   * belong to — UNLESS an open is in flight, when it may be that open's own
   * session named by the server before the awaiting promise has run (#49790):
   * then it is held for `#openSession` to fold, or for `#open` to clear.
   */
  #route(notification: ViewFrame): void {
    const named = (notification.params as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof named !== "string") {
      // FR-97527-3: connection extensions share the fold's call-and-report
      // loop, objects-only guard included.
      fireExtensions(this.#extensions, notification.method, notification.params);
      return;
    }
    let delivered = false;
    for (const session of this.#sessions) {
      if (session.sessionId === named) {
        session.apply(notification);
        delivered = true;
      }
    }
    if (delivered || this.#opening === 0) return;
    const held = this.#held.get(named);
    if (held === undefined) this.#held.set(named, [notification]);
    else held.push(notification);
  }

  /** Call one listener, sending its throw or rejection to every `onNotificationError` handler. */
  #notify(listener: NotificationObserver, notification: Notification): void {
    observe(
      () => listener(notification),
      (error) => {
        // A failure observer failing too is swallowed: like
        // `ApprovalRouter.#report`, there is no one left to tell.
        for (const entry of [...this.#notificationFailureHandlers]) {
          observe(() => entry.handler(error, notification), () => undefined);
        }
      },
    );
  }

  /**
   * Spawn an owned host, run the SS1.4 handshake, and hand back a client whose
   * durability profile came from that handshake (FR-018).
   *
   * The profile is READ rather than asked of the caller, which is the whole
   * reason this factory exists beside the bare constructor: SS2.13.1 makes the
   * absent/unrecognized distinction load-bearing, and a caller re-deriving it
   * by hand is a caller that can get it wrong.
   *
   * Rejects with {@link MuseHostDiscoveryError} before starting anything when
   * `museBin` is omitted and no executable `muse` is on `PATH`.
   *
   * Rejects with {@link MuseHostStartError} when the host is lost before the
   * handshake completes (the binary could not be spawned, or the process
   * ended first — exit code or signal plus the bounded stderr tail;
   * `answeredInitialize` says whether it died after a usable answer). A host
   * that answers with a reply the SDK refuses keeps its own error: an
   * `MspError` for an SS1.6 refusal, or a `ProtocolError` (with the whole
   * refused frame on `line`) for a reply the SDK cannot use, such as one with
   * no schema fingerprint.
   */
  static async spawn(options: MuseClientSpawnOptions): Promise<MuseClient> {
    // The process's own PATH, never `options.env`'s: the host is found the
    // way the Rust and Python SDKs find it, whatever environment it gets.
    const command = await discoverMuseBin(options.museBin, process.env["PATH"], process.platform);
    const handshake = spawnMspConnection({
      command,
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      ...(options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
      ...(options.spawnFn === undefined ? {} : { spawnFn: options.spawnFn }),
    });
    let spawned;
    try {
      spawned = await handshake.initialize({
        clientInfo: options.clientInfo,
        capabilities: withSessionMcpRequested(options.capabilities),
      });
    } catch (error) {
      // A failed handshake must not leak the process it already spawned.
      await handshake.close().catch(() => undefined);
      // A host that ANSWERED `initialize` is not a lost host, however it ends
      // once we close it: its answer is the actionable error. "Answered" is
      // evidence that a response frame came back — an SS1.6 `MspError`, or a
      // `ProtocolError` carrying the frame the SDK refused (a malformed or
      // version-skewed reply) — never the error's class alone (#49912).
      // Decided before the exit is read, so our own close ladder can never
      // dress an answer up as a death.
      const answered =
        error instanceof MspError || (error instanceof ProtocolError && error.line !== undefined);
      if (answered) throw error;
      // No refused frame: the host was lost — before answering, or after a
      // usable answer while we sent `initialized` (the error then says so).
      // close() ended at its observed exit (or its spawn failure), so the
      // evidence is settled: the typed error carries the spawn error or the
      // SS2.11 row plus the stderr tail instead of the transport's first
      // symptom (#49791, #49912).
      throw await hostStartFailure(handshake.child, error, handshake[initializeAnswered]());
    }
    return new MuseClient(spawned.connection, {
      durability: readSessionDurability(spawned.initializeResult),
      ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
      host: spawned,
    });
  }

  /**
   * The handshake result, when this client was built by `spawn`.
   *
   * A plain `Error`, not a typed one: reading this off a client that was not
   * built by `spawn` is API misuse, not a protocol STATE an embedder branches
   * on — a typed class here would send the SS2.13.3b recovery path chasing a
   * host death that never happened.
   */
  get initializeResult(): InitializeResult {
    if (this.#initializeResult === undefined) {
      throw new Error("initializeResult is only available on a client built by MuseClient.spawn");
    }
    return this.#initializeResult;
  }

  /** The host's SS2.11 exit row, when this client was built by `spawn`. */
  get exit(): Promise<ExitClassification> {
    if (this.#child === undefined) {
      // Plain `Error` for the same reason as `initializeResult`: API misuse,
      // not a protocol state.
      throw new Error("exit is only available on a client built by MuseClient.spawn");
    }
    return this.#child.exit;
  }

  /**
   * Settles when the connection closes for any reason: `close()`, the host
   * hanging up, or a transport failure.
   */
  get closed(): Promise<void> {
    return this.#connection.closed;
  }

  /**
   * Hear every server notification in wire order, including those naming no
   * session (`usage/changed`, `account/loginCompleted`) or a session this
   * client did not open. A frame naming a session this client has opened
   * reaches the listener after that session has applied it: folded, or, while
   * the session fills a gap, buffered and folded when the fill completes. One
   * that arrives while its session's start/resume is still in flight reaches
   * the listener first, and the session folds it before the verb returns.
   * Returns the unsubscribe function.
   *
   * The frame is read-only: it is the one the session folds, which for a held
   * or buffered frame happens after the listener runs. Like a `Connection`
   * handler, the listener runs in the read loop, so it must not block. A throw, or an async listener's rejection, goes to every
   * `onNotificationError` handler; the other listeners still hear the frame
   * and the connection stays open.
   */
  onNotification(listener: NotificationObserver): () => void {
    const entry = { listener };
    this.#listeners.add(entry);
    return () => {
      this.#listeners.delete(entry);
    };
  }

  /**
   * Hear what an `onNotification` listener threw or rejected with. With no
   * handler the failure is dropped; either way the pump keeps running.
   * Returns a function that removes this one subscription.
   */
  onNotificationError(handler: NotificationFailureHandler): () => void {
    const entry = { handler };
    this.#notificationFailureHandlers.add(entry);
    return () => {
      this.#notificationFailureHandlers.delete(entry);
    };
  }

  /**
   * Hear each framing or correlation violation the connection detects
   * (`Connection.onProtocolError`). The handler's own throw or rejection is
   * swallowed rather than ending the connection; it is already the observer
   * of failures, so there is no one left to tell. The first call takes over
   * `Connection.onProtocolError`, replacing a handler set there directly (and
   * a later direct `connection.onProtocolError(...)` silences these
   * subscribers). Returns a function that removes this one subscription.
   */
  onProtocolError(handler: ProtocolErrorHandler): () => void {
    if (!this.#protocolErrorsClaimed) {
      this.#protocolErrorsClaimed = true;
      this.#connection.onProtocolError((error) => {
        for (const entry of [...this.#protocolErrorHandlers]) {
          observe(() => entry.handler(error), () => undefined);
        }
      });
    }
    const entry = { handler };
    this.#protocolErrorHandlers.add(entry);
    return () => {
      this.#protocolErrorHandlers.delete(entry);
    };
  }

  /** The durability profile every session this client opens inherits. */
  get durability(): SessionDurabilityProfile {
    return this.#durability;
  }

  /** Open a new root session (tdd SS2.5.1). */
  async startSession(options: StartSessionOptions = {}): Promise<Session> {
    const params: StartParams = {};
    if (options.approvalMode != null) params.approvalMode = options.approvalMode;
    if (options.providerId != null) params.providerId = options.providerId;
    if (options.sessionId != null) params.sessionId = options.sessionId;
    if (options.workspaceRoot != null) params.workspaceRoot = options.workspaceRoot;
    if (options.workspaceRoots != null) params.workspaceRoots = options.workspaceRoots;
    if (options.modelId != null) params.modelId = options.modelId;
    if (options.recoveryMode != null) params.recoveryMode = options.recoveryMode;
    // The initial permission-profile selection, forwarded verbatim like the
    // other start members (undefined stays omitted).
    if (options.permissionProfile != null) params.permissionProfile = options.permissionProfile;
    if (options.config != null) params.config = this.#forwardConfig("session/start", options.config);
    // TEST-42624-10: a caller that requires its selection proves it, never
    // assuming the host default. The flag without the member is API misuse
    // (plain Error, like the other misuse guards here), raised pre-wire.
    const required = options.requirePermissionProfile === true;
    if (required && options.permissionProfile == null) {
      throw new Error(
        "requirePermissionProfile needs permissionProfile: require the selection you pass",
      );
    }
    // Keyed by the id the SERVER named, never the one the caller asked for:
    // `sessionId` is a REQUEST on start, and a session keyed by a hopeful id
    // would reject every one of its own events as foreign.
    const session = await this.#open("session/start", params, (raw) => ({
      result: raw as unknown as SessionStartResult,
      verb: "session/start",
    }));
    if (!required) return session;
    return this.#proveSelection(session, options.permissionProfile as string);
  }

  /**
   * Prove a required start selection (TEST-42624-10): the start result's own
   * `session.permissionState` first (absent = unknown, never applied); else a
   * point-in-time `session/read`, which never subscribes. Only `profileId ==
   * requested` proceeds; anything else throws `PermissionProfileNotApplied`
   * BEFORE any turn is sent. The refused session is dropped from the client
   * (no orphan keeps folding for an id the caller can never reach — the SDK
   * has no set/close-by-id verb); the error's `sessionId` is the caller's
   * handle to resume via `sessionId` or start again. A failed read-back
   * propagates: the client still never proceeds on the default.
   */
  async #proveSelection(session: Session, requested: string): Promise<Session> {
    const opening = session.opening;
    const started =
      opening !== undefined && opening.verb === "session/start"
        ? committedProfileId(opening.result.session)
        : null;
    if (started !== null) {
      if (started === requested) return session;
      this.#sessions.delete(session);
      throw new PermissionProfileNotApplied(requested, started, session.sessionId);
    }
    const read = await this.#connection.command("session/read", {
      sessionId: session.sessionId,
    });
    const served = committedProfileId(read["session"]);
    if (served === requested) return session;
    this.#sessions.delete(session);
    throw new PermissionProfileNotApplied(requested, served, session.sessionId);
  }

  /**
   * Load an existing session and subscribe this connection to its view
   * (tdd SS2.5.2).
   *
   * WITHHELD after an ephemeral host death (SS2.13.3b clause 2, "do not attempt
   * to reattach"), and refused on THIS side of the transport: a reattach
   * attempt that reaches the wire has already violated the clause, whatever the
   * server answers.
   */
  async resumeSession(options: ResumeSessionOptions): Promise<Session> {
    this.#assertReattachAllowed(options.sessionId);
    const params: ResumeParams = { sessionId: options.sessionId };
    if (options.cursor != null) params.cursor = options.cursor;
    if (options.excludeItems != null) params.excludeItems = options.excludeItems;
    if (options.history != null) params.history = options.history;
    if (options.modelId != null) params.modelId = options.modelId;
    if (options.recoveryMode != null) params.recoveryMode = options.recoveryMode;
    if (options.permissionProfile != null) params.permissionProfile = options.permissionProfile;
    if (options.config != null) params.config = this.#forwardConfig("session/resume", options.config);
    return this.#open(
      "session/resume",
      params,
      (raw) => ({
        result: raw as unknown as SessionResumeResult,
        verb: "session/resume",
      }),
      { onApproval: options.onApproval, onApprovalError: options.onApprovalError },
    );
  }

  /**
   * List stored sessions (`session/list`), including text search via
   * `filter.text`. A read-only list: rides `request()`, not `command()`
   * (see `Session.listTasks`).
   */
  async listSessions(options: SessionListParams = {}): Promise<SessionListResult> {
    // One list drives both the exhaustiveness pin and the forwarding, so a
    // regenerated member cannot compile yet be dropped on the wire (#76737).
    const params: Record<string, unknown> = {};
    for (const member of LIST_FORWARDED) {
      const value = options[member];
      if (value != null) params[member] = value;
    }
    const ack = await this.#connection.request("session/list", params);
    return ack as unknown as SessionListResult;
  }

  /**
   * List the models the host accepts in `Session.setModel` (`model/list`).
   * With `sessionId`, that session's current model is flagged `isActive`. A
   * query: rides `request()`, like `listSessions`.
   */
  async listModels(options: ModelListParams = {}): Promise<ModelListResult> {
    const params: Record<string, unknown> = {};
    if (options.sessionId != null) params["sessionId"] = options.sessionId;
    const ack = await this.#connection.request("model/list", params);
    return ack as unknown as ModelListResult;
  }

  /**
   * Read the host's last-observed subscription usage (`usage/read`) without a
   * model call; `usage` is absent when the host has observed nothing.
   */
  async readUsage(): Promise<UsageReadResult> {
    const ack = await this.#connection.request("usage/read");
    return ack as unknown as UsageReadResult;
  }

  /**
   * Send a wire method directly (FR-79107-2), typically one the facade does
   * not wrap, experimental ones included, through the
   * same `Connection.command()` the verbs use: the connection mints the
   * `commandId`, retries a nothing-admitted refusal under the same id, and
   * checks the ack's echo. `options` are that seam's own. An experimental
   * method needs a client spawned with `capabilities: { experimentalApi: true }`
   * (otherwise the host refuses it with an `MspError` of kind
   * `experimentalRequired`, code -32601) and may change without notice.
   *
   * Refused before anything is written, with `MuseFacadeOwnedMethodError`:
   * the methods whose state the facade owns (`FACADE_OWNED_METHODS`); the
   * experimental host stop is not among them (this package names no
   * experimental-only method), so sent raw it is the caller's own, and the
   * exit it causes reaches your sessions as a host death; `close()` is the
   * orderly stop. Frames
   * the command causes still reach your sessions through the client's one
   * inbound pump; this sends and returns the ack, nothing more. Params and
   * ack stay untyped objects: the generated types carry no method-to-params
   * map, and restating one here would drift from the schema.
   *
   * Each call keeps one fixed-size fingerprint for the connection's lifetime
   * (FR-45137-1), so prefer `request` for a query you poll.
   */
  async command<M extends RawMethodName>(
    method: RawMethod<M>,
    params: Record<string, unknown>,
    options?: CommandOptions,
  ): Promise<Record<string, unknown>> {
    // The type binds TypeScript callers; this binds plain-JS ones.
    if (FACADE_OWNED.has(method)) throw new MuseFacadeOwnedMethodError(method);
    return this.#connection.command(method, params, options);
  }

  /**
   * Send a wire request directly (FR-79107-2), typically a query the facade
   * does not wrap, experimental ones included, through `Connection.request()`:
   * no `commandId`, no retry, and omitted `params` stay off the frame.
   * Refuses the same facade-owned methods as `command`, the same way, and
   * needs the same `experimentalApi` opt-in for an experimental method.
   */
  async request<M extends RawMethodName>(
    method: RawMethod<M>,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (FACADE_OWNED.has(method)) throw new MuseFacadeOwnedMethodError(method);
    return this.#connection.request(method, params);
  }

  /**
   * Shut the host down in an orderly way (SS2.1.2); the shutdown this causes
   * is not reported to your sessions as a host death.
   *
   * The EOF this close produces is NOT a death, which is what `#closing`
   * records.
   *
   * `#closing` covers only the EOF; it must not swallow the EXIT ROW. When the
   * host ignores stdin EOF, `#child.close()` escalates to SIGTERM/SIGKILL and
   * the exit classifies as a crash — an abnormal death under SS2.13.3b no
   * matter who started the close, and one no transport event will ever report
   * here because `#closing` already claimed the EOF. So the classification the
   * close itself returns is forwarded to every session: `hostExited` answers
   * `notADeath` for `cleanShutdown`, keeping the orderly arm inert.
   */
  async close(): Promise<void> {
    this.#closing = true;
    if (this.#child !== undefined) {
      const exit = await this.#child.close();
      if (isAbnormalHostDeath(exit)) {
        for (const session of this.#sessions) session.hostExited(exit);
      }
      return;
    }
    await this.#connection.close();
  }

  /**
   * The window `#route` holds unknown-session frames for: from the request to
   * the Session's registration. Counted, not flagged, so two concurrent opens
   * keep it open until the LAST settles; cleared on settle so a frame that
   * named no session this client opened is held no longer than the open it
   * rode in with (#49790).
   */
  async #open(
    verb: "session/start" | "session/resume",
    params: StartParams | ResumeParams,
    opening: (raw: Record<string, unknown>) => SessionOpening,
    approvals: ResumeApprovalHandlers = {},
  ): Promise<Session> {
    this.#opening += 1;
    try {
      const opened = opening(await this.#connection.command(verb, params));
      return this.#openSession(opened.result.session.sessionId, opened, approvals);
    } finally {
      this.#opening -= 1;
      if (this.#opening === 0) this.#held.clear();
    }
  }

  #openSession(sessionId: string, opening: SessionOpening, approvals: ResumeApprovalHandlers): Session {
    const session = new Session({
      connection: this.#connection,
      discarded: this.#discarded,
      durability: this.#durability,
      extensions: this.#extensions,
      opening,
      sessionId,
    });
    // Before the held frames below: an approval re-sent with the resume reply
    // must find the handler, and its failure the observer.
    if (approvals.onApprovalError !== undefined) session.onApprovalError(approvals.onApprovalError);
    if (approvals.onApproval !== undefined) session.onApproval(approvals.onApproval);
    // `#route` drops what `apply` returns (FR-81734-1).
    session[pumpDropsApplyResults]();
    this.#sessions.add(session);
    // The frames that named this session while its verb was in flight fold
    // NOW, in arrival order — synchronously, so nothing the pump routes next
    // can overtake them.
    const held = this.#held.get(sessionId);
    if (held !== undefined) {
      this.#held.delete(sessionId);
      for (const frame of held) session.apply(frame);
    }
    return session;
  }

  /**
   * The `config` to forward, or a typed refusal before anything is sent
   * (FR-79107-3). Per-session MCP servers need the `sessionMcp` grant in the
   * handshake this client was built with (`spawn` requests it; a caller's own
   * handshake must request it too); a client given no handshake cannot show
   * it. A config naming no server needs no grant, as on the host (ADR 32760 D3).
   */
  #forwardConfig(method: "session/start" | "session/resume", config: SessionConfig): SessionConfig {
    if (config.mcpServers == null || Object.keys(config.mcpServers).length === 0) return config;
    if (this.#initializeResult?.grantedCapabilities.includes("sessionMcp") === true) return config;
    throw new MuseCapabilityNotGrantedError(
      "sessionMcp",
      method,
      "config.mcpServers needs the sessionMcp grant, which this connection's handshake does not hold (MuseClient.spawn requests it; a host withholds it when per-session MCP is turned off)",
    );
  }

  #assertReattachAllowed(sessionId: string): void {
    // Two facts, both recorded by an ephemeral discharge: THIS session was
    // discarded, or this client's own ephemeral host died (in which case there
    // is nothing on the other end to reattach TO, whatever id is asked for).
    if (this.#discarded.sessionIds.has(sessionId)) {
      throw new MuseSessionDiscardedError(
        `session ${sessionId} was discarded after an ephemeral host death; it cannot be resumed`,
      );
    }
    if (this.#hostDied && !this.#survivesHostDeath()) {
      throw new MuseSessionDiscardedError(
        "this client's ephemeral host died; SS2.13.3b forbids reattaching to it",
      );
    }
  }

  #survivesHostDeath(): boolean {
    return this.#durability.kind === "durable";
  }

  /**
   * Waits for the exit at most `SIGTERM_GRACE_MS`: a host that closed stdout
   * but keeps running must not hold the failed calls past today's bare error.
   */
  #hostDeathCause(): Promise<MuseHostDiedError | undefined> | undefined {
    if (this.#closing || this.#child === undefined) return undefined;
    const died = this.#child.exit.then(
      (exit) => (isAbnormalHostDeath(exit) ? new MuseHostDiedError(exit) : undefined),
      () => undefined,
    );
    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, SIGTERM_GRACE_MS, undefined);
    });
    return Promise.race([died, grace]).finally(() => clearTimeout(timer));
  }

  /**
   * The transport reached EOF. If this client did not cause it, that is
   * SS2.13.3b's second death notification (T030 obligation b) and every session
   * this client opened discharges through the SAME `Session.hostExited` path
   * the process exit uses — including its latch, so whichever notification
   * arrives second replays the first one's report instead of a half delta.
   */
  #transportClosed(): void {
    if (this.#closing) return;
    this.#hostDied = true;
    for (const session of this.#sessions) session.hostExited({ kind: "transportEof" });
  }
}
