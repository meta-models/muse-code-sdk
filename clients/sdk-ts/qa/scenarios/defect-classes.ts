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
import { initializeResultOf, settlementOfRun } from "../recorder.js";
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

const D19778: QaScenario = {
  id: "D19778",
  title: "`session/compact` reaches target classification on a durable session",
  vein: "landed wire-command families through the facade",
  defectClass: {
    issue: "#19778",
    summary:
      "the serve host's retained-session event sink is built without the strict-append channel, so the fact-retention guard fails closed and every durable `session/compact` is refused before target classification (tdd SS3.7 requires `noop`/`accepted`, or `-32030 invalid_target` for a bogus target)",
  },
  async run(museBin): Promise<ScenarioOutcome> {
    return await drivenOnce({
      museBin,
      label: "d19778",
      async drive(host) {
        await host.command("start", "session/start", { workspaceRoot: "/tmp" });
        await host.command("compact", "session/compact", {
          sessionId: sessionIdOf(host.resultOf("start")),
        });
      },
      observe: (run) => {
        const settlement = settlementOfRun(run, "compact");
        if (settlement.startsWith("err:internal")) return "compact:internal-admission-failure";
        return settlement.startsWith("err:") ? `compact:${settlement}` : "compact:classified";
      },
      expected: "compact:classified",
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
