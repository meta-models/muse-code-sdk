/**
 * QA-TEST-011..013 — the facade-vs-binary classifier, the expect-block flip,
 * and the census of what the set actually covers.
 *
 * QA-TEST-011 is the same discipline as the oracle's can-it-fail proof,
 * applied one level up: a classifier that only ever answers "binary" has
 * classified nothing, and every real finding would then be filed against the
 * wrong package half the time. So both answers are produced on demand, from
 * real child processes, and both are checked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  DEFECT_CLASS_SCENARIOS,
  RecordedHost,
  SDK_QA_SCENARIOS,
  TURN_BLOCKED_SCENARIOS,
  attributeByReplay,
  blockerStillBites,
  buildReport,
  renderReportMarkdown,
  runOracle,
  scenarioWorkDir,
  settlementOfRun,
} from "../qa/index.js";
import type { ObservedRun } from "../qa/index.js";

const SCRIPTED_HOST = fileURLToPath(new URL("./helpers/qa-scripted-host.js", import.meta.url));

const drive = async (host: RecordedHost): Promise<void> => {
  await host.request("list", "session/list", {});
};
const observe = (run: ObservedRun): string => settlementOfRun(run, "list");

async function scriptedRun(arm: string): Promise<{ run: ObservedRun; workDir: string }> {
  const workDir = await scenarioWorkDir(`attr-${arm}`);
  const host = await RecordedHost.open({
    museBin: process.execPath,
    argv: [SCRIPTED_HOST, arm],
    workDir,
    label: arm,
  });
  await host.initialize();
  await drive(host);
  return { run: await host.finish(), workDir };
}

test("QA-TEST-011a: a host-side deviation attributes to the BINARY", async () => {
  const { run, workDir } = await scriptedRun("duplicateResponse");
  try {
    const findings = runOracle(run);
    assert.deepEqual(
      findings.map((found) => `${found.checkId}:${found.indicts}`),
      ["O3:binary"],
      "answering one id twice is the host's doing, not the facade's",
    );
    const attribution = await attributeByReplay({ run, observe, drive });
    assert.equal(attribution.component, "binary");
    assert.equal(attribution.method, "raw-frame-replay");
    assert.equal(
      attribution.observedReplay,
      attribution.observedLive,
      "the facade is a faithful function of the wire, which is what makes it the binary's",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("QA-TEST-011b: a facade misreport attributes to the FACADE", async () => {
  const { run, workDir } = await scriptedRun("faithful");
  try {
    assert.deepEqual(runOracle(run), [], "the faithful arm is clean before the mutation");

    // Mutate the API side only: the wire keeps the frames the host really
    // sent, and the public API now claims something else. That is precisely
    // the shape of a facade bug, and it must NOT be blamed on the host.
    const lying: ObservedRun = {
      ...run,
      api: run.api.map((entry) =>
        entry.kind === "initializeResult"
          ? { ...entry, result: { ...entry.result, userAgent: "a-user-agent-nobody-served" } }
          : entry,
      ),
    };
    const findings = runOracle(lying);
    assert.deepEqual(
      findings.map((found) => `${found.checkId}:${found.indicts}`),
      ["O2:facade"],
      "the surfaced InitializeResult no longer matches the served one",
    );

    const attribution = await attributeByReplay({ run: lying, observe, drive });
    assert.equal(attribution.component, "facade");
    assert.match(attribution.rationale, /O2/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("QA-TEST-012: an expect-block FLIPS the moment its blocker stops biting", async () => {
  const stillBlocked: ObservedRun = {
    api: [
      {
        kind: "notification",
        method: "turn/completed",
        params: { reason: "not logged in: run /login to add an API key" },
      },
    ],
    wire: { frames: [], outbound: [], inbound: [], trailing: { clientToHost: "", hostToClient: "" } },
    requestedMethods: [],
  };
  const lifted: ObservedRun = {
    ...stillBlocked,
    api: [{ kind: "notification", method: "turn/completed", params: { reason: "completed" } }],
  };
  assert.equal(blockerStillBites(stillBlocked), true);
  assert.equal(blockerStillBites(lifted), false, "a turn that actually ran is the flip signal");

  // And the flip must reach the report, loudly: an expect-block that goes
  // quiet when it lifts is a scenario nobody ever converts.
  const report = buildReport({
    binaryPath: "/tmp/tbh",
    binaryVersion: "test",
    scenarios: [
      {
        id: "B02",
        title: "mid-turn interrupt",
        verdict: "block-lifted",
        findings: [],
        expectBlocked: { blocker: "#19535", because: "no turn ever runs" },
        observed: "blocker lifted — the turn ran",
      },
    ],
  });
  assert.equal(report.verdicts["block-lifted"], 1);
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /BLOCK LIFTED/);
  assert.match(markdown, /#19535/);
  assert.match(markdown, /flip these scenarios to real assertions/i);
});

test("QA-TEST-013: the set covers every seeded defect class and every blocked vein", () => {
  const seeded = ["#19649", "#18945", "#19535", "#19778", "#16620", "#20049", "#21861", "#19764"];
  const covered = DEFECT_CLASS_SCENARIOS.map((scenario) => scenario.defectClass?.issue);
  for (const issue of seeded) {
    assert.ok(covered.includes(issue), `no scenario re-drives ${issue} through the SDK`);
  }
  for (const scenario of DEFECT_CLASS_SCENARIOS) {
    assert.ok(
      (scenario.defectClass?.summary.length ?? 0) > 60,
      `${scenario.id} must state what the defect IS, not just cite an issue`,
    );
  }

  // The turn-blocked set: encoded, each naming its blocker, none silently
  // dropped. Losing one of these is the failure mode the seed warned about.
  const blockedVeins = [
    "streamed item deltas",
    "turn/interrupt",
    "turn/cancel",
    "turn/steer",
    "approval round trip",
    "crash recovery",
    "userInput",
    "cross-writer",
  ];
  for (const vein of blockedVeins) {
    assert.ok(
      TURN_BLOCKED_SCENARIOS.some((scenario) => scenario.title.includes(vein)),
      `the turn-blocked set dropped "${vein}"`,
    );
  }
  for (const scenario of TURN_BLOCKED_SCENARIOS) {
    assert.ok(scenario.expectBlocked !== undefined, `${scenario.id} must name its blocker`);
    assert.match(scenario.expectBlocked.blocker, /^#\d+/, `${scenario.id} blocker is an issue`);
    assert.ok(
      scenario.expectBlocked.because.length > 60,
      `${scenario.id} must say WHY it cannot assert yet`,
    );
  }

  assert.equal(
    SDK_QA_SCENARIOS.length,
    new Set(SDK_QA_SCENARIOS.map((scenario) => scenario.id)).size,
    "scenario ids are unique",
  );
});
