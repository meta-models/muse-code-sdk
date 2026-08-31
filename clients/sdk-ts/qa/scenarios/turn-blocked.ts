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
import type { RecordedHost } from "../recorder.js";
import { drivenOnce, sessionIdOf } from "../scenario-kit.js";
import type { QaScenario, ScenarioOutcome } from "../scenario-kit.js";

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

interface BlockedShape {
  readonly id: string;
  readonly title: string;
  readonly vein: string;
  /** The subject calls. They run for real; only their ASSERTION is deferred. */
  subject(host: RecordedHost, sessionId: string): Promise<void>;
  /** What this scenario will assert once the blocker lifts. */
  readonly willAssert: string;
}

function blockedScenario(shape: BlockedShape): QaScenario {
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
      const runs = outcome.runs;
      const bites = runs.every((run) => blockerStillBites(run));
      return { ...outcome, blockerStillBites: bites };
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
      await host.command("steer", "turn/steer", {
        sessionId,
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
      await host.command("cancelInput", "userInput/cancel", {
        sessionId,
        userInputId: "00000000-0000-7000-8000-000000000000",
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
        blockerStillBites: true,
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
