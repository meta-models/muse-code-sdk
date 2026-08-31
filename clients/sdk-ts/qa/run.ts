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
import type { ObservedRun, OracleFinding } from "./oracle.js";
import { initializeResultOf } from "./recorder.js";
import { buildReport } from "./report.js";
import type { QaReport, ScenarioResult, ScenarioVerdict } from "./report.js";
import type { QaScenario } from "./scenario-kit.js";
import { SDK_QA_SCENARIOS } from "./scenarios.js";

export interface RunOptions {
  readonly museBin: string;
  /** HOW the binary was picked (e.g. `MUSE_QA_SDK_BIN`) — a source, not a version. */
  readonly resolvedVia?: string;
  readonly scenarios?: readonly QaScenario[];
}

/**
 * The host's own identity, from the `initialize` handshake the run captured.
 * The build id is already on the wire (`userAgent: "muse-build/0.3.0 (…;
 * build cc9ad71fd28)"`), so an archived report can say WHICH binary it tested
 * instead of which env var was set (#23111 arm 3).
 */
function hostIdentityOf(run: ObservedRun): string | undefined {
  const result = initializeResultOf(run);
  const serverInfo = result?.["serverInfo"] as { name?: unknown; version?: unknown } | undefined;
  if (typeof serverInfo?.name !== "string" || typeof serverInfo.version !== "string") {
    return undefined;
  }
  const userAgent = result?.["userAgent"];
  const build =
    typeof userAgent === "string" ? /\bbuild ([0-9A-Za-z.-]+)/.exec(userAgent)?.[1] : undefined;
  return build === undefined
    ? `${serverInfo.name} ${serverInfo.version}`
    : `${serverInfo.name} ${serverInfo.version} (build ${build})`;
}

export async function runSdkQa(options: RunOptions): Promise<QaReport> {
  const results: ScenarioResult[] = [];
  let hostIdentity: string | undefined;
  for (const scenario of options.scenarios ?? SDK_QA_SCENARIOS) {
    const { result, runs } = await runOne(scenario, options.museBin);
    results.push(result);
    hostIdentity ??= runs.map(hostIdentityOf).find((identity) => identity !== undefined);
  }
  // Absence is modelled ONCE, in `report.ts`: a fallback minted here would
  // let the renderer's "from the initialize handshake" line drift away from
  // the value it interprets (#23111 review).
  return buildReport({
    binaryPath: options.museBin,
    binaryVersion: hostIdentity,
    resolvedVia: options.resolvedVia,
    scenarios: results,
  });
}

interface RunOneOutcome {
  readonly result: ScenarioResult;
  /** The scenario's captured runs, so the caller can read the handshake. */
  readonly runs: readonly ObservedRun[];
}

async function runOne(scenario: QaScenario, museBin: string): Promise<RunOneOutcome> {
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
      result: {
        ...base,
        verdict: "blocked",
        findings: [],
        blockedBecause: `${(error as Error).name}: ${(error as Error).message}`,
      },
      runs: [],
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
    const blockedVerdict = outcome.blockedVerdict;
    // Value-presence, not key-presence: `{ bites: true, refused: undefined }`
    // still compiles as a BlockedVerdict, and an `in` check would misreport
    // that biting outcome as `blocked` (#23324 review).
    if (blockedVerdict?.refused !== undefined) {
      // The drive reached the host but never reached the BLOCKER, so no
      // expect-block verdict is earned. The findings above still travel: the
      // capture is real traffic, and dropping its deviations was the cost of
      // the earlier throw (#23111 review).
      return {
        result: {
          ...base,
          verdict: "blocked",
          findings,
          observed: outcome.observed,
          expected: outcome.expected,
          blockedBecause: blockedVerdict.refused,
          ...(attribution === undefined ? {} : { attribution }),
        },
        runs: outcome.runs,
      };
    }
    return {
      result: {
        ...base,
        verdict: blockedVerdict?.bites === true ? "expected-block" : "block-lifted",
        findings,
        observed: outcome.observed,
        expected: outcome.expected,
        ...(attribution === undefined ? {} : { attribution }),
      },
      runs: outcome.runs,
    };
  }

  const verdict: ScenarioVerdict = !matched
    ? "defect-reproduced"
    : findings.length > 0
      ? "finding"
      : "pass";

  const attribution = verdict === "pass" ? undefined : await attribute();

  return {
    result: {
      ...base,
      verdict,
      findings,
      observed: outcome.observed,
      expected: outcome.expected,
      ...(attribution === undefined ? {} : { attribution }),
    },
    runs: outcome.runs,
  };
}
