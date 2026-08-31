/**
 * SS4.8 gap recovery by splice-fill (spec 14990 FR-020 / T032, tdd SS4.8).
 *
 * Split out of `session.ts` for the same reason `approval.ts` and
 * `turn-submit.ts` were: this is a delivery-plane concern with its own buffer,
 * page walk, and failure vocabulary, and `Session` was already the package's
 * largest module.
 *
 * THE RECIPE, verbatim from tdd SS4.8 and unchanged here: buffer live events
 * at cursors at or after `next` as they arrive; page forward from `after` with
 * `view/page` until the walk reaches `next`; discard the paged events the
 * buffer already holds; splice the buffer after the paged prefix. D-030's
 * second sanctioned path (drop state and re-anchor at the latest compaction
 * snapshot) is NOT built here — it is the #208 lane's spec work, and building
 * both would be a second concrete path for one current use.
 *
 * CURSORS STAY OPAQUE (tdd SS4.1). Nothing below orders two cursors: "at or
 * after `next`" is delivery ORDER, not a comparison — every live frame that
 * arrives after the gap marker is, by the server's own delivery contract, at
 * or after `next`. The walk stops on cursor EQUALITY with the target or on the
 * server's own end-of-view, and the overlap is discarded by set membership.
 */

import { MuseForeignSessionError, MuseGapFillError } from "../errors.js";
import type { Connection } from "../connection/connection.js";
import type { SessionFold } from "../fold/session-fold.js";
import type { PendingRetirement } from "../pending/pending-command-set.js";

import type { ViewPageParams, ViewPageResult } from "@muse/msp";

/**
 * How many events one `view/page` asks for.
 *
 * Any value in the published 1–1000 bound (`ViewPageParams.limit`) is correct
 * — the server MAY serve fewer and the walk follows `nextCursor` either way —
 * so this trades round trips against frame size and is deliberately not a
 * knob: a per-session page size would be a public option with no current
 * consumer asking for one (Constitution XI).
 */
const PAGE_LIMIT = 200;

/** One wire frame, exactly as `Session.apply`'s wide overload accepts it. */
export interface WireFrame {
  readonly method: string;
  readonly params?: unknown;
}

/**
 * Where a drained frame's side effects go. The filler re-feeds frames through
 * `Session`'s own fold-and-route path, so the retirements and the client→server
 * I/O they trigger belong to `Session`, not here.
 */
export interface DrainSink<I> {
  readonly retirements: PendingRetirement<I>[];
  readonly tasks: Promise<readonly PendingRetirement<I>[]>[];
}

export interface GapFillerOptions<I> {
  readonly sessionId: string;
  /** Absent on a fold-only `Session`: there is nothing to page through. */
  readonly connection: Connection | undefined;
  readonly fold: SessionFold;
  /** Fold and route ONE frame, collecting what it produced. */
  readonly apply: (frame: WireFrame, into: DrainSink<I>) => void;
  /** SS2.13.3b: a discharged session folds nothing, fill or no fill. */
  readonly discarded: () => boolean;
}

/** Reported, never thrown — see {@link MuseGapFillError}. */
export type GapFillFailureHandler = (failure: MuseGapFillError) => void;

/** The shared already-settled result for a fill that produced no retirement. */
const NO_RETIREMENTS: Promise<readonly never[]> = Promise.resolve([]);

export class GapFiller<I> {
  readonly #options: GapFillerOptions<I>;
  /** Live frames held while a fill is in flight, in arrival order. */
  readonly #buffer: WireFrame[] = [];
  #filling = false;
  #cursor = "";
  #onFailure: GapFillFailureHandler | undefined;

  constructor(options: GapFillerOptions<I>) {
    this.#options = options;
  }

  /**
   * Cursors the page served at or after a target — the events whose LIVE twin
   * the wire has yet to deliver.
   *
   * THE LATE HALF of the recipe's overlap discard, and only that half (PR
   * #24930 review rounds 1 and 2). A twin that has already arrived is in the
   * buffer, and `#drain` discards those against its own local set of EVERY
   * paged cursor. This set covers the other window: the wire promises no order
   * between the marker and the frame at `next`, so a twin can legally arrive
   * after the fill completed, when the buffer is gone. Folding it then re-runs
   * its routing — for a `turn/started`, a duplicate SS4.13 queue-movement
   * replay on the wire.
   *
   * SELF-DRAINING: an entry is removed the moment its twin arrives, and only
   * cursors at or after a target ever enter (the walk stops at the page that
   * carries it, so at most one page's worth per target).
   *
   * RESIDUAL, stated rather than hidden: an entry whose twin the wire never
   * delivers — because a LATER hole swallowed it — has no arrival to retire it
   * and stays, a short string each, bounded by one page's worth per TARGET —
   * and a coalesced fill has several, since each extension's reaching page adds
   * its own batch.
   *
   * Two prunes were tried and both were defects, so neither is coming back
   * without a proof neither had. Clearing per fill (round 2) drops the refusal
   * for a twin that is still on its way. Retiring inside the WALK when it meets
   * the cursor before its own target (round 3) looks like page-order proof that
   * the twin was swallowed, but the walk cannot see the BUFFER — a coalescing
   * gap moves the target past a cursor whose twin is sitting in it, and the
   * entry is deleted out from under the drain (round 4). Deciding staleness any
   * other way means ordering two opaque cursors, which tdd SS4.1 forbids.
   */
  readonly #servedTwins = new Set<string>();

  /** While true, every live frame but the gap marker itself is held. */
  get filling(): boolean {
    return this.#filling;
  }

  /**
   * Was this frame already applied from a page, as part of the overlap the
   * splice discards? Consuming: a twin is refused exactly once.
   *
   * Returns the matched CURSOR rather than a boolean so the caller can report
   * which event it refused without re-reading (and re-defaulting) a field this
   * method already proved is there.
   */
  claimServedTwin(frame: WireFrame): string | undefined {
    const cursor = GapFiller.#viewCursorOf(frame);
    if (cursor === undefined || !this.#servedTwins.has(cursor)) return undefined;
    this.#servedTwins.delete(cursor);
    return cursor;
  }

  /** Observe fills that did not complete. See {@link MuseGapFillError}. */
  onError(handler: GapFillFailureHandler): void {
    this.#onFailure = handler;
  }

  /** Hold one live frame until the paged prefix is in. */
  hold(frame: WireFrame): void {
    this.#buffer.push(frame);
  }

  /**
   * Recover the fold's outstanding hole.
   *
   * Called on every `view/gap`, including one that lands mid-fill: the running
   * walk reads its target from `fold.pendingGap` on each pass, so a coalesced
   * hole extends the walk in flight rather than starting a second one racing
   * it for the same cursor stream.
   */
  start(): Promise<readonly PendingRetirement<I>[]> {
    const gap = this.#options.fold.pendingGap;
    // Only reachable if a caller invokes this with nothing outstanding; the
    // one production caller folds the marker first, which always sets it.
    if (gap === undefined) return NO_RETIREMENTS;
    if (this.#filling) return NO_RETIREMENTS;
    const connection = this.#options.connection;
    if (connection === undefined) {
      // Nothing is buffered on this path: no fill is coming to release it, and
      // holding the live tail forever would turn one reported hole into a
      // silent second one.
      this.#report(new MuseGapFillError("noConnection", gap.after, gap.next));
      return NO_RETIREMENTS;
    }
    this.#filling = true;
    this.#cursor = gap.after;
    // DELIBERATELY NOT CLEARED (PR #24930 review round 2). An earlier draft
    // cleared here, reasoning that a surviving entry's twin must lie inside the
    // hole this gap names and so would never arrive. That conflated "not
    // delivered yet" with "inside the new hole": a cursor the previous fill
    // served can sit at or AFTER this gap's `next`, in which case its live twin
    // is still coming and clearing loses the only refusal that stops it folding
    // twice. Entries are one-shot and matched by cursor equality, and a cursor
    // names a unique position (tdd SS4.1), so a retained entry can only ever
    // refuse its own true twin.
    return this.#run(connection);
  }

  async #run(connection: Connection): Promise<readonly PendingRetirement<I>[]> {
    const paged: WireFrame[] = [];
    let filled = false;
    try {
      await this.#walk(connection, paged);
      filled = true;
    } catch (error) {
      this.#reportFailure(error);
    }
    // ALWAYS drained, success or failure: the buffered tail is made of events
    // this client really did receive, and swallowing them would add a second
    // hole to the one just reported.
    const drained = this.#drain(paged);
    if (!filled) return drained;

    // THE CLEAR WINDOW (PR #24930 review round 1, P0). `#walk` clears the hole
    // and returns, but `#drain` — which lowers `#filling` — runs a microtask
    // later. A `view/gap` folding in between skips the buffer (markers must, or
    // they could not extend a live walk), finds `#filling` still true, and
    // `start()` returns early: no second `view/page`, no failure report, and
    // `pendingGap` set forever. That is the silent hole FR-020 forbids, and it
    // also costs the consumer its D-030 re-anchor cue.
    //
    // Re-checked HERE, in the same synchronous run that lowered the flag, so no
    // frame can land inside the check. Success only: a fill that FAILED keeps
    // its stated no-retry posture, and its hole is already reported.
    if (this.#options.discarded()) return drained;
    if (this.#options.fold.pendingGap === undefined) return drained;
    const restarted = this.start();
    return Promise.all([drained, restarted]).then(([first, second]) => [...first, ...second]);
  }

  /**
   * Page until the fold's outstanding hole is closed.
   *
   * The outer loop is what makes a mid-walk `view/gap` safe: `gapFilled`
   * refuses to clear a target the fold has since extended, so the walk simply
   * keeps going toward the newer `next` on the SAME cursor stream.
   */
  async #walk(connection: Connection, paged: WireFrame[]): Promise<void> {
    for (;;) {
      // A session discharged mid-walk stops here, BEFORE `gapFilled`: there is
      // nothing left to be current with, and clearing the hole would have the
      // fold report a discarded transcript complete. The host is gone, so a
      // further page would also wait on an answer that is never coming — which
      // is a hang, not a fill.
      if (this.#options.discarded()) return;
      const gap = this.#options.fold.pendingGap;
      if (gap === undefined) return;
      const target = gap.next;
      await this.#walkTo(connection, target, gap.after, paged);
      if (this.#options.discarded()) return;
      if (this.#options.fold.gapFilled(target)) return;
    }
  }

  async #walkTo(
    connection: Connection,
    target: string,
    after: string,
    paged: WireFrame[],
  ): Promise<void> {
    for (;;) {
      if (this.#options.discarded()) return;
      const result = await this.#page(connection, this.#cursor);
      let reached = false;
      for (const event of result.events) {
        this.#requireOwnSession(event, after, target);
        const cursor = event.params.viewCursor;
        // An EARLIER fill already served — and applied — this durable event.
        // A later walk may legally page through the same range, and re-applying
        // it here is the same double fold the discard exists to prevent (PR
        // #24930 review round 3).
        const alreadyApplied = this.#servedTwins.has(cursor);
        // Equality, never a relational compare: `next` is a cursor, and
        // cursors are opaque (tdd SS4.1). Set BEFORE the skip below, or a
        // target the walk skips is a target the walk never reaches, and it
        // pages straight past its own stopping point.
        if (cursor === target) reached = true;
        if (alreadyApplied) {
          // SKIPPED AND NOTHING ELSE (PR #24930 review round 4). An earlier
          // draft also retired the entry here when the walk met it before its
          // target, reasoning that the twin must have been swallowed. The walk
          // cannot see the BUFFER, so that reasoning missed the case where the
          // twin is sitting in it: a coalescing gap moves the target past the
          // cursor, the walk meets it early, and the entry is deleted out from
          // under the drain, which then folds the buffered twin a second time.
          // Leaving the entry alone is what keeps the drain able to refuse it.
          continue;
        }
        paged.push(event);
        // At or after `next` — by page ORDER, not by comparing two cursors.
        // These are the events the live tail also delivers, so their twins are
        // the overlap the splice discards.
        if (reached) this.#servedTwins.add(cursor);
      }
      // The server's own end of the view. `next` names a LIVE cursor and
      // `view/page` serves durable-sourced events only (tdd SS4.7.3), so a
      // hole whose tail was ephemeral ends here and never at `target`.
      if (result.nextCursor === null) return;
      // PROGRESS is the only bound on this walk, and it has to be, because a
      // legitimate fill is unbounded in length: an attempt cap would silently
      // truncate one. A page that carries no event, repeats the cursor it was
      // given, or answers with no cursor at all has not advanced, and paging
      // again would ask the identical question forever.
      if (
        result.events.length === 0 ||
        typeof result.nextCursor !== "string" ||
        result.nextCursor === this.#cursor
      ) {
        throw new MuseGapFillError("pageStalled", after, target);
      }
      this.#cursor = result.nextCursor;
      if (reached) return;
    }
  }

  async #page(connection: Connection, cursor: string): Promise<ViewPageResult> {
    const params: ViewPageParams = {
      cursor,
      limit: PAGE_LIMIT,
      sessionId: this.#options.sessionId,
    };
    const raw = await connection.request(
      "view/page",
      params as unknown as Record<string, unknown>,
    );
    return raw as unknown as ViewPageResult;
  }

  /**
   * A page that serves another session's events aborts the fill.
   *
   * The same check `Session.apply` makes on a live frame, at the one other
   * place a frame can enter the fold. Folding it would corrupt this
   * transcript with another session's history, and the request that asked for
   * it named this `sessionId`, so there is no reading under which the answer
   * is right.
   */
  #requireOwnSession(event: WireFrame, after: string, target: string): void {
    const named = (event.params as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof named === "string" && named !== this.#options.sessionId) {
      throw new MuseGapFillError(
        "pageFailed",
        after,
        target,
        new MuseForeignSessionError(
          `view/page for ${this.#options.sessionId} served an event for session ${named}`,
        ),
      );
    }
  }

  /**
   * Splice: the paged prefix, then the buffered tail minus the overlap.
   *
   * Synchronous up to its return, deliberately. Clearing the buffer and the
   * flag in the same run of code that re-feeds them is what makes the handover
   * atomic — an `await` in the middle would let a live frame arrive after the
   * flag dropped and fold ahead of the tail still waiting in the buffer.
   *
   * It is outside the walk's `try` because the buffered tail must be released
   * on FAILURE too, and it needs no `try` of its own: every frame it re-feeds
   * has already passed the one check `Session.apply` can throw on — the live
   * half at buffer time, the paged half in the walk — so this cannot be the
   * rejection `SessionApplyOutcome.io` promises never to be.
   */
  #drain(paged: readonly WireFrame[]): Promise<readonly PendingRetirement<I>[]> {
    const buffered = this.#buffer.splice(0);
    this.#filling = false;
    // SS2.13.3b outranks the fill: a session discharged while the walk was in
    // flight folds nothing more, and neither half of the splice is exempt.
    if (this.#options.discarded()) return NO_RETIREMENTS;
    const sink: DrainSink<I> = { retirements: [], tasks: [] };
    // EVERY paged cursor, not just the ones at or after a target (PR #24930
    // review round 2, P0). A coalesced gap restarts the walk toward the NEW
    // target with `reached` false, so paged events between the two targets
    // never enter `#servedTwins` — yet their twins ARE in this buffer, because
    // a cursor at or after the first target was delivered live before the
    // second hole opened. Claiming on the persistent set alone folded those
    // twice.
    const served = new Set<string>();
    for (const frame of paged) {
      const cursor = GapFiller.#viewCursorOf(frame);
      if (cursor !== undefined) served.add(cursor);
      this.#options.apply(frame, sink);
    }
    for (const frame of buffered) {
      // The overlap the recipe discards: the page already served this cursor,
      // so folding the buffered copy would route the same event twice.
      const cursor = GapFiller.#viewCursorOf(frame);
      // BOTH sets (PR #24930 review round 3). `served` is what THIS fill
      // applied; `#servedTwins` carries what EARLIER fills served, including
      // the cursors this walk declined to re-apply — nothing deletes those
      // inside the walk, precisely so this branch can still find them. A twin
      // of either can be sitting in this buffer, because `Session.apply`
      // buffers every live frame while a fill runs, before the late-window
      // claim can see it, so this branch is the only thing left to refuse it.
      if (cursor !== undefined && (served.has(cursor) || this.#servedTwins.has(cursor))) {
        // Consume the persistent entry too, so a twin refused here is not
        // refused a second time if the wire also delivers it later.
        this.#servedTwins.delete(cursor);
        continue;
      }
      this.#options.apply(frame, sink);
    }
    if (sink.tasks.length === 0) return Promise.resolve(sink.retirements);
    return Promise.all(sink.tasks).then((batches) => [...sink.retirements, ...batches.flat()]);
  }

  static #viewCursorOf(frame: WireFrame): string | undefined {
    const cursor = (frame.params as { viewCursor?: unknown } | undefined)?.viewCursor;
    return typeof cursor === "string" ? cursor : undefined;
  }

  #reportFailure(error: unknown): void {
    if (error instanceof MuseGapFillError) {
      this.#report(error);
      return;
    }
    // Anything the round trip itself threw — an `MspError` the host authored,
    // a `ProtocolError`, a dead transport — is the same fact from a consumer's
    // point of view: the hole is still there. The cause is carried rather than
    // flattened so the repair stays diagnosable.
    const gap = this.#options.fold.pendingGap;
    this.#report(
      new MuseGapFillError("pageFailed", gap?.after ?? "", gap?.next ?? "", error),
    );
  }

  #report(failure: MuseGapFillError): void {
    try {
      this.#onFailure?.(failure);
    } catch {
      // The consumer's failure OBSERVER threw. Swallowed for the reason
      // `ApprovalRouter.#report` states: this rides
      // `SessionApplyOutcome.io`, whose contract is "IT NEVER REJECTS", and
      // most consumers never await it — so a rejection here would surface as
      // an unhandled rejection and kill the embedder.
    }
  }
}
