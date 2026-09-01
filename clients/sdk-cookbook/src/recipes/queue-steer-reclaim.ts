/**
 * Recipe: queue, steer, and reclaim turns — the multi-turn traffic rules
 * every chat-style UI eventually hits.
 *
 * Runs against `muse-conformance serve-fixture` playing the committed golden
 * transcript `schema/msp/transcripts/turn-unqueued-round-trip`, so this recipe
 * is deterministic and needs no credentials and no model.
 *
 * What it teaches (and what the docs page walks through):
 *  - `turn/start` answers with a `disposition`, and that word is the whole
 *    routing decision: `"started"` (a fresh foreground turn began), `"queued"`
 *    (input parked; the ack's `turnId` names the PRE-MINTED turn that will
 *    carry it), or `"steered"` (absorbed by the running turn). Branch on the
 *    disposition, never on folding history.
 *  - a queued submit can be taken back before it launches: `turn/unqueue`
 *    addressed by the turnId the queueing ack minted, answered by an accepted
 *    ack and then the durable `turn/unqueued` notification.
 *  - what the SDK does with the reclaim: folding `turn/unqueued` through
 *    `Session.apply` retires the pending entry as `kind: "reclaimed"` with
 *    `restoreToComposer: true` and the original input attached — the "un-send"
 *    hands the text back to the composer instead of losing it — and settles
 *    the pre-minted turn's `TurnOutcome` as `kind: "unqueued"`. No
 *    `turn/completed` will ever carry a reclaimed turnId, so a wait folding
 *    only `turn/completed` hangs forever.
 *  - the reclaim is surgical: the ACTIVE turn is untouched and runs to its own
 *    `completed` terminal.
 *
 * Steering is taught on the page (the third disposition and the exact-target
 * `turn/steer` verb) but not exercised here: no committed transcript records
 * a steered submit, because what a steer absorbs depends on a live model's
 * timing. The ratified validation for this recipe names an opt-in-live arm
 * for real steering; that arm is tracked on #24225 alongside recipe 1's.
 *
 * Fixture mechanics, so the code below reads honestly: serve-fixture matches
 * our frames structurally against the transcript's client lines and replays
 * the recorded server lines, answering each request under the client's own
 * request id. Acks echo the RECORDED commandId — and `Connection.command`
 * verifies that echo — so each command passes the transcript's commandId
 * explicitly.
 *
 * The `Session` below is constructed fold-only (no connection): every wire
 * write in this recipe goes through `Connection.command` with an explicit
 * commandId, and the recipe feeds the session the view notifications the
 * recorder captured — the same routing `MuseClient` does for you on a live
 * connection.
 */

import { Session, readSessionDurability } from "@muse-code/sdk";
import type { PendingRetirement } from "@muse-code/sdk";

import { Host, equals, objectAt, requireHost, stringAt } from "../kit/host.js";
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
  host?: Host;
  /** Fold-only: mirrors the wire so the SS4.13/TurnOutcome claims are proven. */
  session?: Session<string>;
  /** How many recorded notifications have been fed to `session.apply`. */
  applied: number;
  sessionId?: string;
  /** The active turn's id, taken from its ack — never derived from the commandId. */
  activeTurnId?: string;
  /** The queued turn's id — by SS3.1.4 the queueing commandId, but always taken from the ack. */
  queuedTurnId?: string;
}

function requireString(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`${what} is not known: an earlier segment did not finish`);
  return value;
}

function requireSession(context: Context): Session<string> {
  if (context.session === undefined) {
    throw new Error("no session: an earlier segment did not finish");
  }
  return context.session;
}

/**
 * Feed every not-yet-applied recorded notification for this session through
 * `Session.apply`, returning the retirements those folds produced. This is
 * the recipe's stand-in for the per-session routing `MuseClient` performs on
 * a live connection; the sessionId filter is what makes feeding a shared
 * recorder safe (`apply` throws on another session's event by design).
 */
function applyView(context: Context): PendingRetirement<string>[] {
  const host = requireHost(context);
  const session = requireSession(context);
  const retirements: PendingRetirement<string>[] = [];
  const seen = host.notifications();
  while (context.applied < seen.length) {
    const notification = seen[context.applied];
    context.applied += 1;
    if (notification === undefined) continue;
    if (notification.params["sessionId"] !== session.sessionId) continue;
    retirements.push(...session.apply(notification).retirements);
  }
  return retirements;
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "spawn",
    title: `Spawn the canned host playing the ${SCENARIO} transcript`,
    async run(context) {
      const host = await Host.spawn(
        {
          command: context.conformanceBin,
          args: ["serve-fixture", "--transcript", `${context.transcriptRoot}/${SCENARIO}`],
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          clientInfo: { name: "conformance", version: "0.0.0" },
        },
        HANDSHAKE_BUDGET_MS,
      );
      context.host = host;
    },
  },
  {
    id: "session",
    title: "Start a session and mirror it in a fold-only Session",
    async run(context) {
      const host = requireHost(context);
      const started = await host.msp.connection.command(
        "session/start",
        { workspaceRoot: WORKSPACE_ROOT },
        { maxAttempts: 1, commandId: SESSION_START_COMMAND_ID },
      );
      const session = objectAt(started, "session", "session/start result");
      const sessionId = stringAt(session, "sessionId", "session/start session");
      // Durability comes off the handshake, exactly as a real client reads
      // it: it decides what happens to pending commands if the host dies.
      const durability = readSessionDurability(host.msp.initializeResult);
      equals(durability.kind, "durable", "the handshake's session durability");
      context.sessionId = sessionId;
      context.session = new Session<string>({ sessionId, durability });
    },
  },
  {
    id: "start-active",
    title: 'Submit while idle: disposition "started", entry retires as materialized',
    async run(context) {
      const host = requireHost(context);
      const session = requireSession(context);
      const sessionId = requireString(context.sessionId, "the session id");
      // The SS4.13 entry FIRST, then the wire: the pending set is what a UI
      // renders optimistically, so it exists from the moment of submission.
      session.pending.submitted({ commandId: ACTIVE_TURN_COMMAND_ID, input: ACTIVE_PROMPT });
      const ack = await host.msp.connection.command(
        "turn/start",
        { sessionId, input: [{ type: "text", text: ACTIVE_PROMPT }] },
        { maxAttempts: 1, commandId: ACTIVE_TURN_COMMAND_ID },
      );
      equals(ack["status"], "accepted", "turn/start ack status");
      equals(ack["disposition"], "started", "the idle submit's disposition");
      equals(ack["startedNewTurn"], true, "the disposition's boolean shorthand");
      // The ack's turnId is authoritative — always take it, never derive it.
      const turnId = stringAt(ack, "turnId", "turn/start ack");
      session.pending.acked(ACTIVE_TURN_COMMAND_ID, { turnId, disposition: "started" });
      context.activeTurnId = turnId;

      // The commandId-bearing userMessage folding in is what retires the
      // entry: the optimistic echo is replaced by the durable item.
      await host.waitFor(
        "the active turn's userMessage item",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "item/completed" &&
          (notification.params["item"] as Record<string, unknown> | undefined)?.["commandId"] ===
            ACTIVE_TURN_COMMAND_ID,
      );
      const retirements = applyView(context);
      const materialized = retirements.find(
        (retirement) => retirement.commandId === ACTIVE_TURN_COMMAND_ID,
      );
      if (materialized === undefined || materialized.kind !== "materialized") {
        throw new Error(
          `the started submit should retire as materialized; got ${JSON.stringify(retirements)}`,
        );
      }
      equals(session.pending.has(ACTIVE_TURN_COMMAND_ID), false, "the materialized entry is gone");
    },
  },
  {
    id: "queue",
    title: 'Submit while busy: disposition "queued", the ack pre-mints the turn',
    async run(context) {
      const host = requireHost(context);
      const session = requireSession(context);
      const sessionId = requireString(context.sessionId, "the session id");
      session.pending.submitted({ commandId: QUEUED_TURN_COMMAND_ID, input: QUEUED_PROMPT });
      const ack = await host.msp.connection.command(
        "turn/start",
        { sessionId, input: [{ type: "text", text: QUEUED_PROMPT }], ifBusy: "queue" },
        { maxAttempts: 1, commandId: QUEUED_TURN_COMMAND_ID },
      );
      equals(ack["status"], "accepted", "the queued submit's ack status");
      equals(ack["disposition"], "queued", "the busy submit's disposition");
      equals(ack["startedNewTurn"], false, "queued input starts no turn yet");
      const queuedTurnId = stringAt(ack, "turnId", "the queued submit's ack");
      session.pending.acked(QUEUED_TURN_COMMAND_ID, { turnId: queuedTurnId, disposition: "queued" });
      context.queuedTurnId = queuedTurnId;
      // Nothing has settled the queued entry: it stays pending — exactly what
      // a UI renders as "queued, not yet running" — until the wire says
      // launched, rejected, or reclaimed.
      equals(session.pending.has(QUEUED_TURN_COMMAND_ID), true, "the queued entry is held");
    },
  },
  {
    id: "reclaim",
    title: "Reclaim the queued turn: turn/unqueue, then the durable turn/unqueued",
    async run(context) {
      const host = requireHost(context);
      const session = requireSession(context);
      const sessionId = requireString(context.sessionId, "the session id");
      const queuedTurnId = requireString(context.queuedTurnId, "the queued turn id");
      // Mint the handle BEFORE the fold settles it, the way a UI already
      // holding "queued turn X" would: the wait below must resolve, not hang.
      const queued = session.turn(queuedTurnId);
      const ack = await host.msp.connection.command(
        "turn/unqueue",
        { sessionId, turnId: queuedTurnId },
        { maxAttempts: 1, commandId: UNQUEUE_COMMAND_ID },
      );
      equals(ack["status"], "accepted", "turn/unqueue ack status");
      equals(ack["turnId"], queuedTurnId, "the turnId the unqueue ack echoes");

      const unqueued = await host.waitFor(
        "the turn/unqueued notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/unqueued" &&
          notification.params["turnId"] === queuedTurnId,
      );
      // The notification's commandId names the turn/start that QUEUED the
      // turn — the entry to retire — not the unqueue command that reclaimed it.
      equals(unqueued.params["commandId"], QUEUED_TURN_COMMAND_ID, "turn/unqueued's commandId");

      const retirements = applyView(context);
      const reclaimed = retirements.find(
        (retirement) => retirement.commandId === QUEUED_TURN_COMMAND_ID,
      );
      if (reclaimed === undefined || reclaimed.kind !== "reclaimed") {
        throw new Error(
          `the reclaim should retire the entry as reclaimed; got ${JSON.stringify(retirements)}`,
        );
      }
      // The whole point of the gesture: the input comes BACK. A client that
      // drops it here has turned "un-send" into "delete my draft".
      equals(reclaimed.restoreToComposer, true, "the reclaim restores to the composer");
      equals(reclaimed.input, QUEUED_PROMPT, "the input handed back to the composer");
      equals(session.pending.has(QUEUED_TURN_COMMAND_ID), false, "the reclaimed entry is gone");

      // The pre-minted turn's outcome is `unqueued` — its own terminal kind.
      // No turn/completed will ever carry this turnId, so a wait folding only
      // turn/completed would hang forever.
      const outcome = await queued.completed;
      equals(outcome.kind, "unqueued", "the reclaimed turn's outcome");
    },
  },
  {
    id: "active-untouched",
    title: "The active turn never noticed: it runs to its own completed terminal",
    async run(context) {
      const host = requireHost(context);
      const session = requireSession(context);
      const activeTurnId = requireString(context.activeTurnId, "the active turn id");
      const completed = await host.waitFor(
        "the active turn's turn/completed",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" &&
          notification.params["turnId"] === activeTurnId,
      );
      equals(completed.params["terminal"], "completed", "the active turn's terminal");
      applyView(context);
      const outcome = await session.turn(activeTurnId).completed;
      if (outcome.kind !== "completed") {
        throw new Error(`the active turn should complete; got ${JSON.stringify(outcome)}`);
      }
      equals(outcome.params.terminal, "completed", "the folded outcome's terminal");
      equals(outcome.observedStart, true, "this session observed the active turn start");
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
      applied: 0,
    };
    return await runJourney(SEGMENTS, context, async (owned) => {
      await owned.host?.abandon(CLOSE_BUDGET_MS);
    });
  },
};
