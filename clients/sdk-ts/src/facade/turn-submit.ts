/**
 * `turn/start` submission and same-`commandId` replay (spec 14990 FR-018 /
 * T030 obligations (a) and (d); tdd SS3.1.1, SS3.2, SS4.13).
 *
 * Split out of `session.ts` for the same reason `approval.ts` was: this is a
 * wire-shaping and idempotency concern, not a fold concern, and `Session` was
 * already the package's largest module.
 *
 * It holds the ONE piece of state `PendingCommandSet` deliberately cannot: the
 * `turn/start` params per `commandId`. The set stores the COMPOSER input and is
 * wire-blind by design (INV-001), so a replay — which must re-send the SAME
 * logical command, byte for byte, to be the sanctioned retry rather than a
 * double execution — needs the params to live on this side of that boundary.
 */

import { MspError } from "../connection/connection.js";
import type { Connection } from "../connection/connection.js";
import type { PendingCommandSet } from "../pending/pending-command-set.js";
import type {
  CommandErrorResponse,
  PendingCommandAck,
  PendingRetirement,
  ReplayAnswer,
} from "../pending/pending-command-set.js";

import type { TurnStartParams, TurnStartResult } from "@muse-code/msp";

/** Errors (TS2344) when `T` is inhabited — i.e. when a member is unforwarded. */
type AssertNever<T extends never> = T;

/**
 * What `Session.sendUserTurn` sends, COMPOSED from the generated params rather
 * than restated (INV-001).
 *
 * `commandId` is excluded because `Connection` is the single minter (INV-013);
 * `sessionId` because the session already knows its own and a caller-supplied
 * one could only disagree with it.
 */
export type SendUserTurnOptions<I> = Readonly<
  Omit<TurnStartParams, "commandId" | "sessionId">
> & {
  /**
   * What to hand back to the composer if this submit is ever retired — SS4.13
   * restores the INPUT, not the wire parts. Optional: a consumer that renders
   * nothing optimistically has nothing to restore.
   */
  readonly composerInput?: I;
};

/**
 * Every member forwarded to the wire. Composition alone does not stop drift —
 * the guard chain in `#params` is hand-listed — so a regenerated member fails
 * the BUILD here until it is forwarded.
 */
const TURN_START_FORWARDED = ["input", "displayText", "ifBusy", "reasoningEffort"] as const;
type _TurnStartIsExhaustive = AssertNever<
  Exclude<
    keyof Omit<TurnStartParams, "commandId" | "sessionId">,
    (typeof TURN_START_FORWARDED)[number]
  >
>;

/**
 * An `MspError` as the pending set reads it (SS4.13's settlement test).
 *
 * `undefined` for anything that is NOT a server-authored MSP error — a
 * `ProtocolError`, a dead transport — because those admit nothing AND prove
 * nothing about the intake, so the entry must HOLD rather than be judged.
 */
export function commandErrorResponse(error: unknown): CommandErrorResponse | undefined {
  if (!(error instanceof MspError)) return undefined;
  const reason = error.data["reason"];
  return {
    code: error.code,
    kind: error.kind,
    ...(typeof reason === "string" ? { reason } : {}),
  };
}

export class TurnSubmitter<I> {
  readonly #sessionId: string;
  readonly #connection: Connection | undefined;
  readonly #pending: PendingCommandSet<I>;
  /** See the module doc. Pruned on retirement, so it tracks the pending set. */
  readonly #memory = new Map<string, TurnStartParams>();

  constructor(
    sessionId: string,
    connection: Connection | undefined,
    pending: PendingCommandSet<I>,
  ) {
    this.#sessionId = sessionId;
    this.#connection = connection;
    this.#pending = pending;
  }

  get wired(): boolean {
    return this.#connection !== undefined;
  }

  requireConnection(verb: string): Connection {
    const connection = this.#connection;
    if (connection === undefined) {
      // A plain `Error`: calling a submit verb on a fold-only Session is API
      // misuse, not the foreign-frame STATE `MuseForeignSessionError` names.
      throw new Error(`${verb} needs a connection; this Session was constructed fold-only`);
    }
    return connection;
  }

  /**
   * Record the optimistic SS4.13 entry, then send `turn/start`.
   *
   * The ORDER is the point. An entry created only on the ack is invisible for
   * exactly the window it exists to cover — between the user pressing enter and
   * the host answering — and `anchorAfterItemId` is fixed here, at submission
   * time, because SS4.13's insertion point may never be relocated by events
   * that fold in afterwards.
   */
  async submit(
    options: SendUserTurnOptions<I>,
    anchorAfterItemId: string | null,
  ): Promise<PendingCommandAck> {
    const connection = this.requireConnection("sendUserTurn");
    // Delegated, not re-implemented: the connection owns the single mint, so
    // INV-013's single-minter property survives this verb needing the id early.
    const commandId = connection.mintCommandId();
    const params = this.#params(commandId, options);
    this.#pending.submitted({
      anchorAfterItemId,
      commandId,
      input: options.composerInput as I,
      ...(params.displayText === undefined ? {} : { displayText: params.displayText }),
    });
    this.#memory.set(commandId, params);

    try {
      const ack = await this.#send(connection, params, commandId);
      this.#pending.acked(commandId, ack);
      return ack;
    } catch (error) {
      const response = commandErrorResponse(error);
      // Only a durable -32030 settles; every other error admitted nothing and
      // the entry HOLDS for the caller's same-commandId retry (SS4.13).
      if (response !== undefined) {
        const settled = this.#pending.ackErrored(commandId, response);
        if (settled !== "held") this.forgetRetired([settled]);
      }
      // Rethrown, deliberately: the caller who submitted still holds its own
      // input, so this path needs no second retirement channel.
      throw error;
    }
  }

  /**
   * Re-send one remembered `turn/start` under its ORIGINAL `commandId`
   * (SS3.1.1 — always safe, and the only re-send that is not a double
   * execution).
   *
   * `undefined` means "no answer this set can act on": either this session
   * never authored the command (a caller-seeded entry), or the failure was a
   * transport/protocol one, which proves nothing about the intake.
   */
  async replay(commandId: string): Promise<ReplayAnswer | undefined> {
    const params = this.#memory.get(commandId);
    if (params === undefined) return undefined;
    const connection = this.requireConnection("turn/start replay");
    try {
      return { ack: await this.#send(connection, params, commandId), kind: "ack" };
    } catch (error) {
      const response = commandErrorResponse(error);
      if (response === undefined) return undefined;
      return { error: response, kind: "error" };
    }
  }

  /** Replay one entry and feed the answer back through the live SS4.13 rules. */
  async driveReplay(commandId: string, into: PendingRetirement<I>[]): Promise<void> {
    const answer = await this.replay(commandId);
    if (answer === undefined) return;
    const settled = this.#pending.replayAnswered(commandId, answer);
    if (settled !== "held") into.push(settled);
  }

  /** Drop the replay memory for retired entries so it tracks the pending set. */
  forgetRetired(retirements: readonly PendingRetirement<I>[]): void {
    for (const retirement of retirements) this.#memory.delete(retirement.commandId);
  }

  async #send(
    connection: Connection,
    params: TurnStartParams,
    commandId: string,
  ): Promise<PendingCommandAck> {
    const raw = await connection.command(
      "turn/start",
      params as unknown as Record<string, unknown>,
      { commandId },
    );
    const result = raw as unknown as TurnStartResult;
    // `turnId` comes from the ACK and never from the `commandId`: SS3.2 makes
    // the ack authoritative, and a queued submit's turn may already exist.
    return { disposition: result.disposition, turnId: result.turnId };
  }

  /**
   * OPTIONAL MEANS OMITTED, NEVER `null` (tdd SS1.2), and the guards are LOOSE
   * (`!= null`) for the same reason `MuseClient`'s are: the types bind only
   * strict TypeScript consumers, and a plain-JS caller reaching the built
   * `dist` can pass an explicit `null` a `!== undefined` guard would forward.
   */
  #params(commandId: string, options: SendUserTurnOptions<I>): TurnStartParams {
    const params: TurnStartParams = {
      commandId,
      input: options.input,
      sessionId: this.#sessionId,
    };
    if (options.displayText != null) params.displayText = options.displayText;
    if (options.ifBusy != null) params.ifBusy = options.ifBusy;
    if (options.reasoningEffort != null) params.reasoningEffort = options.reasoningEffort;
    return params;
  }
}
