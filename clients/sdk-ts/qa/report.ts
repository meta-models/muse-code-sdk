/**
 * Two-track filing instructions and the run report.
 *
 * This module decides WHAT SHOULD BE FILED. It never files: opening issues is
 * the auto-qa procedure's job (`specs/2159-auto-qa-skill`, `--area sdk`), and
 * keeping the decision separate from the act is what lets the harness run
 * without a GitHub token and without a human wondering what it just did.
 */

import type { Attribution } from "./attribution.js";
import type { OracleFinding, SpecRef } from "./oracle.js";

export type FindingTrack =
  | {
      readonly track: "bug";
      readonly labels: readonly ["bug", "auto"];
      /** The named requirement the observed behaviour violates. */
      readonly violates: SpecRef;
      readonly title: string;
      readonly body: string;
    }
  | {
      readonly track: "spec-gap";
      readonly labels: readonly ["spec-gap"];
      /** The specs that must either constrain this or document it as free. */
      readonly against: readonly SpecRef[];
      readonly decision: "constrain-or-document";
      readonly title: string;
      readonly body: string;
    };

function body(finding: OracleFinding, tail: string): string {
  return [
    finding.summary,
    "",
    `- **indicts:** \`${finding.indicts}\` — file this against ${
      finding.indicts === "facade" ? "`@muse/sdk` (clients/sdk-ts)" : "the `tbh` binary"
    }`,
    `- **public API said:** ${finding.apiSaid}`,
    `- **wire said:** ${finding.wireSaid}`,
    "",
    "Wire evidence (verbatim frames from the tap):",
    "",
    "```jsonl",
    ...finding.evidence,
    "```",
    "",
    tail,
  ].join("\n");
}

/**
 * Route one finding. A spec-silent hazard is never dressed up as a violation:
 * filing it as a bug would invite a silent fix, and the charter's whole point
 * is that an unconstrained behaviour integrators depend on must be decided,
 * not patched.
 */
export function classifyFinding(finding: OracleFinding): FindingTrack {
  const title = `[sdk-qa ${finding.checkId}] ${finding.summary}`;
  if (finding.constraint.kind === "spec") {
    return {
      track: "bug",
      labels: ["bug", "auto"],
      violates: finding.constraint.ref,
      title,
      body: body(
        finding,
        `Violates **${finding.constraint.ref.id}** (\`${finding.constraint.ref.source}\`).`,
      ),
    };
  }
  return {
    track: "spec-gap",
    labels: ["spec-gap"],
    against: finding.constraint.candidates,
    decision: "constrain-or-document",
    title,
    body: body(
      finding,
      [
        "No requirement constrains this today, so it is a **spec gap**, not a bug:",
        "",
        `> ${finding.constraint.hazard}`,
        "",
        `Owning spec(s) to decide against: ${finding.constraint.candidates
          .map((ref) => `\`${ref.source}\` (${ref.id})`)
          .join(", ")}.`,
        "",
        "Decision required: **constrain** it (add the requirement and a contract",
        "test) or **document** it as deliberately unconstrained. Do not fix it",
        "silently — an integrator is already depending on the current behaviour.",
      ].join("\n"),
    ),
  };
}

export type ScenarioVerdict =
  /** The observable matched the contract and the oracle was silent. */
  | "pass"
  /** The oracle found a public-API-vs-wire disagreement. */
  | "finding"
  /** A known defect class re-drove through the SDK and still reproduces. */
  | "defect-reproduced"
  /** A scenario whose blocker still bites, exactly as recorded. */
  | "expected-block"
  /** THE BLOCKER IS GONE. Flip this scenario to a real assertion. */
  | "block-lifted"
  /** The scenario could not run, so it learned nothing. */
  | "blocked";

export interface DefectClass {
  /** The confirmed defect this scenario re-drives, e.g. `#19649`. */
  readonly issue: string;
  readonly summary: string;
}

export interface ExpectedBlock {
  /** The issue that blocks this scenario from being a real assertion. */
  readonly blocker: string;
  readonly because: string;
}

export interface ScenarioResult {
  readonly id: string;
  readonly title: string;
  readonly verdict: ScenarioVerdict;
  readonly findings: readonly OracleFinding[];
  readonly defectClass?: DefectClass;
  readonly expectBlocked?: ExpectedBlock;
  /** The observable the verdict rests on, and what the contract expects. */
  readonly observed?: string;
  readonly expected?: string;
  /** Which half owns it, decided by raw-frame replay. */
  readonly attribution?: Attribution;
  /** Why a `blocked` scenario could not run. Absent otherwise. */
  readonly blockedBecause?: string;
}

export interface QaReport {
  readonly binaryPath: string;
  readonly binaryVersion: string;
  readonly scenarios: readonly ScenarioResult[];
  readonly verdicts: Readonly<Record<ScenarioVerdict, number>>;
  readonly filing: {
    readonly bug: readonly FindingTrack[];
    readonly specGap: readonly FindingTrack[];
  };
}

export interface ReportInput {
  readonly binaryPath: string;
  readonly binaryVersion: string;
  readonly scenarios: readonly ScenarioResult[];
}

export function buildReport(input: ReportInput): QaReport {
  const verdicts: Record<ScenarioVerdict, number> = {
    pass: 0,
    finding: 0,
    "defect-reproduced": 0,
    "expected-block": 0,
    "block-lifted": 0,
    blocked: 0,
  };
  const bug: FindingTrack[] = [];
  const specGap: FindingTrack[] = [];
  for (const scenario of input.scenarios) {
    verdicts[scenario.verdict] += 1;
    for (const finding of scenario.findings) {
      const routed = classifyFinding(finding);
      if (routed.track === "bug") bug.push(routed);
      else specGap.push(routed);
    }
  }
  return {
    binaryPath: input.binaryPath,
    binaryVersion: input.binaryVersion,
    scenarios: input.scenarios,
    verdicts,
    filing: { bug, specGap },
  };
}

/**
 * The human-readable half. It states the per-scenario verdicts and separates
 * the two tracks, because "the facade lied" and "the binary did something no
 * spec covers" are different work for different owners (charter decision 5's
 * facade-vs-binary split).
 */
export function renderReportMarkdown(report: QaReport): string {
  const lines = [
    "# auto-qa `--area sdk` run report",
    "",
    `- host binary: \`${report.binaryPath}\``,
    `- host version: \`${report.binaryVersion}\``,
    `- verdicts: ${(Object.entries(report.verdicts) as [ScenarioVerdict, number][])
      .filter(([, count]) => count > 0)
      .map(([verdict, count]) => `${count} ${verdict}`)
      .join(", ")}`,
    "",
    "## Scenarios",
    "",
    "| id | scenario | verdict | component | findings |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const scenario of report.scenarios) {
    const note =
      scenario.verdict === "blocked"
        ? ` — ${scenario.blockedBecause ?? "no reason recorded"}`
        : scenario.expectBlocked === undefined
          ? ""
          : ` (blocker ${scenario.expectBlocked.blocker})`;
    lines.push(
      `| ${scenario.id} | ${scenario.title} | ${scenario.verdict}${note} | ${scenario.attribution?.component ?? "—"} | ${scenario.findings.length} |`,
    );
  }

  const lifted = report.scenarios.filter((scenario) => scenario.verdict === "block-lifted");
  if (lifted.length > 0) {
    lines.push(
      "",
      "## ⚠ BLOCK LIFTED — flip these scenarios to real assertions",
      "",
      "Each of these was recorded as blocked by a named issue, and the blocker no",
      "longer bites. The expect-block was a placeholder for a real assertion; it",
      "has now served its purpose and must be replaced, not re-pinned.",
      "",
    );
    for (const scenario of lifted) {
      lines.push(
        `- **${scenario.id}** ${scenario.title} — blocker \`${scenario.expectBlocked?.blocker ?? "?"}\` no longer reproduces.`,
        `  Expected the blocker's signature; observed \`${scenario.observed ?? "?"}\`.`,
      );
    }
  }

  const reproduced = report.scenarios.filter(
    (scenario) => scenario.verdict === "defect-reproduced",
  );
  if (reproduced.length > 0) {
    lines.push("", "## Confirmed defect classes that still reproduce through the SDK", "");
    for (const scenario of reproduced) {
      lines.push(
        `### ${scenario.id} — ${scenario.defectClass?.issue ?? "unlinked"} ${scenario.title}`,
        "",
        `- **expected:** ${scenario.expected ?? "—"}`,
        `- **observed:** ${scenario.observed ?? "—"}`,
        `- **component (raw-frame replay):** \`${scenario.attribution?.component ?? "not attributed"}\` — ${scenario.attribution?.rationale ?? "no attribution recorded"}`,
        `- **replay evidence:** live \`${scenario.attribution?.observedLive ?? "—"}\` vs replayed \`${scenario.attribution?.observedReplay ?? "—"}\``,
        "",
      );
    }
  }

  const stillBlocked = report.scenarios.filter(
    (scenario) => scenario.verdict === "expected-block",
  );
  if (stillBlocked.length > 0) {
    lines.push(
      "",
      "## Expect-blocked scenarios (encoded, running, not yet assertable)",
      "",
      "These are NOT skipped and NOT weakened. Most drive the real host, record",
      "that their blocker still bites, and turn into `block-lifted` the moment it",
      "stops — which is the signal to replace them with a real assertion. The",
      "exception is a blocker outside this harness's MSP-only lens: there is",
      "nothing to drive and no observable flip, so it is a recorded permanent",
      "expected-block whose lifting is a manual owner decision.",
      "",
      "| id | scenario | blocker | why it cannot assert yet |",
      "| --- | --- | --- | --- |",
    );
    for (const scenario of stillBlocked) {
      lines.push(
        `| ${scenario.id} | ${scenario.title} | ${scenario.expectBlocked?.blocker ?? "?"} | ${scenario.expectBlocked?.because ?? "?"} |`,
      );
    }
  }

  for (const [heading, track, note] of [
    [
      "## Track 1 — spec violations (`bug` + `auto`)",
      report.filing.bug,
      "Each names the requirement it violates. `fix-bug` owns the fix.",
    ],
    [
      "## Track 2 — spec-silent hazards (spec-gap)",
      report.filing.specGap,
      "No requirement constrains these. Each forces a constrain-vs-document decision; none may be fixed silently.",
    ],
  ] as const) {
    lines.push("", heading, "", note, "");
    if (track.length === 0) {
      lines.push("_none_");
      continue;
    }
    for (const item of track) {
      lines.push(`### ${item.title}`, "", item.body, "");
    }
  }
  return lines.join("\n");
}
