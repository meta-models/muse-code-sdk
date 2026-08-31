/**
 * Recipe: cancel a turn while it is running.
 *
 * Runs against `muse-conformance serve-fixture` playing the committed golden
 * transcript `schema/msp/transcripts/cancel-mid-turn` — the canned stdio host,
 * so this recipe is deterministic and needs no credentials and no model.
 *
 * What it teaches (and what the docs page walks through):
 *  - `turn/cancel` is a REQUEST, not an outcome. The ack says the host will
 *    try; the turn is over only when `turn/completed` arrives with the
 *    terminal `"cancelled"`.
 *  - a cancelled turn keeps a balanced history: the in-flight toolCall item
 *    is completed as `"cancelled"`, never dropped.
 *
 * Fixture mechanics, so the code below reads honestly: serve-fixture matches
 * our frames structurally against the transcript's client lines and then
 * replays the recorded server lines byte-exactly. Our request ids unify (the
 * SDK's default minting starts at 1, where the transcript starts), but acks
 * echo the RECORDED commandId — and `Connection.command` verifies that echo —
 * so each command below passes the transcript's commandId explicitly. Values
 * we learn from the wire (sessionId, turnId) are used as received, exactly as
 * a real client uses them.
 */

import { Host, equals, objectAt, requireHost, stringAt } from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

/** The transcript's own client-side values; see the module comment. */
const WORKSPACE_ROOT = "/home/me/src/proj";
const PROMPT = "Run the flaky integration suite";
const SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1";
const TURN_START_COMMAND_ID = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10";
const TURN_CANCEL_COMMAND_ID = "018f6a21-0f0f-7aaa-bbbb-0123456789ab";

interface Context {
  readonly conformanceBin: string;
  readonly transcript: string;
  host?: Host;
  sessionId?: string;
  turnId?: string;
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "spawn-fixture",
    title: "Spawn the canned host playing the cancel-mid-turn transcript",
    async run(context) {
      context.host = await Host.spawn(
        {
          command: context.conformanceBin,
          args: ["serve-fixture", "--transcript", context.transcript],
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          clientInfo: { name: "conformance", version: "0.0.0" },
        },
        HANDSHAKE_BUDGET_MS,
      );
    },
  },
  {
    id: "session",
    title: "Start the session the turn will run in",
    async run(context) {
      const host = requireHost(context);
      const result = await host.msp.connection.command(
        "session/start",
        { workspaceRoot: WORKSPACE_ROOT },
        { maxAttempts: 1, commandId: SESSION_START_COMMAND_ID },
      );
      const session = objectAt(result, "session", "session/start result");
      equals(session["status"], "idle", "a fresh session's status");
      context.sessionId = stringAt(session, "sessionId", "session/start session");
    },
  },
  {
    id: "turn-start",
    title: "Start a turn and watch its work stream in",
    async run(context) {
      const host = requireHost(context);
      const sessionId = context.sessionId;
      if (sessionId === undefined) throw new Error("`session` did not finish");
      const ack = await host.msp.connection.command(
        "turn/start",
        { sessionId, input: [{ type: "text", text: PROMPT }] },
        { maxAttempts: 1, commandId: TURN_START_COMMAND_ID },
      );
      equals(ack["status"], "accepted", "turn/start ack status");
      equals(ack["disposition"], "started", "turn/start ack disposition");
      const turnId = stringAt(ack, "turnId", "turn/start ack");
      await host.waitFor(
        "the turn/started notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/started" && notification.params["turnId"] === turnId,
      );
      // The turn is genuinely mid-work when output is still streaming: the
      // fixture's toolCall item is emitting `item/delta` frames.
      await host.waitFor(
        "a streamed item/delta while the turn runs",
        COMMAND_BUDGET_MS,
        (notification) => notification.method === "item/delta",
      );
      context.turnId = turnId;
    },
  },
  {
    id: "cancel",
    title: "Ask for the cancel, then wait for the turn's own terminal",
    async run(context) {
      const host = requireHost(context);
      const sessionId = context.sessionId;
      const turnId = context.turnId;
      if (sessionId === undefined || turnId === undefined) {
        throw new Error("`turn-start` did not finish");
      }
      const ack = await host.msp.connection.command(
        "turn/cancel",
        { sessionId, turnId },
        { maxAttempts: 1, commandId: TURN_CANCEL_COMMAND_ID },
      );
      equals(ack["status"], "accepted", "turn/cancel ack status");
      // The ack is a promise to try, not the outcome. The outcome is the
      // turn's terminal.
      const completed = await host.waitFor(
        "the cancelled turn/completed notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" && notification.params["turnId"] === turnId,
      );
      equals(completed.params["terminal"], "cancelled", "the turn's terminal");
      // Balanced history: the in-flight toolCall was completed as cancelled,
      // not dropped on the floor.
      const cancelledItem = host.notifications().find(
        (notification) =>
          notification.method === "item/completed" &&
          (notification.params["item"] as Record<string, unknown> | undefined)?.["status"] ===
            "cancelled",
      );
      if (cancelledItem === undefined) {
        throw new Error("the cancelled turn left no item/completed with status \"cancelled\"");
      }
    },
  },
  {
    id: "drain",
    title: "Close stdin and let the fixture host exit cleanly",
    async run(context) {
      const host = requireHost(context);
      const exit = await host.close(CLOSE_BUDGET_MS);
      equals(exit.code, 0, "the fixture host's exit code after stdin EOF");
      context.host = undefined;
    },
  },
];

export const cancelMidTurn: Recipe = {
  id: "cancel-mid-turn",
  title: "Cancel a turn while it is running",
  docsPage: "developer-docs/src/content/docs/cookbook/cancel-a-running-turn.mdx",
  needs: ["conformanceBin"],
  async run(hosts: RecipeHosts): Promise<JourneyReport> {
    const conformanceBin = hosts.conformanceBin;
    if (conformanceBin === undefined) throw new Error("conformanceBin is required");
    const context: Context = {
      conformanceBin,
      transcript: `${hosts.transcriptRoot}/cancel-mid-turn`,
    };
    return await runJourney(SEGMENTS, context, async (owned) => {
      await owned.host?.abandon(CLOSE_BUDGET_MS);
    });
  },
};
