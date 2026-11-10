/**
 * Recipe: cancel a turn while it is running.
 *
 * Runs against `muse-conformance serve-fixture` playing the committed golden
 * transcript `schema/msp/transcripts/cancel-mid-turn` — the canned stdio host,
 * so this recipe is deterministic and needs no credentials and no model.
 *
 * What it teaches (and what the docs page walks through):
 *  - `turn.cancel()` is a REQUEST, not an outcome. Its ack says the host will
 *    try; the turn is over only when `turn.completed` settles with the
 *    terminal `"cancelled"`.
 *  - a cancelled turn keeps a balanced history: the in-flight toolCall item
 *    is completed as `"cancelled"`, never dropped.
 *
 * Fixture mechanics, so the code below reads honestly: serve-fixture matches
 * our frames structurally against the transcript's client lines and then
 * replays the recorded server lines byte-exactly. Request ids unify, but acks
 * echo the RECORDED commandId — and the SDK verifies that echo — so the
 * connection's one commandId minter is scripted with the transcript's ids in
 * send order. Everything else goes through the `MuseClient` facade, and the
 * values we learn from the wire (sessionId, turnId) are used as received.
 */

import { MuseClient, readSessionDurability, spawnMspConnection } from "@muse-code/sdk";
import type { FoldedItem, Session, Turn } from "@muse-code/sdk";

import { HOST_DRAIN_WINDOW_MS, drainQuietly, equals, within } from "../kit/host.js";
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
  client?: MuseClient;
  session?: Session;
  turn?: Turn;
  /** The toolCall that was running when we asked for the cancel. */
  toolCallId?: string;
}

/**
 * Hand out the transcript's commandIds in send order. Harness-only: a real
 * client keeps the SDK's default minter, which is what makes ids unique.
 */
function scriptedCommandIds(ids: readonly string[]): () => string {
  const queue = [...ids];
  return () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("the recipe sent more commands than the transcript records");
    return next;
  };
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "spawn-fixture",
    title: "Spawn the canned host playing the cancel-mid-turn transcript",
    async run(context) {
      const stderr: string[] = [];
      // Built by hand rather than with `MuseClient.spawn`: spawn asks for an
      // extra capability the recorded `initialize` line does not carry.
      const handshake = spawnMspConnection({
        command: context.conformanceBin,
        args: ["serve-fixture", "--transcript", context.transcript],
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        shutdownTimeoutMs: HOST_DRAIN_WINDOW_MS,
        onStderr: (chunk) => stderr.push(chunk),
        connection: {
          mintCommandId: scriptedCommandIds([
            SESSION_START_COMMAND_ID,
            TURN_START_COMMAND_ID,
            TURN_CANCEL_COMMAND_ID,
          ]),
        },
      });
      let spawned;
      try {
        spawned = await within(
          "the MSP handshake",
          HANDSHAKE_BUDGET_MS,
          handshake.initialize({ clientInfo: { name: "conformance", version: "0.0.0" } }),
        );
      } catch (error) {
        await drainQuietly("the fixture host", CLOSE_BUDGET_MS, () => handshake.close());
        throw new Error(`handshake failed; stderr: ${stderr.join("")}`, { cause: error });
      }
      context.client = new MuseClient(spawned.connection, {
        durability: readSessionDurability(spawned.initializeResult),
        host: spawned,
      });
    },
  },
  {
    id: "session",
    title: "Start the session the turn will run in",
    async run(context) {
      const client = context.client;
      if (client === undefined) throw new Error("`spawn-fixture` did not finish");
      const session = await within(
        "the session/start result",
        COMMAND_BUDGET_MS,
        client.startSession({ workspaceRoot: WORKSPACE_ROOT }),
      );
      equals(session.opening?.verb, "session/start", "how the session was opened");
      if (session.opening?.verb === "session/start") {
        equals(session.opening.result.session.status, "idle", "a fresh session's status");
      }
      context.session = session;
    },
  },
  {
    id: "turn-start",
    title: "Start a turn and watch its work stream in",
    async run(context) {
      const session = context.session;
      if (session === undefined) throw new Error("`session` did not finish");
      const turn = await within(
        "the turn/start ack",
        COMMAND_BUDGET_MS,
        session.sendUserTurn({ input: [{ type: "text", text: PROMPT }] }),
      );
      // `items()` replays what the fold already holds, then tails, so a fast
      // host cannot slip the running tool call past us.
      const toolCall = await within(
        "a running toolCall item",
        COMMAND_BUDGET_MS,
        firstRunningToolCall(turn),
      );
      // The turn is genuinely mid-work when output is still streaming. Open the
      // live feed and read the fold in the same tick: the first chunk is in one.
      const live = turn.deltas();
      try {
        const output =
          session.fold.items.accumulated(toolCall.itemId, "output") ??
          (await within("a streamed output chunk", COMMAND_BUDGET_MS, live.next())).value?.delta;
        if (output === undefined || output.length === 0) {
          throw new Error("the running toolCall streamed no output");
        }
      } finally {
        await live.return?.();
      }
      context.turn = turn;
      context.toolCallId = toolCall.itemId;
    },
  },
  {
    id: "cancel",
    title: "Ask for the cancel, then wait for the turn's own terminal",
    async run(context) {
      const session = context.session;
      const turn = context.turn;
      const toolCallId = context.toolCallId;
      if (session === undefined || turn === undefined || toolCallId === undefined) {
        throw new Error("`turn-start` did not finish");
      }
      const ack = await within("the turn/cancel ack", COMMAND_BUDGET_MS, turn.cancel());
      equals(ack.status, "accepted", "turn/cancel ack status");
      // The ack is a promise to try, not the outcome. The outcome is the
      // turn's terminal.
      const outcome = await within("the cancelled turn's outcome", COMMAND_BUDGET_MS, turn.completed);
      if (outcome.kind !== "completed") {
        throw new Error(`the cancelled turn should complete; got ${JSON.stringify(outcome)}`);
      }
      equals(outcome.params.terminal, "cancelled", "the turn's terminal");
      // Balanced history: the in-flight toolCall was completed as cancelled,
      // not dropped on the floor.
      equals(session.fold.items.get(toolCallId)?.status, "cancelled", "the toolCall's final status");
    },
  },
  {
    id: "drain",
    title: "Close stdin and let the fixture host exit cleanly",
    async run(context) {
      const client = context.client;
      if (client === undefined) throw new Error("`spawn-fixture` did not finish");
      await within("the fixture host's orderly drain and exit", CLOSE_BUDGET_MS, client.close());
      equals((await client.exit).kind, "cleanShutdown", "the fixture host's exit classification");
      context.client = undefined;
    },
  },
];

async function firstRunningToolCall(turn: Turn): Promise<FoldedItem> {
  for await (const item of turn.items()) {
    if (item.kind === "toolCall" && item.status === "inProgress") return item;
  }
  throw new Error("the turn ended without a running toolCall");
}

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
      const client = owned.client;
      if (client !== undefined) {
        await drainQuietly("the fixture host", CLOSE_BUDGET_MS, () => client.close());
      }
    });
  },
};
