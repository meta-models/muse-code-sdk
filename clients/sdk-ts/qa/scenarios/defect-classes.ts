/**
 * The confirmed defect classes from the stdio auto-qa pass, re-driven through
 * the SDK.
 *
 * The stdio pass found these by speaking raw NDJSON. Re-driving them through
 * `@muse-code/sdk` answers a different question: does the facade carry the defect
 * through unchanged, hide it, or add one of its own? That is why every
 * scenario here supplies an `attributeWith` plan — a finding without a
 * facade-vs-binary component sends the fix lane to the wrong package, which
 * is worse than filing nothing.
 *
 * Each scenario states its observable as a string and the contract's expected
 * value beside it, so a report reader never has to re-derive what "fail"
 * meant. `defect-reproduced` here is the harness WORKING.
 */

import type { ObservedRun } from "../oracle.js";
import { initializeResultOf, rejectionReasonOfRun, settlementOfRun } from "../recorder.js";
import {
  drivenAcrossRestart,
  drivenOnce,
  historyModeOf,
  resultOfStep,
  sessionIdOf,
} from "../scenario-kit.js";
import type { QaScenario, ScenarioOutcome } from "../scenario-kit.js";

/** A UUIDv7 the scenario controls, for the classes whose subject IS the id. */
function uuidV7(seedMs: number, tail: string): string {
  const hex = seedMs.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${tail.padStart(12, "0")}`;
}

const settledError = (run: ObservedRun, step: string): boolean =>
  settlementOfRun(run, step).startsWith("err:");

// ---------------------------------------------------------------------------
// #19649 — session/resume accepts a cursor and serves from genesis anyway
// ---------------------------------------------------------------------------

const D19649: QaScenario = {
  id: "D19649",
  title: "`session/resume` honours the `cursor` it was given",
  vein: "session load/resume state integrity",
  defectClass: {
    issue: "#19649",
    summary:
      "resume reduces `cursor` to a presence bit, so every cursor — valid, stale, or never-existed — serves full from-genesis inline history and the `notFound`/`missingAnchor` rejection is unreachable (tdd SS2.5.2)",
  },
  async run(museBin): Promise<ScenarioOutcome> {
    return await drivenAcrossRestart({
      museBin,
      label: "d19649",
      async seed(host) {
        await host.command("start", "session/start", { workspaceRoot: "/tmp" });
        const sessionId = sessionIdOf(host.resultOf("start"));
        await host.request("read", "session/read", { sessionId, excludeItems: false });
        return { sessionId, cursor: host.resultOf("read")?.["viewCursor"] };
      },
      driveWith:
        ({ sessionId, cursor }) =>
        async (host) => {
          await host.command("resumeValid", "session/resume", {
            sessionId,
            ...(typeof cursor === "string" ? { cursor } : {}),
          });
          await host.command("resumeBogus", "session/resume", {
            sessionId,
            cursor: "v:00000000-0000-7000-8000-000000000000:999",
          });
        },
      observe: (run) => {
        const bogus = settledError(run, "resumeBogus")
          ? settlementOfRun(run, "resumeBogus")
          : `ok:mode=${historyModeOf(run, "resumeBogus")}`;
        return `validCursor:${historyModeOf(run, "resumeValid")}|bogusCursor:${bogus}`;
      },
      expected: "validCursor:none|bogusCursor:err:notFound",
    });
  },
};

// ---------------------------------------------------------------------------
// #18945 — materialized history freezes and goes permanently unavailable
// ---------------------------------------------------------------------------

const D18945: QaScenario = {
  id: "D18945",
  title: "resumed history survives a host restart (MSP-native arm)",
  vein: "session load/resume state integrity",
  defectClass: {
    issue: "#18945",
    summary:
      "the materialized sidecar freezes and flips to terminal `unavailable`, after which every read and resume returns empty history forever. The MSP-NATIVE arm was fixed by f4aae2ed99a, so this is its regression guard; the CROSS-WRITER arm is expect-blocked as B08 because it needs an out-of-band `tbh exec` writer, outside this harness's MSP-only lens",
  },
  async run(museBin): Promise<ScenarioOutcome> {
    return await drivenAcrossRestart({
      museBin,
      label: "d18945",
      async seed(host) {
        await host.command("start", "session/start", { workspaceRoot: "/tmp" });
        return sessionIdOf(host.resultOf("start"));
      },
      driveWith: (sessionId) => async (host) => {
        await host.command("resume", "session/resume", { sessionId });
        await host.request("read", "session/read", { sessionId, excludeItems: false });
      },
      observe: (run) => {
        const resume = settledError(run, "resume") ? settlementOfRun(run, "resume") : "ok";
        const read = resultOfStep(run, "read");
        // `unavailable`, or an empty cursor beside a live turnCount, is the
        // terminal this defect drives the sidecar to.
        const dead = historyModeOf(run, "read") === "unavailable" || read?.["viewCursor"] === "";
        return `resume:${resume}|readHistory:${dead ? "unavailable" : "available"}`;
      },
      expected: "resume:ok|readHistory:available",
    });
  },
};

// ---------------------------------------------------------------------------
// #19535 — the serve host can never run a turn
// ---------------------------------------------------------------------------

/**
 * D19535's turn-terminal observable.
 *
 * File-local on purpose: the turn-blocked set states its blocker through
 * `blockerStillBites`, not through this projection, so there is no second
 * consumer to export for.
 */
function observeTurnTerminal(run: ObservedRun): string {
  const completed = run.api.filter(
    (entry) => entry.kind === "notification" && entry.method === "turn/completed",
  );
  if (completed.length === 0) return "turnTerminal:<none observed>";
  return /not logged in/i.test(JSON.stringify(completed))
    ? "turnTerminal:credential-failure"
    : "turnTerminal:not-a-credential-failure";
}

const D19535: QaScenario = {
  id: "D19535",
  title: "a turn started over MSP reaches a model",
  vein: "turn lifecycle over stdio",
  defectClass: {
    issue: "#19535",
    summary:
      "every production serve-host entry point hardwires `RuntimeBuilderFactory::not_logged_in()`, so any turn dies at model-respond regardless of credentials",
  },
  async run(museBin): Promise<ScenarioOutcome> {
    return await drivenOnce({
      museBin,
      label: "d19535",
      async drive(host) {
        await host.command("start", "session/start", { workspaceRoot: "/tmp" });
        const sessionId = sessionIdOf(host.resultOf("start"));
        await host.command("turn", "turn/start", {
          sessionId,
          input: [{ type: "text", text: "say pong" }],
        });
        await host.waitForNotification("turn/completed", 20_000);
      },
      observe: observeTurnTerminal,
      expected: "turnTerminal:not-a-credential-failure",
      // #23537: this scenario's subject is a turn that REACHES a model, so it
      // needs a configured host. Against an unconfigured home the logged-out
      // fallback is correct behaviour, and this scenario reported
      // `defect-reproduced` against a binary in which #19535 was already fixed.
      // Echo is credential-free, and is spec 19535's own canonical configured
      // case (FR-004 / TEST-001).
      configureProvider: "echo",
    });
  },
};

// ---------------------------------------------------------------------------
// #19778 — session/compact is refused at admission on every durable session
// ---------------------------------------------------------------------------

/**
 * What a guard-earning D19778 pass looks like (#19778 2026-09-02 reopen).
 *
 * Arm one is the no-run session: tdd SS3.7's params note mandates the typed
 * `commandRejected`/`missing_run` refusal there — that refusal IS target
 * classification, never the defect. Arm two is the defect class's actual
 * trigger, a session with a completed run: admission must reach the runtime's
 * typed SS3.7 vocabulary (`accepted`/`noop`, or a typed `-32030` reason such
 * as this rig's `compaction_unavailable` — echo composes no context budget)
 * instead of dying `-32603 internal` at fact retention.
 */
export const D19778_EXPECTED = "compact:missing_run|afterTurn:classified";

/**
 * D19778's observable, exported for QA-TEST-016: the guard must read SS3.7
 * CLASSIFICATION, not "any error is the defect". Its 2026-09-02 false reopen
 * came from exactly that misread — the spec-mandated `missing_run` refusal on
 * a fresh session surfaced as `compact:err:commandRejected` and was reported
 * as the defect against a binary whose classification is conformant.
 */
export function observeD19778(run: ObservedRun): string {
  return `compact:${noRunFace(run)}|afterTurn:${completedRunFace(run)}`;
}

/**
 * The no-run arm: tdd SS3.7's params note mandates exactly the typed
 * `commandRejected`/`missing_run` refusal here (pinned end-to-end by
 * `session_compact_is_registered_on_the_real_assembly`), so the face pins
 * that exact reason — an internal death, a different reason (e.g. the
 * #17389 `invalid_target` face leaking onto MSP), or a success would each
 * be a deviation worth reporting.
 */
function noRunFace(run: ObservedRun): string {
  const settlement = settlementOfRun(run, "compact");
  if (
    settlement === "err:commandRejected" &&
    rejectionReasonOfRun(run, "compact") === "missing_run"
  ) {
    return "missing_run";
  }
  if (settlement.startsWith("err:internal")) return "internal-admission-failure";
  if (settlement.startsWith("ok:")) return "ok-but-SS3.7-mandates-missing_run";
  return faceWithReason(run, "compact", settlement);
}

/**
 * The completed-run arm — the surface #19778 actually bit on: admission must
 * reach the runtime's typed SS3.7 vocabulary (`accepted`/`noop`, or a typed
 * `-32030` reason; on this echo rig, `compaction_unavailable` — echo composes
 * no context budget, and pre-#21244 persisting even that rejection died
 * `-32603 internal`).
 *
 * Any `commandRejected` CARRYING a reason is already typed classification:
 * `command/compact.rs` maps the receipt's `ManualCompactionReason` onto the
 * wire verbatim via `manual_compaction_reason_to_wire` (`wire_word()`), and
 * `turn_submit.rs::command_rejected` answers `-32603 internal` rather than
 * fabricate a missing reason, so a present reason IS the runtime having
 * classified the target. Enumerating `ManualCompactionReason::wire_word`
 * here — a subset, or today's whole list — would re-create the 2026-09-02
 * false reopen for every word left out or minted later (`runtime_closed` is
 * a real admission-time rejection from `validate_prepared_manual_compaction`),
 * and tdd SS3.1.2 already says to treat unknown reasons as terminal
 * rejections (#27227 review).
 *
 * Three states are still not a pass. A run whose turn never completed proves
 * nothing about this arm (#23111's earned-verdict rule). `run_active` is the
 * drive's own drain loop timing out rather than the host answering: the Rust
 * counterpart in `serve_assembly.rs` treats a finished run that never
 * released its active-run slot as a hard failure, so it reads as its own
 * face instead of counting as classification. And `missing_run` here is the
 * runtime failing to resolve the run it just completed: the probe omits
 * `turnId`, so SS3.7 resolves the latest run, and `serve_assembly.rs` pins
 * that same compact `accepted` — one known-bad word, not a pass (#27227
 * review). Only the LAST `compactAfterTurn` settlement is read
 * (`rejectionReasonOfRun`/`settlementOfRun` walk newest-first), because the
 * drive's drain loop legitimately records `run_active` probes before the
 * typed answer.
 */
function completedRunFace(run: ObservedRun): string {
  const turnRan =
    settlementOfRun(run, "turn").startsWith("ok:") &&
    run.api.some((entry) => entry.kind === "notification" && entry.method === "turn/completed");
  if (!turnRan) return "turn-never-completed";
  const settlement = settlementOfRun(run, "compactAfterTurn");
  if (settlement.startsWith("ok:")) return "classified";
  if (settlement.startsWith("err:internal")) return "internal-admission-failure";
  if (settlement === "err:commandRejected") {
    const reason = rejectionReasonOfRun(run, "compactAfterTurn");
    if (reason === "run_active") return "run-slot-never-released";
    if (reason === "missing_run") return "completed-run-not-resolvable";
    if (reason !== undefined) return "classified";
  }
  return faceWithReason(run, "compactAfterTurn", settlement);
}

function faceWithReason(run: ObservedRun, step: string, settlement: string): string {
  const reason = rejectionReasonOfRun(run, step);
  return reason === undefined ? settlement : `${settlement}/${reason}`;
}

const D19778: QaScenario = {
  id: "D19778",
  title: "`session/compact` reaches target classification on a durable session",
  vein: "landed wire-command families through the facade",
  defectClass: {
    issue: "#19778",
    summary:
      "the serve host's retained-session event sink was built without the strict-append channel, so durable `session/compact` admission (including persisting a typed rejection) died `-32603 internal` at fact retention instead of reaching tdd SS3.7's typed classification — which on a NO-RUN session is the mandated `commandRejected`/`missing_run` refusal, itself conformance and never this defect (the 2026-09-02 false reopen)",
  },
  async run(museBin): Promise<ScenarioOutcome> {
    return await drivenOnce({
      museBin,
      label: "d19778",
      async drive(host) {
        await host.command("start", "session/start", { workspaceRoot: "/tmp" });
        const sessionId = sessionIdOf(host.resultOf("start"));
        // Arm one — no resolvable run: SS3.7 mandates `missing_run` here.
        await host.command("compact", "session/compact", { sessionId });
        // Arm two — the defect class's actual trigger: a session with a
        // completed run. Echo is credential-free (#23537, D19535 above).
        await host.command("turn", "turn/start", {
          sessionId,
          input: [{ type: "text", text: "seed one completed run" }],
        });
        await host.waitForNotification("turn/completed", 20_000);
        // `turn/completed` is announced BEFORE the runtime frees the
        // active-run slot (the drain race recorded at the #21244 review-P0
        // comment in crates/session-server/tests/serve_view_suites/
        // serve_assembly.rs, which also records that no passive drain signal
        // exists on this wire surface). Re-probe the compact itself: the SDK
        // mints a FRESH commandId per call, so each drained retry is a new
        // admission, and the observable reads only the LAST settlement.
        const drainDeadline = Date.now() + 20_000;
        for (;;) {
          await host.command("compactAfterTurn", "session/compact", { sessionId });
          const draining = host.rejectionReasonOf("compactAfterTurn") === "run_active";
          if (!draining || Date.now() >= drainDeadline) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      },
      observe: observeD19778,
      expected: D19778_EXPECTED,
      configureProvider: "echo",
    });
  },
};

// ---------------------------------------------------------------------------
// #16620 — a byte-identical turn/start replayed on a fresh host is a conflict
// ---------------------------------------------------------------------------

const D16620: QaScenario = {
  id: "D16620",
  title: "an identical `turn/start` replayed after restart returns the original ack",
  vein: "reconnect / child restart",
  defectClass: {
    issue: "#16620",
    summary:
      "the `started` disposition is treated as NotRecoverable, so a byte-identical cross-restart replay skips every payload-verifying recovery lane and is answered `command_id_conflict` instead of the original ack (spec 207 INV-006/FR-011)",
  },
  async run(museBin): Promise<ScenarioOutcome> {
    const commandId = uuidV7(1, "16620abcdef");
    return await drivenAcrossRestart({
      museBin,
      label: "d16620",
      async seed(host) {
        await host.command("start", "session/start", { workspaceRoot: "/tmp" });
        const sessionId = sessionIdOf(host.resultOf("start"));
        const turnParams = { sessionId, input: [{ type: "text", text: "say pong MSP1" }] };
        await host.command("turn", "turn/start", turnParams, commandId);
        return { sessionId, turnParams };
      },
      driveWith:
        ({ sessionId, turnParams }) =>
        async (host) => {
          await host.command("resume", "session/resume", { sessionId });
          await host.command("replay", "turn/start", turnParams, commandId);
        },
      observe: (run) => {
        const settlement = settlementOfRun(run, "replay");
        if (settlement.includes("commandRejected")) return "replay:command_id_conflict";
        return settlement.startsWith("err:") ? `replay:${settlement}` : "replay:original-ack";
      },
      expected: "replay:original-ack",
    });
  },
};

// ---------------------------------------------------------------------------
// #20049 — an omitted-turnId stop fabricates a turnId from the commandId
// ---------------------------------------------------------------------------

const D20049: QaScenario = {
  id: "D20049",
  title: "a stop with no running turn is rejected, not acked with an invented id",
  vein: "cancellation mid-turn",
  defectClass: {
    issue: "#20049",
    summary:
      "`turn/interrupt` with `turnId` omitted, on a session with no foreground turn, answers `accepted` with `turnId` set to the client's own commandId — an identity no event can ever name (tdd SS3.4 requires `missing_run`)",
  },
  async run(museBin): Promise<ScenarioOutcome> {
    const commandId = uuidV7(2, "20049abcdef");
    return await drivenOnce({
      museBin,
      label: "d20049",
      async drive(host) {
        await host.command("start", "session/start", { workspaceRoot: "/tmp" });
        const sessionId = sessionIdOf(host.resultOf("start"));
        // The CONTROL arm first: an explicitly-named nonexistent turn is
        // correctly rejected, which proves the probe is not simply blind.
        await host.command("named", "turn/interrupt", {
          sessionId,
          turnId: uuidV7(3, "deadbeef0001"),
        });
        await host.command("omitted", "turn/interrupt", { sessionId }, commandId);
      },
      observe: (run) => {
        const named = settledError(run, "named") ? "rejected" : "accepted";
        if (settledError(run, "omitted")) return `named:${named}|omitted:rejected`;
        const turnId = resultOfStep(run, "omitted")?.["turnId"];
        return `named:${named}|omitted:accepted${turnId === commandId ? "-with-fabricated-turnId" : ""}`;
      },
      expected: "named:rejected|omitted:rejected",
    });
  },
};

// ---------------------------------------------------------------------------
// #21861 — the ephemeral approval-mode ceiling is never constructed
// ---------------------------------------------------------------------------

const D21861: QaScenario = {
  id: "D21861",
  title: "an ephemeral host refuses an approval mode above its seal",
  vein: "approvals flow",
  defectClass: {
    issue: "#21861",
    summary:
      "every production site passes `ApprovalModeCeiling::durable()`, so a wire client on `serve --no-session-log` can raise its own authority to `allowAll` despite the SS2.13.5 ephemeral seal at `promptUnmatched`",
  },
  async run(museBin): Promise<ScenarioOutcome> {
    return await drivenOnce({
      museBin,
      label: "d21861",
      serveArgs: ["--no-session-log"],
      async drive(host) {
        await host.command("start", "session/start", { workspaceRoot: "/tmp" });
        const sessionId = sessionIdOf(host.resultOf("start"));
        await host.command("raise", "session/setApprovalMode", { sessionId, mode: "allowAll" });
        // CONTROL: narrowing must stay accepted, so a blanket refusal cannot
        // be mistaken for the ceiling working.
        await host.command("narrow", "session/setApprovalMode", {
          sessionId,
          mode: "denyUnmatched",
        });
      },
      observe: (run) => {
        const durability = initializeResultOf(run)?.["sessionDurability"];
        return `durability:${String(durability)}|raise:${
          settledError(run, "raise") ? "refused" : "accepted"
        }|narrow:${settledError(run, "narrow") ? "refused" : "accepted"}`;
      },
      expected: "durability:ephemeral|raise:refused|narrow:accepted",
    });
  },
};

// ---------------------------------------------------------------------------
// #19764 — CLOSED/FIXED (PR #22437). Kept as a regression guard.
// ---------------------------------------------------------------------------

/** The exact command D19764 runs; the guard's read assertion keys on it. */
export const D19764_COMMAND_TEXT = "printf R371_CLEAN_MSP_USER_SHELL";

/** Is D19764's item in a `session/read` result — `kind` and `commandText` both? */
function d19764ItemIn(result: Record<string, unknown> | undefined): boolean {
  const items = (result?.["history"] as { items?: unknown } | undefined)?.items;
  return (
    Array.isArray(items) &&
    items.some(
      (item) =>
        (item as { kind?: unknown }).kind === "userShell" &&
        (item as { commandText?: unknown }).commandText === D19764_COMMAND_TEXT,
    )
  );
}

/** Exported so the guard's observable is testable without a real host (#23111). */
export function observeD19764(run: ObservedRun): string {
  const granted = initializeResultOf(run)?.["grantedCapabilities"];
  const hasGrant = Array.isArray(granted) && granted.includes("userShell");
  const shell = settledError(run, "shell") ? settlementOfRun(run, "shell") : "accepted";
  // The read the scenario issues is PART of the verdict: the guard's title is
  // "its item survives `session/read`", and before #23111 a run whose read came
  // back empty was still green because nothing here looked at it.
  const read = d19764ItemIn(resultOfStep(run, "read")) ? "userShell-item" : "missing";
  return `granted:${hasGrant ? "userShell" : "none"}|shell:${shell}|read:${read}`;
}

export const D19764_EXPECTED = "granted:userShell|shell:accepted|read:userShell-item";

const D19764: QaScenario = {
  id: "D19764",
  title: "`session/userShell` executes and its item survives `session/read`",
  vein: "landed wire-command families through the facade",
  defectClass: {
    issue: "#19764",
    summary:
      "CLOSED as completed by PR #22437 (merge `098ccfbecbb2ed9bee32fbd4a4f3baf7049ebad3`, an ancestor of origin/main), so this is a REGRESSION GUARD rather than a live target. The historical break granted the `userShell` capability, acked the command, then failed dispatch as ``unknown tool `shell` `` with the item never reaching `session/read`",
  },
  async run(museBin): Promise<ScenarioOutcome> {
    return await drivenOnce({
      museBin,
      label: "d19764",
      // The capability MUST be requested: the guard is that the grant and the
      // execution agree, and an ungranted run would prove only the refusal.
      requestedCapabilities: ["userShell"],
      async drive(host) {
        await host.command("start", "session/start", {
          workspaceRoot: "/tmp",
          approvalMode: "allowAll",
        });
        const sessionId = sessionIdOf(host.resultOf("start"));
        await host.command("shell", "session/userShell", {
          sessionId,
          commandText: D19764_COMMAND_TEXT,
        });
        // Assert the COMMITTED state, not a race with the flush: wait for the
        // item's terminal, then poll the read to an ATTEMPT bound (#23109's
        // read-side view materializes ~1.05s after item/completed, and a
        // wall-clock bound would make the attribution replay run a different
        // call sequence than the live run).
        await host.waitForNotification("item/completed", 15_000);
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await host.request("read", "session/read", { sessionId, excludeItems: false });
          if (d19764ItemIn(host.resultOf("read"))) break;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      },
      observe: observeD19764,
      expected: D19764_EXPECTED,
    });
  },
};

export const DEFECT_CLASS_SCENARIOS: readonly QaScenario[] = [
  D19649,
  D18945,
  D19535,
  D19778,
  D16620,
  D20049,
  D21861,
  D19764,
];
