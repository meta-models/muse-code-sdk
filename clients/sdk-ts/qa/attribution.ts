/**
 * Facade-vs-binary attribution, by RAW-FRAME REPLAY.
 *
 * A defect report against the wrong half is worse than none: it sends the fix
 * lane to the wrong package. So no SDK finding leaves this harness without a
 * component, and the component is never a guess — it is decided by replaying
 * the exact frames the real host sent into a fresh SDK, with no binary in the
 * process tree, and asking whether the public API's view is a faithful
 * function of those frames.
 *
 *   the wire carried the defect, and the SDK reported it faithfully
 *     -> BINARY: the host really did that; the facade is a clean mirror.
 *   the wire was correct, and the public API disagreed with it
 *     -> FACADE: the oracle's api-vs-wire finding IS the proof.
 *   the observation does not reproduce from the frames alone
 *     -> INDETERMINATE: timing, process state, or stderr is involved. Said
 *        out loud, never rounded to whichever half is convenient.
 */

import { rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { runOracle } from "./oracle.js";
import type { ObservedRun, OracleFinding } from "./oracle.js";
import { RecordedHost, scenarioWorkDir } from "./recorder.js";

export const REPLAY_HOST_PATH = fileURLToPath(new URL("./replay-host.js", import.meta.url));

export type Component = "binary" | "facade" | "indeterminate";

export interface Attribution {
  readonly component: Component;
  readonly method: "raw-frame-replay";
  /** What the real run observed, and what the replay of its frames observed. */
  readonly observedLive: string;
  readonly observedReplay: string;
  readonly oracleFindings: readonly OracleFinding[];
  readonly rationale: string;
}

/**
 * Re-drive the SAME public-API steps against a host that replays `run`'s
 * captured frames, then project the same observable out of both.
 *
 * `drive` must issue the same calls in the same order as the live scenario:
 * the replay host answers requests positionally, so a different call sequence
 * would be comparing two different transcripts.
 */
export async function attributeByReplay(options: {
  readonly run: ObservedRun;
  readonly observe: (run: ObservedRun) => string;
  readonly drive: (host: RecordedHost) => Promise<void>;
}): Promise<Attribution> {
  const oracleFindings = runOracle(options.run);
  const observedLive = options.observe(options.run);

  const workDir = await scenarioWorkDir("replay");
  let observedReplay: string;
  // `host` is declared out here so the teardown below reaches it on EVERY
  // path. A throwing `initialize()` or `drive()` used to skip `finish()`
  // entirely, leaving the replay child and its shim alive with their stdio
  // handles open — the same leak that hangs the QA run after the report prints.
  let host: RecordedHost | undefined;
  try {
    const framesFile = join(workDir, "inbound.ndjson");
    await writeFile(framesFile, `${options.run.wire.inbound.map((f) => f.raw).join("\n")}\n`, "utf8");
    host = await RecordedHost.open({
      museBin: process.execPath,
      argv: [REPLAY_HOST_PATH, framesFile],
      workDir,
      label: "replay",
    });
    await host.initialize();
    await options.drive(host);
    observedReplay = options.observe(await host.finish());
  } catch (error) {
    observedReplay = `<replay failed: ${(error as Error).message}>`;
  } finally {
    // `finish()` is guarded against a second close, so the success path pays
    // nothing here; the failure path is the one that needs it.
    try {
      await host?.finish();
    } catch {
      // Teardown must not overwrite the observation that got us here.
    }
    await rm(workDir, { recursive: true, force: true });
  }

  // An oracle finding alone does not indict the facade: "the host answered
  // one id twice" is a wire-vs-API disagreement the BINARY caused. Only a
  // finding that explicitly indicts the facade moves the component.
  const facadeIndictments = oracleFindings.filter((found) => found.indicts === "facade");
  if (facadeIndictments.length > 0) {
    return {
      component: "facade",
      method: "raw-frame-replay",
      observedLive,
      observedReplay,
      oracleFindings,
      rationale: `the oracle found the public API disagreeing with the frames the host actually sent (${facadeIndictments
        .map((found) => found.checkId)
        .join(", ")}), so the misreport is the facade's regardless of what the host meant`,
    };
  }
  if (observedReplay === observedLive) {
    return {
      component: "binary",
      method: "raw-frame-replay",
      observedLive,
      observedReplay,
      oracleFindings,
      rationale:
        "replaying the host's own frames into a fresh SDK reproduces the same public-API observation, so the facade is a faithful function of the wire and the deviation is carried by the frames",
    };
  }
  return {
    component: "indeterminate",
    method: "raw-frame-replay",
    observedLive,
    observedReplay,
    oracleFindings,
    rationale:
      "the observation did not reproduce from the recorded frames alone, so something outside the wire (timing, process state, or host stderr) participates and neither half can be blamed yet",
  };
}
