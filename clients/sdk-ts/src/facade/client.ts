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

import type { Connection } from "../connection/connection.js";
import { spawnMspConnection } from "../connection/spawn.js";
import type {
  ExitClassification,
  MuseServeChild,
  SpawnedMspConnection,
} from "../connection/spawn.js";
import { MuseSessionDiscardedError } from "../errors.js";
import { DiscardedSessions } from "./discarded.js";
import { isAbnormalHostDeath, readSessionDurability } from "./host-death.js";
import type { SessionDurabilityProfile } from "./host-death.js";
import { Session } from "./session.js";
import type {
  InitializeParams,
  InitializeResult,
  SessionResumeParams,
  SessionResumeResult,
  SessionStartParams,
  SessionStartResult,
} from "@muse/msp";

/**
 * The params this module builds. `commandId` is excluded because
 * `Connection.command()` is the single minter and stamps it (INV-013).
 */
type StartParams = Omit<SessionStartParams, "commandId">;
type ResumeParams = Omit<SessionResumeParams, "commandId">;

/** Errors (TS2344) when `T` is inhabited — i.e. when a member is unforwarded. */
type AssertNever<T extends never> = T;

/**
 * Every `StartParams` member `startSession` forwards. `config` is allow-listed
 * as intentionally unforwardable: [`SessionConfig`] declares no members yet.
 */
const START_FORWARDED = [
  "approvalMode",
  "providerId",
  "sessionId",
  "workspaceRoot",
  "modelId",
] as const;
type _StartIsExhaustive = AssertNever<
  Exclude<keyof StartParams, (typeof START_FORWARDED)[number] | "config">
>;

/** Every `ResumeParams` member `resumeSession` forwards. */
const RESUME_FORWARDED = ["sessionId", "cursor", "excludeItems", "history"] as const;
type _ResumeIsExhaustive = AssertNever<
  Exclude<keyof ResumeParams, (typeof RESUME_FORWARDED)[number]>
>;

/**
 * Caller-facing options for `session/start` (tdd SS2.5.1).
 *
 * `config` is excluded as well as `commandId`: [`SessionConfig`] declares no
 * members and is reserved for a future Configuration section, so there is
 * nothing a caller could put in it today.
 */
export type StartSessionOptions = Readonly<Omit<SessionStartParams, "commandId" | "config">>;

/** Caller-facing options for `session/resume` (tdd SS2.5.2). */
export type ResumeSessionOptions = Readonly<Omit<SessionResumeParams, "commandId">>;

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
}

/** What `MuseClient.spawn` needs: FR-018's `{ museBin, args?, env? }`, plus the handshake. */
export interface MuseClientSpawnOptions {
  readonly museBin: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  /** REPLACES the child's environment (PATH included) — spread `process.env` to extend it. */
  readonly env?: NodeJS.ProcessEnv;
  /** Client identification, forwarded verbatim into `initialize` (SS1.4). */
  readonly clientInfo: InitializeParams["clientInfo"];
  /** Capability posture; absent means all defaults. */
  readonly capabilities?: InitializeParams["capabilities"];
  /** Raw stderr chunks, drained from process birth and never parsed (INV-010). */
  readonly onStderr?: (chunk: string) => void;
  /** See `MuseServeChildOptions.shutdownTimeoutMs`. */
  readonly shutdownTimeoutMs?: number;
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
  /** Sessions this client opened, so one death notification reaches them all. */
  readonly #sessions = new Set<Session>();
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
    this.#child = options.host?.child;
    this.#initializeResult = options.host?.initializeResult;
    // THE ONE INBOUND PUMP (FR-018/FR-019). `Session.apply` is the only event
    // entry point and `#connection` is private, so without this a spawn-built
    // consumer has no way to hear a single view frame: every turn wait hangs
    // (SS3.1.4) and `onApproval` can never fire. `Connection.onNotification`
    // holds ONE handler — this client claims it, which is part of what
    // "MuseClient owns the connection" means; a consumer that needs the raw
    // feed builds around a bare `Connection` and `Session` instead.
    this.#connection.onNotification((notification) => this.#route(notification));
    // Registered at construction, not at the first session: an EOF can land
    // before any session exists, and the flag has to be read at that moment.
    void this.#connection.closed.then(() => this.#transportClosed());
  }

  /**
   * Deliver one view notification to the session(s) it names.
   *
   * A frame naming NO session is dropped here rather than fed to every
   * session: `Session.apply` already tolerates unknown methods, but only the
   * frames that name a `sessionId` have an owner to route to. A frame naming
   * an UNKNOWN session is dropped for the same reason — routing it anywhere
   * would trip the foreign-frame throw on a session it does not belong to.
   */
  #route(notification: { readonly method: string; readonly params?: unknown }): void {
    const named = (notification.params as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof named !== "string") return;
    for (const session of this.#sessions) {
      if (session.sessionId === named) session.apply(notification);
    }
  }

  /**
   * Spawn an owned host, run the SS1.4 handshake, and hand back a client whose
   * durability profile came from that handshake (FR-018).
   *
   * The profile is READ rather than asked of the caller, which is the whole
   * reason this factory exists beside the bare constructor: SS2.13.1 makes the
   * absent/unrecognized distinction load-bearing, and a caller re-deriving it
   * by hand is a caller that can get it wrong.
   */
  static async spawn(options: MuseClientSpawnOptions): Promise<MuseClient> {
    const handshake = spawnMspConnection({
      command: options.museBin,
      ...(options.args === undefined ? {} : { args: options.args }),
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
      ...(options.shutdownTimeoutMs === undefined
        ? {}
        : { shutdownTimeoutMs: options.shutdownTimeoutMs }),
    });
    let spawned;
    try {
      spawned = await handshake.initialize({
        clientInfo: options.clientInfo,
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      });
    } catch (error) {
      // A failed handshake must not leak the process it already spawned.
      await handshake.close().catch(() => undefined);
      throw error;
    }
    return new MuseClient(spawned.connection, {
      durability: readSessionDurability(spawned.initializeResult),
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
    if (options.modelId != null) params.modelId = options.modelId;
    const raw = await this.#connection.command("session/start", params);
    const result = raw as unknown as SessionStartResult;
    // Keyed by the id the SERVER named, never the one the caller asked for:
    // `sessionId` is a REQUEST on start, and a session keyed by a hopeful id
    // would reject every one of its own events as foreign.
    return this.#openSession(result.session.sessionId, {
      result,
      verb: "session/start",
    });
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
    const raw = await this.#connection.command("session/resume", params);
    const result = raw as unknown as SessionResumeResult;
    return this.#openSession(result.session.sessionId, {
      result,
      verb: "session/resume",
    });
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

  #openSession(
    sessionId: string,
    opening: NonNullable<ConstructorParameters<typeof Session>[0]["opening"]>,
  ): Session {
    const session = new Session({
      connection: this.#connection,
      discarded: this.#discarded,
      durability: this.#durability,
      opening,
      sessionId,
    });
    this.#sessions.add(session);
    return session;
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
