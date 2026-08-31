/**
 * Run the `--area sdk` scenario set against one real host and report.
 *
 * This function RUNS the harness. It does not file anything, does not schedule
 * anything, and does not decide when a QA pass happens — those belong to the
 * auto-qa procedure (`specs/2159-auto-qa-skill`, `--area sdk`).
 */

import { attributeByReplay } from "./attribution.js";
import type { Attribution } from "./attribution.js";
import { runOracle } from "./oracle.js";
import type { OracleFinding } from "./oracle.js";
import { buildReport } from "./report.js";
import type { QaReport, ScenarioResult, ScenarioVerdict } from "./report.js";
import type { QaScenario } from "./scenario-kit.js";
import { SDK_QA_SCENARIOS } from "./scenarios.js";

export interface RunOptions {
  readonly museBin: string;
  readonly museVersion?: string;
  readonly scenarios?: readonly QaScenario[];
}

export async function runSdkQa(options: RunOptions): Promise<QaReport> {
  const results: ScenarioResult[] = [];
  for (const scenario of options.scenarios ?? SDK_QA_SCENARIOS) {
    results.push(await runOne(scenario, options.museBin));
  }
  return buildReport({
    binaryPath: options.museBin,
    binaryVersion: options.museVersion ?? "unknown",
    scenarios: results,
  });
}

async function runOne(scenario: QaScenario, museBin: string): Promise<ScenarioResult> {
  const base = {
    id: scenario.id,
    title: `${scenario.title} (${scenario.vein})`,
    ...(scenario.defectClass === undefined ? {} : { defectClass: scenario.defectClass }),
    ...(scenario.expectBlocked === undefined ? {} : { expectBlocked: scenario.expectBlocked }),
  };

  let outcome: Awaited<ReturnType<QaScenario["run"]>>;
  try {
    outcome = await scenario.run(museBin);
  } catch (error) {
    // A scenario that could not complete is BLOCKED, never a pass: an
    // exception here means the harness learned nothing about the host.
    return {
      ...base,
      verdict: "blocked",
      findings: [],
      blockedBecause: `${(error as Error).name}: ${(error as Error).message}`,
    };
  }

  const findings: readonly OracleFinding[] = outcome.runs.flatMap((run) => runOracle(run));
  const matched = outcome.observed === outcome.expected;

  // Attribution costs a replay child, so it runs only when there is something
  // to attribute — and it runs for BOTH arms, because a facade misreport and
  // a binary deviation are different bug reports against different packages.
  const attribute = async (): Promise<Attribution | undefined> =>
    outcome.attributeWith === undefined
      ? undefined
      : await attributeByReplay({
          run: outcome.attributeWith.run,
          observe: outcome.attributeWith.observe,
          drive: outcome.attributeWith.drive,
        });

  if (scenario.expectBlocked !== undefined) {
    // An expect-block asserts its BLOCKER, not the feature. It flips loudly
    // the moment the blocker stops biting — that flip is the whole point.
    //
    // Its findings still reach the report's filing tracks, though: B01-B07
    // drive the real host, so a wire deviation during a blocked run (an O5
    // error-without-kind, say) is filed like any other. Acceptance 4 requires
    // every filed finding to carry a component decided by replay, so this path
    // attributes too — a `filing.specGap` entry with no component would be the
    // one place the harness reverts to judgement.
    const attribution = findings.length > 0 ? await attribute() : undefined;
    return {
      ...base,
      verdict: outcome.blockerStillBites === true ? "expected-block" : "block-lifted",
      findings,
      observed: outcome.observed,
      expected: outcome.expected,
      ...(attribution === undefined ? {} : { attribution }),
    };
  }

  const verdict: ScenarioVerdict = !matched
    ? "defect-reproduced"
    : findings.length > 0
      ? "finding"
      : "pass";

  const attribution = verdict === "pass" ? undefined : await attribute();

  return {
    ...base,
    verdict,
    findings,
    observed: outcome.observed,
    expected: outcome.expected,
    ...(attribution === undefined ? {} : { attribution }),
  };
}
