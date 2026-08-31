/**
 * QA-TEST-008/009 — the harness end to end against the REAL `tbh serve`.
 *
 * QA-TEST-008 proves the harness runs: real `@muse/sdk`, real binary, real
 * MSP stdio, real tap, real oracle.
 *
 * QA-TEST-009 is the one that makes 008 worth anything. It takes the SAME
 * captured real-binary run and mutates ONE frame of it, then re-runs the
 * oracle. Clean run -> no finding; mutated run -> a finding naming the
 * mutation. Without that pairing, a silent oracle is indistinguishable from
 * a blind one.
 *
 * Building `tbh` is a multi-minute Rust build, so the real-binary arm is
 * gated on a discoverable binary rather than being built inside this Node
 * lane. A gate is not a pass: when it cannot run it says so loudly and names
 * the exact command that makes it runnable. The auto-qa `--area sdk`
 * procedure ALWAYS has a built binary, which is where this coverage is
 * mandatory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ORACLE_CHECKS,
  RecordedHost,
  SDK_QA_SCENARIOS,
  buildReport,
  renderReportMarkdown,
  resolveMuseBinary,
  runOracle,
  runSdkQa,
  scenarioWorkDir,
} from "../qa/index.js";
import type { ObservedRun, WireFrame } from "../qa/index.js";
import { rm } from "node:fs/promises";

const BINARY = resolveMuseBinary();

/** Replace one inbound frame with a mutated copy, leaving everything else. */
function mutateInbound(
  run: ObservedRun,
  predicate: (frame: WireFrame) => boolean,
  mutate: (json: Record<string, unknown>) => Record<string, unknown>,
): ObservedRun {
  let mutatedCount = 0;
  const frames = run.wire.frames.map((frame) => {
    if (frame.direction !== "hostToClient" || frame.json === undefined || !predicate(frame)) {
      return frame;
    }
    mutatedCount += 1;
    const json = mutate(structuredClone(frame.json));
    return { ...frame, json, raw: JSON.stringify(json) };
  });
  assert.equal(mutatedCount, 1, "the mutation must land on exactly one real captured frame");
  return {
    ...run,
    wire: {
      ...run.wire,
      frames,
      outbound: frames.filter((frame) => frame.direction === "clientToHost"),
      inbound: frames.filter((frame) => frame.direction === "hostToClient"),
    },
  };
}

test(
  "QA-TEST-008/009: the harness drives the REAL binary, and the oracle discriminates on that real traffic",
  { timeout: 180_000 },
  async (t) => {
    if (!BINARY.available) {
      t.skip(`REAL-BINARY ARM DID NOT RUN — this is NOT a pass. ${BINARY.reason}`);
      return;
    }

    const workDir = await scenarioWorkDir("real");
    let run: ObservedRun;
    try {
      const host = await RecordedHost.open({ museBin: BINARY.path, workDir, label: "real" });
      await host.initialize();
      await host.request("list", "session/list", {});
      await host.request("models", "model/list", {});
      run = await host.finish();
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }

    // --- QA-TEST-008: it really talked to the real host ---------------------
    const initializeResponse = run.wire.inbound.find(
      (frame) => (frame.json?.["result"] as { serverInfo?: unknown } | undefined)?.serverInfo,
    );
    assert.ok(initializeResponse !== undefined, "the real host answered `initialize`");
    const serverInfo = (
      initializeResponse.json?.["result"] as { serverInfo?: { name?: unknown } }
    ).serverInfo;
    assert.equal(serverInfo?.name, "muse", "the recording is of the product host, not a fixture");
    assert.deepEqual(
      run.api.find((entry) => entry.kind === "exit")?.classification,
      { kind: "cleanShutdown" },
      "stdin EOF drains the real host to a clean exit (SS2.11)",
    );

    // --- QA-TEST-009a: control — the oracle is silent on faithful real traffic
    const clean = runOracle(run);
    assert.deepEqual(
      clean.map((f) => `${f.checkId}: ${f.summary}`),
      [],
      "the real binary's traffic must be clean under every check",
    );

    // --- QA-TEST-009b: subject — one mutated real frame IS caught -----------
    const forgedFingerprint = mutateInbound(
      run,
      (frame) => (frame.json?.["result"] as { schema?: unknown } | undefined)?.schema !== undefined,
      (json) => {
        const result = json["result"] as { schema: { fingerprint: string } };
        result.schema.fingerprint = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
        return json;
      },
    );
    const fingerprintFindings = runOracle(forgedFingerprint);
    assert.deepEqual(
      fingerprintFindings.map((f) => f.checkId),
      ["O2", "O6"],
      "a served fingerprint the client was not told about must be caught",
    );
    for (const found of fingerprintFindings) {
      assert.match(found.wireSaid, /0000000000000000/, "the finding quotes what the wire said");
      assert.ok(found.apiSaid.length > 0);
    }

    // A second, independent mutation: the host answers one id twice.
    const duplicated = { ...run };
    const listResponse = run.wire.inbound.find(
      (frame) => (frame.json?.["result"] as { sessions?: unknown } | undefined)?.sessions,
    );
    assert.ok(listResponse !== undefined, "the real host answered `session/list`");
    const frames = [...run.wire.frames, { ...listResponse, order: run.wire.frames.length }];
    const doubled: ObservedRun = {
      ...duplicated,
      wire: {
        ...run.wire,
        frames,
        outbound: frames.filter((frame) => frame.direction === "clientToHost"),
        inbound: frames.filter((frame) => frame.direction === "hostToClient"),
      },
    };
    const duplicateFindings = runOracle(doubled);
    assert.deepEqual(duplicateFindings.map((f) => f.checkId), ["O3"]);
    assert.match(duplicateFindings[0]?.wireSaid ?? "", /twice/);

    // --- the report the procedure consumes ---------------------------------
    const report = buildReport({
      binaryPath: BINARY.path,
      binaryVersion: BINARY.source,
      scenarios: [
        { id: "S1", title: "handshake + read plane", verdict: "pass", findings: [] },
        { id: "M1", title: "mutated fingerprint", verdict: "finding", findings: fingerprintFindings },
      ],
    });
    assert.equal(report.filing.bug.length, 2, "both fingerprint findings are spec violations");
    assert.match(renderReportMarkdown(report), /wire said/);
  },
);

/**
 * QA-TEST-010 — every shipped scenario actually RUNS against the real host.
 *
 * It does not assert zero findings: a finding is the harness working, and
 * pinning "clean" here would turn a real product defect into a red harness
 * lane and pressure someone to delete the check. What it pins is that no
 * scenario is BLOCKED (a scenario that cannot run has learned nothing) and
 * that every finding it can produce carries both halves of its evidence.
 */
test("QA-TEST-010: the shipped scenario set runs end to end on the real binary", { timeout: 300_000 }, async (t) => {
  if (!BINARY.available) {
    t.skip(`REAL-BINARY ARM DID NOT RUN — this is NOT a pass. ${BINARY.reason}`);
    return;
  }
  const report = await runSdkQa({ museBin: BINARY.path, museVersion: BINARY.source });
  assert.equal(report.scenarios.length, SDK_QA_SCENARIOS.length);
  const blocked = report.scenarios.filter((scenario) => scenario.verdict === "blocked");
  assert.deepEqual(
    blocked.map((scenario) => `${scenario.id}: ${scenario.blockedBecause ?? ""}`),
    [],
    "a blocked scenario proves nothing about the host",
  );
  for (const scenario of report.scenarios) {
    for (const found of scenario.findings) {
      assert.ok(found.apiSaid.trim().length > 0, `${scenario.id}/${found.checkId} states the API side`);
      assert.ok(found.wireSaid.trim().length > 0, `${scenario.id}/${found.checkId} states the wire side`);
    }
  }
  assert.match(renderReportMarkdown(report), /## Track 1 — spec violations/);
});

test("QA-TEST-009c: every oracle check declares a constraint and a filing track", () => {
  assert.ok(ORACLE_CHECKS.length > 0);
  const ids = ORACLE_CHECKS.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length, "check ids are unique");
  for (const check of ORACLE_CHECKS) {
    if (check.constraint.kind === "spec") {
      assert.match(check.constraint.ref.id, /^(FR|INV|SC)-\d+$/, `${check.id} names a requirement`);
      assert.match(check.constraint.ref.source, /^specs\//, `${check.id} cites a spec by path`);
    } else {
      assert.ok(check.constraint.hazard.length > 40, `${check.id} says why integrators depend on it`);
      assert.ok(check.constraint.candidates.length > 0, `${check.id} names where to decide it`);
    }
  }
  assert.ok(
    ORACLE_CHECKS.some((check) => check.constraint.kind === "silent"),
    "the spec-gap track must have at least one real producer, not just a type",
  );
});
