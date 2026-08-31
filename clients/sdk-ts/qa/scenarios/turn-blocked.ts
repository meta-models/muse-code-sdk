/**
 * The turn-dependent surface: encoded, running, and EXPECT-BLOCKED.
 *
 * None of these can assert their real subject yet, because #19535 hardwires a
 * not-logged-in provider into every production serve-host entry point, so no
 * turn is ever in flight long enough to stream a delta, be interrupted, be
 * steered, raise an approval, or ask for input.
 *
 * They are not skipped and not deleted, and no assertion here is weakened to
 * make one pass. B01-B07 each drive the real host, issue their real subject
 * calls, and record whether the blocker STILL BITES. The moment it stops
 * biting the verdict flips to `block-lifted`, the report shouts about it, and
 * the scenario must be replaced by a real assertion. A scenario quietly
 * omitted now is one nobody adds later.
 *
 * B08 is the one exception, and it is a DIFFERENT shape (spec acceptance 5,
 * second limb): its blocker sits outside this harness's MSP-only lens, so
 * there is nothing for it to drive and no signal its flip could ride on. It is
 * a recorded PERMANENT expected-block — encoded so the gap stays visible — and
 * lifting it is a manual owner decision, not something a run can observe.
 */

import type { ObservedRun } from "../oracle.js";
import { errorKindOfRun, settlementOfRun } from "../recorder.js";
import type { RecordedHost } from "../recorder.js";
import { drivenOnce, sessionIdOf } from "../scenario-kit.js";
import type { BlockedVerdict, QaScenario, ScenarioOutcome } from "../scenario-kit.js";

const BLOCKER = "#19535";
const BECAUSE =
  "`tbh serve` hardwires `RuntimeBuilderFactory::not_logged_in()`, so every turn terminalizes at model-respond in milliseconds and the subject behaviour never occurs";

/** Did #19535 still bite — i.e. did the turn die on the pinned credential failure? */
function blockerStillBites(run: ObservedRun): boolean {
  const completed = run.api.filter(
    (entry) => entry.kind === "notification" && entry.method === "turn/completed",
  );
  const text = JSON.stringify(completed);
  if (/not logged in/i.test(text)) return true;
  // No terminal at all is the historical shape of the same blocker (the issue
  // records zero terminal frames reaching the wire before f62591ef).
  return completed.length === 0;
}

/** What one driven run proved about the blocker. */
export type BlockedRunEvidence = "bites" | "lifted" | { readonly rejected: string };

/**
 * Re-exported from `scenario-kit.ts`, which owns it now that `ScenarioOutcome`
 * carries the union as one field (#23111 review round 3).
 */
export type { BlockedVerdict } from "../scenario-kit.js";

/**
 * Error kinds that mean the call died BEFORE any handler ran, so the run
 * reached no turn-dependent behaviour whatever the turn did independently:
 *
 *  - `invalidParams` — rejected at param validation.
 *  - `methodNotFound` — rejected at dispatch; the registry answers it for any
 *    method the active permission profile withholds (FR-024), so it is
 *    reachable on the very calls these scenarios issue (#23111 review).
 */
const REJECTED_BEFORE_ANY_HANDLER: ReadonlySet<string> = new Set([
  "invalidParams",
  "methodNotFound",
]);

/** The two steps every blocked scenario's own drive issues before the subject. */
const BLOCKED_SETUP_STEPS: ReadonlySet<string> = new Set(["start", "turn"]);

/** Every step a captured run settled, in first-issue order. */
function settledStepsOf(run: ObservedRun): readonly string[] {
  const steps: string[] = [];
  for (const entry of run.api) {
    if (entry.kind !== "requestOk" && entry.kind !== "requestError") continue;
    if (steps.includes(entry.step)) continue;
    steps.push(entry.step);
  }
  return steps;
}

/**
 * The subject steps a captured run ACTUALLY issued — every settled step
 * outside the fixed setup. Derived from the run rather than hand-listed on
 * each shape, so a forgotten or misspelled entry cannot silently hide a
 * rejection (#23111 review). Used to NAME the rejected call's role; the scan
 * itself covers setup steps too, because a rejected `session/start` or
 * `turn/start` reaches the blocker's behaviour just as little.
 */
export function subjectStepsOf(run: ObservedRun): readonly string[] {
  return settledStepsOf(run).filter((step) => !BLOCKED_SETUP_STEPS.has(step));
}

/**
 * Decide what a driven run proves. Exported so the verdict — including the
 * never-reached-the-host arm — is testable without a real host (#23111), the
 * same reason `blockerStillBites` is.
 *
 * A call the host rejected before any handler ran proves nothing about the
 * blocker, however loudly the turn independently died on the credential
 * failure (#23111 arm 2: B04/B07 reported `expected-block` on exactly that
 * traffic). The subject steps are DERIVED here rather than passed in, so no
 * caller can hand over a stale list that hides a rejection.
 */
export function blockedRunEvidence(run: ObservedRun): BlockedRunEvidence {
  const subjects = subjectStepsOf(run);
  for (const step of settledStepsOf(run)) {
    const kind = errorKindOfRun(run, step);
    if (kind === undefined || !REJECTED_BEFORE_ANY_HANDLER.has(kind)) continue;
    const role = subjects.includes(step) ? "subject" : "setup call";
    return {
      rejected: `${role} \`${step}\` settled \`${settlementOfRun(run, step)}\` — it never reached the host's turn-dependent behaviour`,
    };
  }
  return blockerStillBites(run) ? "bites" : "lifted";
}

/**
 * Fold per-run evidence into the outcome's `blockedVerdict` — or REFUSE
 * the verdict.
 *
 * The refusal is returned as a VALUE, not thrown: a throw unwinds past
 * `runSdkQa`'s oracle, discarding every deviation the same capture recorded
 * (spec 14990 Scenario 6 acceptance 1 — the oracle runs over every driven
 * run). The verdict is unchanged either way: `runSdkQa` maps a refusal to
 * `blocked` ("could not run, learned nothing"), never `expected-block`
 * (#23111).
 */
export function foldBlockedEvidence(
  id: string,
  evidence: readonly BlockedRunEvidence[],
): BlockedVerdict {
  const rejected = evidence.filter(
    (proof): proof is { readonly rejected: string } => typeof proof === "object",
  );
  if (rejected.length > 0) {
    return {
      refused: `${id} was rejected before reaching ${BLOCKER}: ${rejected
        .map((proof) => proof.rejected)
        .join("; ")}`,
    };
  }
  return { bites: evidence.every((proof) => proof === "bites") };
}

/**
 * The whole derivation → evidence → fold chain, as ONE function the shipped
 * scenario calls and a test can call with the same arguments. Extracted
 * because a composition that lives only inside `blockedScenario` cannot be
 * pinned without a live host (#23111 review).
 */
export function blockedVerdictOf(id: string, runs: readonly ObservedRun[]): BlockedVerdict {
  return foldBlockedEvidence(
    id,
    runs.map((run) => blockedRunEvidence(run)),
  );
}

export interface BlockedShape {
  readonly id: string;
  readonly title: string;
  readonly vein: string;
  /** The subject calls. They run for real; only their ASSERTION is deferred. */
  subject(host: RecordedHost, sessionId: string): Promise<void>;
  /** What this scenario will assert once the blocker lifts. */
  readonly willAssert: string;
}

/**
 * Build one expect-blocked scenario.
 *
 * Exported so a test can drive a REAL host through this exact factory — the
 * only way to pin that the shipped scenario consults `blockedVerdictOf`
 * rather than reading the turn's terminal directly (#23111 review).
 */
export function blockedScenario(shape: BlockedShape): QaScenario {
  return {
    id: shape.id,
    title: shape.title,
    vein: shape.vein,
    expectBlocked: { blocker: BLOCKER, because: BECAUSE },
    async run(museBin): Promise<ScenarioOutcome> {
      const outcome = await drivenOnce({
        museBin,
        label: shape.id.toLowerCase(),
        async drive(host) {
          await host.command("start", "session/start", { workspaceRoot: "/tmp" });
          const sessionId = sessionIdOf(host.resultOf("start"));
          await host.command("turn", "turn/start", {
            sessionId,
            input: [{ type: "text", text: "say pong" }],
          });
          // The subject calls run FOR REAL. Only their assertion is deferred.
          await shape.subject(host, sessionId ?? "");
          await host.waitForNotification("turn/completed", 20_000);
        },
        observe: (run) =>
          blockerStillBites(run)
            ? `blocked-by-${BLOCKER}: the turn died on the pinned credential failure`
            : `blocker lifted — the turn ran. NOW ASSERT: ${shape.willAssert}`,
        expected: `blocked-by-${BLOCKER} until its fix lands, then: ${shape.willAssert}`,
      });
      return { ...outcome, blockedVerdict: blockedVerdictOf(shape.id, outcome.runs) };
    },
  };
}

export const TURN_BLOCKED_SCENARIOS: readonly QaScenario[] = [
  blockedScenario({
    id: "B01",
    title: "streamed item deltas arrive during a turn",
    vein: "turn lifecycle over stdio",
    async subject() {
      // The subject is what the host emits unprompted; there is nothing to send.
    },
    willAssert:
      "`item/delta` notifications arrive before `item/completed`, and the concatenated deltas equal the completed value (INV-004)",
  }),
  blockedScenario({
    id: "B02",
    title: "a mid-turn `turn/interrupt` stops the running turn",
    vein: "cancellation mid-turn",
    async subject(host, sessionId) {
      await host.command("interrupt", "turn/interrupt", { sessionId });
    },
    willAssert:
      "the running turn's real `turnId` is echoed and `turn/completed` settles `interrupted` — the arm #20049's fabricated-ack defect cannot reach today",
  }),
  blockedScenario({
    id: "B03",
    title: "a mid-turn `turn/cancel` retracts the running turn",
    vein: "cancellation mid-turn",
    async subject(host, sessionId) {
      await host.command("cancel", "turn/cancel", { sessionId });
    },
    willAssert: "`turn/completed` settles `cancelled` and the turn wait settles (INV-014)",
  }),
  blockedScenario({
    id: "B04",
    title: "`turn/steer` reaches a running turn",
    vein: "turn lifecycle over stdio",
    async subject(host, sessionId) {
      // The host requires `expectedTurnId` (crates/session-server
      // command/turn_steer.rs); the RUNNING turn's real id is in the
      // `turn/start` ack. The placeholder keeps the params well-formed on the
      // rare rejected ack, so the steer still reaches turn-state validation.
      const turnId = (host.resultOf("turn") as { turnId?: unknown } | undefined)?.turnId;
      await host.command("steer", "turn/steer", {
        sessionId,
        expectedTurnId:
          typeof turnId === "string" ? turnId : "00000000-0000-7000-8000-000000000000",
        input: [{ type: "text", text: "actually, say pang" }],
      });
    },
    willAssert: "the steer is admitted into the live turn and its text folds into the transcript",
  }),
  blockedScenario({
    id: "B05",
    title: "a live approval round trip over the server-initiated request",
    vein: "approvals flow",
    async subject(host, sessionId) {
      await host.request("pending", "approval/listPending", { sessionId });
    },
    willAssert:
      "the host raises `approval/request` as a SERVER-INITIATED request, the SDK routes it to the registered handler, and `approval/decide` is commandId-idempotent (FR-019)",
  }),
  blockedScenario({
    id: "B06",
    title: "crash recovery mid-turn: a killed host's turn is recoverable",
    vein: "reconnect / child restart",
    async subject(host, sessionId) {
      await host.request("readDuringTurn", "session/read", { sessionId, excludeItems: false });
    },
    willAssert:
      "a host that dies with a turn in flight leaves a recoverable record, and the next host's `session/resume` reports the interrupted turn rather than a clean idle session",
  }),
  blockedScenario({
    id: "B07",
    title: "the `userInput` round trip settles the prompt",
    vein: "approvals flow",
    async subject(host, sessionId) {
      // `reason` is host-required (crates/session-server user_input/params.rs);
      // without it the cancel dies at param validation and never reaches the
      // userInput plane (#23111).
      await host.command("cancelInput", "userInput/cancel", {
        sessionId,
        userInputId: "00000000-0000-7000-8000-000000000000",
        reason: "auto-qa --area sdk probes the cancel path while #19535 blocks a real prompt",
      });
    },
    willAssert:
      "the host raises `userInput/request`, the SDK routes it, and `userInput/answer` settles it with a matching `userInput/settled` notification",
  }),
  {
    // The one blocker that is NOT #19535: #18945's cross-writer arm needs a
    // second, non-MSP writer. Encoded here so the gap is visible rather than
    // silently missing from the set.
    id: "B08",
    title: "#18945 cross-writer arm: a journal advanced by `tbh exec` still resumes",
    vein: "session load/resume state integrity",
    expectBlocked: {
      blocker: "#18945 (cross-writer arm)",
      because:
        "reproducing it needs an out-of-band `tbh exec` or TUI writer appending to the same journal, which is outside this harness's MSP-only external-integrator lens (charter decision 1). Fix PR #21273 is open behind #19087",
    },
    async run(): Promise<ScenarioOutcome> {
      return {
        runs: [],
        blockedVerdict: { bites: true },
        observed:
          "blocked: the harness speaks only MSP stdio, so it cannot mint the out-of-band write this arm requires",
        expected:
          "an MSP-reachable way to advance a journal from a second writer, or an explicit owner decision to widen the harness's lens beyond MSP",
      };
    },
  },
];

/** Re-exported so the flip is testable without waiting for a real fix. */
export { blockerStillBites };
