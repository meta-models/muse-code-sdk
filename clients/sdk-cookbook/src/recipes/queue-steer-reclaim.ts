/**
 * Recipe: queue, steer, and reclaim turns — the multi-turn traffic rules
 * every chat-style UI eventually hits.
 *
 * Runs against `muse-conformance serve-fixture` playing the committed golden
 * transcript `schema/msp/transcripts/turn-unqueued-round-trip`, so this recipe
 * is deterministic and needs no credentials and no model.
 *
 * What it teaches (and what the docs page walks through):
 *  - a submit gets one of three dispositions, and that word is the whole
 *    routing decision: `"started"` (a fresh foreground turn began), `"queued"`
 *    (input parked; the turn handle names the PRE-MINTED turn that will carry
 *    it), or `"steered"` (absorbed by the running turn). `session.pending`
 *    shows it: a queued submit stays there, acked `"queued"`, until the wire
 *    says launched, rejected, or reclaimed.
 *  - a queued submit can be taken back before it launches: `turn.unqueue()`
 *    on the handle the queued submit returned. The accepted reclaim retires
 *    the pending entry as `kind: "reclaimed"` with `restoreToComposer: true`
 *    and the original input attached — the "un-send" hands the text back to
 *    the composer instead of losing it — and the pre-minted turn's
 *    `turn.completed` settles as `kind: "unqueued"`. No `turn/completed` will
 *    ever carry a reclaimed turnId, so a wait folding only `turn/completed`
 *    hangs forever. `unqueue()` returns that retirement whichever of the ack
 *    and `turn/unqueued` the client reads first.
 *  - the reclaim is surgical: the ACTIVE turn is untouched and runs to its own
 *    `completed` terminal.
 *
 * Steering is taught on the page (the third disposition and `turn.steer`) but
 * not exercised here: no committed transcript records a steered submit,
 * because what a steer absorbs depends on a live model's timing. The ratified
 * validation for this recipe names an opt-in-live arm for real steering; that
 * arm is tracked on #24225 alongside recipe 1's.
 *
 * Fixture mechanics, so the code below reads honestly: serve-fixture matches
 * our frames structurally against the transcript's client lines and replays
 * the recorded server lines, answering each request under the client's own
 * request id. Acks echo the RECORDED commandId — and the SDK verifies that
 * echo — so the connection's one commandId minter is scripted with the
 * transcript's ids in send order. Everything else goes through `MuseClient`.
 */

import { MuseClient, readSessionDurability, spawnMspConnection } from "@muse-code/sdk";
import type { PendingCommandEntry, PendingRetirement, Session, Turn } from "@muse-code/sdk";

import { HOST_DRAIN_WINDOW_MS, drainQuietly, equals, within } from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

const SCENARIO = "turn-unqueued-round-trip";

/** The transcript's own client-side values; see the module comment. */
const WORKSPACE_ROOT = "/home/me/src/proj";
const ACTIVE_PROMPT = "Review the current deployment state";
const QUEUED_PROMPT = "Run the queued deployment checks";
const SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1";
const ACTIVE_TURN_COMMAND_ID = "018f6a32-1111-7000-8000-0000000000a1";
const QUEUED_TURN_COMMAND_ID = "018f6a32-3333-7000-8000-0000000000c3";
const UNQUEUE_COMMAND_ID = "018f6a32-5555-7000-8000-0000000000c5";

interface Context {
  readonly conformanceBin: string;
  readonly transcriptRoot: string;
  client?: MuseClient;
  session?: Session;
  active?: Turn;
  queued?: Turn;
  /** The queued submit's pending entry, as `session.pending` showed it. */
  queuedEntry?: PendingCommandEntry<unknown>;
  /** What `turn.unqueue()` returned, set once the reclaim was accepted. */
  unqueued?: { readonly retirement: PendingRetirement<unknown> | undefined };
}

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not known: an earlier segment did not finish`);
  return value;
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
    id: "spawn",
    title: `Spawn the canned host playing the ${SCENARIO} transcript`,
    async run(context) {
      const stderr: string[] = [];
      // Built by hand rather than with `MuseClient.spawn`: spawn asks for an
      // extra capability the recorded `initialize` line does not carry.
      const handshake = spawnMspConnection({
        command: context.conformanceBin,
        args: ["serve-fixture", "--transcript", `${context.transcriptRoot}/${SCENARIO}`],
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        shutdownTimeoutMs: HOST_DRAIN_WINDOW_MS,
        onStderr: (chunk) => stderr.push(chunk),
        connection: {
          mintCommandId: scriptedCommandIds([
            SESSION_START_COMMAND_ID,
            ACTIVE_TURN_COMMAND_ID,
            QUEUED_TURN_COMMAND_ID,
            UNQUEUE_COMMAND_ID,
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
      // Durability comes off the handshake: it decides what happens to pending
      // commands if the host dies.
      const durability = readSessionDurability(spawned.initializeResult);
      equals(durability.kind, "durable", "the handshake's session durability");
      context.client = new MuseClient(spawned.connection, { durability, host: spawned });
    },
  },
  {
    id: "session",
    title: "Start the session through the client",
    async run(context) {
      const client = required(context.client, "the client");
      context.session = await within(
        "the session/start result",
        COMMAND_BUDGET_MS,
        client.startSession({ workspaceRoot: WORKSPACE_ROOT }),
      );
    },
  },
  {
    id: "start-active",
    title: 'Submit while idle: disposition "started", entry retires as materialized',
    async run(context) {
      const session = required(context.session, "the session");
      // `composerInput` is what a retirement hands back; the SDK records the
      // pending entry before it writes the wire, so a UI can render it at once.
      const active = await within(
        "the turn/start ack",
        COMMAND_BUDGET_MS,
        session.sendUserTurn({
          input: [{ type: "text", text: ACTIVE_PROMPT }],
          composerInput: ACTIVE_PROMPT,
        }),
      );
      // The userMessage carrying our commandId folding in is what retires the
      // entry: the optimistic echo is replaced by the durable item.
      const userMessage = await within(
        "the active turn's userMessage item",
        COMMAND_BUDGET_MS,
        firstItemOfKind(active, "userMessage"),
      );
      equals(userMessage.commandId, ACTIVE_TURN_COMMAND_ID, "the userMessage's commandId");
      equals(session.pending.size, 0, "pending entries once the started submit materialized");
      equals(active.observedStart, true, "the started submit's turn began");
      context.active = active;
    },
  },
  {
    id: "queue",
    title: 'Submit while busy: disposition "queued", the ack pre-mints the turn',
    async run(context) {
      const session = required(context.session, "the session");
      const queued = await within(
        "the queued submit's ack",
        COMMAND_BUDGET_MS,
        session.sendUserTurn({
          input: [{ type: "text", text: QUEUED_PROMPT }],
          ifBusy: "queue",
          composerInput: QUEUED_PROMPT,
        }),
      );
      // The handle names a turn that does not run yet. Nothing has settled
      // the entry, so it stays pending — exactly what a UI renders as
      // "queued, not yet running" — until the wire says launched, rejected,
      // or reclaimed.
      const entry = session.pending.list().find((held) => held.ack?.turnId === queued.turnId);
      if (entry === undefined) throw new Error("the queued submit left no pending entry");
      equals(entry.ack?.disposition, "queued", "the busy submit's disposition");
      equals(entry.input, QUEUED_PROMPT, "the queued entry's composer input");
      equals(queued.observedStart, false, "queued input starts no turn yet");
      context.queued = queued;
      context.queuedEntry = entry;
    },
  },
  {
    id: "reclaim",
    title: "Reclaim the queued turn: unqueue, entry back to the composer",
    async run(context) {
      const session = required(context.session, "the session");
      const queued = required(context.queued, "the queued turn");
      const entry = required(context.queuedEntry, "the queued entry");
      const { ack, retirement } = await within("the turn/unqueue ack", COMMAND_BUDGET_MS, queued.unqueue());
      equals(ack.status, "accepted", "turn/unqueue ack status");
      equals(ack.turnId, queued.turnId, "the turnId the unqueue ack echoes");
      equals(session.pending.has(entry.commandId), false, "the reclaimed entry is gone");
      // The next segment asserts what came back; keep it for that step.
      context.unqueued = { retirement };

      // The pre-minted turn's outcome is `unqueued` — its own terminal kind.
      // No turn/completed will ever carry this turnId, so a wait folding only
      // turn/completed would hang forever.
      const outcome = await within("the reclaimed turn's outcome", COMMAND_BUDGET_MS, queued.completed);
      if (outcome.kind !== "unqueued") {
        throw new Error(`the reclaimed turn should settle unqueued; got ${JSON.stringify(outcome)}`);
      }
      // turn/unqueued names the turn/start that QUEUED the turn — the entry
      // it retires — not the unqueue command that reclaimed it.
      equals(outcome.params.commandId, entry.commandId, "turn/unqueued's commandId");
    },
  },
  {
    id: "reclaim-returns-the-draft",
    title: "The accepted unqueue hands the draft back to the composer",
    async run(context) {
      const { retirement } = required(context.unqueued, "the unqueue result");
      if (retirement === undefined) {
        throw new Error("unqueue() returned no retirement for the accepted reclaim");
      }
      // The whole point of the gesture: the input comes BACK. A client that
      // drops it here has turned "un-send" into "delete my draft".
      if (retirement.kind !== "reclaimed") {
        throw new Error(`the reclaim should retire the entry as reclaimed; got ${JSON.stringify(retirement)}`);
      }
      equals(retirement.restoreToComposer, true, "the reclaim restores to the composer");
      equals(retirement.input, QUEUED_PROMPT, "the input handed back to the composer");
    },
  },
  {
    id: "active-untouched",
    title: "The active turn never noticed: it runs to its own completed terminal",
    async run(context) {
      const active = required(context.active, "the active turn");
      const outcome = await within("the active turn's outcome", COMMAND_BUDGET_MS, active.completed);
      if (outcome.kind !== "completed") {
        throw new Error(`the active turn should complete; got ${JSON.stringify(outcome)}`);
      }
      equals(outcome.params.terminal, "completed", "the active turn's terminal");
      equals(outcome.observedStart, true, "this session observed the active turn start");
    },
  },
  {
    id: "drain",
    title: "Close stdin and let the fixture host exit cleanly",
    async run(context) {
      const client = required(context.client, "the client");
      await within("the fixture host's orderly drain and exit", CLOSE_BUDGET_MS, client.close());
      equals((await client.exit).kind, "cleanShutdown", "the fixture host's exit classification");
      context.client = undefined;
    },
  },
];

async function firstItemOfKind(turn: Turn, kind: string): Promise<Record<string, unknown>> {
  for await (const item of turn.items()) {
    if (item.kind === kind) return item as Record<string, unknown>;
  }
  throw new Error(`the turn ended without a ${kind} item`);
}

export const queueSteerReclaim: Recipe = {
  id: "queue-steer-reclaim",
  title: "Queue, steer, and reclaim turns",
  docsPage: "developer-docs/src/content/docs/cookbook/queue-steer-and-reclaim-turns.mdx",
  needs: ["conformanceBin"],
  async run(hosts: RecipeHosts): Promise<JourneyReport> {
    const conformanceBin = hosts.conformanceBin;
    if (conformanceBin === undefined) throw new Error("conformanceBin is required");
    const context: Context = {
      conformanceBin,
      transcriptRoot: hosts.transcriptRoot,
    };
    return await runJourney(SEGMENTS, context, async (owned) => {
      const client = owned.client;
      if (client !== undefined) {
        await drainQuietly("the fixture host", CLOSE_BUDGET_MS, () => client.close());
      }
    });
  },
};
