/**
 * Handshake and lifecycle over stdio.
 *
 * These conform fully against the release binary, so this group stays small
 * on purpose: the yield is in the defect classes and the turn-blocked set,
 * and a QA suite that spends its budget re-proving a green surface is
 * measuring its own effort rather than the product.
 */

import { drivenOnce } from "../scenario-kit.js";
import type { QaScenario, ScenarioOutcome } from "../scenario-kit.js";
import { errorKindOfRun } from "../recorder.js";
import type { ObservedRun } from "../oracle.js";

/** Handshake and the lease-free read plane: what every integrator does first. */
const S01: QaScenario = {
  id: "S01",
  title: "handshake, then the lease-free read plane",
  vein: "lifecycle over stdio",
  async run(museBin): Promise<ScenarioOutcome> {
    return await drivenOnce({
      museBin,
      label: "s01",
      async drive(host) {
        await host.request("list", "session/list", {});
        await host.request("models", "model/list", {});
      },
      observe: (run: ObservedRun) =>
        JSON.stringify(run.api.find((entry) => entry.kind === "exit")?.classification ?? null),
      expected: JSON.stringify({ kind: "cleanShutdown" }),
    });
  },
};

/**
 * The ephemeral profile withholds the durable-only methods. An integrator
 * meets that as a typed error, so this is the typed-error path through the
 * facade with a real host-produced error rather than a manufactured one.
 */
const S02: QaScenario = {
  id: "S02",
  title: "durable-only methods are withheld under `--no-session-log`",
  vein: "landed wire-command families through the facade",
  async run(museBin): Promise<ScenarioOutcome> {
    return await drivenOnce({
      museBin,
      label: "s02",
      serveArgs: ["--no-session-log"],
      async drive(host) {
        await host.request("read", "session/read", {
          sessionId: "00000000-0000-7000-8000-000000000000",
        });
      },
      observe: (run) => errorKindOfRun(run, "read") ?? "<no typed error>",
      expected: "methodNotFound",
    });
  },
};

/** Malformed params: the host's own validation, surfaced as a typed error. */
const S03: QaScenario = {
  id: "S03",
  title: "invalid params surface as a typed error, not a hang",
  vein: "landed wire-command families through the facade",
  async run(museBin): Promise<ScenarioOutcome> {
    return await drivenOnce({
      museBin,
      label: "s03",
      async drive(host) {
        // A relative workspaceRoot is rejected by the host: the SDK must carry
        // that refusal through as a typed error and settle the caller (FR-014).
        await host.command("badStart", "session/start", { workspaceRoot: "relative/path" });
      },
      observe: (run) => errorKindOfRun(run, "badStart") ?? "<no typed error>",
      expected: "invalidParams",
    });
  },
};

export const CONFORMANCE_SCENARIOS: readonly QaScenario[] = [S01, S02, S03];
