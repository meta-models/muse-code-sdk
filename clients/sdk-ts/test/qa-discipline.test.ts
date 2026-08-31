/**
 * QA-TEST-004..007 — the harness's own discipline invariants. These are the
 * rules that keep the harness an EXTERNAL INTEGRATOR rather than a privileged
 * insider, and a reporter rather than a filer.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ORACLE_CHECKS,
  QaEvidenceError,
  buildReport,
  classifyFinding,
  finding,
  renderReportMarkdown,
} from "../qa/index.js";

const QA_SOURCE_DIR = fileURLToPath(new URL("../../qa", import.meta.url));

async function qaSourceFiles(): Promise<readonly string[]> {
  const entries = await readdir(QA_SOURCE_DIR, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

const SPEC_BOUND_CHECK = ORACLE_CHECKS.find((check) => check.constraint.kind === "spec");
const SILENT_CHECK = ORACLE_CHECKS.find((check) => check.constraint.kind === "silent");

test("QA-TEST-004: a finding with no wire evidence is REFUSED, not filed", () => {
  assert.ok(SPEC_BOUND_CHECK !== undefined, "at least one check is spec-bound");
  const wellFormed = finding(SPEC_BOUND_CHECK, {
    indicts: "facade",
    summary: "the surfaced result is not the served result",
    apiSaid: "initializeResult.userAgent === 'a'",
    wireSaid: "the initialize response carried userAgent 'b'",
    evidence: ['{"jsonrpc":"2.0","id":1,"result":{}}'],
  });
  assert.equal(wellFormed.checkId, SPEC_BOUND_CHECK.id);

  for (const missing of ["apiSaid", "wireSaid"] as const) {
    assert.throws(
      () =>
        finding(SPEC_BOUND_CHECK, {
          indicts: "facade",
          summary: "internal field Z looked wrong",
          apiSaid: missing === "apiSaid" ? "   " : "the public API said X",
          wireSaid: missing === "wireSaid" ? "" : "the wire said Y",
          evidence: [],
        }),
      QaEvidenceError,
      `a finding missing ${missing} must be refused (charter decision 4)`,
    );
  }
});

test("QA-TEST-005: two-track filing routes violations and gaps differently", () => {
  assert.ok(SPEC_BOUND_CHECK !== undefined);
  assert.ok(SILENT_CHECK !== undefined, "at least one check is spec-silent");

  const violation = classifyFinding(
    finding(SPEC_BOUND_CHECK, {
      indicts: "facade",
      summary: "v",
      apiSaid: "x",
      wireSaid: "y",
      evidence: [],
    }),
  );
  assert.equal(violation.track, "bug");
  assert.deepEqual([...violation.labels], ["bug", "auto"]);
  assert.ok(SPEC_BOUND_CHECK.constraint.kind === "spec");
  assert.equal(violation.violates.id, SPEC_BOUND_CHECK.constraint.ref.id);

  const gap = classifyFinding(
    finding(SILENT_CHECK, { indicts: "binary", summary: "g", apiSaid: "x", wireSaid: "y", evidence: [] }),
  );
  assert.equal(gap.track, "spec-gap");
  // The 2026-08-25 owner ruling: no `spec-gap` label exists and none is being
  // minted, so the track files as `bug` + `auto` and the owning-spec body line
  // IS the routing (#23111 arm 4).
  assert.deepEqual([...gap.labels], ["bug", "auto"]);
  assert.match(gap.body, /Owning spec\(s\) to decide against/);
  assert.ok(gap.against.length > 0, "a gap names the spec that must constrain or document it");
  assert.equal(gap.decision, "constrain-or-document");
  assert.ok(
    !("violates" in gap),
    "a spec-silent hazard must never be dressed up as a spec violation",
  );
});

test("QA-TEST-005b: the report states verdicts and the facade-vs-binary split", () => {
  assert.ok(SPEC_BOUND_CHECK !== undefined);
  const report = buildReport({
    binaryPath: "/tmp/tbh",
    binaryVersion: "0.0.0-test",
    scenarios: [
      { id: "S1", title: "handshake", verdict: "pass", findings: [] },
      {
        id: "S2",
        title: "list",
        verdict: "finding",
        findings: [
          finding(SPEC_BOUND_CHECK, {
            indicts: "facade",
            summary: "s",
            apiSaid: "x",
            wireSaid: "y",
            evidence: [],
          }),
        ],
      },
    ],
  });
  assert.equal(report.verdicts.pass, 1);
  assert.equal(report.verdicts.finding, 1);
  assert.equal(report.filing.bug.length, 1);
  assert.equal(report.filing.specGap.length, 0);
  const markdown = renderReportMarkdown(report);
  assert.match(markdown, /public API said/);
  assert.match(markdown, /wire said/);
  assert.match(markdown, /S1/);
  assert.match(markdown, /S2/);
});

test("QA-TEST-006: the harness reaches the SDK through its PUBLIC barrel only", async () => {
  const files = await qaSourceFiles();
  assert.ok(files.length > 0, "the qa driver has sources to check");
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/from\s+"([^"]+)"/g)) {
      const specifier = match[1] ?? "";
      if (!specifier.includes("src/")) continue;
      // Only the package barrel, at any nesting depth. A deeper path would
      // give the harness knowledge no external integrator has.
      if (/^(\.\.\/)+src\/index\.js$/.test(specifier)) continue;
      offenders.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "an external integrator has only the barrel; a deeper import makes every finding unfileable",
  );
});

test("QA-TEST-007: the harness reports; it never files and never reaches the network", async () => {
  const files = await qaSourceFiles();
  const offenders: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const [pattern, why] of [
      [/\bgh\s+(issue|pr|api)\b/, "shells out to gh"],
      [/node:(https?|net|tls|dgram)/, "imports a network module"],
      [/\bfetch\s*\(/, "calls fetch"],
      [/\bXMLHttpRequest\b/, "calls XMLHttpRequest"],
    ] as const) {
      if (pattern.test(text)) offenders.push(`${file}: ${why}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "filing is the auto-qa procedure's job (spec 2159); the driver only reports",
  );
});
