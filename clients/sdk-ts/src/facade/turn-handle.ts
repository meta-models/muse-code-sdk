/**
 * `TurnHandle` — one turn's view of the fold (spec 14990 FR-018, INV-014;
 * tasks.md T030).
 *
 * A handle owns two things: the SS3.1.4 turn-wait, and the async iterators
 * that ride the fold for this turn. It authors no wire traffic and holds no
 * durable state — `Session` feeds it folded events and it fans them out.
 *
 * INV-006 governs the wait: the SDK never locally times out, fails, or
 * completes a turn. Every settlement below traces to a server-authored fact,
 * with one sanctioned exception that is not a terminal at all —
 * terminal-unknown after an ephemeral host death, which SS2.13.3b makes a
 * client MUST ("stop waiting for a terminal") and which stays an annotation
 * rather than a synthesized event.
 */

import type {
  Item,
  ItemDeltaParams,
  TurnCompletedParams,
  TurnErrorKind,
  TurnTerminal,
  TurnUnqueuedParams,
} from "@muse/msp";

/**
 * Bound through the CLOSED extraction of each generated vocabulary. Both
 * `TurnTerminal` and `TurnErrorKind` end in `| (string & {})`, so a bare
 * `"launchEror"` compiles green against them — and this discriminator is
 * barrel-exported, so the typo would ship. Every sibling literal in this
 * package is bound the same way for the same reason.
 */
const TERMINAL_FAILED: Extract<TurnTerminal, "failed"> = "failed";
const LAUNCH_ERROR: Extract<TurnErrorKind, "launchError"> = "launchError";

import type { DeepReadonly } from "../fold/session-fold.js";

/**
 * What the iterators yield: the fold's stored item, sealed.
 *
 * `DeepReadonly` because these ARE the objects the fold holds — the generated
 * wire types carry no `readonly`, so an unsealed yield would let a consumer
 * write `item.revision = 0` and defeat the INV-003 guard through the read
 * surface (PR #23087 review round). The seal is compile-time only; nothing is
 * frozen or cloned on the hot path.
 */
export type FoldedItem = DeepReadonly<Item>;

/**
 * How a turn ended, from a waiter's point of view.
 *
 * SS3.1.4 names exactly two resolutions of the turn-wait, and the pre-minted
 * turn is why there are two rather than one:
 *
 *  - `completed` — the ordinary terminal, AND the launch-failure exit
 *    (`"deferred_start_failed"`: terminal `"failed"`, `error.kind:
 *    "launchError"`, no preceding `turn/started`). `isLaunchFailure` reads
 *    that WIRE marker; `observedStart` does not discriminate them, because a
 *    terminal-first fold is legitimate for turns that really ran.
 *  - `unqueued` — the reclaim (SS3.6). No `turn/completed` will ever carry
 *    this `turnId`, so a wait folding only `turn/completed` hangs forever.
 *
 * `turn/retracted` and `turn/retryScheduled` are deliberately absent: a
 * retracted turn still reaches its own terminal, and a scheduled retry is
 * explicitly non-terminal (SS4.5.1).
 */
export type TurnOutcome =
  | {
      readonly kind: "completed";
      readonly params: TurnCompletedParams;
      /**
       * Did THIS session observe a `turn/started` for this turn?
       *
       * A session-local observation, NOT a launch-failure marker. The fold
       * deliberately accepts a terminal-first `turn/completed` for turns that
       * really did run — single-shot turns, gap fills, and any consumer that
       * attached mid-stream or replayed a canned transcript from partway
       * through — so `false` here covers those too.
       *
       * The launch failure has its own WIRE marker and that is the one to
       * branch on: `terminal: "failed"` with `error.kind: "launchError"`
       * (tdd SS3.1.4/SS4.5.1). `isLaunchFailure` below reads it.
       */
      readonly observedStart: boolean;
    }
  | { readonly kind: "unqueued"; readonly params: TurnUnqueuedParams }
  /**
   * SS2.13.3b: an ephemeral host died, so the client stops waiting. Carries no
   * `reason`: the arm has exactly one cause, so a single-valued field would
   * add nothing `kind` does not already say while freezing a permanent
   * obligation into a public type (Constitution XI).
   */
  | { readonly kind: "terminalUnknown" };

/**
 * The `"deferred_start_failed"` exit (SS3.1.4/SS3.2): a pre-minted turn whose
 * launch errored at the terminal boundary, so the runtime wrote its terminal
 * directly and no `turn/started` was ever emitted BY THE HOST.
 *
 * Read off the wire, never off local observation: a client that had not been
 * listening when the turn started is not looking at a launch failure.
 */
export function isLaunchFailure(outcome: TurnOutcome): boolean {
  return (
    outcome.kind === "completed" &&
    outcome.params.terminal === TERMINAL_FAILED &&
    outcome.params.error?.kind === LAUNCH_ERROR
  );
}

/**
 * A single-consumer push stream. Buffers when nobody is awaiting and hands the
 * buffer over before reporting an end or a failure, so a consumer never loses
 * events it was already owed.
 */
class PushStream<T> implements AsyncIterableIterator<T> {
  readonly #buffer: T[] = [];
  readonly #onFinished: () => void;
  /**
   * FIFO, not a single slot. `items()`/`deltas()` hand out a plain
   * `AsyncIterableIterator`, so `Promise.all([it.next(), it.next()])` prefetch
   * is a reasonable thing for a consumer to write — and a single slot let the
   * second call overwrite the first waiter, leaving the first promise never
   * settled and handing its value to the second caller. A silently
   * never-settling promise is the hang class this file exists to prevent.
   */
  readonly #waiters: {
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }[] = [];
  #ended = false;
  #failure: unknown;

  /**
   * `onFinished` deregisters this stream from its owner. Without it a consumer
   * that `break`s out of a `for await` — or simply drops the iterator — stays
   * in the fan-out set for the rest of the turn, so every later event is
   * pushed into a stream nobody reads. A render loop that re-attaches per
   * frame would grow one dead stream per frame.
   */
  constructor(onFinished: () => void) {
    this.#onFinished = onFinished;
  }

  push(value: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) {
      this.#buffer.push(value);
      return;
    }
    waiter.resolve({ done: false, value });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    // Drain EVERY queued waiter, not just the oldest.
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(error: unknown): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  next(): Promise<IteratorResult<T>> {
    // Buffered values come out first even after an end or a failure: the
    // consumer was already owed them, and swallowing them here would be the
    // silent hole the iterators exist to prevent.
    if (this.#buffer.length > 0) {
      return Promise.resolve({ done: false, value: this.#buffer.shift() as T });
    }
    if (this.#failure !== undefined) return Promise.reject(this.#failure);
    if (this.#ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.#waiters.push({ reject, resolve });
    });
  }

  /** `break`/`return` inside a `for await`: drop the backlog and finish. */
  return(): Promise<IteratorResult<T>> {
    this.#buffer.length = 0;
    this.end();
    this.#onFinished();
    return Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<T> {
    return this;
  }
}

/** The turn's replayable backlog, supplied by `Session` from the fold. */
export type ItemReplay = () => readonly FoldedItem[];

/**
 * A turn, as a CONSUMER sees it — the SS7.1 turn surface and nothing else.
 *
 * `Session.turn()` returns this rather than the concrete `TurnHandle` because
 * the handle's "fed by Session" mutators (`settleCompleted`, `settleUnqueued`,
 * `fail`, `pushItem`, …) would otherwise be public: an embedder could call
 * `settleCompleted` and fabricate a terminal the server never authored, which
 * is exactly what INV-006 forbids. They stay reachable only through
 * `Session.apply`, i.e. only from a server-authored event.
 */
export interface Turn {
  readonly turnId: string;
  /** Did THIS session observe a `turn/started`? Not a launch-failure marker. */
  readonly observedStart: boolean;
  readonly completed: Promise<TurnOutcome>;
  items(): AsyncIterableIterator<FoldedItem>;
  deltas(): AsyncIterableIterator<ItemDeltaParams>;
}

export class TurnHandle implements Turn {
  readonly turnId: string;
  readonly #replayItems: ItemReplay;
  readonly #itemStreams = new Set<PushStream<FoldedItem>>();
  readonly #deltaStreams = new Set<PushStream<ItemDeltaParams>>();
  readonly #completed: Promise<TurnOutcome>;

  #settle: ((outcome: TurnOutcome) => void) | undefined;
  #fail: ((error: unknown) => void) | undefined;
  #observedStart = false;
  #settled = false;
  /**
   * Retained so an iterator opened AFTER the failure reports it too. Without
   * it a late `items()` saw only `#settled` and ended cleanly — handing the
   * consumer a partial replay plus a tidy `done`, i.e. an unfinished turn
   * rendered as finished, which is the invented completion INV-006 forbids.
   */
  #failure: unknown;

  constructor(turnId: string, replayItems: ItemReplay) {
    this.turnId = turnId;
    this.#replayItems = replayItems;
    this.#completed = new Promise<TurnOutcome>((resolve, reject) => {
      this.#settle = resolve;
      this.#fail = reject;
    });
    // A wait nobody awaits must not crash the embedding host on rejection.
    // Later awaiters still receive it (the same posture `MuseServeChild` takes).
    this.#completed.catch(() => {});
  }

  /** Settles on `turn/completed`, `turn/unqueued`, or the ephemeral discard. */
  get completed(): Promise<TurnOutcome> {
    return this.#completed;
  }

  /**
   * How many iterators this handle is still fanning out to.
   *
   * Exposed so the deregistration contract is assertable: an iterator a
   * consumer broke out of, or simply dropped, must leave this set rather than
   * accumulate for the rest of the turn.
   */
  get liveStreamCount(): number {
    return this.#itemStreams.size + this.#deltaStreams.size;
  }

  /** Did a `turn/started` ever fold for this turn? */
  get observedStart(): boolean {
    return this.#observedStart;
  }

  /**
   * This turn's items: everything the fold already holds for it, at its
   * current revision and in first-opened order, then the live tail — one yield
   * per fold-observed revision CHANGE. A stale re-emission mutates nothing
   * (INV-003) and therefore yields nothing.
   *
   * The iterator ends when the turn settles; it never ends on a local timeout.
   */
  items(): AsyncIterableIterator<FoldedItem> {
    const stream: PushStream<FoldedItem> = new PushStream<FoldedItem>(() =>
      this.#itemStreams.delete(stream),
    );
    for (const item of this.#replayItems()) stream.push(item);
    this.#admit(stream, this.#itemStreams);
    return stream;
  }

  /**
   * This turn's `item/delta` frames, live only.
   *
   * Deliberately NOT replayed, and the asymmetry with `items()` is a fact
   * about the fold rather than an oversight: the store holds each item at its
   * latest revision plus the ACCUMULATED delta text per field path
   * (`ItemStore.accumulated`), never the delta event sequence. A consumer
   * attaching mid-turn reads the accumulated value from the fold; there is no
   * retained event list to replay, and inventing one would be a second copy of
   * state that INV-002's determinism would then have to defend.
   */
  deltas(): AsyncIterableIterator<ItemDeltaParams> {
    const stream: PushStream<ItemDeltaParams> = new PushStream<ItemDeltaParams>(() =>
      this.#deltaStreams.delete(stream),
    );
    this.#admit(stream, this.#deltaStreams);
    return stream;
  }

  /**
   * Register a fresh stream, or finish it the way this turn already finished.
   * The failure branch comes FIRST: a turn that failed is not a turn that
   * ended. `PushStream` drains the replay before reporting either, so a late
   * consumer still receives everything it was owed.
   */
  #admit<T>(stream: PushStream<T>, into: Set<PushStream<T>>): void {
    if (this.#failure !== undefined) stream.fail(this.#failure);
    else if (this.#settled) stream.end();
    else into.add(stream);
  }

  // ---- fed by Session -----------------------------------------------------

  markStarted(): void {
    this.#observedStart = true;
  }

  pushItem(item: FoldedItem): void {
    for (const stream of this.#itemStreams) stream.push(item);
  }

  pushDelta(params: ItemDeltaParams): void {
    for (const stream of this.#deltaStreams) stream.push(params);
  }

  settleCompleted(params: TurnCompletedParams): void {
    this.#finish({ kind: "completed", observedStart: this.#observedStart, params });
  }

  settleUnqueued(params: TurnUnqueuedParams): void {
    this.#finish({ kind: "unqueued", params });
  }

  /** SS2.13.3b: an ephemeral host died; stop waiting for a terminal. */
  settleTerminalUnknown(): void {
    this.#finish({ kind: "terminalUnknown" });
  }

  /**
   * A DURABLE host died abnormally. The waiter gets no answer here — FM-001
   * puts the terminals on resume — so it is rejected rather than resolved: a
   * resolution would be the invented terminal INV-006 forbids, and silence
   * would be the SS3.1.4 hang.
   */
  fail(error: unknown): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#failure = error;
    this.#fail?.(error);
    this.#clear();
    for (const stream of this.#itemStreams) stream.fail(error);
    for (const stream of this.#deltaStreams) stream.fail(error);
    this.#itemStreams.clear();
    this.#deltaStreams.clear();
  }

  #finish(outcome: TurnOutcome): void {
    // First settlement wins: a duplicate terminal is a losing racer's echo.
    if (this.#settled) return;
    this.#settled = true;
    this.#settle?.(outcome);
    this.#clear();
    for (const stream of this.#itemStreams) stream.end();
    for (const stream of this.#deltaStreams) stream.end();
    this.#itemStreams.clear();
    this.#deltaStreams.clear();
  }

  #clear(): void {
    this.#settle = undefined;
    this.#fail = undefined;
  }
}
