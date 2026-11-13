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

import type { FoldExtension } from "../fold/extension.js";
import { SessionFold } from "../fold/session-fold.js";
import type { DeepReadonly, FoldOutcome, ViewEvent } from "../fold/session-fold.js";
import { PendingCommandSet } from "../pending/pending-command-set.js";
import type {
  PendingRetirement,
  ReplayAnswer,
  SnapshotJoinFacts,
} from "../pending/pending-command-set.js";
import { ProtocolError } from "../connection/connection.js";
import type { Connection } from "../connection/connection.js";
import { ApprovalRouter } from "./approval.js";
import type { ApprovalFailureHandler, ApprovalHandler } from "./approval.js";
import { TurnSubmitter } from "./turn-submit.js";
import type { SendUserTurnOptions, SteerTurnOptions } from "./turn-submit.js";
import { GapFiller } from "./gap-fill.js";
import type { DrainSink, GapFillFailureHandler, WireFrame } from "./gap-fill.js";
import {
  isAbnormalHostDeath,
  isItemInProgress,
  MuseHostDiedError,
  survivesHostDeath,
} from "./host-death.js";
import { MuseForeignSessionError, MuseSessionDiscardedError } from "../errors.js";
import type { DiscardedSessions } from "./discarded.js";
import type {
  HostDeathDischarge,
  HostDeathNotification,
  SessionDurabilityProfile,
} from "./host-death.js";
import { PushStream, TurnHandle } from "./turn-handle.js";
import type { FoldedItem, Turn, TurnControls, TurnUnqueueOutcome } from "./turn-handle.js";
import { runTurn } from "./run.js";
import type { RunOptions, RunResult } from "./run.js";

import type {
  ApprovalMode,
  ApprovalRequestParams,
  ApprovalUpdatedParams,
  CommandAcceptedResult,
  CommandStatus,
  FeedbackSubmitParams,
  FeedbackSubmitResult,
  HookListResult,
  Item,
  ItemDeltaParams,
  ItemKind,
  ModelSelection,
  PluginInstallResult,
  PluginInstallTarget,
  PluginListResult,
  ReasoningEffort,
  RecapRequestResult,
  SessionCompactParams,
  SessionCompactResult,
  SessionForkParams,
  SessionForkResult,
  SessionLeaveParams,
  SessionLeaveResult,
  SessionRenameResult,
  SessionResumeResult,
  SessionSetApprovalModeResult,
  SessionSetModelResult,
  SessionSetReasoningEffortResult,
  SessionSideChatResult,
  SessionStartResult,
  SkillListResult,
  SkillSetActivationParams,
  SkillSetActivationResult,
  SubagentOwnerReasonParams,
  TaskListResult,
  TurnCancelResult,
  TurnInputPart,
  TurnStartDisposition,
  TurnInterruptResult,
  TurnUnqueueResult,
  UserInputAnswer,
  UserInputAnswerResult,
  WorkflowControlResult,
  WorkflowResumeResult,
} from "@muse-code/msp";

/**
 * True when a routed `approval/request` carries every member the approval
 * router reads: its `approvalId`, the requirement's `approvalId` and
 * `sourceIndex`, and each offered choice's `choiceId`.
 */
function isRoutableApprovalRequest(params: Record<string, unknown>): params is Record<string, unknown> & ApprovalRequestParams {
  const { approvalId, currentRequirementId, availableChoices } = params;
  return (
    typeof approvalId === "string" &&
    isRecord(currentRequirementId) &&
    typeof currentRequirementId["approvalId"] === "string" &&
    Number.isInteger(currentRequirementId["sourceIndex"]) &&
    Array.isArray(availableChoices) &&
    availableChoices.every((choice) => isRecord(choice) && typeof choice["choiceId"] === "string")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Bound to the generated vocabulary so a misspelling fails `tsc`. */
const USER_MESSAGE: Extract<ItemKind, "userMessage"> = "userMessage";
const ACCEPTED: Extract<CommandStatus, "accepted"> = "accepted";
const QUEUED: Extract<TurnStartDisposition, "queued"> = "queued";

/**
 * The shared already-settled `io` for an event that triggered no I/O.
 *
 * A fresh `Promise.resolve([])` per `apply` would allocate on the hot
 * notification path for the overwhelming majority of frames, which carry
 * neither a pending command nor an approval.
 */
const NO_IO: Promise<readonly never[]> = Promise.resolve([]);

/**
 * Module-private friend seam (never on the package barrel, like
 * `connection.ts`'s `submissionTail`): `MuseClient` marks each session it
 * opens, because its inbound pump drops what `apply` returns. A reclaim the
 * fold retires while this session's own `unqueue()` for that turn is in
 * flight is then held for that call (FR-81734-1).
 *
 * @internal
 */
export const pumpDropsApplyResults = Symbol("Session.pumpDropsApplyResults");

/**
 * Module-private friend seam (never on the package barrel): `Session.run`'s
 * abort takes a queued turn back under one `commandId` and sends that same
 * reclaim again while the session runtime does not take it (ADR 77912 D1).
 *
 * @internal
 */
export const resendableUnqueue = Symbol("Session.resendableUnqueue");

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

/** The optional reason `interruptSubagent`/`stopSubagent`/`closeSubagent` record. */
export type SubagentReasonOptions = Readonly<Pick<SubagentOwnerReasonParams, "reason">>;

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
  /**
   * Fold extensions for this session (FR-97527-3), consulted inside the
   * one apply path. `MuseClient` forwards its own list here for every
   * session it opens, so one registration covers both planes.
   */
  readonly extensions?: readonly FoldExtension[];
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
 * `io`, and the work it caused settles on the FIRST gap frame's. A repeat of a
 * `next` already named while the hole is open folds as `ignoredStaleFrame` and
 * extends nothing; after a failed fill it still restarts that fill, and the
 * restarted walk's work settles on this frame's `io`.
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
 * One inbound frame as a session applies it: a view notification, a frame an
 * SS4.8 fill spliced in from a page, or the frame a re-sent server request is
 * folded as (`approval/request` as itself, `userInput/request` as its
 * `userInput/requested` twin).
 */
export type ViewFrame = WireFrame;

/**
 * One event a session folded, as `Session.events()` yields it: the event and
 * what folding it changed, self-contained because the loop body may run after
 * later events folded (FR-97336-1). Optional members may be added; a consumer
 * reads the ones it knows.
 */
export interface SessionEvent<I = unknown> {
  /** The protocol event, as the session applied it. */
  readonly frame: ViewFrame;
  /**
   * What it changed: the value `Session.apply` returned for a live event. An
   * event a gap fill spliced in carries its fold result and no retirements or
   * I/O of its own: those settle on the `view/gap` event's `io`.
   */
  readonly outcome: SessionApplyOutcome<I>;
  /** For an item event that changed the item: the item as it stood after this event. */
  readonly item?: FoldedItem;
}

/** Options for `Session.events()`. */
export interface SessionEventsOptions {
  /** Aborting it ends the stream, as `return()` does. */
  readonly signal?: AbortSignal;
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

  readonly #fold: SessionFold;
  /**
   * Approvals the fold holds a durable terminal for. Read by a re-sent
   * `approval/request`, which skips the fold, so it authors nothing for an
   * approval already resolved; mirrors the fold's own record, keyed for O(1).
   */
  readonly #resolvedApprovalIds = new Set<string>();
  readonly #durability: SessionDurabilityProfile;
  /** The first discharge, replayed verbatim on every later call. */
  #discharge: HostDeathDischarge<I> | undefined;
  /** Set on a durable abnormal death, so late handles inherit the rejection. */
  #deathError: MuseHostDiedError | undefined;
  readonly #turns = new Map<string, TurnHandle<I>>();
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

  /** The live `events()` streams, fed by every folded event. */
  readonly #eventStreams = new Set<PushStream<SessionEvent<I>>>();
  /** Set through {@link pumpDropsApplyResults} by `MuseClient`. */
  #applyResultsDropped = false;
  /** This session's own `unqueue()` calls awaiting their ack, counted per turn id. */
  readonly #unqueuesInFlight = new Map<string, number>();
  /**
   * FR-81734-1: a reclaim the fold retired while its turn's own `unqueue()`
   * was in flight on a session whose pump drops `apply`'s return. The call
   * hands it out; it goes when the last in-flight call for the turn settles,
   * so this holds at most one entry per in-flight call.
   */
  readonly #heldReclaims = new Map<string, PendingRetirement<I>>();

  /**
   * The wire half of every turn handle's control verbs (FR-79106-1). Each
   * refuses on a discarded or fold-only session before anything is sent;
   * `steer` rides the SS4.13 submit path, and an accepted `unqueue` retires
   * the queued entry at once (SS4.13 Reclaimed: "its own reclaim ack"); the
   * later `turn/unqueued` then finds nothing left to retire. When
   * `turn/unqueued` folds first under `MuseClient`, the fold's retirement is
   * held for the call instead (FR-81734-1).
   */
  readonly #turnControls: TurnControls<I> = {
    cancel: async (turnId) =>
      (await this.#command("cancel", "turn/cancel", { turnId })) as unknown as TurnCancelResult,
    interrupt: async (turnId, options) =>
      (await this.#command("interrupt", "turn/interrupt", {
        turnId,
        ...(options.retract == null ? {} : { retract: options.retract }),
      })) as unknown as TurnInterruptResult,
    steer: async (turnId, options: SteerTurnOptions<I>) => {
      this.#requireLiveConnection("steer");
      return await this.#submit.steer(turnId, options, this.#lastFoldedItemId());
    },
    unqueue: async (turnId, commandId): Promise<TurnUnqueueOutcome<I>> => {
      this.#unqueuesInFlight.set(turnId, (this.#unqueuesInFlight.get(turnId) ?? 0) + 1);
      try {
        const ack = (await this.#command(
          "unqueue",
          "turn/unqueue",
          { turnId },
          commandId,
        )) as unknown as TurnUnqueueResult;
        const held = this.#heldReclaims.get(turnId);
        if (held !== undefined) {
          this.#heldReclaims.delete(turnId);
          return { ack, retirement: held };
        }
        return { ack, retirement: ack.status === ACCEPTED ? this.#reclaimQueued(turnId) : undefined };
      } finally {
        const left = (this.#unqueuesInFlight.get(turnId) ?? 1) - 1;
        if (left > 0) {
          this.#unqueuesInFlight.set(turnId, left);
        } else {
          this.#unqueuesInFlight.delete(turnId);
          this.#heldReclaims.delete(turnId);
        }
      }
    },
  };

  /** @internal See {@link pumpDropsApplyResults}. */
  [pumpDropsApplyResults](): void {
    this.#applyResultsDropped = true;
  }

  /** Yield one folded event to every live `events()` stream. */
  #emit(frame: WireFrame, outcome: SessionApplyOutcome<I>): void {
    if (this.#eventStreams.size === 0) return;
    const fold = outcome.fold;
    // The item as of THIS event: the store keeps one object per revision, so
    // a later revision folding before the consumer reads cannot change it.
    const item =
      fold.kind === "item" && fold.outcome.kind !== "ignoredStaleRevision"
        ? this.#fold.items.get(fold.outcome.itemId)
        : undefined;
    const event: SessionEvent<I> = item === undefined ? { frame, outcome } : { frame, item, outcome };
    for (const stream of this.#eventStreams) stream.push(event);
  }

  /**
   * Fold one frame an SS4.8 fill splices in, and yield it. Its retirements
   * and I/O settle on the gap frame's `io`, so the event carries none.
   */
  #spliced(frame: WireFrame, into: DrainSink<I>): void {
    const fold = this.#foldAndRoute(frame, into);
    this.#emit(frame, { fold, io: NO_IO, retirements: [] });
  }

  /** @internal See {@link resendableUnqueue}: each call of the result sends the same reclaim. */
  [resendableUnqueue](turnId: string): () => Promise<TurnUnqueueOutcome<I>> {
    const commandId = this.#requireLiveConnection("unqueue").mintCommandId();
    return () => this.#turnControls.unqueue(turnId, commandId);
  }

  /** Retire this session's acked-queued entry for `turnId`, if it holds one. */
  #reclaimQueued(turnId: string): PendingRetirement<I> | undefined {
    const entry = this.#pending
      .list()
      .find((held) => held.ack?.turnId === turnId && held.ack.disposition === QUEUED);
    if (entry === undefined) return undefined;
    const retired = this.#pending.observedReclaim(entry.commandId);
    if (retired !== undefined) this.#submit.forgetRetired([retired]);
    return retired;
  }

  constructor(options: SessionOptions) {
    this.sessionId = options.sessionId;
    this.#durability = options.durability;
    this.#fold = new SessionFold(options.extensions);
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
      apply: (frame, into) => this.#spliced(frame, into),
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
    const outcome = this.#applyLive(event);
    // A frame held for a fill is yielded when the fill splices it in.
    if (outcome.fold.kind !== "bufferedDuringGap") this.#emit(event, outcome);
    return outcome;
  }

  /**
   * Every event this session folds from now on, with what it changed
   * (FR-97336-1). Live from the call, never replayed: read `fold`, then call
   * this in the same tick, and nothing is missed, including the events
   * folded while `startSession`/`resumeSession` was in flight. Each folded
   * event is yielded once, in arrival order; the events a gap fill splices in
   * are yielded when applied, in order. Buffered like `turn.items()`, so a slow
   * reader never holds folding up.
   *
   * `break`, `return()` or `options.signal` ends it. It finishes the way a
   * turn's `items()` does when the host dies: it ends after an ephemeral
   * host's death, and rejects with `MuseHostDiedError` after a durable one's,
   * once the events it already buffered are read.
   */
  events(options: SessionEventsOptions = {}): AsyncIterableIterator<SessionEvent<I>> {
    const stream: PushStream<SessionEvent<I>> = new PushStream<SessionEvent<I>>(() => {
      this.#eventStreams.delete(stream);
      options.signal?.removeEventListener("abort", onAbort);
    });
    const onAbort = (): void => void stream.return();
    if (options.signal?.aborted === true) stream.end();
    else if (this.#deathError !== undefined) stream.fail(this.#deathError);
    else if (this.#discharge?.kind === "discharged") stream.end();
    else {
      this.#eventStreams.add(stream);
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    return stream;
  }

  #applyLive(event: WireFrame): SessionApplyOutcome<I> {
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
    // A stale repeat of an earlier gap still restarts a failed fill, as every
    // folded `view/gap` (a `deliveryGap` or a stale repeat) reaches `start()`
    // (a no-op while a fill runs).
    if (
      outcome.kind === "deliveryGap" ||
      (outcome.kind === "ignoredStaleFrame" && outcome.method === "view/gap")
    ) {
      sink.tasks.push(this.#gaps.start());
    }
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
    // A re-sent `approval/request` server request skips the fold, which lists
    // only the `approval/requested` notification, and reaches approval routing
    // like that notification: the per-stage latch decides each stage once, and
    // an approval already resolved authors nothing.
    // A request missing the members the router reads is dropped, never thrown
    // on (SS1.5.4), whichever path applies it: a held frame replayed inside
    // `resumeSession` included. A routed or dropped request reports
    // `ignoredUnrecognizedMethod`, a sanctioned interim like `session/started`'s
    // (#62835 owns a dedicated outcome); one with no params object falls through
    // to the fold's `ignoredMissingParams`, like every other frame.
    if (event.method === "approval/request" && isRecord(event.params)) {
      const params = event.params;
      if (isRoutableApprovalRequest(params) && !this.#resolvedApprovalIds.has(params.approvalId)) {
        this.#approvalRequested(params, tasks);
      }
      return { kind: "ignoredUnrecognizedMethod", method: event.method };
    }
    const outcome = this.#fold.apply(event);
    if (outcome.kind === "approvalResolved") this.#resolvedApprovalIds.add(outcome.approvalId);
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
        if (reclaimed === undefined) break;
        // FR-81734-1: under `MuseClient` this session's own in-flight unqueue
        // for the turn is where it lands. Held INSTEAD of returned, so no
        // outcome, live or spliced into a gap's `io`, carries it a second time.
        if (this.#applyResultsDropped && this.#unqueuesInFlight.has(known.params.turnId)) {
          this.#submit.forgetRetired([reclaimed]);
          this.#heldReclaims.set(known.params.turnId, reclaimed);
        } else {
          retirements.push(reclaimed);
        }
        break;
      }

      case "approval/requested":
        // FR-019's outbound half. Gated on the fold's own verdict: a request
        // the fold IGNORED (a redelivery for an approval already durably
        // resolved) must author no decision — no second resolution is coming,
        // so a decide against it can only bounce.
        if (outcome.kind === "approvalPending") this.#approvalRequested(known.params, tasks);
        break;

      case "approval/updated":
        // FR-019's outbound half too (#36949): a stage advance is delivered by
        // this frame alone on the notification plane, so it must drive the
        // handler — the why and the request merge live on
        // `ApprovalRouter.updated`. The same fold verdict gates it: an update
        // the fold IGNORED (unknown or already-resolved approval) authors
        // nothing, and the verdict itself carries the retained request the
        // merge needs.
        if (outcome.kind === "approvalPending") {
          this.#approvalUpdated(outcome.requested, known.params, tasks);
        }
        break;

      // Folded, deliberately NOT routed to a turn handle. Listed rather than
      // defaulted so this switch is exhaustive over `ViewEvent`: the fold's
      // `AssertNever` forces each new #206 view notification into that union,
      // and a `default` arm here would swallow the addition silently.
      //
      // `view/gap` is here because it routes to no turn: it names a hole in
      // DELIVERY, so what it moves is the fold's currency, and the recovery
      // it triggers is started by `apply` off the `deliveryGap` verdict, or off
      // a stale `view/gap`'s `ignoredStaleFrame`, rather than from this switch
      // (FR-020 / T032).
      case "view/gap":
      case "turn/retracted": // the turn still reaches its own terminal
      case "turn/retryScheduled": // non-terminal by contract (SS4.5.1)
      case "turn/modelRetryScheduled": // non-terminal by contract (SS4.5.1)
      case "turn/modelAttemptStarted": // non-terminal by contract (SS4.5.1)
      case "turn/foregroundCompleted": // non-terminal by contract (SS4.5.12)
      case "approval/reviewing": // reviewer-held twin of approval/requested (tdd SS5.5.1): a notice, no decide is open
      case "approval/resolved":
      case "userInput/requested":
      case "userInput/settled":
      case "session/modelChanged":
      case "session/reasoningEffortChanged":
      case "session/goalChanged":
      case "session/todoListChanged":
      case "session/branchChanged":
      case "session/tokenUsage":
      case "session/contextUsage":
      case "session/approvalModeChanged":
      case "session/modelRouteUnserved":
      case "session/nameChanged":
      // The monitor-inbox trio (SS4.5.18): consumer-folded notices, never
      // turn-handle traffic — the fold surfaces their facts on the
      // `monitorInbox` outcome and seeds no store.
      case "monitor/inboxItemAdmitted":
      case "monitor/inboxItemDrained":
      case "monitor/inboxItemVoided":
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
  turn(turnId: string): Turn<I> {
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
  #handle(turnId: string): TurnHandle<I> {
    return this.#turns.get(turnId) ?? this.#mint(turnId);
  }

  #mint(turnId: string): TurnHandle<I> {
    const fresh = new TurnHandle<I>(turnId, () => this.#itemsOfTurn(turnId), this.#turnControls);
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
      for (const stream of this.#eventStreams) stream.fail(died);
      this.#eventStreams.clear();
      this.#discharge = { exit, kind: "durableDeath", profile };
      return this.#discharge;
    }

    const retiredCommands = this.#pending.discardEphemeral();
    const terminalUnknownItems = this.#fold.markEphemeralHostDeath(isItemInProgress);
    for (const handle of this.#turns.values()) handle.settleTerminalUnknown();
    for (const stream of this.#eventStreams) stream.end();
    this.#eventStreams.clear();
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
  async sendUserTurn(options: SendUserTurnOptions<I>): Promise<Turn<I>> {
    const ack = await this.#submit.submit(options, this.#lastFoldedItemId());
    return this.#handle(ack.turnId);
  }

  /**
   * Run one turn to its end in a single call (FR-79108-1): submit `input`
   * (a string is one text part), wait for the server to end the turn, and
   * resolve its outcome, final answer text, items and usage. Pass
   * `options.signal` to stop the turn; see {@link RunOptions}. Use
   * `sendUserTurn` to stream items or deltas as they arrive.
   */
  run(input: string | readonly TurnInputPart[], options?: RunOptions): Promise<RunResult> {
    return runTurn(this, input, options);
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

  // ---- user-input answers (ADR 42116 D18) ----------------------------------

  /**
   * Answer a question this session lists in `fold.pendingUserInputs()` (tdd
   * SS5.10.2): sends `userInput/answer` with one answer per question and
   * resolves with the host's admission. The question leaves the pending list
   * only when the server's `userInput/settled` arrives.
   */
  async answerUserInput(
    userInputId: string,
    answers: readonly UserInputAnswer[],
  ): Promise<UserInputAnswerResult> {
    // Refused before anything is sent, as `sendUserTurn` is: SS2.13.3b
    // forbids reattaching a discarded session.
    if (this.#discharge?.kind === "discharged") {
      throw new MuseSessionDiscardedError(
        `session ${this.sessionId} was discarded after an ephemeral host death; it cannot answer a question`,
      );
    }
    const connection = this.#submit.requireConnection("answerUserInput");
    // No explicit `commandId`: `Connection.command()` mints and stamps it, and
    // refuses an ack that echoes a different one. An ack with none is refused
    // here, with one naming another question.
    const ack = await connection.command("userInput/answer", {
      sessionId: this.sessionId,
      userInputId,
      answers: [...answers],
    });
    if (typeof ack["commandId"] !== "string" || ack["userInputId"] !== userInputId) {
      throw new ProtocolError(
        `userInput/answer acknowledged command ${String(ack["commandId"])} for question ${String(ack["userInputId"])}, expected question ${userInputId}`,
      );
    }
    return ack as unknown as UserInputAnswerResult;
  }

  // ---- wire-present query and command facades -----------------------------

  #requireLiveConnection(verb: string): Connection {
    if (this.#discharge?.kind === "discharged") {
      throw new MuseSessionDiscardedError(
        `session ${this.sessionId} was discarded after an ephemeral host death; it cannot ${verb}`,
      );
    }
    return this.#submit.requireConnection(verb);
  }

  // The four read-only lists (here and `MuseClient.listSessions`) ride
  // `request()`, not `command()`: their wire params carry no `commandId`,
  // and `command()` would retain one dedup entry per call for the whole
  // connection lifetime — a polling caller would grow it without bound.

  /** List this session's live background and foreground tasks (`task/list`). */
  async listTasks(): Promise<TaskListResult> {
    const ack = await this.#requireLiveConnection("listTasks").request("task/list", {
      sessionId: this.sessionId,
    });
    return ack as unknown as TaskListResult;
  }

  /** List this session's user-invocable skills (`skill/list`). */
  async listSkills(): Promise<SkillListResult> {
    const ack = await this.#requireLiveConnection("listSkills").request("skill/list", {
      sessionId: this.sessionId,
    });
    return ack as unknown as SkillListResult;
  }

  /** List this session's installed hook rows (`hook/list`). */
  async listHooks(): Promise<HookListResult> {
    const ack = await this.#requireLiveConnection("listHooks").request("hook/list", {
      sessionId: this.sessionId,
    });
    return ack as unknown as HookListResult;
  }

  /** Pause a live workflow run (`workflow/pause`). */
  async pauseWorkflow(workflowRunId: string): Promise<WorkflowControlResult> {
    const ack = await this.#requireLiveConnection("pauseWorkflow").command("workflow/pause", {
      sessionId: this.sessionId,
      workflowRunId,
    });
    return ack as unknown as WorkflowControlResult;
  }

  /** Resume a paused workflow run (`workflow/resume`). */
  async resumeWorkflow(workflowRunId: string): Promise<WorkflowResumeResult> {
    const ack = await this.#requireLiveConnection("resumeWorkflow").command("workflow/resume", {
      sessionId: this.sessionId,
      workflowRunId,
    });
    return ack as unknown as WorkflowResumeResult;
  }

  /** Request a recap of this session (`recap/request`); admission only. */
  async requestRecap(): Promise<RecapRequestResult> {
    const ack = await this.#requireLiveConnection("requestRecap").command("recap/request", {
      sessionId: this.sessionId,
    });
    return ack as unknown as RecapRequestResult;
  }

  /**
   * Submit feedback about this session (`feedback/submit`). The host
   * serves it only when the spawn requested the `feedback` capability
   * (`requestedCapabilities: ["feedback"]`) and install policy allows
   * it; without that grant the host refuses the call. Its wire params
   * define no `commandId` (each call is one submit; the wire contract
   * attaches no dedup), so it rides `request()` and mints none.
   */
  async submitFeedback(
    input: Omit<FeedbackSubmitParams, "sessionId">,
  ): Promise<FeedbackSubmitResult> {
    const ack = await this.#requireLiveConnection("submitFeedback").request("feedback/submit", {
      ...input,
      sessionId: this.sessionId,
    });
    return ack as unknown as FeedbackSubmitResult;
  }

  /**
   * Open a side chat from this session (`session/sideChat`). Returns the wire
   * result; opening a wired `Session` for the new side session is the
   * caller's composition, as with a directly built `Session`.
   */
  async openSideChat(): Promise<SessionSideChatResult> {
    const ack = await this.#requireLiveConnection("openSideChat").command("session/sideChat", {
      sessionId: this.sessionId,
    });
    return ack as unknown as SessionSideChatResult;
  }

  // ---- session control verbs (FR-79106-1) ---------------------------------

  /** Send one session-scoped command; the connection mints its `commandId`. */
  async #command(
    verb: string,
    method: string,
    params: Record<string, unknown>,
    commandId?: string,
  ): Promise<Record<string, unknown>> {
    return await this.#requireLiveConnection(verb).command(
      method,
      { ...params, sessionId: this.sessionId },
      commandId === undefined ? undefined : { commandId },
    );
  }

  /**
   * Fork this session into a new one (`session/fork`). Returns the wire
   * result for the new session; opening a wired `Session` for it stays the
   * caller's composition, as with `openSideChat`.
   */
  async fork(
    options: Readonly<Omit<SessionForkParams, "commandId" | "sessionId">> = {},
  ): Promise<SessionForkResult> {
    return (await this.#command("fork", "session/fork", { ...options })) as unknown as SessionForkResult;
  }

  /** Compact this session's context (`session/compact`); admission only, or `noop`. */
  async compact(
    options: Readonly<Omit<SessionCompactParams, "commandId" | "sessionId">> = {},
  ): Promise<SessionCompactResult> {
    return (await this.#command("compact", "session/compact", { ...options })) as unknown as SessionCompactResult;
  }

  /** Select the model for later model calls (`session/setModel`). */
  async setModel(model: ModelSelection): Promise<SessionSetModelResult> {
    return (await this.#command("setModel", "session/setModel", { model })) as unknown as SessionSetModelResult;
  }

  /** Set this session's standing reasoning effort (`session/setReasoningEffort`). */
  async setReasoningEffort(reasoningEffort: ReasoningEffort): Promise<SessionSetReasoningEffortResult> {
    return (await this.#command("setReasoningEffort", "session/setReasoningEffort", {
      reasoningEffort,
    })) as unknown as SessionSetReasoningEffortResult;
  }

  /** Select one of the host's preconfigured approval modes (`session/setApprovalMode`). */
  async setApprovalMode(mode: ApprovalMode): Promise<SessionSetApprovalModeResult> {
    return (await this.#command("setApprovalMode", "session/setApprovalMode", {
      mode,
    })) as unknown as SessionSetApprovalModeResult;
  }

  /** Set or change this session's stored name (`session/rename`). */
  async rename(name: string): Promise<SessionRenameResult> {
    return (await this.#command("rename", "session/rename", { name })) as unknown as SessionRenameResult;
  }

  /**
   * Release this session from the host (`session/leave`); `stop: true` also
   * cancels unfinished work. Admission only: the host reports the release
   * later as `session/leaveCompleted`.
   */
  async leave(
    options: Readonly<Omit<SessionLeaveParams, "commandId" | "sessionId">> = {},
  ): Promise<SessionLeaveResult> {
    return (await this.#command("leave", "session/leave", { ...options })) as unknown as SessionLeaveResult;
  }

  /** Queue a note into a running subagent (`subagent/sendMessage`). */
  async sendSubagentMessage(subagentId: string, body: string): Promise<CommandAcceptedResult> {
    return await this.#subagent("sendSubagentMessage", "subagent/sendMessage", { body, subagentId });
  }

  /** Queue a follow-up task for a subagent (`subagent/followupTask`). */
  async followupSubagentTask(subagentId: string, body: string): Promise<CommandAcceptedResult> {
    return await this.#subagent("followupSubagentTask", "subagent/followupTask", { body, subagentId });
  }

  /** Ask a subagent to yield at its next boundary (`subagent/interrupt`). */
  async interruptSubagent(subagentId: string, options: SubagentReasonOptions = {}): Promise<CommandAcceptedResult> {
    return await this.#subagent("interruptSubagent", "subagent/interrupt", { ...options, subagentId });
  }

  /** Stop a running subagent (`subagent/stop`). */
  async stopSubagent(subagentId: string, options: SubagentReasonOptions = {}): Promise<CommandAcceptedResult> {
    return await this.#subagent("stopSubagent", "subagent/stop", { ...options, subagentId });
  }

  /** Resume a paused or recoverable subagent (`subagent/resume`). */
  async resumeSubagent(subagentId: string): Promise<CommandAcceptedResult> {
    return await this.#subagent("resumeSubagent", "subagent/resume", { subagentId });
  }

  /** Reopen a stopped or closed subagent (`subagent/reopen`). */
  async reopenSubagent(subagentId: string): Promise<CommandAcceptedResult> {
    return await this.#subagent("reopenSubagent", "subagent/reopen", { subagentId });
  }

  /** Close a subagent as its owner (`subagent/close`). */
  async closeSubagent(subagentId: string, options: SubagentReasonOptions = {}): Promise<CommandAcceptedResult> {
    return await this.#subagent("closeSubagent", "subagent/close", { ...options, subagentId });
  }

  /** Consume a subagent's ready result (`subagent/readResult`). */
  async readSubagentResult(subagentId: string): Promise<CommandAcceptedResult> {
    return await this.#subagent("readSubagentResult", "subagent/readResult", { subagentId });
  }

  async #subagent(verb: string, method: string, params: Record<string, unknown>): Promise<CommandAcceptedResult> {
    return (await this.#command(verb, method, params)) as unknown as CommandAcceptedResult;
  }

  /** List this session's installed plugins (`plugin/list`); a query, like `listTasks`. */
  async listPlugins(): Promise<PluginListResult> {
    const ack = await this.#requireLiveConnection("listPlugins").request("plugin/list", {
      sessionId: this.sessionId,
    });
    return ack as unknown as PluginListResult;
  }

  /** Install one plugin from a marketplace or a host folder (`plugin/install`). */
  async installPlugin(target: PluginInstallTarget): Promise<PluginInstallResult> {
    return (await this.#command("installPlugin", "plugin/install", { target })) as unknown as PluginInstallResult;
  }

  /** Turn one skill on or off in one scope (`skill/setActivation`). */
  async setSkillActivation(
    options: Readonly<Omit<SkillSetActivationParams, "commandId" | "sessionId">>,
  ): Promise<SkillSetActivationResult> {
    return (await this.#command("setSkillActivation", "skill/setActivation", {
      ...options,
    })) as unknown as SkillSetActivationResult;
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

  /** The #36949 stage-advance re-route; the merge lives on `ApprovalRouter.updated`. */
  #approvalUpdated(
    requested: DeepReadonly<ApprovalRequestParams>,
    params: ApprovalUpdatedParams,
    tasks: Promise<readonly PendingRetirement<I>[]>[],
  ): void {
    const decided = this.#approvals.updated(requested, params);
    // Awaitable through `io`, same as `#approvalRequested` above.
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
    // on the wire (spec Edge Cases; tdd SS4.5.6 example). A `!== undefined`
    // guard let null through and minted a phantom turn keyed `null`,
    // attributing the userShell item and its deltas to it (#23557).
    const turnId = item.turnId;
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
