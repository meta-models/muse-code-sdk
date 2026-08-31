/**
 * `Session` — the SS7.1 facade's composition of the transport-less core
 * (spec 14990 FR-018 / T030, FM-002 / T030b).
 *
 * It owns a `SessionFold` and a `PendingCommandSet`, routes folded view events
 * to per-turn handles, and discharges the ephemeral host-death obligation.
 * Like everything else in this SDK it holds no durable state (spec Lifecycle &
 * Composition): every fact it reports came from a server event or from the two
 * stores it composes.
 *
 * The SS4.8 splice-fill (FR-020, T032) is here too, in `gap-fill.ts`: this
 * layer owns it because the recipe needs client→server I/O (`view/page`) and
 * because the buffer it splices is the same routing path the iterators read.
 *
 * Everything else FR-018/FR-019 name IS here as of #23980: `sendUserTurn` over
 * the enrolled `turn/start` row, `onApproval`'s idempotent `approval/decide`
 * submission, and the SS4.13 retirement drivers that need client->server I/O.
 * The connection is an OPTIONAL seam: a fold-only `Session` — the transport-less
 * composition every earlier arm builds — stays valid and refuses the submit
 * verbs loudly rather than dropping a caller's input on the floor.
 */

import { SessionFold } from "../fold/session-fold.js";
import type { FoldOutcome, ViewEvent } from "../fold/session-fold.js";
import { PendingCommandSet } from "../pending/pending-command-set.js";
import type {
  PendingRetirement,
  ReplayAnswer,
  SnapshotJoinFacts,
} from "../pending/pending-command-set.js";
import type { Connection } from "../connection/connection.js";
import { ApprovalRouter } from "./approval.js";
import type { ApprovalFailureHandler, ApprovalHandler } from "./approval.js";
import { TurnSubmitter } from "./turn-submit.js";
import type { SendUserTurnOptions } from "./turn-submit.js";
import { GapFiller } from "./gap-fill.js";
import type { DrainSink, GapFillFailureHandler, WireFrame } from "./gap-fill.js";
import {
  isAbnormalHostDeath,
  isItemInProgress,
  MuseHostDiedError,
  survivesHostDeath,
} from "./host-death.js";
import { MuseForeignSessionError } from "../errors.js";
import type { DiscardedSessions } from "./discarded.js";
import type {
  HostDeathDischarge,
  HostDeathNotification,
  SessionDurabilityProfile,
} from "./host-death.js";
import { TurnHandle } from "./turn-handle.js";
import type { FoldedItem, Turn } from "./turn-handle.js";

import type {
  ApprovalRequestParams,
  Item,
  ItemDeltaParams,
  ItemKind,
  SessionResumeResult,
  SessionStartResult,
} from "@muse-code/msp";

/** Bound to the generated vocabulary so a misspelling fails `tsc`. */
const USER_MESSAGE: Extract<ItemKind, "userMessage"> = "userMessage";

/**
 * The shared already-settled `io` for an event that triggered no I/O.
 *
 * A fresh `Promise.resolve([])` per `apply` would allocate on the hot
 * notification path for the overwhelming majority of frames, which carry
 * neither a pending command nor an approval.
 */
const NO_IO: Promise<readonly never[]> = Promise.resolve([]);

/**
 * Which verb opened this session, and what it answered.
 *
 * `MuseClient.startSession`/`resumeSession` resolve to a `Session` (FR-018), so
 * without this the typed wire result — `viewCursor`, the resume history, the
 * server's own `sessionId` — would be swallowed by the wrapper. Discriminated
 * by the verb rather than a bare union, so a consumer that only handles resume
 * cannot silently read a start result's absent members.
 */
export type SessionOpening =
  | { readonly verb: "session/start"; readonly result: SessionStartResult }
  | { readonly verb: "session/resume"; readonly result: SessionResumeResult };

/**
 * Options for constructing a `Session` directly. Sessions opened through
 * `MuseClient` are configured for you; build one yourself when you manage
 * the connection — or omit the connection to fold recorded events with no
 * host at all.
 */
export interface SessionOptions {
  readonly sessionId: string;
  /**
   * Required, not defaulted. Whether this session survives its host decides
   * what happens to every in-flight item and command when the host dies
   * (SS2.13.3b), and a default would let a caller skip reading the handshake
   * and silently inherit the wrong obligation. `readSessionDurability` turns
   * an `InitializeResult` into this value.
   */
  readonly durability: SessionDurabilityProfile;
  /**
   * The wire seam the submit verbs author through. OPTIONAL because fold-only
   * construction is a real current use, not a hypothetical one: every
   * transport-less arm in this package builds a `Session` with no host at all.
   */
  readonly connection?: Connection;
  /**
   * What an ephemeral host death already discarded, shared across the sessions
   * ONE client opened (SS2.13.3b, T030 obligation (c)). Omitted, this session
   * remembers only its own discards — the pre-#23980 behaviour.
   */
  readonly discarded?: DiscardedSessions;
  /** Set by `MuseClient`; see {@link SessionOpening}. */
  readonly opening?: SessionOpening;
}

/**
 * The fold as a consumer may READ it.
 *
 * An ALLOWLIST (`Pick`), not `Omit` of the mutator names. `Omit` never checks
 * its keys against the type, so every future public `SessionFold` method would
 * land on this barrel-exported "read-only" view silently — and the contract
 * already plans one: `seedFromSnapshot` (FR-008), a mutator that would feed the
 * fold past `apply`'s turn routing and discard latch. `Pick` constrains its
 * keys to `keyof SessionFold`, so both drift directions are compile errors.
 * This is the same conversion `FoldItems` made one layer down (PR #23087).
 */
export type SessionFoldView = Pick<
  SessionFold,
  | "activeTurnId"
  // The FM-003 currency pair. Read-only, like everything else here: the fill
  // is `Session`'s to drive, and a consumer calling `gapFilled` would report a
  // hole closed that nothing filled.
  | "current"
  | "pendingGap"
  | "items"
  | "pendingApprovals"
  | "pendingUserInputs"
  | "resolvedApprovals"
  | "sessionState"
  | "settledUserInputs"
  | "turn"
  | "turns"
>;

/**
 * The pending set as a consumer may READ and DRIVE it.
 *
 * `discardEphemeral`, `observedReclaim` and `observedUserMessage` are
 * `Session`'s to call: it drives them from folded events and reports what they
 * returned. A consumer calling `discardEphemeral()` directly drains the set and
 * latches it discarded, so the later real `hostExited` reports
 * `retiredCommands: []` — silently losing the very inputs the discharge exists
 * to hand back. Same allowlist discipline as the fold view.
 *
 * `stopRetrying` and `replayAnswered` are hidden for the same bookkeeping
 * reason, re-exposed as `Session` methods: both can retire an entry the
 * submit verb authored, and a retirement that bypasses
 * `TurnSubmitter.forgetRetired` leaves that command's `turn/start` params in
 * the replay memory forever — unbounded over the sanctioned SS3.1.1
 * submit-then-abandon flow.
 */
export type PendingCommandView<I> = Pick<
  PendingCommandSet<I>,
  | "ackErrored"
  | "acked"
  | "discarded"
  | "get"
  | "has"
  | "joinSnapshot"
  | "list"
  | "observedQueueMovement"
  | "reconnectedWithoutSnapshot"
  | "resolveReplayAtJoin"
  | "size"
  | "submitted"
>;

/**
 * `Session.apply`'s own refusal. NOT a `FoldOutcome`: the fold can never emit
 * it, and putting it there promised a direct `SessionFold` consumer a refusal
 * that seam does not produce.
 */
export interface SessionApplyRefusal {
  readonly kind: "refusedSessionDiscarded";
}

/**
 * `Session.apply`'s other own verdict, for the same reason: a frame held while
 * an SS4.8 fill is in flight (FR-020 / T032).
 *
 * NOT a `FoldOutcome` — the fold has not seen this frame yet and reporting one
 * would state a fold move that has not happened. The frame is not lost: it is
 * re-fed through this same path, in cursor order behind the paged prefix, when
 * the fill splices. The pause a consumer sees is exactly this.
 */
export interface SessionGapBuffered {
  readonly kind: "bufferedDuringGap";
  readonly method: string;
}

/**
 * A live frame the SS4.8 fill already applied from a page — the other half of
 * the recipe's overlap discard (PR #24930 review round 1).
 *
 * The wire promises no order between a `view/gap` and the frame at its `next`,
 * so the live twin of an event the page served can arrive after the fill
 * finished, when the buffer is gone. Refused once, by cursor equality, because
 * folding it again would re-run its routing — a duplicate SS4.13 queue-movement
 * replay on the wire, which is exactly what the discard exists to prevent.
 */
export interface SessionGapOverlap {
  readonly kind: "ignoredGapOverlap";
  readonly method: string;
  readonly viewCursor: string;
}

/**
 * What one `Session.apply` did: the fold's own outcome, plus any SS4.13
 * pending-command retirements the event triggered.
 *
 * Retirements ride the return value rather than a stream, matching the pull
 * model the pending set already uses: every
 * retirement is returned synchronously by the mutator that produced it — with
 * ONE stated exception.
 *
 * THE EXCEPTION (FR-020 / T032). A frame HELD during an SS4.8 fill reports
 * `bufferedDuringGap` with `retirements: []`, because at that moment nothing
 * has folded. Its real effects — an SS4.13 reclaim, an approval round trip —
 * happen when the fill splices, and they surface on the `io` of the EARLIER
 * `view/gap` apply that started the fill, never on the buffered frame's own
 * return. A consumer reconciling retirements frame by frame must therefore keep
 * the gap frame's outcome and await its `io`, or it will read `[]` for a
 * reclaim that really happened.
 *
 * A SECOND `view/gap` that lands while a fill is running rides the same
 * channel for the same reason: it extends the running walk instead of starting
 * its own, so its apply reports `deliveryGap` with an already-settled empty
 * `io`, and the work it caused settles on the FIRST gap frame's.
 */
export interface SessionApplyOutcome<I> {
  readonly fold: FoldOutcome | SessionApplyRefusal | SessionGapBuffered | SessionGapOverlap;
  readonly retirements: readonly PendingRetirement<I>[];
  /**
   * The client->server I/O this event triggered, settled — the SS4.13 replays
   * queue movement demands, and FR-019's `approval/decide` submission. Resolves
   * to the retirements that I/O produced.
   *
   * A SEPARATE channel from `retirements` because `apply` is synchronous by
   * contract: a consumer's notification pump must not be made to await a round
   * trip before it can fold the next frame. An event that triggers no I/O gets
   * a shared already-resolved empty, so awaiting this is always safe and never
   * allocates.
   *
   * IT NEVER REJECTS. A replay whose transport failed proves nothing about the
   * intake, so its entry holds and the authoritative report is the host-death
   * notification that is already on its way; an approval failure is reported to
   * `onApprovalError`. Rejecting here would surface as an unhandled rejection
   * in every consumer that does not await it — which is most of them, since the
   * value exists for tests and for consumers that want a barrier.
   */
  readonly io: Promise<readonly PendingRetirement<I>[]>;
}

/**
 * One conversation with the agent.
 *
 * A session folds every server event into readable state — items, turns,
 * session facts, pending approvals — and submits your side of the exchange.
 * Get one from `MuseClient.startSession` or `resumeSession`, then
 * `sendUserTurn` to talk, `turn` to follow a turn's items to its outcome,
 * and `onApproval` to answer permission requests.
 */
export class Session<I = unknown> {
  readonly sessionId: string;
  /** See {@link SessionOpening}. Absent when the caller built this directly. */
  readonly opening: SessionOpening | undefined;
  readonly #pending: PendingCommandSet<I>;
  readonly #discarded: DiscardedSessions | undefined;
  /** `turn/start` submission and same-`commandId` replay (`turn-submit.ts`). */
  readonly #submit: TurnSubmitter<I>;
  /** The FR-019 round trip (`approval.ts`). */
  readonly #approvals: ApprovalRouter;
  /** The FR-020 splice-fill (`gap-fill.ts`). */
  readonly #gaps: GapFiller<I>;

  readonly #fold = new SessionFold();
  readonly #durability: SessionDurabilityProfile;
  /** The first discharge, replayed verbatim on every later call. */
  #discharge: HostDeathDischarge<I> | undefined;
  /** Set on a durable abnormal death, so late handles inherit the rejection. */
  #deathError: MuseHostDiedError | undefined;
  readonly #turns = new Map<string, TurnHandle>();
  /**
   * `item/delta` frames whose item the fold does not hold yet. The store
   * already buffers the delta TEXT against the item's arrival (SS4.7.3, spec
   * Edge Cases); a delta's TURN is equally unknowable until then, so the
   * frames wait here and are attributed when the item lands. Dropping them
   * instead would put a silent hole in the very iterators FR-020 forbids one
   * in. Bounded by the same fact that bounds the store's own buffer: the
   * durable `item/completed` always lands the item.
   */
  readonly #unattributedDeltas = new Map<string, ItemDeltaParams[]>();

  constructor(options: SessionOptions) {
    this.sessionId = options.sessionId;
    this.#durability = options.durability;
    this.#discarded = options.discarded;
    this.opening = options.opening;
    this.#pending = new PendingCommandSet<I>(
      options.discarded === undefined
        ? undefined
        : { discardedCommandIds: options.discarded.commandIds },
    );
    this.#submit = new TurnSubmitter<I>(options.sessionId, options.connection, this.#pending);
    this.#approvals = new ApprovalRouter(options.sessionId, options.connection);
    this.#gaps = new GapFiller<I>({
      apply: (frame, into) => this.#foldAndRoute(frame, into),
      connection: options.connection,
      discarded: () => this.#discharge?.kind === "discharged",
      fold: this.#fold,
      sessionId: options.sessionId,
    });
  }

  get durability(): SessionDurabilityProfile {
    return this.#durability;
  }

  /** Read-only; events enter through `apply` so turn routing cannot be skipped. */
  get fold(): SessionFoldView {
    return this.#fold;
  }

  /** The SS4.13 set, minus the three mutators `Session` drives itself. */
  get pending(): PendingCommandView<I> {
    return this.#pending;
  }

  /**
   * How many turns this session has minted a handle for.
   *
   * Distinct from `fold.turns()`, which counts turns the WIRE named: a handle
   * is also minted by `turn()` and by item routing, so this is the number that
   * reveals a phantom turn minted from a bad key (a `userShell` item's null
   * `turnId`, say). Read-only and observation-only.
   *
   * @internal Test observability, stripped from the published declarations
   * (`stripInternal`). `Session` is barrel-exported, so without this the getter
   * would be frozen API the moment #211 adopts the package — the same call
   * `liveStreamCount` got by staying off the public `Turn` (Constitution XI).
   */
  get knownTurnCount(): number {
    return this.#turns.size;
  }

  /**
   * Fold one view event, then fan it out to the turn handles that want it.
   *
   * Throws on an event for another session. Every `ViewEvent` params type
   * carries a required `sessionId`, and with no `MuseClient` router yet an
   * embedder feeds this straight off a connection — so on a multiplexed feed
   * one misrouted frame would silently corrupt this transcript. The
   * constructor takes a `sessionId`; this is what makes taking it mean
   * something.
   */
  apply(event: ViewEvent): SessionApplyOutcome<I>;
  apply(event: { readonly method: string; readonly params?: unknown }): SessionApplyOutcome<I>;
  apply(
    event: ViewEvent | { readonly method: string; readonly params?: unknown },
  ): SessionApplyOutcome<I> {
    // Only enforce when the frame actually NAMES a session. `ViewEvent`'s
    // members all declare `sessionId`, but a newer host's unknown notification
    // reaches this method at runtime and SS1.5.4 says it is tolerated
    // losslessly — an unconditional read threw `MuseForeignSessionError`
    // ("belongs to session undefined") on it, or a raw `TypeError` when the
    // frame carried no `params` at all.
    const named = (event as { params?: { sessionId?: unknown } }).params?.sessionId;
    if (typeof named === "string" && named !== this.sessionId) {
      throw new MuseForeignSessionError(
        `event ${event.method} belongs to session ${named}, not ${this.sessionId}`,
      );
    }

    // AFTER the foreign check, deliberately. A frame naming a DIFFERENT session
    // is an embedder routing bug, never this session's trailing drain frame, so
    // the pump-safety rationale below does not cover it — refusing it here
    // would relabel a routing bug as our own drain refusal and hide it exactly
    // when a multiplexed embedder needs to see it.
    //
    // REFUSED, not thrown. A discarded session must still not fold — ItemStore's
    // own guard covers only ITEM events, so a post-discharge `turn/completed`
    // once settled a fresh turn "completed" on a session the client was told to
    // discard. But throwing killed the consumer's pump on a single trailing
    // drain frame, the exact failure this method already refuses for missing
    // params and unknown methods. SS2.13.3b requires that nothing fold; it does
    // not require an exception.
    if (this.#discharge?.kind === "discharged") {
      return { fold: { kind: "refusedSessionDiscarded" }, io: NO_IO, retirements: [] };
    }

    // An SS4.8 fill is in flight, so the live tail waits for the paged prefix
    // (tdd SS4.8's "buffer live events … splice the buffer after the paged
    // prefix"). Folding it now would run the fold backwards when the older
    // paged events land, and would hand the iterators the tail before the
    // hole they follow. The MARKER itself is exempt: a second overflow has to
    // reach the fold to extend the outstanding hole, or the walk stops short
    // of it and reports current with a hole still open.
    if (this.#gaps.filling && event.method !== "view/gap") {
      this.#gaps.hold(event);
      return {
        fold: { kind: "bufferedDuringGap", method: event.method },
        io: NO_IO,
        retirements: [],
      };
    }

    // The overlap's late half: a frame a completed fill already applied from a
    // page, whose live twin the wire delivered afterwards. Reached only when NO
    // fill is running — during one the buffer takes the frame first, and the
    // drain refuses it there against both its own paged cursors and the
    // persistent set.
    const twin = this.#gaps.claimServedTwin(event);
    if (twin !== undefined) {
      return {
        fold: { kind: "ignoredGapOverlap", method: event.method, viewCursor: twin },
        io: NO_IO,
        retirements: [],
      };
    }

    const sink: DrainSink<I> = { retirements: [], tasks: [] };
    const outcome = this.#foldAndRoute(event, sink);
    // FR-020: recover before this fold may call itself current again. Started
    // HERE rather than inside the routing switch because it is the one arm
    // that authors client→server I/O off a notification, and `io` is the
    // channel that carries it.
    if (outcome.kind === "deliveryGap") sink.tasks.push(this.#gaps.start());
    return {
      fold: outcome,
      io: Session.#settleIo(sink.tasks),
      retirements: sink.retirements,
    };
  }

  /** Observe SS4.8 fills that did not complete. See `MuseGapFillError`. */
  onGapError(handler: GapFillFailureHandler): void {
    this.#gaps.onError(handler);
  }

  /**
   * Fold one frame and fan it out to the turn handles that want it.
   *
   * The shared path: `apply` uses it for a live frame, and `GapFiller` uses it
   * to re-feed the paged prefix and the buffered tail. One path is what makes
   * a spliced frame indistinguishable from a live one to everything
   * downstream — the fold, the iterators, and the SS4.13 retirements.
   */
  #foldAndRoute(event: WireFrame, sink: DrainSink<I>): FoldOutcome {
    const retirements: PendingRetirement<I>[] = [];
    const tasks = sink.tasks;
    const outcome = this.#fold.apply(event);
    // The fold drops a frame with no `params` as `ignoredMissingParams`
    // (SS1.5.4: drop, never throw). The switch below reads `event.params` on
    // the turn and delta arms, so without this early return a single
    // `{method:"turn/completed"}` frame throws a raw TypeError out of the ONLY
    // event entry point and kills the consumer's notification pump.
    if (outcome.kind === "ignoredMissingParams") return outcome;
    const known = event as ViewEvent;
    switch (known.method) {
      case "item/started":
      case "item/updated":
      case "item/completed":
        // A stale re-emission changed nothing (INV-003), so it yields nothing.
        if (outcome.kind === "item" && outcome.outcome.kind !== "ignoredStaleRevision") {
          this.#itemFolded(known.params.item, retirements);
        }
        break;
      case "item/delta":
        this.#deltaFolded(known.params);
        break;
      case "turn/started":
        this.#handle(known.params.turnId).markStarted();
        this.#queueMoved(known.params.turnId, tasks);
        break;
      case "turn/completed":
        this.#handle(known.params.turnId).settleCompleted(known.params);
        this.#queueMoved(known.params.turnId, tasks);
        break;
      case "turn/unqueued": {
        this.#handle(known.params.turnId).settleUnqueued(known.params);
        // SS4.13 "Reclaimed": the reclaim this client just observed retires
        // the entry NOW, with its input restored to the composer. Leaving it
        // in the set is the durable-looking echo SS4.13 forbids — and it would
        // later be retired `terminalUnknown` by a discharge, which would be a
        // fabricated annotation about a command whose fate is known.
        const reclaimed = this.#pending.observedReclaim(known.params.commandId);
        if (reclaimed !== undefined) retirements.push(reclaimed);
        break;
      }

      case "approval/requested":
        // FR-019's outbound half. Gated on the fold's own verdict: a request
        // the fold IGNORED (a redelivery for an approval already durably
        // resolved) must author no decision — no second resolution is coming,
        // so a decide against it can only bounce.
        if (outcome.kind === "approvalPending") this.#approvalRequested(known.params, tasks);
        break;

      // Folded, deliberately NOT routed to a turn handle. Listed rather than
      // defaulted so this switch is exhaustive over `ViewEvent`: the fold's
      // `AssertNever` forces each new #206 view notification into that union,
      // and a `default` arm here would swallow the addition silently.
      //
      // `view/gap` is here because it routes to no turn: it names a hole in
      // DELIVERY, so what it moves is the fold's currency, and the recovery
      // it triggers is started by `apply` off the `deliveryGap` verdict rather
      // than from this switch (FR-020 / T032).
      case "view/gap":
      case "turn/retracted": // the turn still reaches its own terminal
      case "turn/retryScheduled": // non-terminal by contract (SS4.5.1)
      // An UPDATE refreshes a pending approval; it never opens one, and it
      // carries none of the request-shape members (`itemId`, `turnId`,
      // `toolName`) an `ApprovalHandler` is typed on. SS5.6.3: a re-issued
      // REQUEST embodies the refresh, and that is the frame that drives the
      // handler — so calling it from here would either lie about the request
      // or need a second, thinner handler type for one wire event.
      case "approval/updated":
      case "approval/resolved":
      case "userInput/requested":
      case "userInput/settled":
      case "session/modelChanged":
      case "session/goalChanged":
      case "session/todoListChanged":
      case "session/branchChanged":
      case "session/tokenUsage":
      case "session/contextUsage":
      case "session/approvalModeChanged":
        break;

      default: {
        // Compile-time exhaustiveness. Runtime tolerance of a newer host's
        // unknown method is unaffected — `SessionFold.apply` already returns
        // `ignoredUnrecognizedMethod` for one (SS1.5.4).
        const unrouted: never = known;
        void unrouted;
        break;
      }
    }
    // The retired entries are gone from the pending set, so their replay
    // memory goes with them — `TurnSubmitter.#memory`'s contract is "pruned on
    // retirement, so it tracks the pending set". This covers the two
    // retirements `apply` produces synchronously (the materialized userMessage
    // and the `turn/unqueued` reclaim); the consumer-driven retirement verbs
    // (`stopRetrying`, `replayAnswered`) prune through their own `Session`
    // wrappers.
    if (retirements.length > 0) {
      this.#submit.forgetRetired(retirements);
      sink.retirements.push(...retirements);
    }
    return outcome;
  }

  /** Flatten the event's I/O tasks, or hand back the shared empty. */
  static #settleIo<I>(
    tasks: readonly Promise<readonly PendingRetirement<I>[]>[],
  ): Promise<readonly PendingRetirement<I>[]> {
    if (tasks.length === 0) return NO_IO;
    return Promise.all(tasks).then((batches) => batches.flat());
  }

  /**
   * The handle for a turn, created on first mention from either side. A turn
   * the fold has already settled returns its settled handle, so a wait
   * registered late resolves instead of hanging on an event that has passed.
   */
  turn(turnId: string): Turn {
    const held = this.#turns.get(turnId);
    if (held !== undefined) return held;
    const fresh = this.#mint(turnId);
    // A CONSUMER asking about a turn this session has no news of, after the
    // host died, must not hang: no answer is coming on this connection. That
    // is the SS3.1.4 trap SS2.13.3b's "stop waiting for a terminal" forbids.
    // Server-minted handles deliberately skip this — see `#handle`.
    if (this.#discharge?.kind === "discharged") fresh.settleTerminalUnknown();
    else if (this.#deathError !== undefined) fresh.fail(this.#deathError);
    return fresh;
  }

  /**
   * A handle minted because a SERVER FRAME named this turn. Never pre-failed,
   * and that is what makes the post-death behaviour ORDER-INDEPENDENT.
   *
   * A durable death does not stop the fold (FM-001), so frames can still
   * arrive for a turn with no handle yet. Pre-failing here made the outcome
   * depend on which frame arrived first: terminal-first settled, started-first
   * pre-failed the handle and first-settlement-wins then dropped the real
   * terminal one frame later — the same server fact, two different answers.
   * That asymmetry is measured against synthetic frames; which order a real
   * host emits after a crash is NOT something this lane has observed, and the
   * rule does not depend on it. A frame arriving IS the connection still speaking,
   * so a handle it mints is not a waiter with no answer coming; `turn()` keeps
   * the latch for the case that genuinely is.
   */
  #handle(turnId: string): TurnHandle {
    return this.#turns.get(turnId) ?? this.#mint(turnId);
  }

  #mint(turnId: string): TurnHandle {
    const fresh = new TurnHandle(turnId, () => this.#itemsOfTurn(turnId));
    this.#turns.set(turnId, fresh);
    return fresh;
  }

  /**
   * A host process exited. Classify it, and discharge SS2.13.3b if the profile
   * demands it (tasks.md T030b, FM-002).
   *
   * REPORT EVERY NOTIFICATION OF THE DEATH — the exit promise AND transport
   * EOF. A repeat report of an already-latched death is not a no-op: it marks
   * END OF DRAIN and settles waits the drain minted after the first report.
   * A consumer that dedupes exit notifications and reports the death once
   * leaves those waits pending forever (FM-001).
   *
   * Three outcomes, and the middle one is the one an implementation drops:
   *  - an ORDERLY exit (SS2.11 row 0) is not a death: nothing is discharged
   *    and the session stays usable;
   *  - a DURABLE session's abnormal death reconciles on resume (FM-001), so
   *    the stores are left exactly as observed and only the waiters are told;
   *  - an EPHEMERAL — or unrecognized (SS2.13.1) — session's abnormal death
   *    discharges the obligation in full.
   */
  hostExited(exit: HostDeathNotification): HostDeathDischarge<I> {
    // A second notification of the SAME death (a client can learn of it from
    // both the exit promise and a transport EOF) must report the same thing.
    // The primitives are only side-effect-idempotent: `discardEphemeral`
    // drains the set, so its RETURN is a one-shot delta and a client reading
    // the later notification would silently lose the retired inputs.
    if (this.#discharge !== undefined) {
      // END-OF-DRAIN SWEEP. A durable death does not stop the fold (FM-001),
      // so between the first notification and this one the drain can mint
      // handles from `turn/started` frames whose terminals never arrive.
      // Those are left pending by `#handle` on purpose — a delivered terminal
      // must be able to win — but a SECOND notification means the drain is
      // over and nothing more is coming, so anything still unsettled would
      // hang forever: the SS3.1.4 trap INV-014 forbids.
      //
      // Safe precisely because `fail()`/`settleTerminalUnknown()` no-op on an
      // already-settled handle: a terminal the drain DID deliver keeps its
      // win, so this cannot undo the order-independence it sits beside.
      this.#sweepUnsettledAfterDrain();
      return this.#discharge;
    }

    const profile = this.#durability;
    if (!isAbnormalHostDeath(exit)) return { exit, kind: "notADeath", profile };

    if (survivesHostDeath(profile)) {
      // FM-001: the stores are left exactly as observed — the terminals arrive
      // on resume — so only the waiters are told.
      const died = new MuseHostDiedError(exit);
      this.#deathError = died;
      for (const handle of this.#turns.values()) handle.fail(died);
      this.#discharge = { exit, kind: "durableDeath", profile };
      return this.#discharge;
    }

    const retiredCommands = this.#pending.discardEphemeral();
    const terminalUnknownItems = this.#fold.markEphemeralHostDeath(isItemInProgress);
    for (const handle of this.#turns.values()) handle.settleTerminalUnknown();
    // SS2.13.3b "do not attempt to reattach". `discardEphemeral` already wrote
    // the commandIds into the shared set (it holds it by reference); the
    // sessionId is this layer's to record, because the pending set does not
    // know one. `MuseClient.resumeSession` is the reader.
    this.#discarded?.sessionIds.add(this.sessionId);
    this.#submit.forgetRetired(retiredCommands);
    this.#discharge = {
      exit,
      kind: "discharged",
      profile,
      retiredCommands,
      terminalUnknownItems,
    };
    return this.#discharge;
  }

  /**
   * Settle everything the drain left open. DURABLE ONLY, and `#deathError` is
   * set iff a durable death latched, so the condition is the discriminator.
   *
   * There is deliberately no ephemeral arm: after a discharge the first
   * notification settled every held handle, `apply()` refuses before a frame
   * can mint one, and `turn()` settles a fresh mint on the spot — so no
   * unsettled handle can exist for it to reach. An arm for that state would be
   * untestable defense for something no producer reaches (Constitution XI) and
   * a mutant that survives by construction.
   */
  #sweepUnsettledAfterDrain(): void {
    if (this.#deathError === undefined) return;
    for (const handle of this.#turns.values()) handle.fail(this.#deathError);
  }

  // ---- FR-018 submit verb (T030 obligation a) -----------------------------

  /**
   * Submit a user turn (tdd SS3.2) and hand back THIS session's handle for the
   * turn the ack named.
   *
   * The returned handle is the one `apply` already routes events to — not a
   * second one minted beside it, which would compare equal on every field and
   * then never receive an item, a delta, or a terminal.
   *
   * The wire shaping, the optimistic SS4.13 entry, and the settle-on-rejection
   * rule all live in `TurnSubmitter`; what is decided HERE is the one thing that
   * needs the fold: the entry's insertion point, which is the last item this
   * session holds at submission time.
   */
  async sendUserTurn(options: SendUserTurnOptions<I>): Promise<Turn> {
    const ack = await this.#submit.submit(options, this.#lastFoldedItemId());
    return this.#handle(ack.turnId);
  }

  // ---- FR-019 approval round trip (T031) ----------------------------------

  /** Answer approvals with `handler` (FR-019). See `ApprovalRouter`. */
  onApproval(handler: ApprovalHandler): void {
    this.#approvals.onApproval(handler);
  }

  /** Observe round trips that did not complete. See `ApprovalFailure`. */
  onApprovalError(handler: ApprovalFailureHandler): void {
    this.#approvals.onApprovalError(handler);
  }

  // ---- consumer-driven SS4.13 retirement verbs ----------------------------

  /**
   * Stop the SS3.1.1 retry loop for one entry and take its input back
   * (SS4.13 "Abandoned").
   *
   * A `Session` method rather than a `pending` view member: the retirement
   * must also prune the submitter's replay memory, or the abandoned command's
   * `turn/start` params live for the session's lifetime — unbounded over the
   * sanctioned submit-then-abandon flow.
   */
  stopRetrying(commandId: string): PendingRetirement<I> | undefined {
    const retired = this.#pending.stopRetrying(commandId);
    if (retired !== undefined) this.#submit.forgetRetired([retired]);
    return retired;
  }

  /**
   * Feed a consumer-driven replay's answer through the live SS4.13 settlement
   * rules. Wrapped for the same replay-memory bookkeeping as `stopRetrying`;
   * `"held"` means the answer settled nothing and the entry stays.
   */
  replayAnswered(commandId: string, answer: ReplayAnswer): PendingRetirement<I> | "held" {
    const settled = this.#pending.replayAnswered(commandId, answer);
    if (settled !== "held") this.#submit.forgetRetired([settled]);
    return settled;
  }

  // ---- SS4.13 drivers that need client->server I/O (T030 obligation d) ----

  /**
   * Resolve a snapshot join by performing the I/O its plan demands (SS4.13,
   * SS4.9): same-`commandId` resubmits FIRST, then the replays, then the
   * reclaimed-signature verdict.
   *
   * The order is normative, not incidental: SS4.13 requires an unacked entry be
   * resubmitted "before any retire-to-composer", because a join miss does not
   * prove the intake was never written.
   *
   * `PendingCommandSet.joinSnapshot` stays available on `pending` for a
   * fold-only consumer that performs its own I/O; this verb is for the wired
   * case and therefore requires a connection even when the plan turns out empty.
   */
  async resolveSnapshotJoin(facts: SnapshotJoinFacts): Promise<readonly PendingRetirement<I>[]> {
    this.#submit.requireConnection("resolveSnapshotJoin");
    const plan = this.#pending.joinSnapshot(facts);
    const out: PendingRetirement<I>[] = [...plan.retirements];
    for (const commandId of plan.mustResubmit) await this.#submit.driveReplay(commandId, out);
    const queuedCommandIds = facts.queuedTurns.map((queued) => queued.commandId);
    for (const commandId of plan.mustReplay) {
      const answer = await this.#submit.replay(commandId);
      if (answer === undefined) continue;
      // The snapshot is what makes the reclaimed signature decidable, so this
      // path uses `resolveReplayAtJoin` rather than the live `replayAnswered`.
      const settled = this.#pending.resolveReplayAtJoin(commandId, answer, queuedCommandIds);
      if (settled !== "held") out.push(settled);
    }
    this.#submit.forgetRetired(out);
    return out;
  }

  /**
   * Resolve a reconnect with NO snapshot (`history.mode: "none"`, the default
   * cursor-resume path). Reconnect itself is the trigger: replay each acked
   * entry once, resubmit each unacked entry's SAME `commandId` once.
   */
  async resolveReconnect(): Promise<readonly PendingRetirement<I>[]> {
    this.#submit.requireConnection("resolveReconnect");
    const plan = this.#pending.reconnectedWithoutSnapshot();
    const out: PendingRetirement<I>[] = [];
    for (const commandId of plan.mustResubmit) await this.#submit.driveReplay(commandId, out);
    for (const commandId of plan.mustReplay) await this.#submit.driveReplay(commandId, out);
    this.#submit.forgetRetired(out);
    return out;
  }

  // ---- event-driven I/O ---------------------------------------------------

  #lastFoldedItemId(): string | null {
    const items = this.#fold.items.list();
    return items.length === 0 ? null : (items[items.length - 1]?.itemId ?? null);
  }

  /**
   * SS4.13 "Queue movement": a `turn/started` or `turn/completed` for a turn
   * that is not an entry's own decides that entry's fate at a launch boundary,
   * and SS4.3 carries no view event for a command-intake settlement — so the
   * only way to learn it is to replay.
   */
  #queueMoved(turnId: string, tasks: Promise<readonly PendingRetirement<I>[]>[]): void {
    if (!this.#submit.wired) return;
    const commandIds = this.#pending.observedQueueMovement(turnId);
    if (commandIds.length === 0) return;
    tasks.push(this.#driveQueueReplays(commandIds));
  }

  async #driveQueueReplays(
    commandIds: readonly string[],
  ): Promise<readonly PendingRetirement<I>[]> {
    const out: PendingRetirement<I>[] = [];
    for (const commandId of commandIds) {
      try {
        await this.#submit.driveReplay(commandId, out);
      } catch {
        // Swallowed on purpose, and narrowly: `replay` already converts a
        // server-authored MSP error into an answer, so reaching here means the
        // TRANSPORT failed. That proves nothing about the intake, so the entry
        // holds — and the authoritative report is the host-death notification
        // already on its way. Rethrowing would reject an `io` most consumers
        // never await, i.e. crash the embedder for a fact it is about to be
        // told properly.
      }
    }
    this.#submit.forgetRetired(out);
    return out;
  }

  #approvalRequested(
    params: ApprovalRequestParams,
    tasks: Promise<readonly PendingRetirement<I>[]>[],
  ): void {
    const decided = this.#approvals.requested(params);
    // An approval decision retires no pending command — it is not an SS4.13
    // entry — but it still has to be awaitable through the same `io`, or a
    // consumer has no barrier for the round trip it just triggered.
    if (decided !== undefined) tasks.push(decided.then(() => []));
  }

  #itemsOfTurn(turnId: string): readonly FoldedItem[] {
    return this.#fold.items.list().filter((item) => item.turnId === turnId);
  }

  #itemFolded(item: Item, retirements: PendingRetirement<I>[]): void {
    // SS4.13 "Materialized": the `commandId`-bearing `userMessage` landed, so
    // the optimistic entry is replaced by the real item at the item's own
    // position. `itemId` is the ITEM's id — item ids and command ids are
    // separate namespaces on the wire.
    if (item.kind === USER_MESSAGE && item.commandId !== undefined) {
      const materialized = this.#pending.observedUserMessage(item.commandId, item.itemId);
      if (materialized !== undefined) retirements.push(materialized);
    }
    // `!= null`, not `!== undefined`: `userShell` items carry `turnId: null`
    // on the wire (spec Edge Cases; tdd SS4.5.6 example) while the generated
    // type says `turnId?: string`, so tsc cannot catch this one. A `!==
    // undefined` guard let null through and minted a phantom turn keyed
    // `null`, attributing the userShell item and its deltas to it.
    const turnId = item.turnId ?? undefined;
    if (turnId != null) this.#handle(turnId).pushItem(item);
    const buffered = this.#unattributedDeltas.get(item.itemId);
    if (buffered === undefined) return;
    this.#unattributedDeltas.delete(item.itemId);
    if (turnId == null) return; // `userShell` is not turn-scoped
    const handle = this.#handle(turnId);
    for (const params of buffered) handle.pushDelta(params);
  }

  #deltaFolded(params: ItemDeltaParams): void {
    const held = this.#fold.items.get(params.itemId);
    if (held === undefined) {
      const buffered = this.#unattributedDeltas.get(params.itemId);
      if (buffered === undefined) this.#unattributedDeltas.set(params.itemId, [params]);
      else buffered.push(params);
      return;
    }
    if (held.turnId != null) this.#handle(held.turnId).pushDelta(params);
  }
}
