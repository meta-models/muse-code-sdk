/**
 * Recipe: classify every way `muse serve` can exit.
 *
 * The exit-classification guide gives the model: stderr is evidence a client
 * captures and never parses, and the exit code is the contract a client
 * branches on when the process dies before or instead of answering (tdd
 * SS2.11). This recipe makes that model executable. The SDK does the mapping
 * — `MuseServeChild.exit` resolves to an `ExitClassification` the moment the
 * host is gone — so what a client writes is one `switch` on `kind`.
 *
 * Four exits, each proven where it can be proven honestly:
 *
 *  - the SWITCHED-OFF SDK GATE (exit 5, `sdkSurfaceUnavailable`): the release
 *    binary, spawned with the gate env set to `off`. Since GA the built-in
 *    default is OPEN and the variable survives as the off-switch, so an
 *    absent variable serves; switched off, no argument is parsed and no host
 *    is constructed, so retrying — with any arguments — cannot help.
 *  - a SPAWN FAILURE is not an exit at all: a binary path that does not exist
 *    rejects `child.exit` instead of classifying, because a host that never
 *    ran has no exit to classify.
 *  - the CONFIGURATION row (exit 3, `configError`, retry `fix-config`):
 *    driven through `muse-conformance serve-fixture --exit-code 3`, the same
 *    way the SDK's own exit-table test reaches every row deterministically.
 *    Fixture plumbing, not client guidance — and deliberately not the release
 *    binary: a corrupt config file provokes exit 1 from today's `muse serve`,
 *    never 3 (the SS2.11 Configuration row has no producer yet, #25989).
 *  - the CLEAN STDIN-EOF DRAIN (exit 0, `cleanShutdown`): close stdin on a
 *    live host and the orderly drain ends it — the only row where the session
 *    was durably closed.
 *
 * Plus the one non-exit this recipe exists to keep separate: a FAILED TURN.
 * The logged-out host proves it live — its every turn fails with the pinned
 * not-logged-in terminal (spec 19535 FR-005) while the process neither exits
 * nor stops answering. And `isLaunchFailure` is the precision instrument on
 * that boundary: it reads a turn-level wire marker (`turn/completed`,
 * terminal `"failed"`, `error.kind: "launchError"` — tdd SS3.1.4), so it is
 * FALSE for the logged-out failure (a model error on a run that started,
 * `turn/started` observed) and true only for the deferred-start-failed
 * shape, which this recipe feeds it synthetically — the same
 * real-arm-plus-synthetic-arm pattern the fingerprint recipe uses.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MuseServeChild, isLaunchFailure, spawnMspConnection } from "@muse-code/sdk";
import type { ExitClassification, TurnOutcome } from "@muse-code/sdk";
import type { TurnCompletedParams } from "@muse-code/msp";

import {
  Host,
  SDK_GATE_ENV,
  TimeoutError,
  equals,
  objectAt,
  requireHost,
  stringAt,
  within,
} from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const EXIT_BUDGET_MS = 30_000;
const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

interface Context {
  readonly museBin: string;
  readonly conformanceBin: string;
  host?: Host;
  workspaceRoot?: string;
  sessionId?: string;
  failedTurn?: TurnOutcome;
}

/** The complete child environment every spawn here starts from. */
function baseEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    TBH_CREDENTIAL_BACKEND: "file",
    TBH_DISABLE_TELEMETRY: "1",
  };
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "gate-closed",
    title: "A host whose SDK gate is switched off answers exit 5 before parsing anything",
    async run(context) {
      // The one env difference from every healthy spawn in this cookbook:
      // the gate env explicitly "off". Since GA the built-in default is OPEN
      // and the variable survives as the off-switch, so an ABSENT variable
      // serves; a switched-off host answers exit 5 for every argument
      // vector — nothing was parsed, no host was constructed — so
      // `initialize` is never worth sending; the exit is the whole
      // conversation.
      const handshake = spawnMspConnection({
        command: context.museBin,
        args: ["serve"],
        env: {
          ...baseEnv(await mkdtemp(join(tmpdir(), "muse-cookbook-home-"))),
          [SDK_GATE_ENV]: "off",
        },
      });
      try {
        const classification = await within(
          "the gated host's exit",
          EXIT_BUDGET_MS,
          handshake.child.exit,
        );
        equals(classification.kind, "sdkSurfaceUnavailable", "the closed gate's classification");
        if (classification.kind !== "sdkSurfaceUnavailable") return;
        equals(classification.exitCode, 5, "the closed gate's exit code");
        // "never" means never: do not retry, and do not retry with different
        // arguments — no invocation of this binary will serve.
        equals(classification.retry, "never", "the closed gate's retry posture");
        // The evidence obligation: stderr is captured and surfaced, never
        // parsed. Its presence is asserted; its content is deliberately not.
        if (classification.stderrTail.length === 0) {
          throw new Error("a refused start must leave stderr evidence to surface");
        }
      } finally {
        // A fast no-op on the already-exited child; on the failure path —
        // the child unexpectedly still serving — it is what keeps a detached
        // process-group leader from outliving the run (PR #25993 review).
        await handshake.child.close().catch(() => undefined);
      }
    },
  },
  {
    id: "never-launched",
    title: "A binary that could not spawn rejects instead of classifying",
    async run() {
      // No process ran, so there is no exit to classify: `child.exit`
      // REJECTS with the spawn error. Branch on this separately from every
      // `ExitClassification` row — "the host never ran" and "the host ran
      // and died" have different remedies (a wrong path vs a host problem).
      const home = await mkdtemp(join(tmpdir(), "muse-cookbook-home-"));
      const handshake = spawnMspConnection({
        command: join(home, "no-such-muse-host"),
        env: baseEnv(home),
      });
      let classification: ExitClassification | undefined;
      try {
        classification = await within(
          "the failed spawn's settlement",
          EXIT_BUDGET_MS,
          handshake.child.exit,
        );
      } catch (error) {
        // Our own timeout is NOT the rejection this segment exists to see:
        // a `child.exit` that hangs on a failed spawn is a regression, not a
        // pass (PR #25993 review).
        if (error instanceof TimeoutError) throw error;
        // The SDK propagates the raw spawn error, so its `code` is the
        // contract a client branches on for "the binary is not there".
        const code = (error as { code?: unknown }).code;
        equals(code, "ENOENT", "the spawn rejection's error code");
        return;
      }
      throw new Error(
        `a host that never ran must not classify; got ${JSON.stringify(classification)}`,
      );
    },
  },
  {
    id: "config-error-row",
    title: "Exit 3 classifies as configError with the fix-config posture",
    async run(context) {
      // The canned host exits with exactly the code it is told to, which is
      // how the SDK's own exit-table test reaches every SS2.11 row
      // deterministically. Fixture plumbing, not client guidance — today's
      // release binary cannot be provoked into exit 3 (#25989), and the row's
      // meaning is the contract this segment pins: the host started, the
      // configuration is unusable, retrying without fixing it cannot help.
      const child = MuseServeChild.spawn({
        museBin: context.conformanceBin,
        args: ["serve-fixture", "--exit-code", "3", "--stderr-lines", "3"],
        env: baseEnv(await mkdtemp(join(tmpdir(), "muse-cookbook-home-"))),
      });
      try {
        const classification = await within(
          "the fixture host's exit",
          EXIT_BUDGET_MS,
          child.exit,
        );
        equals(classification.kind, "configError", "exit 3's classification");
        if (classification.kind !== "configError") return;
        equals(classification.exitCode, 3, "the configuration row's exit code");
        equals(classification.retry, "fix-config", "the configuration row's retry posture");
        if (classification.stderrTail.length === 0) {
          throw new Error("the configuration row must carry stderr naming what to fix");
        }
      } finally {
        await child.close().catch(() => undefined);
      }
    },
  },
  {
    id: "spawn-live-host",
    title: "Spawn the release-built host, logged out on purpose",
    async run(context) {
      // An isolated HOME with no credentials: the host composes its
      // logged-out fallback and keeps serving. That is the point — the next
      // segment needs a host whose turns fail while the process lives.
      context.workspaceRoot = await mkdtemp(join(tmpdir(), "muse-cookbook-ws-"));
      context.host = await Host.start(
        {
          museBin: context.museBin,
          home: await mkdtemp(join(tmpdir(), "muse-cookbook-home-")),
          workspaceRoot: context.workspaceRoot,
          clientInfo: { name: "muse_sdk_cookbook", version: "0.0.0" },
        },
        HANDSHAKE_BUDGET_MS,
      );
      const host = requireHost(context);
      const result = await host.msp.connection.command("session/start", {
        workspaceRoot: context.workspaceRoot,
      });
      const session = objectAt(result, "session", "session/start result");
      context.sessionId = stringAt(session, "sessionId", "session/start session");
    },
  },
  {
    id: "failed-turn-is-not-an-exit",
    title: "A failed turn is a wire event; the host that delivered it is still serving",
    async run(context) {
      const host = requireHost(context);
      const sessionId = context.sessionId;
      if (sessionId === undefined) throw new Error("`spawn-live-host` did not finish");
      const ack = await host.msp.connection.command("turn/start", {
        sessionId,
        input: [{ type: "text", text: "say hello" }],
      });
      equals(ack["status"], "accepted", "turn/start ack status");
      const turnId = stringAt(ack, "turnId", "turn/start ack");
      const completed = await host.waitFor(
        "the turn/completed notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" && notification.params["turnId"] === turnId,
      );
      equals(completed.params["terminal"], "failed", "the logged-out turn's terminal");
      // A facade consumer gets a `TurnOutcome` from its turn waiter; this
      // connection-level recipe builds the same shape from the notification
      // it just received, `observedStart` computed the way the fold does —
      // did THIS session see a turn/started for this turn?
      const outcome: TurnOutcome = {
        kind: "completed",
        params: completed.params as unknown as TurnCompletedParams,
        observedStart: host
          .notifications()
          .some(
            (notification) =>
              notification.method === "turn/started" && notification.params["turnId"] === turnId,
          ),
      };
      // Not every failed turn is a launch failure. The logged-out turn's run
      // STARTED and then could not reach a model, so its error kind is
      // "modelError" and `isLaunchFailure` says no — branch on the marker,
      // never on `terminal === "failed"` alone. The started-ness is asserted,
      // not assumed: it is the sentence the docs page teaches (PR #25993
      // review).
      equals(outcome.observedStart, true, "turn/started observed for the logged-out turn");
      equals(isLaunchFailure(outcome), false, "isLaunchFailure on a model-error terminal");
      const error = objectAt(completed.params, "error", "turn/completed params");
      equals(error["kind"], "modelError", "the logged-out failure's error kind");
      context.failedTurn = outcome;
      // ...and none of it is a host exit: the same process answers the very
      // next request. THIS is the distinction the recipe exists to teach —
      // a turn terminal classifies one turn on a live wire;
      // `ExitClassification` classifies the death of the process itself.
      const read = await within(
        "session/read on the host that just failed a turn",
        COMMAND_BUDGET_MS,
        host.msp.connection.request("session/read", { sessionId, excludeItems: true }),
      );
      const session = objectAt(read, "session", "session/read result");
      equals(session["sessionId"], sessionId, "the live host still reads its session");
    },
  },
  {
    id: "launch-failure-is-a-turn-marker",
    title: "isLaunchFailure reads the launch-boundary wire shape, never a process exit",
    async run(context) {
      const failed = context.failedTurn;
      if (failed === undefined || failed.kind !== "completed") {
        throw new Error("`failed-turn-is-not-an-exit` did not finish");
      }
      // The deferred-start-failed shape (tdd SS3.1.4): the same failed
      // terminal, had the turn died at the LAUNCH boundary instead — error
      // kind "launchError", written by the runtime with no turn/started ever
      // emitted. Synthetic on purpose: a headless recipe cannot make a real
      // host fail a launch on demand, and the helper's contract is exactly
      // this wire shape, so feeding it that shape is the honest proof — the
      // same way the fingerprint recipe feeds `checkServedFingerprint` a
      // newer host's fingerprint.
      const launchShape: TurnOutcome = {
        kind: "completed",
        params: {
          ...failed.params,
          error: { kind: "launchError", message: "synthetic launch failure", retryable: true },
        } as unknown as TurnCompletedParams,
        observedStart: false,
      };
      equals(isLaunchFailure(launchShape), true, "isLaunchFailure on the launch-error shape");
    },
  },
  {
    id: "clean-drain",
    title: "Close stdin and the orderly drain ends in the one durably-closed row",
    async run(context) {
      const host = requireHost(context);
      const exit = await host.close(CLOSE_BUDGET_MS);
      equals(exit.code, 0, "the host's exit code after stdin EOF");
      equals(exit.signal, null, "the host's exit signal after stdin EOF");
      const classification = await host.msp.child.exit;
      equals(classification.kind, "cleanShutdown", "the orderly drain's classification");
      context.host = undefined;
    },
  },
];

export const classifyServeExits: Recipe = {
  id: "classify-serve-exits",
  title: "Classify every way muse serve can exit",
  docsPage: "developer-docs/src/content/docs/cookbook/classify-every-serve-exit.mdx",
  needs: ["museBin", "conformanceBin"],
  async run(hosts: RecipeHosts): Promise<JourneyReport> {
    const museBin = hosts.museBin;
    const conformanceBin = hosts.conformanceBin;
    if (museBin === undefined) throw new Error("museBin is required");
    if (conformanceBin === undefined) throw new Error("conformanceBin is required");
    const context: Context = { museBin, conformanceBin };
    return await runJourney(SEGMENTS, context, async (owned) => {
      await owned.host?.abandon(CLOSE_BUDGET_MS);
    });
  },
};
