/**
 * `SessionFold` — the SS4 client fold, bound to the generated wire types
 * (spec 14990 FR-007, tasks.md T019).
 *
 * `ItemStore` and `SessionStateStore` are generic because they were written
 * before the session-view plane entered the generated declarations. This
 * module is where the generic parameters are BOUND: items are `@muse/msp`'s
 * `Item`, state-family values are the generated `session/*` params objects,
 * and every event this fold accepts is typed as the params object the wire
 * actually carries. Nothing here restates a wire shape (INV-001).
 *
 * Beyond the two-store composition, the fold owns the parts of the view that
 * are neither an item nor a state family:
 *
 *  - the TURN LIFECYCLE — `turn/started`, `turn/completed`, `turn/retracted`,
 *    `turn/unqueued`, and the non-terminal `turn/retryScheduled`;
 *  - the APPROVAL and USER-INPUT view events as fold INPUTS — the pending
 *    sets and their first durable terminal. The decision flow (choosing and
 *    sending a resolution) is the facade's, not the fold's;
 *  - the DELIVERY marker `view/gap` — it seeds no store, it moves the fold's
 *    CURRENCY (`pendingGap`/`current`, FM-003). The recovery that fills the
 *    hole needs client→server I/O and is therefore the facade's (T032).
 *
 * INV-006 governs all of it: the fold never invents a terminal. A retract and
 * a reclaim are not `TurnTerminal` values and are never rendered as one, an
 * unrecognized `TurnTerminal` is kept verbatim, and a second resolution never
 * displaces the first durable one.
 */

import type {
  ApprovalRequestParams,
  ApprovalResolvedParams,
  ApprovalUpdatedParams,
  Item,
  ItemCompletedParams,
  ItemDeltaParams,
  ItemStartedParams,
  ItemUpdatedParams,
  MspNotification,
  SessionApprovalModeChangedParams,
  SessionBranchChangedParams,
  SessionContextUsageParams,
  SessionGoalChangedParams,
  SessionModelChangedParams,
  SessionTodoListChangedParams,
  SessionTokenUsageParams,
  TurnCompletedParams,
  TurnError,
  TurnRetractedParams,
  TurnRetryScheduledParams,
  TurnStartedParams,
  TurnTerminal,
  TurnUnqueuedParams,
  UserInputRequestParams,
  UserInputSettledParams,
  ViewGapParams,
} from "@muse/msp";

import { ItemStore } from "./item-store.js";
import type {
  DeltaApplyOutcome,
  ItemApplyOutcome,
  TerminalUnknownItemAnnotation,
} from "./item-store.js";
import { SessionStateStore } from "./state-store.js";
import type { StateApplyOutcome, StateValue } from "./state-store.js";

/** The session-state families, each keyed in the store by its method name. */
export type SessionStateParams =
  | SessionApprovalModeChangedParams
  | SessionBranchChangedParams
  | SessionContextUsageParams
  | SessionGoalChangedParams
  | SessionModelChangedParams
  | SessionTodoListChangedParams
  | SessionTokenUsageParams;

/** A view notification, paired with the generated params object it carries. */
export type ViewEvent =
  | { readonly method: "item/started"; readonly params: ItemStartedParams }
  | { readonly method: "item/updated"; readonly params: ItemUpdatedParams }
  | { readonly method: "item/completed"; readonly params: ItemCompletedParams }
  | { readonly method: "item/delta"; readonly params: ItemDeltaParams }
  | { readonly method: "turn/started"; readonly params: TurnStartedParams }
  | { readonly method: "turn/completed"; readonly params: TurnCompletedParams }
  | { readonly method: "turn/retracted"; readonly params: TurnRetractedParams }
  | { readonly method: "turn/retryScheduled"; readonly params: TurnRetryScheduledParams }
  | { readonly method: "turn/unqueued"; readonly params: TurnUnqueuedParams }
  | { readonly method: "approval/requested"; readonly params: ApprovalRequestParams }
  | { readonly method: "approval/updated"; readonly params: ApprovalUpdatedParams }
  | { readonly method: "approval/resolved"; readonly params: ApprovalResolvedParams }
  | { readonly method: "userInput/requested"; readonly params: UserInputRequestParams }
  | { readonly method: "userInput/settled"; readonly params: UserInputSettledParams }
  | { readonly method: "session/modelChanged"; readonly params: SessionModelChangedParams }
  | { readonly method: "session/goalChanged"; readonly params: SessionGoalChangedParams }
  | { readonly method: "session/todoListChanged"; readonly params: SessionTodoListChangedParams }
  | { readonly method: "session/branchChanged"; readonly params: SessionBranchChangedParams }
  | { readonly method: "session/tokenUsage"; readonly params: SessionTokenUsageParams }
  | { readonly method: "session/contextUsage"; readonly params: SessionContextUsageParams }
  | {
      readonly method: "session/approvalModeChanged";
      readonly params: SessionApprovalModeChangedParams;
    }
  /**
   * The delivery-plane marker (tdd SS4.8). A `ViewEvent` since spec 14990
   * T032, and the ONE arm that changes no session state: it names a hole in
   * DELIVERY rather than a change in the view, so what it moves is the fold's
   * CURRENCY — see `pendingGap` below.
   *
   * D-24021-1 excluded it deliberately and left the flip to this lane
   * ("that lane owns removing the exclusion"). The flip is recorded in
   * `specs/14990-muse-sdk/decisions/23980-fold-the-view-gap-marker.md`. What
   * changed is not the structural fact D-24021-1 named — the marker still
   * carries no `viewCursor` and no `sourceRange`, and still seeds nothing into
   * either store — but the SDK's answer to it: a frame this package fully
   * recognizes may not be reported as `ignoredUnrecognizedMethod`, because
   * that is the report reserved for a NEWER host's method this SDK has never
   * heard of (SS1.5.4), and a consumer told that cannot tell a tolerated
   * unknown from an unfilled hole.
   */
  | { readonly method: "view/gap"; readonly params: ViewGapParams };

/**
 * Compile-time coverage: every `MspNotification` except the handshake's
 * `initialized` is a fold input. A #206 enrollment that adds a view
 * notification fails HERE rather than being silently ignored at runtime.
 *
 * `initialized` is the sole remaining exclusion, and it is a HANDSHAKE
 * notification rather than a view one — it is answered by `MspHandshake`
 * before this fold exists. The `view/gap` exclusion D-24021-1 recorded was
 * removed by spec 14990 T032 when the marker became the `ViewEvent` arm above.
 */
type AssertNever<T extends never> = T;
type UnfoldedViewNotification = Exclude<MspNotification, "initialized" | ViewEvent["method"]>;
export type EveryViewNotificationIsFolded = AssertNever<UnfoldedViewNotification>;

/**
 * The reverse direction: every `ViewEvent` arm names a REAL generated
 * notification. `Exclude` silently ignores excluder members outside the
 * union, so without this a typo'd or later-retired arm would compile clean
 * as dead code (PR #23087 review round).
 */
type StaleViewArm = Exclude<ViewEvent["method"], MspNotification>;
export type NoStaleViewArm = AssertNever<StaleViewArm>;

/**
 * The same reverse pin for the hand-typed exclusion literal above:
 * `Exclude` silently ignores excluder members outside the union, so a
 * retired or renamed `initialized` would otherwise compile clean as dead
 * vocabulary (the PR #23087 rule, applied to this file's only other
 * hand-typed method set).
 */
type StaleExclusion = Exclude<"initialized", MspNotification>;
export type NoStaleExclusion = AssertNever<StaleExclusion>;

/**
 * A recursively read-only view of a value.
 *
 * The fold's snapshot getters hand back its OWN stored objects — copying
 * every read would cost more than the fold saves — and the generated wire
 * types carry no `readonly`, so without this a consumer could write through
 * a snapshot into fold state. This is composition over the generated types,
 * never a restatement of one (INV-001).
 *
 * `readonly` is compile-time only; this is a type-level seal against
 * accidental writes, not a runtime freeze. The alternative — deep-freezing
 * or cloning on every read — would be a real cost on the hot path for a
 * hazard the compiler can price at zero (PR #23087 review round).
 */
export type DeepReadonly<T> = T extends (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends ReadonlyArray<infer U>
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** The session-state family keys: the `session/*` half of `ViewEvent`. */
export type SessionStateMethod = ViewEvent["method"] & `session/${string}`;

/**
 * The methods whose arms can drop a frame as stale. Narrow rather than the
 * whole `ViewEvent["method"]`: a consumer switching on a stale drop would
 * otherwise have to "handle" cases like `item/delta` that no arm produces,
 * and could never match exhaustively. A future arm that starts dropping
 * widens this deliberately (PR #23087 review round).
 */
export type StaleDroppableMethod =
  | "turn/started"
  | "turn/completed"
  | "turn/retryScheduled"
  | "approval/requested"
  | "approval/updated"
  | "userInput/requested";

/**
 * The `NoStaleViewArm` sibling for the union above: these are hand-typed
 * literals, so without this pin a typo'd or later-retired member compiles
 * clean and a consumer told to match `ignoredStaleFrame` exhaustively has to
 * "handle" a case no arm can produce (PR #23087 review round).
 */
type StrayStaleDroppable = Exclude<StaleDroppableMethod, ViewEvent["method"]>;
export type EveryStaleDroppableIsWireVocabulary = AssertNever<StrayStaleDroppable>;

/** Where a turn stands. Client fold state — not a wire vocabulary. */
export type TurnState = "running" | "settled" | "retracted" | "unqueued";

/** A turn as the fold has observed it. */
export interface TurnEntry {
  readonly turnId: string;
  /** The submitting command, when an event carried it. */
  readonly commandId?: string;
  readonly state: TurnState;
  /** The server's terminal, verbatim. Absent unless `turn/completed` folded. */
  readonly terminal?: TurnTerminal;
  /** Present iff the terminal was `"failed"` (tdd SS4.5.1). */
  readonly error?: TurnError;
  /** The latest scheduled model retry; non-terminal (tdd SS4.5.1, D-026). */
  readonly retryScheduled?: TurnRetryScheduledParams;
}

/** An approval awaiting its first durable terminal. */
export interface PendingApproval {
  readonly approvalId: string;
  readonly requested: ApprovalRequestParams;
  /** The most recent `approval/updated` refresh, if any. */
  readonly latestUpdate?: ApprovalUpdatedParams;
}

/** What one `apply` did — enough to drive a render without re-diffing. */
export type FoldOutcome =
  | { readonly kind: "item"; readonly outcome: ItemApplyOutcome }
  | { readonly kind: "itemDelta"; readonly outcome: DeltaApplyOutcome }
  | { readonly kind: "turn"; readonly turnId: string; readonly state: TurnState }
  | { readonly kind: "sessionState"; readonly outcome: StateApplyOutcome<SessionStateParams> }
  | { readonly kind: "approvalPending"; readonly approvalId: string }
  | {
      readonly kind: "approvalResolved";
      readonly approvalId: string;
      /** False when a durable terminal had already landed; the first wins. */
      readonly firstTerminal: boolean;
    }
  | { readonly kind: "userInputPending"; readonly userInputId: string }
  | {
      readonly kind: "userInputSettled";
      readonly userInputId: string;
      readonly firstSettlement: boolean;
    }
  | {
      /**
       * A `view/gap` folded: push delivery dropped everything in the open
       * interval `(after, next)`, so this fold is no longer current until a
       * sanctioned recovery fills it (tdd SS4.8, FM-003).
       *
       * The bounds are the FRAME's own, verbatim — the coalesced outstanding
       * hole is `pendingGap`, which is what a recovery walks. Reported rather
       * than dropped because the SDK recognizes this frame completely: an
       * `ignoredUnrecognizedMethod` here would be indistinguishable from a
       * newer host's genuinely unknown method (SS1.5.4).
       */
      readonly kind: "deliveryGap";
      readonly after: string;
      readonly next: string;
    }
  | { readonly kind: "ignoredUnrecognizedMethod"; readonly method: string }
  | {
      /**
       * A frame that carried no `params`. The generated `Notification`
       * declares `params` optional ("omitted entirely when empty"), so the
       * wire can legally deliver one — but no `ViewEvent` arm is foldable
       * without its params object, every one of them reads at least a
       * `sessionId`. Dropped rather than thrown: SS1.5.4's posture is that a
       * frame this SDK cannot fold leaves the rest of the fold intact, and
       * throwing here would kill the consumer's notification pump
       * (PR #23087 review round).
       */
      readonly kind: "ignoredMissingParams";
      readonly method: string;
    }
  | {
      /**
       * A recognized frame the fold deliberately dropped, leaving state
       * unchanged: a `turn/started` or `turn/completed` for a turn that
       * already left `running`, an `approval/updated` for an approval it
       * never saw requested (or whose entry a resolution already deleted),
       * or a redelivered `approval/requested` / `userInput/requested` for an
       * approval/prompt that already has its durable terminal. Truthful by
       * contract: a "pending" kind here would make a renderer show an entry
       * the fold does not hold (PR #23087 review round).
       *
       * SCOPE. "Dropped" means only that THIS fold's state is unchanged; it
       * does not mean the frame carried nothing. The one known post-terminal
       * frame that carries a first-delivery fact — an `approval/updated`
       * whose `policyPersistence` reports a FAILED `localPersistent` store
       * write, which the server sends AFTER `approval/resolved` (tdd
       * SS5.5/SS6.8) — is dropped here with no accessor holding the reason.
       * Surfacing it is deferred to the facade slice: issue #23379.
       */
      readonly kind: "ignoredStaleFrame";
      readonly method: StaleDroppableMethod;
      readonly id: string;
    };

interface InternalTurn {
  turnId: string;
  commandId?: string;
  state: TurnState;
  terminal?: TurnTerminal;
  error?: TurnError;
  retryScheduled?: TurnRetryScheduledParams;
}

interface InternalApproval {
  requested: ApprovalRequestParams;
  latestUpdate?: ApprovalUpdatedParams;
}

/**
 * The fold's read-only view of its `ItemStore`. Every mutation goes through
 * `apply()`; a directly reachable `seed`/`applyDelta` would let a consumer
 * desync the composite view (items cleared, turn/pending maps not), breaking
 * INV-002 replay equality (PR #23087 review round).
 *
 * An ALLOWLIST, stated explicitly: TypeScript never checks `Omit`'s keys
 * against the type, so a renamed or newly added `ItemStore` mutator would
 * land on this exported surface silently. An explicit member list admits
 * only what is written here, in both drift directions.
 *
 * Hiding the mutator METHODS is only half the job. The values these
 * accessors return ARE the fold's stored objects and the generated wire
 * types carry no `readonly`, so `fold.items.get(id).revision = 0` used to
 * typecheck AND stick — defeating the INV-003 revision guard and breaking
 * INV-002 replay equality through the read surface the mutator allowlist
 * was supposed to seal. Every accessor therefore returns `DeepReadonly`
 * (PR #23087 review round).
 */
export interface FoldItems {
  accumulated(itemId: string, field?: string): string | undefined;
  accumulatedFields(itemId: string): readonly string[];
  readonly ephemeralSessionDiscarded: boolean;
  get(itemId: string): DeepReadonly<Item> | undefined;
  has(itemId: string): boolean;
  isTerminalUnknown(itemId: string): boolean;
  lastOpenedItemId(): string | undefined;
  list(): readonly DeepReadonly<Item>[];
  readonly size: number;
}

/**
 * The fold's read-only view of its `SessionStateStore`, stated explicitly
 * rather than derived: the store's `get`/`has` take a bare `string`, so
 * `get("session/modelchanged")` would typecheck and silently read
 * `undefined`. The family key IS protocol vocabulary, so name it — this
 * surface goes public in this PR, and narrowing it later is a break.
 */
export interface FoldSessionState {
  /**
   * GENERIC in the family, so the return type is that family's params
   * object rather than the 7-way union. With the union, a wrong-family cast
   * (`get("session/goalChanged") as SessionTokenUsageParams`) was a legal
   * narrowing and read the wrong shape silently — the same invisible-miss
   * class the key narrowing closed on the argument side. The method→params
   * map already exists in `ViewEvent`; this just reuses it.
   */
  get<M extends SessionStateMethod>(
    family: M,
  ): DeepReadonly<StateValue<Extract<ViewEvent, { method: M }>["params"]>> | undefined;
  has(family: SessionStateMethod): boolean;
  /**
   * Every family that holds a value, in insertion order. Narrowed in the
   * RETURN position too, so the obvious consumer loop —
   * `for (const f of families()) get(f)` — round-trips against this same
   * interface instead of forcing the bare-string cast the parameter
   * narrowing exists to forbid.
   */
  families(): readonly SessionStateMethod[];
}

/**
 * The whole client-side session view: items, session state, turns, and the
 * pending approval/user-input sets.
 */
export class SessionFold {
  readonly #itemStore = new ItemStore<Item>();
  readonly #sessionStateStore = new SessionStateStore<SessionStateParams>();

  /** Items, snapshot-only: the mutators are `apply()`'s, not the consumer's. */
  get items(): FoldItems {
    return this.#itemStore;
  }

  /**
   * Discharge the SS2.13.3b ephemeral host-death obligation over the item
   * half: every item still in progress becomes terminal-unknown and the fold
   * refuses further events (spec FM-002; slice 3's T030b).
   *
   * A FOLD-level method rather than a `FoldItems` entry on purpose. `items` is
   * snapshot-only — an allowlist whose whole job is that a store mutator can
   * never leak onto the consumer surface (PR #23087 review round) — and this
   * IS a mutator. Widening the allowlist to reach it would undo that; routing
   * it here keeps exactly one caller (`Session.hostExited`) and leaves the
   * read surface untouched. The in-progress probe stays the caller's, so the
   * store remains wire-shape-blind (INV-001).
   */
  markEphemeralHostDeath(
    isInProgress: (item: Item) => boolean,
  ): readonly TerminalUnknownItemAnnotation[] {
    return this.#itemStore.markEphemeralHostDeath(isInProgress);
  }

  /**
   * The session-state families, keyed by notification method name. Named
   * `sessionState` rather than `state` because the surface contract reserves
   * `state` for the FR-008 aggregate that arrives with snapshot ingestion.
   * Snapshot-only, like `items`.
   */
  get sessionState(): FoldSessionState {
    // The ONE narrowing cast, here rather than at every consumer. The store
    // is generic over a `string` family key (it predates the generated
    // session-view plane, INV-001), but `apply`'s seven `session/*` arms are
    // its only writers in this fold — an unrecognized method reaches the
    // ignore arm, never the store — so every key it can hold IS a
    // `SessionStateMethod`.
    return this.#sessionStateStore as FoldSessionState;
  }

  readonly #turns = new Map<string, InternalTurn>();
  readonly #pendingApprovals = new Map<string, InternalApproval>();
  readonly #resolvedApprovals = new Map<string, ApprovalResolvedParams>();
  readonly #pendingUserInputs = new Map<string, UserInputRequestParams>();
  readonly #settledUserInputs = new Map<string, UserInputSettledParams>();
  #activeTurnId: string | undefined;
  #pendingGap: ViewGapParams | undefined;

  /** The turn currently running, if one is. */
  get activeTurnId(): string | undefined {
    return this.#activeTurnId;
  }

  /**
   * The outstanding delivery hole, or `undefined` when there is none (tdd
   * SS4.8, FM-003).
   *
   * COALESCED, keeping the FIRST `after`: consecutive overflows are one hole
   * from a filler's point of view, which is the client mirror of the server's
   * own D-16487-1 bracket rule. A recovery walks `(after, next)` and calls
   * `gapFilled(next)` with the target it actually reached, so a hole that grew
   * while the walk was in flight cannot be reported filled.
   */
  get pendingGap(): DeepReadonly<ViewGapParams> | undefined {
    return this.#pendingGap;
  }

  /**
   * Is this fold current with the session view?
   *
   * FM-003's "only then reports current": false from the moment a `view/gap`
   * folds until its hole is filled. Live events keep folding meanwhile — they
   * are real facts and dropping them would add a second hole — so this flag is
   * the ONLY statement that the transcript has a hole in it.
   */
  get current(): boolean {
    return this.#pendingGap === undefined;
  }

  /**
   * A recovery filled the hole up to `next`. Returns whether it cleared.
   *
   * EQUALITY, never a relational compare (tdd SS4.1): the argument is the
   * target the walk reached, and it clears only when that is still the
   * outstanding target. A gap that arrived mid-walk left a newer `next`, so
   * this answers `false` and the fold stays not-current — the truthful answer,
   * since the second hole is unfilled.
   *
   * A fold-level mutator with the same rationale as `markEphemeralHostDeath`:
   * `items`/`sessionState` are snapshot-only allowlists, and this belongs to
   * neither store.
   */
  gapFilled(next: string): boolean {
    if (this.#pendingGap?.next !== next) return false;
    this.#pendingGap = undefined;
    return true;
  }

  /**
   * Fold one view event.
   *
   * The `default` arm is not defensive padding: the wire is an external
   * boundary and SS1.5.4 makes a NEW notification additive evolution, so a
   * host newer than this SDK really does reach it. Ignoring the frame keeps
   * the rest of the fold intact, which is what tolerance means. The second
   * overload is how such a frame gets in: the wire's actual shape is
   * `{ method: string, params }`, and the ONE tolerance cast lives here
   * rather than at every call site — a hand-written literal for a KNOWN
   * method should use the `ViewEvent` overload and keep its typo checking
   * (PR #23087 review round).
   *
   * `params` is OPTIONAL on the wide overload because the generated
   * `Notification` — the exact type this package's own `NotificationHandler`
   * hands consumers — declares it optional. Requiring it here would make
   * `fold.apply(notification)` a TS2769 and force every wiring site to
   * re-wrap the frame, which is the ceremony this overload exists to remove.
   */
  apply(event: ViewEvent): FoldOutcome;
  apply(event: { readonly method: string; readonly params?: unknown }): FoldOutcome;
  apply(event: ViewEvent | { readonly method: string; readonly params?: unknown }): FoldOutcome {
    // `params` is optional on the wire, and every recognized arm below
    // dereferences it. Drop the frame here rather than let one arm throw on
    // an absent params object — SS1.5.4 tolerance is drop-don't-throw, and a
    // throw would take out the consumer's notification pump.
    //
    // NOT just `=== undefined`. `params: null` is a very common sloppy
    // JSON-RPC spelling of "no params" and threw the same raw TypeError one
    // value over; a non-object (`42`, a string) got further still and minted a
    // phantom turn keyed `undefined`. An ARRAY needs its own clause because
    // JSON-RPC 2.0 permits positional params and `typeof [] === "object"`, so
    // it slipped both: `params: []` reached the arms and SETTLED a turn keyed
    // `undefined`. The classification lives HERE so both this overload pair
    // and `Session.apply` inherit it from one place.
    if (event.params === null || typeof event.params !== "object" || Array.isArray(event.params)) {
      return { kind: "ignoredMissingParams", method: event.method };
    }
    const typed = event as ViewEvent;
    switch (typed.method) {
      case "item/started":
      case "item/updated":
      case "item/completed":
        return { kind: "item", outcome: this.#itemStore.apply(typed.params.item) };
      case "item/delta":
        return {
          kind: "itemDelta",
          outcome: this.#itemStore.applyDelta(
            typed.params.itemId,
            typed.params.delta,
            typed.params.field ?? "text",
          ),
        };

      case "turn/started":
        return this.#turnStarted(typed.params);
      case "turn/completed":
        return this.#turnCompleted(typed.params);
      case "turn/retracted":
        return this.#turnRetracted(typed.params);
      case "turn/unqueued":
        return this.#turnUnqueued(typed.params);
      case "turn/retryScheduled":
        return this.#turnRetryScheduled(typed.params);

      case "approval/requested":
        return this.#approvalRequested(typed.params);
      case "approval/updated":
        return this.#approvalUpdated(typed.params);
      case "approval/resolved":
        return this.#approvalResolved(typed.params);

      case "userInput/requested":
        return this.#userInputRequested(typed.params);
      case "userInput/settled":
        return this.#userInputSettled(typed.params);

      case "view/gap":
        return this.#deliveryGap(typed.params);

      case "session/modelChanged":
      case "session/goalChanged":
      case "session/todoListChanged":
      case "session/branchChanged":
      case "session/tokenUsage":
      case "session/contextUsage":
      case "session/approvalModeChanged":
        return {
          kind: "sessionState",
          outcome: this.#sessionStateStore.apply(
            typed.method,
            typed.params,
            typed.params.viewCursor,
          ),
        };

      default: {
        const unrecognized = event as { readonly method: string };
        return { kind: "ignoredUnrecognizedMethod", method: unrecognized.method };
      }
    }
  }

  /** Turns in first-observed order. */
  turns(): readonly DeepReadonly<TurnEntry>[] {
    return [...this.#turns.values()].map((turn) => SessionFold.#turnSnapshot(turn));
  }

  turn(turnId: string): DeepReadonly<TurnEntry> | undefined {
    const held = this.#turns.get(turnId);
    return held === undefined ? undefined : SessionFold.#turnSnapshot(held);
  }

  /** Approvals awaiting a durable terminal, in first-observed order. */
  pendingApprovals(): readonly DeepReadonly<PendingApproval>[] {
    return [...this.#pendingApprovals.entries()].map(([approvalId, held]) => ({
      approvalId,
      requested: held.requested,
      ...(held.latestUpdate !== undefined ? { latestUpdate: held.latestUpdate } : {}),
    }));
  }

  /** The winning durable terminal per approval, in first-observed order. */
  resolvedApprovals(): readonly DeepReadonly<ApprovalResolvedParams>[] {
    return [...this.#resolvedApprovals.values()];
  }

  /**
   * Prompts awaiting a durable settlement, in first-observed order. The
   * entries ARE the generated request params — the wire shape already carries
   * `userInputId`, so a wrapper would only duplicate it (unlike
   * `PendingApproval`, which earns its wrapper with `latestUpdate`).
   */
  pendingUserInputs(): readonly DeepReadonly<UserInputRequestParams>[] {
    return [...this.#pendingUserInputs.values()];
  }

  /** The winning durable settlement per prompt, in first-observed order. */
  settledUserInputs(): readonly DeepReadonly<UserInputSettledParams>[] {
    return [...this.#settledUserInputs.values()];
  }

  // ---- turn lifecycle -----------------------------------------------------

  #turnStarted(params: TurnStartedParams): FoldOutcome {
    // A turn the fold has already seen leave `running` never re-opens. A
    // redelivered `turn/started` after a terminal/retract/reclaim would mint
    // `{state: "running", terminal: …}` — a shape `TurnEntry`'s own docs say
    // cannot exist — and re-point `activeTurnId` at a turn no completion will
    // follow, so a renderer keyed on it shows a running turn forever.
    // `#turnFor` mints fresh entries as `running`, so a first sighting (and a
    // redelivery while genuinely running) still folds.
    const turn = this.#turnFor(params.turnId);
    if (turn.state !== "running") {
      return { kind: "ignoredStaleFrame", method: "turn/started", id: params.turnId };
    }
    turn.commandId = params.commandId;
    turn.state = "running";
    this.#activeTurnId = params.turnId;
    return { kind: "turn", turnId: params.turnId, state: turn.state };
  }

  #turnCompleted(params: TurnCompletedParams): FoldOutcome {
    // A turn the fold never saw start still settles here: single-shot and
    // gap-filled turns arrive terminal-first (tdd SS4.4.1's sibling rule).
    const turn = this.#turnFor(params.turnId);
    // …but a RETRACTED or RECLAIMED turn stays that way. Replaying the
    // completion frame that preceded an accepted retract would flip the entry
    // back to `settled` and lose the retract fact entirely (the same
    // redelivered-frame class as `#turnStarted` above).
    if (turn.state === "retracted" || turn.state === "unqueued") {
      return { kind: "ignoredStaleFrame", method: "turn/completed", id: params.turnId };
    }
    turn.state = "settled";
    turn.terminal = params.terminal;
    if (params.error !== undefined) turn.error = params.error;
    // The retry hint is a "retrying in Ns" countdown, and it clears on the
    // turn's next event — which a completion is (tdd SS4.5.1). Leaving it set
    // makes a renderer show the countdown on a finished turn.
    turn.retryScheduled = undefined;
    this.#clearActive(params.turnId);
    return { kind: "turn", turnId: params.turnId, state: turn.state };
  }

  #turnRetracted(params: TurnRetractedParams): FoldOutcome {
    const turn = this.#turnFor(params.turnId);
    turn.commandId = params.commandId;
    // A retract is NOT a `TurnTerminal`; leaving `terminal` unset is the whole
    // point (INV-006). The retracted user message re-arrives via `item/updated`
    // with `retracted: true`, which the item half folds.
    turn.state = "retracted";
    this.#clearActive(params.turnId);
    return { kind: "turn", turnId: params.turnId, state: turn.state };
  }

  #turnUnqueued(params: TurnUnqueuedParams): FoldOutcome {
    // The reclaim of a QUEUED submit: this turn was pre-minted at admission
    // and never launched, so no `turn/started` preceded it and no
    // `turn/completed` will follow (tdd SS3.6, SS4.5.1). It therefore never
    // becomes the active turn and never carries a terminal.
    const turn = this.#turnFor(params.turnId);
    turn.commandId = params.commandId;
    turn.state = "unqueued";
    this.#clearActive(params.turnId);
    return { kind: "turn", turnId: params.turnId, state: turn.state };
  }

  #turnRetryScheduled(params: TurnRetryScheduledParams): FoldOutcome {
    // Non-terminal by contract: it never resolves a turn-wait (tdd SS3.1.4).
    const turn = this.#turnFor(params.turnId);
    // …but it is still a turn frame, so it takes the same redelivery guard as
    // the other arms. Without it, replaying a whole page re-plants the retry
    // hint on a turn that already left `running` — and the clear in
    // `#turnCompleted` can no longer undo that, because the replayed
    // completion is itself dropped. The turn would show "retrying in Ns"
    // forever.
    if (turn.state !== "running") {
      return { kind: "ignoredStaleFrame", method: "turn/retryScheduled", id: params.turnId };
    }
    turn.retryScheduled = params;
    return { kind: "turn", turnId: params.turnId, state: turn.state };
  }

  #turnFor(turnId: string): InternalTurn {
    const held = this.#turns.get(turnId);
    if (held !== undefined) return held;
    const fresh: InternalTurn = { turnId, state: "running" };
    this.#turns.set(turnId, fresh);
    return fresh;
  }

  #clearActive(turnId: string): void {
    if (this.#activeTurnId === turnId) this.#activeTurnId = undefined;
  }

  static #turnSnapshot(turn: InternalTurn): TurnEntry {
    return {
      turnId: turn.turnId,
      state: turn.state,
      ...(turn.commandId !== undefined ? { commandId: turn.commandId } : {}),
      ...(turn.terminal !== undefined ? { terminal: turn.terminal } : {}),
      ...(turn.error !== undefined ? { error: turn.error } : {}),
      ...(turn.retryScheduled !== undefined ? { retryScheduled: turn.retryScheduled } : {}),
    };
  }

  // ---- the delivery-plane marker ------------------------------------------

  #deliveryGap(params: ViewGapParams): FoldOutcome {
    // Coalesced on the FIRST `after`: a second overflow while the first hole
    // is still open extends the range rather than replacing it. Replacing it
    // would move the lower bound past events that were never delivered, so a
    // walk from the newer `after` would skip them permanently — a silent hole
    // manufactured by the very state that exists to name one.
    this.#pendingGap = {
      after: this.#pendingGap?.after ?? params.after,
      next: params.next,
      sessionId: params.sessionId,
    };
    // The FRAME's own bounds, not the coalesced ones: this is a report of what
    // arrived. `pendingGap` is the outstanding hole.
    return { after: params.after, kind: "deliveryGap", next: params.next };
  }

  // ---- approvals and user input as fold inputs ----------------------------

  #approvalRequested(params: ApprovalRequestParams): FoldOutcome {
    // A request for an approval that already has its durable terminal (a
    // redelivered or pre-join frame) never re-opens it: no second resolution
    // is coming, so the resurrected entry would pend forever (tdd SS5's
    // first-terminal-wins, request side).
    if (this.#resolvedApprovals.has(params.approvalId)) {
      return { kind: "ignoredStaleFrame", method: "approval/requested", id: params.approvalId };
    }
    // A re-request REPLACES the entry, `latestUpdate` included: a re-issued
    // request already embodies the latest refresh (tdd SS5.6.3), so pairing
    // the new request with the OLD update would show stale stage/choices and
    // a decide against them bounces -32053.
    this.#pendingApprovals.set(params.approvalId, { requested: params });
    return { kind: "approvalPending", approvalId: params.approvalId };
  }

  #approvalUpdated(params: ApprovalUpdatedParams): FoldOutcome {
    // An update REFRESHES a pending view; it never opens one. An update for an
    // approval this fold never saw requested (a pre-join frame) is dropped
    // rather than synthesized into a request it cannot honestly describe —
    // and the outcome says so, rather than claiming a pending entry.
    //
    // A POST-RESOLVE update lands here too, because the resolve deleted the
    // entry. Most are redeliveries, but a FAILED `localPersistent`
    // `policyPersistence` report is a first delivery of a new fact (tdd
    // SS5.5/SS6.8). This fold drops it and holds no accessor for the reason;
    // surfacing is deferred to the facade slice — issue #23379.
    const held = this.#pendingApprovals.get(params.approvalId);
    if (held === undefined) {
      return { kind: "ignoredStaleFrame", method: "approval/updated", id: params.approvalId };
    }
    held.latestUpdate = params;
    return { kind: "approvalPending", approvalId: params.approvalId };
  }

  #approvalResolved(params: ApprovalResolvedParams): FoldOutcome {
    this.#pendingApprovals.delete(params.approvalId);
    const firstTerminal = !this.#resolvedApprovals.has(params.approvalId);
    // The FIRST durable terminal decision is the one that stands (tdd SS5); a
    // later one is a losing racer's echo, never an overwrite.
    if (firstTerminal) this.#resolvedApprovals.set(params.approvalId, params);
    return { kind: "approvalResolved", approvalId: params.approvalId, firstTerminal };
  }

  #userInputRequested(params: UserInputRequestParams): FoldOutcome {
    // Symmetric with `#approvalRequested`: a settled prompt stays settled.
    if (this.#settledUserInputs.has(params.userInputId)) {
      return { kind: "ignoredStaleFrame", method: "userInput/requested", id: params.userInputId };
    }
    this.#pendingUserInputs.set(params.userInputId, params);
    return { kind: "userInputPending", userInputId: params.userInputId };
  }

  #userInputSettled(params: UserInputSettledParams): FoldOutcome {
    this.#pendingUserInputs.delete(params.userInputId);
    const firstSettlement = !this.#settledUserInputs.has(params.userInputId);
    if (firstSettlement) this.#settledUserInputs.set(params.userInputId, params);
    return { kind: "userInputSettled", userInputId: params.userInputId, firstSettlement };
  }
}
