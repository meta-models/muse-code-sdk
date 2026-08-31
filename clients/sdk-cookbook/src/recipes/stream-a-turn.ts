/**
 * Recipe: stream a turn's answer into a UI.
 *
 * Runs against `muse-conformance serve-fixture` playing the committed golden
 * transcript `schema/msp/transcripts/text-run-single-turn` — the canned stdio
 * host, so this recipe is deterministic and needs no credentials and no model.
 *
 * What it teaches (and what the docs page walks through):
 *  - `item/delta` frames are the LIVE text: append each one to what you have
 *    already drawn, keyed by `itemId`, and your UI fills in as the agent
 *    speaks.
 *  - `item/completed` is AUTHORITATIVE: its `item.text` is the whole answer.
 *    Replace what you accumulated with it rather than trusting your own
 *    concatenation — this recipe asserts the two agree, which is exactly the
 *    invariant a UI is relying on when it does the cheap thing.
 *  - the turn is over on `turn/completed`, not on the last delta. That frame
 *    carries the terminal and the usage a UI shows when the answer settles.
 *
 * Fixture mechanics, so the code below reads honestly: serve-fixture matches
 * our frames structurally against the transcript's client lines and then
 * replays the recorded server lines byte-exactly. Our request ids unify, but
 * acks echo the RECORDED commandId — and `Connection.command` verifies that
 * echo — so each command below passes the transcript's commandId explicitly.
 * Values we learn from the wire (sessionId, turnId, itemId) are used as
 * received, exactly as a real client uses them.
 */

import { Host, equals, objectAt, requireHost, stringAt } from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { RecordedNotification } from "../kit/host.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

/** The transcript's own client-side values; see the module comment. */
const WORKSPACE_ROOT = "/home/me/src/proj";
const PROMPT = "Run the agent test suite and summarize failures";
const SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1";
const TURN_START_COMMAND_ID = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10";

interface Context {
  readonly conformanceBin: string;
  readonly transcript: string;
  host?: Host;
  sessionId?: string;
  turnId?: string;
  itemId?: string;
}

/**
 * The delta text for one item, in arrival order — the accumulation a UI does
 * as the frames land — plus how many frames went into it. `field` is checked
 * because a delta names WHICH member of the item it extends; appending a
 * non-text delta to a text buffer is the quiet way to corrupt the rendered
 * answer.
 *
 * `pieces` is reported here rather than recounted by the caller so the
 * streaming floor counts exactly the frames this consumed, by construction.
 * The two used to be separate copies of this predicate and had already
 * drifted once — the floor briefly counted non-text deltas, which would have
 * let a single-piece answer clear a floor of two (PR #25153 review).
 */
function accumulate(
  notifications: readonly RecordedNotification[],
  itemId: string,
): { readonly text: string; readonly pieces: number } {
  let text = "";
  let pieces = 0;
  for (const notification of notifications) {
    if (notification.method !== "item/delta") continue;
    if (notification.params["itemId"] !== itemId) continue;
    if (notification.params["field"] !== "text") continue;
    const delta = notification.params["delta"];
    if (typeof delta !== "string") {
      throw new Error(`an item/delta for ${itemId} carried a non-string delta: ${JSON.stringify(delta)}`);
    }
    text += delta;
    pieces += 1;
  }
  return { text, pieces };
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "spawn-fixture",
    title: "Spawn the canned host playing the text-run-single-turn transcript",
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
    title: "Send the prompt and take the turn id off the ack",
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
      equals(ack["startedNewTurn"], true, "turn/start ack startedNewTurn");
      context.turnId = stringAt(ack, "turnId", "turn/start ack");
      await host.waitFor(
        "the turn/started notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/started" && notification.params["sessionId"] === sessionId,
      );
    },
  },
  {
    id: "answer-begins",
    title: "Catch the agent's message opening, empty, before any text arrives",
    async run(context) {
      const host = requireHost(context);
      const turnId = context.turnId;
      if (turnId === undefined) throw new Error("`turn-start` did not finish");
      // A UI creates its message bubble HERE — on item/started — so the very
      // first delta has somewhere to land. The opening frame carries the
      // itemId every later delta is keyed by.
      const started = await host.waitFor(
        "the agentMessage item/started notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "item/started" &&
          (notification.params["item"] as Record<string, unknown> | undefined)?.["kind"] ===
            "agentMessage",
      );
      const item = objectAt(started.params, "item", "item/started params");
      equals(item["turnId"], turnId, "the agent message's turn id");
      equals(item["status"], "inProgress", "the agent message's status while it streams");
      equals(item["text"], "", "the agent message's text before any delta");
      context.itemId = stringAt(item, "itemId", "item/started item");
    },
  },
  {
    id: "stream-and-settle",
    title: "Accumulate the deltas, then let item/completed have the last word",
    async run(context) {
      const host = requireHost(context);
      const itemId = context.itemId;
      if (itemId === undefined) throw new Error("`answer-begins` did not finish");
      const completed = await host.waitFor(
        "the agent message's item/completed notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "item/completed" &&
          (notification.params["item"] as Record<string, unknown> | undefined)?.["itemId"] ===
            itemId,
      );
      const item = objectAt(completed.params, "item", "item/completed params");
      equals(item["status"], "completed", "the finished agent message's status");
      const authoritative = stringAt(item, "text", "item/completed item");

      // The streaming assertion, and the reason a UI may draw deltas at all:
      // what arrived in pieces reassembles to exactly what the authoritative
      // frame carries. If these ever disagree, a UI that trusts its own
      // concatenation is showing the user something the host never said.
      const streamed = accumulate(host.notifications(), itemId);
      equals(streamed.text, authoritative, "the accumulated deltas vs the authoritative text");

      // ...and it genuinely STREAMED: one delta carrying the whole answer
      // would satisfy the equality above while proving nothing about the
      // incremental path this recipe exists to teach.
      // The count comes from the accumulation itself, so it counts exactly
      // the frames that were summed and cannot drift from them.
      if (streamed.pieces < 2) {
        throw new Error(
          `the answer arrived in ${String(streamed.pieces)} delta(s); this recipe needs a genuinely incremental stream`,
        );
      }
    },
  },
  {
    id: "turn-terminal",
    title: "Wait for the turn's own terminal, not the last delta",
    async run(context) {
      const host = requireHost(context);
      const turnId = context.turnId;
      if (turnId === undefined) throw new Error("`turn-start` did not finish");
      const completed = await host.waitFor(
        "the turn/completed notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" && notification.params["turnId"] === turnId,
      );
      equals(completed.params["terminal"], "completed", "the turn's terminal");
      // The settle frame is also where a UI reads what the turn cost.
      const usage = objectAt(completed.params, "usage", "turn/completed params");
      if (typeof usage["inputTokens"] !== "number" || typeof usage["outputTokens"] !== "number") {
        throw new Error(`turn/completed usage lacks numeric token counts: ${JSON.stringify(usage)}`);
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

export const streamATurn: Recipe = {
  id: "stream-a-turn",
  title: "Stream a turn's answer into a UI",
  docsPage: "developer-docs/src/content/docs/cookbook/stream-a-turns-answer.mdx",
  needs: ["conformanceBin"],
  async run(hosts: RecipeHosts): Promise<JourneyReport> {
    const conformanceBin = hosts.conformanceBin;
    if (conformanceBin === undefined) throw new Error("conformanceBin is required");
    const context: Context = {
      conformanceBin,
      transcript: `${hosts.transcriptRoot}/text-run-single-turn`,
    };
    return await runJourney(SEGMENTS, context, async (owned) => {
      await owned.host?.abandon(CLOSE_BUDGET_MS);
    });
  },
};
