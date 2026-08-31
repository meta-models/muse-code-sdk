/** The scenario contract, and the one helper that keeps attribution honest. */

import { rm } from "node:fs/promises";

import type { ObservedRun } from "./oracle.js";
import { RecordedHost, hermeticEnv, scenarioWorkDir } from "./recorder.js";
import type { DefectClass, ExpectedBlock } from "./report.js";

export interface AttributionPlan {
  /** The captured run whose frames are replayed. */
  readonly run: ObservedRun;
  /** The observable the verdict rests on, projected out of a run. */
  observe(run: ObservedRun): string;
  /** The SAME call sequence, re-issued against the replay host. */
  drive(host: RecordedHost): Promise<void>;
}

/**
 * What an expect-blocked scenario proved: a blocker verdict, or a refusal to
 * give one. A refusal is carried as a VALUE rather than thrown so the oracle
 * still runs over `runs` and the deviations that same capture recorded are
 * still filed (#23111).
 */
export type BlockedVerdict =
  | { readonly bites: boolean; readonly refused?: never }
  | { readonly refused: string; readonly bites?: never };

export interface ScenarioOutcome {
  readonly runs: readonly ObservedRun[];
  /** What the public API actually reported, as a comparable string. */
  readonly observed: string;
  /** What the contract says it should have been. */
  readonly expected: string;
  /**
   * Expect-blocked scenarios only. ONE field carries the one-of union, so an
   * outcome that both refuses the verdict and reports a bite cannot be
   * written — "refused wins" is the type's shape, not a branch order
   * (#23111 review round 3).
   */
  readonly blockedVerdict?: BlockedVerdict;
  /** Supplied when a mismatch would need a component. */
  readonly attributeWith?: AttributionPlan;
}

export interface QaScenario {
  readonly id: string;
  readonly title: string;
  /** The charter vein this covers, for the report. */
  readonly vein: string;
  readonly defectClass?: DefectClass;
  readonly expectBlocked?: ExpectedBlock;
  run(museBin: string): Promise<ScenarioOutcome>;
}

export interface DrivenOnceOptions {
  readonly museBin: string;
  readonly label: string;
  readonly serveArgs?: readonly string[];
  readonly requestedCapabilities?: readonly string[];
  /** Every post-handshake call, in order. Reused verbatim by the replay. */
  drive(host: RecordedHost): Promise<void>;
  observe(run: ObservedRun): string;
  readonly expected: string;
  /** Select a provider in this scenario's home before the host starts (#23537). */
  readonly configureProvider?: "echo";
}

/**
 * Drive one real host, then hand attribution the SAME `drive` function.
 *
 * The replay host answers positionally, so a replay that issues a different
 * call sequence than the live run is comparing two different transcripts and
 * reports `indeterminate` — a harness defect wearing an honest-looking label.
 * Making the live sequence and the replay sequence one function object
 * removes that whole class of mistake by construction rather than by review.
 */
export async function drivenOnce(options: DrivenOnceOptions): Promise<ScenarioOutcome> {
  const workDir = await scenarioWorkDir(options.label);
  try {
    const host = await RecordedHost.open({
      museBin: options.museBin,
      workDir,
      label: options.label,
      ...(options.serveArgs === undefined ? {} : { serveArgs: options.serveArgs }),
      ...(options.configureProvider === undefined
        ? {}
        : { configureProvider: options.configureProvider }),
    });
    await host.initialize(
      options.requestedCapabilities === undefined
        ? undefined
        : { requestedCapabilities: [...options.requestedCapabilities] },
    );
    await options.drive(host);
    const run = await host.finish();
    return {
      runs: [run],
      observed: options.observe(run),
      expected: options.expected,
      attributeWith: { run, observe: options.observe, drive: options.drive },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export interface DrivenAcrossRestartOptions<T> {
  readonly museBin: string;
  readonly label: string;
  readonly serveArgs?: readonly string[];
  /** Steps on the FIRST host. Its HOME is what the second host inherits. */
  seed(host: RecordedHost): Promise<T>;
  /** Steps on the SECOND host. Attribution replays exactly this. */
  driveWith(seeded: T): (host: RecordedHost) => Promise<void>;
  observe(run: ObservedRun): string;
  readonly expected: string;
}

/**
 * Seed state on one host, let it die, then drive a FRESH host over the same
 * durable home. The restart is the point: everything the second host knows
 * came through the journal, which is exactly what the load/resume and
 * cross-restart classes interrogate.
 */
export async function drivenAcrossRestart<T>(
  options: DrivenAcrossRestartOptions<T>,
): Promise<ScenarioOutcome> {
  const workDir = await scenarioWorkDir(options.label);
  try {
    const firstLabel = `${options.label}a`;
    const first = await RecordedHost.open({
      museBin: options.museBin,
      workDir,
      label: firstLabel,
      ...(options.serveArgs === undefined ? {} : { serveArgs: options.serveArgs }),
    });
    await first.initialize();
    const seeded = await options.seed(first);
    const firstRun = await first.finish();

    const drive = options.driveWith(seeded);
    const second = await RecordedHost.open({
      museBin: options.museBin,
      workDir,
      label: `${options.label}b`,
      env: hermeticEnv(`${workDir}/${firstLabel}-home`),
      ...(options.serveArgs === undefined ? {} : { serveArgs: options.serveArgs }),
    });
    await second.initialize();
    await drive(second);
    const secondRun = await second.finish();

    return {
      runs: [firstRun, secondRun],
      observed: options.observe(secondRun),
      expected: options.expected,
      attributeWith: { run: secondRun, observe: options.observe, drive },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/** The session id a `session/start` step returned, if it returned one. */
export function sessionIdOf(result: Record<string, unknown> | undefined): string | undefined {
  const id = (result?.["session"] as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof id === "string" ? id : undefined;
}

export function resultOfStep(
  run: ObservedRun,
  step: string,
): Record<string, unknown> | undefined {
  for (let index = run.api.length - 1; index >= 0; index -= 1) {
    const entry = run.api[index];
    if (entry?.kind === "requestOk" && entry.step === step) return entry.result;
  }
  return undefined;
}

/** `history.mode` as served for a step, or `<absent>`. */
export function historyModeOf(run: ObservedRun, step: string): string {
  const history = resultOfStep(run, step)?.["history"] as { mode?: unknown } | undefined;
  return typeof history?.mode === "string" ? history.mode : "<absent>";
}
