/**
 * `PendingCommand`: the client-side fold over pending commands.
 *
 * Normative source: tdd SS4.13 (owned by decision record D-032). This module
 * implements that subsection and does not re-derive it; every rule below
 * quotes or cites the clause it realizes. It is **client state only** — no
 * wire event, method, snapshot member, or durable record (INV-007), and it
 * never crosses the wire.
 *
 * The full fold is `S' = f(S, server events, pending client events)`: server
 * events remain the only source of durable truth, and a `PendingCommand`
 * entry is a rendering of the client's own intent.
 *
 * The entry itself is client-local by ruling, and its join keys (`commandId`,
 * `turnId`, `itemId`) are opaque strings by protocol rule (SS3.1.4, SS4.1).
 * The wire vocabulary it touches is fully generated: spec 206 Phase 11
 * (#22772) enrolled the `turn/start` ack and the `-32030` `commandRejected`
 * registry row, so INV-001's one recorded interim exception is discharged
 * here — nothing below restates a wire shape.
 *
 * Every comparison against a wire value goes through a constant ANNOTATED
 * with the generated vocabulary (`Extract<...>`), which is what makes a
 * misspelling a compile error. Comparing a bare literal against the open
 * `ErrorKind`/`TurnStartDisposition` unions typechecks either way — that
 * invisibility is precisely what the exception cost.
 */

import type {
  ErrorKind,
  MspErrorDataKind,
  TurnStartDisposition,
  TurnStartResult,
} from "@muse/msp";

import { MuseSessionDiscardedError } from "../errors.js";

/**
 * The JSON-RPC code for a durable command rejection (tdd SS3.1.2, Appendix B).
 *
 * `@muse/msp` is a types-only package, so the registry's CODE cannot be
 * imported the way its types can. It is named exactly once, here, and
 * `pending-command-wire-binding.test.ts` pins it to the `commandRejected` row
 * in `schema/msp/stable/msp.schema.json` — the same pin shape
 * `EXPECTED_SCHEMA_FINGERPRINT` uses, so a schema advance that moves the code
 * reds this lane instead of silently leaving the SDK settling on a dead code.
 */
export const COMMAND_REJECTED_CODE = -32030;

/**
 * The registry row's `kind`, bound to the CLOSED generated vocabulary.
 *
 * `ErrorKind` is open (`| (string & {})`), so a typo compared against it still
 * typechecks. `MspErrorDataKind` is the closed registry vocabulary, so this
 * annotation makes a misspelling fail `tsc`.
 */
export const COMMAND_REJECTED_KIND: Extract<MspErrorDataKind, "commandRejected"> =
  "commandRejected";

/** The `"queued"` disposition, bound so a misspelling fails `tsc` (SS3.2). */
const QUEUED_DISPOSITION: Extract<TurnStartDisposition, "queued"> = "queued";

/**
 * The ack's disposition — the generated SS3.2 vocabulary (`TurnStartDisposition`).
 * Open: an unrecognized value is "acked, not otherwise classified" and holds
 * like a started turn.
 */
export type PendingDisposition = TurnStartDisposition;

/**
 * The ack a submit received: the turn it named, and how it was admitted.
 *
 * This IS the generated `turn/start` result's `turnId`/`disposition` pair, so
 * a `TurnStartResult` off the wire is handed to `acked()` unchanged.
 */
export type PendingCommandAck = Readonly<Pick<TurnStartResult, "turnId" | "disposition">>;

/** An error response to a submit, or to a `commandId` replay. */
export interface CommandErrorResponse {
  readonly code: number;
  readonly kind: ErrorKind;
  /** `commandRejected` reason, verbatim snake_case (tdd SS1.6 exemption). */
  readonly reason?: string;
}

/** The answer to an idempotent `commandId` replay (tdd SS3.1.1). */
export type ReplayAnswer =
  | { readonly kind: "ack"; readonly ack: PendingCommandAck }
  | { readonly kind: "error"; readonly error: CommandErrorResponse };

/** An entry, as a consumer sees it. Immutable snapshot of internal state. */
export interface PendingCommandEntry<I> {
  readonly commandId: string;
  readonly input: I;
  readonly displayText?: string;
  readonly ack?: PendingCommandAck;
  /**
   * The item the entry renders AFTER: the last item present in the client's
   * fold at submission time (`null` = before every item). Fixed at insertion
   * — server events folding in afterwards MUST NOT relocate it (SS4.13
   * "Insertion point and ordering"). A snapshot join may re-anchor a kept
   * queued entry; nothing else moves it.
   */
  readonly anchorAfterItemId: string | null;
  readonly submissionIndex: number;
  /** Set at a snapshot join for a server-confirmed queued entry only. */
  readonly queuedOrder?: number;
}

/**
 * Why an entry left the set. Every retirement is triggered by a
 * server-authored fact; the set never invents one (INV-006, SS3.1.3).
 */
export type PendingRetirement<I> =
  /**
   * The command materialized. `matchedBy: "userMessage"` — the
   * `commandId`-bearing `userMessage` folded in and `itemId` is that item's
   * OWN id (item ids and command ids are separate namespaces on the wire).
   * `matchedBy: "activeTurn"` — a snapshot's `activeTurn.commandId` matched;
   * no user-message item id is in hand, so `itemId` is absent and the caller
   * renders from the snapshot's items.
   */
  | {
      readonly kind: "materialized";
      readonly commandId: string;
      readonly matchedBy: "userMessage";
      readonly itemId: string;
    }
  | {
      readonly kind: "materialized";
      readonly commandId: string;
      readonly matchedBy: "activeTurn";
    }
  /** Durably rejected (-32030). Nothing happened; restore the input. */
  | { readonly kind: "rejected"; readonly commandId: string; readonly reason: string; readonly input: I; readonly restoreToComposer: true }
  /** Reclaimed (D-024): the turn never launched. Restore the input. */
  | { readonly kind: "reclaimed"; readonly commandId: string; readonly input: I; readonly restoreToComposer: true }
  /** Restart recovery settled the intake `abandoned` (SS3.1.3). */
  | { readonly kind: "abandoned"; readonly commandId: string; readonly input: I; readonly restoreToComposer: true }
  /**
   * The client itself stopped retrying a nothing-admitted error. SS4.13:
   * "a client that stops retrying MUST retire the entry back to its composer
   * rather than leave a durable-looking echo behind."
   */
  | { readonly kind: "retryAbandonedByClient"; readonly commandId: string; readonly input: I; readonly restoreToComposer: true }
  /**
   * Ephemeral-profile host death (SS2.13 / SS4.4.3 carve-out): the client
   * does not know what happened and MUST NOT invent it.
   */
  | { readonly kind: "terminalUnknown"; readonly commandId: string; readonly input: I };

/** Facts a snapshot supplies for the join (tdd SS4.9.1 `state` members). */
export interface SnapshotJoinFacts {
  readonly activeTurn: { readonly turnId: string; readonly commandId: string } | null;
  /** Admitted-but-not-launched submits, in launch order. */
  readonly queuedTurns: readonly { readonly turnId: string; readonly commandId: string }[];
  /**
   * `commandId`-bearing `userMessage` items in `state.items`, each paired
   * with the item's OWN id — the caller holds both when building the facts,
   * and the pair keeps the materialized retirement's `itemId` a real item id
   * on the resume/reconnect path exactly as on the live path.
   */
  readonly userMessageCommandIds: Iterable<{
    readonly commandId: string;
    readonly itemId: string;
  }>;
  /** The last item of the reconciled fold — where kept queued entries re-anchor. */
  readonly lastItemId: string | null;
}

/**
 * The work a join leaves for the caller. The set is transport-less: it names
 * the I/O the SS4.13 MUSTs require and the caller performs it, then feeds the
 * answers back through `replayAnswered` / `acked`.
 */
export interface PendingJoinPlan<I> {
  readonly retirements: readonly PendingRetirement<I>[];
  /** Acked entries the caller MUST resolve by replaying the `commandId`. */
  readonly mustReplay: readonly string[];
  /**
   * Unacked entries the caller MUST resubmit with the SAME `commandId`
   * before any retire-to-composer — demanded once per plan (the single
   * ordered pass that builds a plan visits each entry once), re-demanded on
   * each new join; SS3.1.1 idempotency makes the re-demand safe. A
   * fresh-`commandId` re-send is the double execution this ordering
   * prevents.
   */
  readonly mustResubmit: readonly string[];
  /** Entries kept as server-confirmed pending, in their new render order. */
  readonly kept: readonly string[];
}

interface InternalEntry<I> {
  commandId: string;
  input: I;
  displayText?: string;
  ack?: PendingCommandAck;
  anchorAfterItemId: string | null;
  submissionIndex: number;
  queuedOrder?: number;
}

/**
 * The client-local pending-command set.
 *
 * A client that never renders optimistically simply holds no entries and the
 * fold degenerates to SS4.1 — that is a supported mode, not a degraded one.
 */
export interface PendingCommandSetOptions {
  /**
   * Where `discardEphemeral()` records the ids it retired, and where every
   * replay guard reads (SS2.13.3b "do not replay the session's `commandId`s").
   *
   * Injected BY REFERENCE so one client can share a single set across the
   * sessions it opens: the clause constrains what this CLIENT does next, and a
   * per-instance set let a FRESH `Session` replay a dead host's ids at a new
   * host. Omitted, the set owns a private one and behaves exactly as before.
   */
  readonly discardedCommandIds?: Set<string>;
}

/**
 * Tracks the commands you have submitted that the server has not yet woven
 * into the view: their optimistic display order, acknowledgements, replay
 * answers at reconnect, and retirements. `Session` owns and drives one per
 * conversation; read it through the session's pending view.
 */
export class PendingCommandSet<I = unknown> {
  readonly #entries = new Map<string, InternalEntry<I>>();
  readonly #ephemeralDiscardedCommandIds: Set<string>;
  #discarded = false;
  #nextSubmissionIndex = 0;

  constructor(options?: PendingCommandSetOptions) {
    this.#ephemeralDiscardedCommandIds = options?.discardedCommandIds ?? new Set<string>();
  }

  /**
   * Record a submission. `anchorAfterItemId` is the last item present in the
   * client's fold right now (SS4.13 insertion point).
   */
  submitted(params: {
    commandId: string;
    input: I;
    displayText?: string;
    anchorAfterItemId?: string | null;
  }): void {
    // Replay check FIRST: for an id this set actually retired, "cannot be
    // replayed against a new host" is the precise diagnosis, and the generic
    // set-closed message below would bury it.
    this.#assertNotEphemeralReplay(params.commandId);
    // Then the whole SET, not just the ids it retired. A brand-new submit
    // after an ephemeral host died would otherwise be accepted and retired
    // `terminalUnknown` by the next discharge — "we don't know whether this
    // ran" about input provably never sent to any host, which is the
    // fabricated annotation SS2.13.3b exists to forbid.
    this.#assertSessionActive();
    if (this.#entries.has(params.commandId)) {
      // A resubmit of the same commandId is the sanctioned exactly-once
      // retry (SS3.1.1); it does not create a second entry and MUST NOT
      // move the original's anchor.
      return;
    }
    const entry: InternalEntry<I> = {
      commandId: params.commandId,
      input: params.input,
      anchorAfterItemId: params.anchorAfterItemId ?? null,
      submissionIndex: this.#nextSubmissionIndex++,
    };
    if (params.displayText !== undefined) entry.displayText = params.displayText;
    this.#entries.set(params.commandId, entry);
  }

  /** The submit (or a replay) was acked. */
  acked(commandId: string, ack: PendingCommandAck): void {
    const entry = this.#entries.get(commandId);
    if (entry === undefined) return;
    entry.ack = ack;
  }

  /**
   * The submit (or a replay) answered with an error.
   *
   * Only a durable `commandRejected` (-32030) is a settlement. Every other
   * error admits nothing — the other SS3.1.2 admission errors and SS1's
   * envelope errors, `inputTooLarge` among them — so the entry HOLDS while
   * the client retries with the same `commandId` (SS4.13 "Nothing-admitted
   * errors are not settlements").
   */
  ackErrored(commandId: string, error: CommandErrorResponse): PendingRetirement<I> | "held" {
    const entry = this.#entries.get(commandId);
    if (entry === undefined) return "held";
    if (!PendingCommandSet.isSettlement(error)) return "held";
    return this.#retire(entry, this.#rejectionRetirement(entry, error));
  }

  /**
   * The client has decided to stop retrying a nothing-admitted error. The
   * entry must not linger as a durable-looking echo (SS4.13).
   */
  stopRetrying(commandId: string): PendingRetirement<I> | undefined {
    const entry = this.#entries.get(commandId);
    if (entry === undefined) return undefined;
    return this.#retire(entry, {
      kind: "retryAbandonedByClient",
      commandId,
      input: entry.input,
      restoreToComposer: true,
    });
  }

  /**
   * A `userMessage` item carrying this `commandId` folded in: the entry
   * materialized and the item replaces it at the item's own transcript
   * position (SS4.13 "Materialized").
   *
   * Multi-client echo de-duplication falls out of the same join: a
   * `userMessage` with no matching local entry is another client's
   * submission — this returns `undefined` and the caller renders it plainly.
   */
  observedUserMessage(commandId: string, itemId: string): PendingRetirement<I> | undefined {
    const entry = this.#entries.get(commandId);
    if (entry === undefined) return undefined;
    return this.#retire(entry, { kind: "materialized", commandId, matchedBy: "userMessage", itemId });
  }

  /**
   * A reclaim this client actually observed (its own reclaim ack, or any live
   * fold D-024's lane charters). Retire immediately — same composer restore,
   * without waiting for a snapshot join (SS4.13 "Reclaimed").
   */
  observedReclaim(commandId: string): PendingRetirement<I> | undefined {
    const entry = this.#entries.get(commandId);
    if (entry === undefined) return undefined;
    return this.#retire(entry, {
      kind: "reclaimed",
      commandId,
      input: entry.input,
      restoreToComposer: true,
    });
  }

  /**
   * Queue movement: a `turn/started` or `turn/completed` for a turn that is
   * NOT the entry's own.
   *
   * SS4.3 carries no view event for a command-intake settlement, so a
   * post-ack rejection reaches a live client only by replay: on each such
   * event a client holding an acked-QUEUED entry MUST re-verify it by
   * replaying its `commandId`. Queue movement is the trigger precisely
   * because a queued turn's fate is decided at its launch boundary — no
   * polling loop and no invented timeout (SS3.1.3 stays intact).
   *
   * @returns the `commandId`s the caller must replay.
   */
  observedQueueMovement(turnId: string): readonly string[] {
    const out: string[] = [];
    for (const entry of this.#entries.values()) {
      if (entry.ack === undefined) continue;
      if (entry.ack.disposition !== QUEUED_DISPOSITION) continue;
      if (entry.ack.turnId === turnId) continue; // the entry's own turn
      out.push(entry.commandId);
    }
    return out;
  }

  /**
   * Feed back a `commandId` replay answer (SS3.1.1 — always safe).
   *
   * Three shapes, per SS4.13's rejected/abandoned arms:
   *  - a durable rejection: retire (reason `"abandoned"` → Abandoned arm,
   *    any other reason → Rejected arm);
   *  - the original ack, still pending: keep waiting;
   *  - an ack whose staleness only a snapshot can prove: keep waiting — the
   *    reclaimed signature needs `queuedTurns` in hand (`joinSnapshot`).
   */
  replayAnswered(commandId: string, answer: ReplayAnswer): PendingRetirement<I> | "held" {
    this.#assertNotEphemeralReplay(commandId);
    const entry = this.#entries.get(commandId);
    if (entry === undefined) return "held";
    if (answer.kind === "ack") {
      entry.ack = answer.ack;
      return "held";
    }
    if (!PendingCommandSet.isSettlement(answer.error)) return "held";
    return this.#retire(entry, this.#rejectionRetirement(entry, answer.error));
  }

  /**
   * Reconnect with NO snapshot (`history.mode: "none"`, the default
   * cursor-resume path). There is no join to run, so reconnect itself is the
   * trigger: replay each ACKED entry's `commandId` once; resubmit each
   * UNACKED entry's same `commandId` once before any retire-to-composer.
   *
   * Without `queuedTurns` in hand the reclaimed signature is undecidable, so
   * a stale `"queued"` ack waits for the next snapshot join or queue
   * movement — never a locally invented terminal.
   */
  reconnectedWithoutSnapshot(): PendingJoinPlan<I> {
    // Once-per-plan comes from the single `#ordered()` pass (each entry is
    // visited exactly once); a NEW reconnect demands again, which SS3.1.1
    // same-`commandId` idempotency makes safe — a once-per-lifetime latch
    // would strand an entry whose demand was lost to a second disconnect
    // (SS4.13 forbids).
    const mustReplay: string[] = [];
    const mustResubmit: string[] = [];
    for (const entry of this.#ordered()) {
      if (entry.ack === undefined) {
        mustResubmit.push(entry.commandId);
      } else {
        mustReplay.push(entry.commandId);
      }
    }
    return {
      retirements: [],
      mustReplay,
      mustResubmit,
      kept: this.#ordered().map((e) => e.commandId),
    };
  }

  /**
   * Join local entries against an authoritative snapshot (SS4.9), by
   * `commandId`. The five arms, in the order SS4.13 states them.
   */
  joinSnapshot(facts: SnapshotJoinFacts): PendingJoinPlan<I> {
    // Once-per-plan comes from the single ordered pass below, exactly as in
    // `reconnectedWithoutSnapshot`; a NEW join demands again, which SS3.1.1
    // same-`commandId` idempotency makes safe (SS4.13 forbids stranding an
    // entry whose demand was lost to a second disconnect).
    const retirements: PendingRetirement<I>[] = [];
    const mustReplay: string[] = [];
    const mustResubmit: string[] = [];

    const userMessageItemByCommandId = new Map<string, string>();
    for (const pair of facts.userMessageCommandIds) {
      userMessageItemByCommandId.set(pair.commandId, pair.itemId);
    }
    const queuedIndexByCommandId = new Map<string, number>();
    facts.queuedTurns.forEach((q, index) => queuedIndexByCommandId.set(q.commandId, index));

    for (const entry of this.#ordered()) {
      const { commandId } = entry;

      // Arm 1 — materialized: a userMessage item (its own item id is in the
      // join facts), or the activeTurn's commandId (no item id in hand — the
      // retirement says so via matchedBy, never aliasing the command id).
      const userMessageItemId = userMessageItemByCommandId.get(commandId);
      if (userMessageItemId !== undefined) {
        retirements.push(
          this.#retire(entry, {
            kind: "materialized",
            commandId,
            matchedBy: "userMessage",
            itemId: userMessageItemId,
          }),
        );
        continue;
      }
      if (facts.activeTurn?.commandId === commandId) {
        retirements.push(
          this.#retire(entry, { kind: "materialized", commandId, matchedBy: "activeTurn" }),
        );
        continue;
      }

      // Arm 2 — server-confirmed queued: keep, reordered to queuedTurns order.
      const queuedIndex = queuedIndexByCommandId.get(commandId);
      if (queuedIndex !== undefined) {
        entry.queuedOrder = queuedIndex;
        // A kept entry re-anchors after the last item of the reconciled fold.
        entry.anchorAfterItemId = facts.lastItemId;
        continue;
      }

      // Arm 3 — an acked STEER matches neither activeTurn.commandId nor
      // queuedTurns by design: it is pending on the running turn's
      // PendingSteerQueue (SS3.3), not settled. Keep it as server-confirmed
      // pending; retiring here shows "never ran" and then double-sends when
      // the steer delivers. A steer keeps its submission anchor — it has no
      // launch position.
      if (
        entry.ack !== undefined &&
        facts.activeTurn !== null &&
        entry.ack.turnId === facts.activeTurn.turnId
      ) {
        continue;
      }

      // Arm 4 — acked, matching nothing: resolve by replaying the commandId.
      if (entry.ack !== undefined) {
        mustReplay.push(commandId);
        continue;
      }

      // Arm 5 — unacked, and the join did not match it. The intake is durable
      // BEFORE the ack (SS3.1.3), and a join miss does not prove the intake
      // was never written (a parked steer is in none of the join surfaces),
      // so demand a SAME-commandId resubmit before any retire-to-composer.
      mustResubmit.push(commandId);
    }

    return {
      retirements,
      mustReplay,
      mustResubmit,
      kept: this.#ordered().map((e) => e.commandId),
    };
  }

  /**
   * The reclaimed signature, decidable only with a snapshot in hand: an
   * acked-queued entry ABSENT from the snapshot's `queuedTurns` whose replay
   * still answers the stale `"queued"` ack retires as *reclaimed* at the
   * snapshot join (SS4.13 "Reclaimed").
   *
   * Call this with the replay answer for a `mustReplay` entry produced by
   * `joinSnapshot`, passing the same snapshot's `queuedTurns` commandIds.
   */
  resolveReplayAtJoin(
    commandId: string,
    answer: ReplayAnswer,
    snapshotQueuedCommandIds: Iterable<string>,
  ): PendingRetirement<I> | "held" {
    this.#assertNotEphemeralReplay(commandId);
    const entry = this.#entries.get(commandId);
    if (entry === undefined) return "held";

    if (answer.kind === "error") {
      if (!PendingCommandSet.isSettlement(answer.error)) return "held";
      return this.#retire(entry, this.#rejectionRetirement(entry, answer.error));
    }

    const stillQueuedByServer = new Set(snapshotQueuedCommandIds).has(commandId);
    if (answer.ack.disposition === QUEUED_DISPOSITION && !stillQueuedByServer) {
      // The snapshot just proved this ack stale.
      return this.#retire(entry, {
        kind: "reclaimed",
        commandId,
        input: entry.input,
        restoreToComposer: true,
      });
    }

    // A still-pending "steered" or "started" ack: the entry stays pending and
    // materializes or settles later. Never promote it locally.
    entry.ack = answer.ack;
    return "held";
  }

  /**
   * Abnormal death of an EPHEMERAL-profile host (SS2.13, SS4.4.3 carve-out):
   * nothing is ever settled, replaying a `commandId` at a new host is
   * forbidden, and every entry falls under the discard obligation as
   * terminal-unknown — a client-side annotation, never a wire fact.
   */
  discardEphemeral(): readonly PendingRetirement<I>[] {
    const out: PendingRetirement<I>[] = [];
    for (const entry of this.#ordered()) {
      this.#ephemeralDiscardedCommandIds.add(entry.commandId);
      out.push(
        this.#retire(entry, {
          kind: "terminalUnknown",
          commandId: entry.commandId,
          input: entry.input,
        }),
      );
    }
    this.#discarded = true;
    return out;
  }

  /** Has the ephemeral discard closed this set? */
  get discarded(): boolean {
    return this.#discarded;
  }

  #assertSessionActive(): void {
    if (this.#discarded) {
      throw new MuseSessionDiscardedError(
        "ephemeral session was discarded after abnormal host death; it accepts no new submissions",
      );
    }
  }

  #assertNotEphemeralReplay(commandId: string): void {
    if (this.#ephemeralDiscardedCommandIds.has(commandId)) {
      throw new MuseSessionDiscardedError(
        `ephemeral host died; commandId \`${commandId}\` cannot be replayed against a new host`,
      );
    }
  }

  /**
   * Entries in render order.
   *
   * Before any join this is submission order. After a join, entries the
   * server confirmed queued are re-anchored to the end of the reconciled
   * fold and ordered among themselves by `queuedTurns` — so they sort after
   * the submission-anchored entries (steers and unacked), which keep their
   * own anchors. That is SS4.13's "entries render in submission order, and
   * for queued submits the server-confirmed order wins whenever it is
   * observed".
   */
  list(): readonly PendingCommandEntry<I>[] {
    return this.#ordered().map((entry) => {
      const out: PendingCommandEntry<I> = {
        commandId: entry.commandId,
        input: entry.input,
        anchorAfterItemId: entry.anchorAfterItemId,
        submissionIndex: entry.submissionIndex,
        ...(entry.displayText !== undefined ? { displayText: entry.displayText } : {}),
        ...(entry.ack !== undefined ? { ack: entry.ack } : {}),
        ...(entry.queuedOrder !== undefined ? { queuedOrder: entry.queuedOrder } : {}),
      };
      return out;
    });
  }

  get(commandId: string): PendingCommandEntry<I> | undefined {
    return this.list().find((e) => e.commandId === commandId);
  }

  has(commandId: string): boolean {
    return this.#entries.has(commandId);
  }

  get size(): number {
    return this.#entries.size;
  }

  /**
   * Only a durable `commandRejected` (-32030) settles a command. Everything
   * else admitted nothing (SS4.13).
   *
   * The registry binds `-32030` <-> `commandRejected` one-to-one (SS3.1.2
   * Appendix B), so a response where the two fields DISAGREE is a server
   * fault in which one field still asserts the durable rejection. Either
   * signal settles (OR): SS3.1.2's stated bias for unfamiliar vocabulary is
   * toward terminal ("treat unknown reasons as terminal rejections"), and
   * holding forever on a half-asserted rejection strands the entry as the
   * durable-looking echo SS4.13 forbids.
   */
  static isSettlement(error: CommandErrorResponse): boolean {
    return error.code === COMMAND_REJECTED_CODE || error.kind === COMMAND_REJECTED_KIND;
  }

  #rejectionRetirement(entry: InternalEntry<I>, error: CommandErrorResponse): PendingRetirement<I> {
    const reason = error.reason ?? "";
    if (reason === "abandoned") {
      return {
        kind: "abandoned",
        commandId: entry.commandId,
        input: entry.input,
        restoreToComposer: true,
      };
    }
    return {
      kind: "rejected",
      commandId: entry.commandId,
      reason,
      input: entry.input,
      restoreToComposer: true,
    };
  }

  #retire(entry: InternalEntry<I>, retirement: PendingRetirement<I>): PendingRetirement<I> {
    this.#entries.delete(entry.commandId);
    return retirement;
  }

  #ordered(): InternalEntry<I>[] {
    const submissionAnchored: InternalEntry<I>[] = [];
    const launchOrdered: InternalEntry<I>[] = [];
    for (const entry of this.#entries.values()) {
      (entry.queuedOrder === undefined ? submissionAnchored : launchOrdered).push(entry);
    }
    submissionAnchored.sort((a, b) => a.submissionIndex - b.submissionIndex);
    launchOrdered.sort((a, b) => (a.queuedOrder ?? 0) - (b.queuedOrder ?? 0));
    return [...submissionAnchored, ...launchOrdered];
  }
}
