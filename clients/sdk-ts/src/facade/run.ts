/**
 * `Session.run` — one call from a prompt to the turn's final answer (spec
 * 14990 FR-79108-1).
 *
 * Built only from facade verbs the session already has: `sendUserTurn`, the
 * turn-wait, `items()`, and `unqueue`/`cancel` for an abort; the abort's
 * unqueue goes through the session's internal `resendableUnqueue`, the same
 * control holding one `commandId` across resends. It holds no state
 * of its own and reaches the fold and the pending set only through those verbs
 * and the read-only pending view, so every SS4.13 rule keeps applying exactly
 * as it does for a hand-written `sendUserTurn` loop.
 */

import type {
  CommandStatus,
  ItemKind,
  ItemStatus,
  MessagePhase,
  TokenUsage,
  TurnInputPart,
  TurnInputPartType,
  TurnStartDisposition,
} from "@muse-code/msp";

import { defaultRetryDelay, MspError } from "../connection/connection.js";
import { COMMAND_REJECTED_KIND } from "../pending/pending-command-set.js";
import { resendableUnqueue, type Session } from "./session.js";
import type { FoldedItem, Turn, TurnOutcome, TurnUnqueueOutcome } from "./turn-handle.js";
import type { SendUserTurnOptions } from "./turn-submit.js";

/** Bound to the generated vocabularies so a misspelling fails `tsc`. */
const TEXT: Extract<TurnInputPartType, "text"> = "text";
const AGENT_MESSAGE: Extract<ItemKind, "agentMessage"> = "agentMessage";
const COMPLETED: Extract<ItemStatus, "completed"> = "completed";
const COMMENTARY: Extract<MessagePhase, "commentary"> = "commentary";
const ACCEPTED: Extract<CommandStatus, "accepted"> = "accepted";
const QUEUED: Extract<TurnStartDisposition, "queued"> = "queued";
/** FR-77912-2's reason for a call the session runtime did not take: nothing was written. */
const RUNTIME_BUSY = "runtime_busy";

/**
 * What `run` forwards to `turn/start`, plus the abort signal. Composed from
 * `SendUserTurnOptions`, so a new `turn/start` member reaches `run` with no
 * edit here. `composerInput` is left out: `run` hands back no SS4.13
 * retirement, so there is nothing for it to restore.
 */
export type RunOptions = Readonly<Omit<SendUserTurnOptions<unknown>, "input" | "composerInput">> & {
  /**
   * Stops the turn. An already-aborted signal rejects at once and sends
   * nothing. An abort while the turn is queued sends `turn/unqueue`, and
   * `turn/cancel` if the turn launched first; while it runs, `turn/cancel`.
   * `run` then waits for the server to end the turn and rejects with
   * `signal.reason`. An abort once the turn has ended sends nothing.
   */
  readonly signal?: AbortSignal;
};

/** What `run` resolves to once the server has ended the turn. */
export interface RunResult {
  readonly turnId: string;
  /** The server-authored outcome; a failed or cancelled turn still resolves. */
  readonly outcome: TurnOutcome;
  /**
   * The `text` of the turn's last `agentMessage` item (in first-opened order)
   * that completed and is not `"commentary"`: an absent or unknown
   * `messagePhase` on a completed item reads as `"finalAnswer"`. `undefined`
   * when the turn produced no such item.
   */
  readonly finalText: string | undefined;
  /** The turn's items as the fold holds them at the end, in first-opened order. */
  readonly items: readonly FoldedItem[];
  /** The turn's token usage from `turn/completed`; absent on other outcomes. */
  readonly usage: TokenUsage | undefined;
}

export async function runTurn<I>(
  host: Session<I>,
  input: string | readonly TurnInputPart[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { signal, ...submit } = options;
  // An already-aborted signal rejects with its reason before anything is sent
  // (the web-platform AbortSignal convention).
  signal?.throwIfAborted();
  const parts: TurnInputPart[] = typeof input === "string" ? [{ text: input, type: TEXT }] : [...input];
  // A refused submit rejects with its own error, aborted or not: no turn
  // exists for an abort to stop.
  const turn = await host.sendUserTurn({ ...submit, input: parts });
  const outcome = signal === undefined ? await turn.completed : await settleOrAbort(host, turn, signal);
  const items: FoldedItem[] = [];
  // The turn has settled, so this replays the fold's items at their latest
  // revision and ends; it never waits.
  for await (const item of turn.items()) items.push(item);
  return {
    finalText: finalAnswerText(items),
    items,
    outcome,
    turnId: turn.turnId,
    usage: outcome.kind === "completed" ? outcome.params.usage : undefined,
  };
}

const ABORTED = Symbol("aborted");

async function settleOrAbort<I>(host: Session<I>, turn: Turn<I>, signal: AbortSignal): Promise<TurnOutcome> {
  let onAbort = (): void => {};
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  let first: TurnOutcome | typeof ABORTED;
  try {
    first = await Promise.race([turn.completed, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  if (first !== ABORTED) return first;
  await stop(host, turn);
  // The turn's end is the server's to report (INV-006). Waiting for it leaves
  // the session idle when `run` rejects, and INV-014 settles this wait on
  // every exit, host death included.
  await turn.completed.catch(() => undefined);
  throw signal.reason;
}

/**
 * Unqueue the turn while this session holds its queued entry and no
 * `turn/started` has folded; otherwise, or when the unqueue loses the launch
 * race (tdd SS3.6 rejects it, never upgrading it to a cancel), cancel it. An
 * unqueue the session runtime did not take (`runtime_busy`, ADR 77912 D1)
 * wrote nothing, so it goes out again under its first `commandId` after the
 * connection's backoff, with no cap, until the host decides it or the turn
 * starts.
 *
 * A refused stop is not reported: whatever it answered, the turn-wait the
 * caller awaits next is what reports how the turn ended.
 */
async function stop<I>(host: Session<I>, turn: Turn<I>): Promise<void> {
  const queued = host.pending
    .list()
    .some((entry) => entry.ack?.turnId === turn.turnId && entry.ack.disposition === QUEUED);
  if (queued && !turn.observedStart) {
    let unqueue: (() => Promise<TurnUnqueueOutcome<I>>) | undefined;
    for (let attempt = 1; ; attempt += 1) {
      try {
        unqueue ??= host[resendableUnqueue](turn.turnId);
        if ((await unqueue()).ack.status === ACCEPTED) return;
        break;
      } catch (error) {
        // Lost the launch race, or refused: the turn may run, so cancel it below.
        if (!untaken(error) || turn.observedStart) break;
      }
      await defaultRetryDelay(attempt);
      if (turn.observedStart) break;
    }
  }
  try {
    await turn.cancel();
  } catch {
    // The turn already ended, or the host is gone; the turn-wait reports which.
  }
}

function untaken(error: unknown): boolean {
  return (
    error instanceof MspError &&
    error.kind === COMMAND_REJECTED_KIND &&
    error.data["reason"] === RUNTIME_BUSY
  );
}

function finalAnswerText(items: readonly FoldedItem[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (
      item !== undefined &&
      item.kind === AGENT_MESSAGE &&
      item.status === COMPLETED &&
      item.messagePhase !== COMMENTARY
    ) {
      return item.text;
    }
  }
  return undefined;
}
