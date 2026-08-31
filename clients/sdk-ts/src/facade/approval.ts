/**
 * The FR-019 approval round trip: inbound `approval/requested` → the consumer's
 * handler → outbound `approval/decide` (spec 14990 T031, tdd SS5.4).
 *
 * Split out of `session.ts` rather than added to it: the router owns a handler,
 * a per-stage latch, and a decision-shaping guard chain that have nothing to do
 * with folding a view, and `Session` was already the package's largest module.
 *
 * SHAPE NOTE, established from the bundle rather than assumed. `approval/request`
 * as a SERVER REQUEST is not enrolled — the schema carries `approval/requested`
 * as a NOTIFICATION only — so the round trip is notification-in /
 * command-out, which is exactly the pair FR-019 names. The server-request form
 * would be a #206 enrollment request (INV-001), never a local interface.
 */

import type { Connection } from "../connection/connection.js";

import type { ApprovalDecideParams, ApprovalRequestParams } from "@muse/msp";

/** Errors (TS2344) when `T` is inhabited — i.e. when a member is unforwarded. */
type AssertNever<T extends never> = T;

/** The params this module builds; `Connection.command()` stamps the `commandId`. */
type DecideParams = Omit<ApprovalDecideParams, "commandId">;

/**
 * Every `DecideParams` member the guard chain below forwards. Composition alone
 * does not stop drift — the chain is hand-listed — so a regenerated member
 * fails the BUILD here until it is forwarded, exactly as `MuseClient`'s two
 * chains do.
 */
const DECIDE_FORWARDED = [
  "approvalId",
  "choiceId",
  "requirementId",
  "sessionId",
  "feedback",
] as const;
type _DecideIsExhaustive = AssertNever<
  Exclude<keyof DecideParams, (typeof DECIDE_FORWARDED)[number]>
>;

/**
 * What an approval handler answers with: a choice the SERVER offered, and
 * optional feedback. Composed from the generated decide params, so "the client
 * picks a `choiceId`" stays one fact rather than two that can drift.
 *
 * D-006 is select-never-create, and this TYPE cannot enforce it — `choiceId` is
 * a `string` on the wire — so the router checks the answer against the
 * request's own `availableChoices` before the frame is built.
 */
export type ApprovalDecisionInput = Readonly<Pick<ApprovalDecideParams, "choiceId" | "feedback">>;

/** FR-019: the consumer's decision callback. May be sync or async. */
export type ApprovalHandler = (
  request: ApprovalRequestParams,
) => ApprovalDecisionInput | Promise<ApprovalDecisionInput>;

/**
 * Why one approval round trip did not complete.
 *
 * REPORTED, not thrown: the trip is driven from a notification, so a throw
 * would escape into the consumer's pump with nothing to catch it — the same
 * hazard `Session.apply` already refuses a malformed frame for. Each arm names
 * a DIFFERENT owner (the consumer's handler, the consumer's choice, the host),
 * because the repair differs.
 */
export type ApprovalFailure =
  | {
      readonly kind: "unofferedChoice";
      readonly approvalId: string;
      readonly choiceId: string;
      readonly availableChoiceIds: readonly string[];
    }
  | { readonly kind: "handlerThrew"; readonly approvalId: string; readonly error: unknown }
  | { readonly kind: "submitFailed"; readonly approvalId: string; readonly error: unknown };

/** Receives each `ApprovalFailure`; the failure's `kind` names what went wrong and whose repair it is. */
export type ApprovalFailureHandler = (failure: ApprovalFailure) => void;

export class ApprovalRouter {
  readonly #sessionId: string;
  readonly #connection: Connection | undefined;
  #handler: ApprovalHandler | undefined;
  #onFailure: ApprovalFailureHandler | undefined;
  /**
   * Approval STAGES already decided, keyed by `approvalId` + `requirementId`.
   *
   * Not `approvalId` alone: `requirementId` is SS5.4's multi-stage race guard,
   * so a stage-2 request must get its own decision or the approval pends
   * forever. Not per-request either: a redelivered `approval/requested` for the
   * SAME stage must author no second decide, or a two-stage approval races
   * itself. The key is kept on FAILURE too — a genuinely advancing stage brings
   * a new `requirementId` and therefore a new key, so "ask the consumer once
   * per stage" holds absolutely.
   */
  readonly #decidedStages = new Set<string>();

  constructor(sessionId: string, connection: Connection | undefined) {
    this.#sessionId = sessionId;
    this.#connection = connection;
  }

  /**
   * Register the decision callback (FR-019).
   *
   * REPLACES any previous handler rather than adding to a list: two handlers
   * would race to decide one approval and only one decision can win, so the
   * loser's would be silently discarded.
   */
  onApproval(handler: ApprovalHandler): void {
    this.#handler = handler;
  }

  /** Observe round trips that did not complete. See {@link ApprovalFailure}. */
  onApprovalError(handler: ApprovalFailureHandler): void {
    this.#onFailure = handler;
  }

  /**
   * An `approval/requested` folded. Returns the decision round trip to await,
   * or `undefined` when this client authors nothing for it.
   *
   * No handler at all is the supported default posture, NOT a degraded one
   * (D-008): the client runs under the server's own default-deny, and this SDK
   * parks nothing — no queued decision, no synthesized denial, no local hold.
   */
  requested(params: ApprovalRequestParams): Promise<void> | undefined {
    const handler = this.#handler;
    if (handler === undefined) return undefined;
    const stage = ApprovalRouter.#stageKey(params);
    if (this.#decidedStages.has(stage)) return undefined;
    // Latched BEFORE the first await: a redelivery folded on the very next
    // frame must find the stage already claimed, and an `await` boundary here
    // would let both pass the check.
    this.#decidedStages.add(stage);
    return this.#decide(params, handler);
  }

  static #stageKey(params: ApprovalRequestParams): string {
    const requirement = params.currentRequirementId;
    return `${params.approvalId} ${requirement.approvalId}:${String(requirement.sourceIndex)}`;
  }

  async #decide(params: ApprovalRequestParams, handler: ApprovalHandler): Promise<void> {
    const connection = this.#connection;
    // Checked BEFORE the handler runs: asking a consumer to decide and then
    // dropping the answer is worse than not asking, and on a fold-only session
    // that is all this could do.
    if (connection === undefined) {
      // A plain `Error`: constructing fold-only and then registering a decide
      // handler is API misuse, not the foreign-frame STATE
      // `MuseForeignSessionError` names — a typed class here would send an
      // embedder's routing-bug branch chasing a session mismatch that never
      // happened.
      this.#report({
        approvalId: params.approvalId,
        error: new Error(
          "approval/decide needs a connection; this Session was constructed fold-only",
        ),
        kind: "submitFailed",
      });
      return;
    }

    let decision: ApprovalDecisionInput;
    try {
      decision = await handler(params);
    } catch (error) {
      this.#report({ approvalId: params.approvalId, error, kind: "handlerThrew" });
      return;
    }

    const availableChoiceIds = params.availableChoices.map((choice) => choice.choiceId);
    if (!availableChoiceIds.includes(decision.choiceId)) {
      // D-006 select-never-create, enforced on THIS side of the transport. An
      // invented choice bounces -32052 a round trip later, by which time the
      // stage may have advanced — so the diagnosis a consumer would actually
      // see is a stale-requirement error about a frame it should never have
      // sent.
      this.#report({
        approvalId: params.approvalId,
        availableChoiceIds,
        choiceId: decision.choiceId,
        kind: "unofferedChoice",
      });
      return;
    }

    const decideParams: DecideParams = {
      approvalId: params.approvalId,
      choiceId: decision.choiceId,
      // Echoed from the request, never remembered: SS5.4 makes a stale value a
      // -32053, and the request in hand is the only current statement of it.
      requirementId: params.currentRequirementId,
      sessionId: this.#sessionId,
    };
    // Loose guard, and omitted rather than nulled (SS1.2): `feedback` is valid
    // only on choices with `acceptsFeedback`, so an explicit null forwarded by
    // a plain-JS caller would be rejected by the host.
    if (decision.feedback != null) decideParams.feedback = decision.feedback;

    try {
      // No explicit `commandId`: unlike `sendUserTurn`, nothing here needs the
      // id before the ack, so `Connection.command()` mints and stamps it — and
      // its own SS3.1.1 retry then reuses that id for free.
      await connection.command(
        "approval/decide",
        decideParams as unknown as Record<string, unknown>,
      );
    } catch (error) {
      this.#report({ approvalId: params.approvalId, error, kind: "submitFailed" });
    }
  }

  #report(failure: ApprovalFailure): void {
    try {
      this.#onFailure?.(failure);
    } catch {
      // The consumer's failure OBSERVER threw. Swallowed, deliberately: a
      // rejection escaping here rides `SessionApplyOutcome.io`, whose contract
      // is "IT NEVER REJECTS" — and since most consumers never await `io`, it
      // would surface as an unhandled rejection that kills the embedder, the
      // exact failure that contract exists to prevent. The failure itself was
      // already handed to the observer; there is no one left to tell.
    }
  }
}
