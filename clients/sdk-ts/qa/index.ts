/**
 * `auto-qa --area sdk` — the black-box QA harness for `@muse-code/sdk`.
 *
 * It plays an EXTERNAL INTEGRATOR: the real `@muse-code/sdk`, reached only through
 * its public barrel, driving the real `tbh serve` binary over MSP stdio, with
 * a wire tap recording both directions so every finding can be stated as
 * "public API said X, wire said Y".
 *
 * Owning specs: the driver is `specs/14990-muse-sdk/spec.md`; the QA procedure
 * that runs it is `specs/2159-auto-qa-skill/spec.md` (`--area sdk`).
 */

export { MUSE_QA_SDK_BIN, resolveMuseBinary } from "./binary.js";
export type { BinaryResolution } from "./binary.js";

export { REPLAY_HOST_PATH, attributeByReplay } from "./attribution.js";
export type { Attribution, Component } from "./attribution.js";

export { ORACLE_CHECKS, QaEvidenceError, finding, runOracle } from "./oracle.js";
export type {
  ApiObservation,
  Indicted,
  ObservedRun,
  OracleCheck,
  OracleFinding,
  SpecConstraint,
  SpecRef,
} from "./oracle.js";

export {
  QA_CLIENT_INFO,
  RecordedHost,
  errorKindOfRun,
  hermeticEnv,
  initializeResultOf,
  scenarioWorkDir,
  settlementOfRun,
} from "./recorder.js";
export type { OpenHostOptions } from "./recorder.js";

export { UNKNOWN, buildReport, classifyFinding, renderReportMarkdown } from "./report.js";
export type {
  DefectClass,
  ExpectedBlock,
  FindingTrack,
  QaReport,
  ScenarioResult,
  ScenarioVerdict,
} from "./report.js";

export { runSdkQa } from "./run.js";
export type { RunOptions } from "./run.js";

export {
  blockedRunEvidence,
  blockedScenario,
  blockedVerdictOf,
  blockerStillBites,
  foldBlockedEvidence,
  subjectStepsOf,
} from "./scenarios/turn-blocked.js";
export type {
  BlockedRunEvidence,
  BlockedShape,
  BlockedVerdict,
} from "./scenarios/turn-blocked.js";
export {
  D19764_COMMAND_TEXT,
  D19764_EXPECTED,
  observeD19764,
} from "./scenarios/defect-classes.js";
export {
  CONFORMANCE_SCENARIOS,
  DEFECT_CLASS_SCENARIOS,
  SDK_QA_SCENARIOS,
  TURN_BLOCKED_SCENARIOS,
} from "./scenarios.js";
export { drivenAcrossRestart, drivenOnce, historyModeOf, resultOfStep, sessionIdOf } from "./scenario-kit.js";
export type { AttributionPlan, QaScenario, ScenarioOutcome } from "./scenario-kit.js";

export { TAP_SHIM_PATH, readTapPids, readWireLog, tappedSpawnOptions } from "./tap.js";
export type { TapPids, TappedSpawnOptions, WireDirection, WireFrame, WireLog } from "./tap.js";
