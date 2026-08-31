/**
 * Recipe: retry a command without double-submitting.
 *
 * Runs against `muse-conformance serve-fixture` playing three committed golden
 * transcripts, so this recipe is deterministic and needs no credentials and no
 * model. It is the executable companion to the commands-and-idempotency guide.
 *
 * What it teaches (and what the docs page walks through), one arm per
 * transcript:
 *
 *  - `goal-replayed-command` — the exactly-once contract. `Connection.command`
 *    mints ONE `commandId` per logical command; resubmitting the same
 *    `commandId` with the same payload JOINS the original command instead of
 *    running it twice. The replay's ack is value-identical (same `turnId`),
 *    no second effect folds into the view, and reusing the id with a
 *    DIFFERENT payload is a client bug the SDK refuses locally.
 *
 *  - `pending-command-ack-launch` — how a pending entry usually retires: the
 *    command materializes. A `turn/start` acked `"queued"` names the turn
 *    that WILL run the input; queue movement (another turn's terminal) is the
 *    replay trigger for entries still waiting, and the launch boundary folds
 *    a `commandId`-bearing `userMessage` item that retires the entry as
 *    `materialized`.
 *
 *  - `pending-command-ack-reject` — the other retirement. The queued turn's
 *    launch fails: a failed `turn/completed` arrives for a turn that never
 *    started, and replaying the `commandId` answers a durable `-32030`
 *    `commandRejected` rejection. The entry retires `rejected` with
 *    `restoreToComposer: true` — the user's input goes back to the composer,
 *    never silently dropped and never re-run under a fresh id.
 *
 * Fixture mechanics, so the code below reads honestly: serve-fixture matches
 * our frames structurally against the transcript's client lines and then
 * replays the recorded server lines byte-exactly. Our request ids unify (the
 * SDK's default minting starts at 1, where each transcript starts), but acks
 * echo the RECORDED commandId — and `Connection.command` verifies that echo —
 * so each command below passes the transcript's commandId explicitly. Values
 * we learn from the wire (sessionId, turnId, itemId) are used as received,
 * exactly as a real client uses them.
 */

import { MspError, PendingCommandSet } from "@muse-code/sdk";

import { Host, equals, objectAt, requireHost, stringAt } from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

/** The transcripts' own client-side values; see the module comment. */
const SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1";
const WORKSPACE_ROOT = "/home/me/src/proj";

/** `goal-replayed-command`: the session id is the transcript's own client value. */
const REPLAY_SESSION_ID = "0198f0aa-1111-7000-8000-0000000000aa";
const GOAL_SET_COMMAND_ID = "018f6a22-4010-7000-8000-00000000d010";
const GOAL_OBJECTIVE = "Replay me";

/** Both pending-command transcripts run the same first turn shape. */
const FIRST_TURN_COMMAND_ID = "018f6a32-1111-7000-8000-0000000000a1";
/** `pending-command-ack-launch`: the queued submit that launches. */
const LAUNCH_QUEUED_COMMAND_ID = "018f6a32-2222-7000-8000-0000000000b2";
const LAUNCH_FIRST_PROMPT = "Review the current test failures";
const LAUNCH_QUEUED_PROMPT = "Run the queued release checks";
/** `pending-command-ack-reject`: the queued submit whose launch fails. */
const REJECT_QUEUED_COMMAND_ID = "018f6a32-3333-7000-8000-0000000000c3";
const REJECT_FIRST_PROMPT = "Review the current deployment state";
const REJECT_QUEUED_PROMPT = "Run the queued deployment checks";

interface Context {
  readonly conformanceBin: string;
  readonly transcriptRoot: string;
  host?: Host;
  /** The pending-command fold under test in the two ack arms. */
  pending?: PendingCommandSet<string>;
  sessionId?: string;
  firstTurnId?: string;
  queuedTurnId?: string;
  /** The first ack of the replay arm's `goal/set`, compared against the replay. */
  goalAck?: Record<string, unknown>;
}

function requireString(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`${what} is not known: an earlier segment did not finish`);
  return value;
}

/**
 * Spawn a fresh fixture host for one arm, reclaiming the previous arm's child
 * first and resetting everything an arm learns from its own wire — the same
 * arm-boundary discipline approve-or-deny.ts uses, for the same reasons.
 */
function spawnSegment(id: string, scenario: string): Segment<Context> {
  return {
    id,
    title: `Spawn the canned host playing the ${scenario} transcript`,
    async run(context) {
      await context.host?.abandon(CLOSE_BUDGET_MS);
      context.host = undefined;
      context.pending = undefined;
      context.sessionId = undefined;
      context.firstTurnId = undefined;
      context.queuedTurnId = undefined;
      context.goalAck = undefined;
      context.host = await Host.spawn(
        {
          command: context.conformanceBin,
          args: ["serve-fixture", "--transcript", `${context.transcriptRoot}/${scenario}`],
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          clientInfo: { name: "conformance", version: "0.0.0" },
        },
        HANDSHAKE_BUDGET_MS,
      );
    },
  };
}

/**
 * The shared opening of the two pending-command arms: start the session, then
 * start a first turn and track it in a fresh `PendingCommandSet` from submit,
 * through the ack, to the `materialized` retirement at its own `userMessage`.
 */
function startTrackedTurnSegments(
  arm: string,
  prompt: string,
): ReadonlyArray<Segment<Context>> {
  return [
    {
      id: `${arm}-session`,
      title: "Start the session the turns will run in",
      async run(context) {
        const host = requireHost(context);
        const started = await host.msp.connection.command(
          "session/start",
          { workspaceRoot: WORKSPACE_ROOT },
          { maxAttempts: 1, commandId: SESSION_START_COMMAND_ID },
        );
        const session = objectAt(started, "session", "session/start result");
        context.sessionId = stringAt(session, "sessionId", "session/start session");
        context.pending = new PendingCommandSet<string>();
      },
    },
    {
      id: `${arm}-first-turn`,
      title: "Start a turn and watch its entry materialize",
      async run(context) {
        const host = requireHost(context);
        const sessionId = requireString(context.sessionId, "the session id");
        const pending = context.pending;
        if (pending === undefined) throw new Error("`session` did not finish");
        // Record the optimistic entry BEFORE the ack: the entry is what the
        // composer renders while the submit is in flight.
        pending.submitted({ commandId: FIRST_TURN_COMMAND_ID, input: prompt });
        equals(pending.has(FIRST_TURN_COMMAND_ID), true, "the pending set holds the submit");
        const ack = await host.msp.connection.command(
          "turn/start",
          { sessionId, input: [{ type: "text", text: prompt }] },
          { maxAttempts: 1, commandId: FIRST_TURN_COMMAND_ID },
        );
        equals(ack["status"], "accepted", "turn/start ack status");
        equals(ack["disposition"], "started", "turn/start ack disposition");
        const turnId = stringAt(ack, "turnId", "turn/start ack");
        pending.acked(FIRST_TURN_COMMAND_ID, { turnId, disposition: "started" });
        // The command materializes: a userMessage item carrying our commandId
        // folds in, and the entry retires in favour of the real item.
        const folded = await host.waitFor(
          "the commandId-bearing userMessage item",
          COMMAND_BUDGET_MS,
          (notification) => {
            if (notification.method !== "item/completed") return false;
            const item = notification.params["item"] as Record<string, unknown> | undefined;
            return item?.["commandId"] === FIRST_TURN_COMMAND_ID;
          },
        );
        const item = objectAt(folded.params, "item", "item/completed params");
        const retirement = pending.observedUserMessage(
          FIRST_TURN_COMMAND_ID,
          stringAt(item, "itemId", "the userMessage item"),
        );
        equals(retirement?.kind, "materialized", "the started turn's retirement");
        equals(pending.has(FIRST_TURN_COMMAND_ID), false, "the materialized entry left the set");
        context.firstTurnId = turnId;
      },
    },
  ];
}

/** Submit the queued follow-up turn of a pending-command arm. */
function queueSecondTurnSegment(arm: string, commandId: string, prompt: string): Segment<Context> {
  return {
    id: `${arm}-queue`,
    title: "Queue a second turn while the first is still running",
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireString(context.sessionId, "the session id");
      const pending = context.pending;
      if (pending === undefined) throw new Error("`session` did not finish");
      pending.submitted({ commandId, input: prompt });
      const ack = await host.msp.connection.command(
        "turn/start",
        { sessionId, input: [{ type: "text", text: prompt }], ifBusy: "queue" },
        { maxAttempts: 1, commandId },
      );
      equals(ack["status"], "accepted", "the queued turn/start ack status");
      equals(ack["disposition"], "queued", "the queued turn/start ack disposition");
      equals(ack["startedNewTurn"], false, "whether the queued submit started a turn");
      // The ack pre-mints the turn that WILL run this input. Nothing has run
      // yet: the entry stays pending, now server-confirmed queued.
      const turnId = stringAt(ack, "turnId", "the queued turn/start ack");
      pending.acked(commandId, { turnId, disposition: "queued" });
      context.queuedTurnId = turnId;
    },
  };
}

const REPLAY_SEGMENTS: ReadonlyArray<Segment<Context>> = [
  spawnSegment("replay-spawn", "goal-replayed-command"),
  {
    id: "replay-session",
    title: "Start the session the goal will be set in",
    async run(context) {
      const host = requireHost(context);
      const started = await host.msp.connection.command(
        "session/start",
        // The transcript's client supplied its own session id; replay it
        // verbatim, then use the result's id exactly as a real client would.
        { sessionId: REPLAY_SESSION_ID, workspaceRoot: WORKSPACE_ROOT },
        { maxAttempts: 1, commandId: SESSION_START_COMMAND_ID },
      );
      const session = objectAt(started, "session", "session/start result");
      context.sessionId = stringAt(session, "sessionId", "session/start session");
    },
  },
  {
    id: "replay-first-submit",
    title: "Set a goal and let its woken turn run to its terminal",
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireString(context.sessionId, "the session id");
      const ack = await host.msp.connection.command(
        "goal/set",
        { sessionId, objective: GOAL_OBJECTIVE },
        { maxAttempts: 1, commandId: GOAL_SET_COMMAND_ID },
      );
      equals(ack["status"], "accepted", "goal/set ack status");
      const turnId = stringAt(ack, "turnId", "goal/set ack");
      // The goal folds once and its woken turn runs to its own terminal, so
      // the session is idle again before the retry under test.
      await host.waitFor(
        "the session/goalChanged notification",
        COMMAND_BUDGET_MS,
        (notification) => notification.method === "session/goalChanged",
      );
      const completed = await host.waitFor(
        "the woken turn's terminal",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" && notification.params["turnId"] === turnId,
      );
      equals(completed.params["terminal"], "completed", "the woken turn's terminal");
      context.goalAck = ack;
    },
  },
  {
    id: "replay-joins",
    title: "Resubmit the same commandId: a value-identical ack, no second effect",
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireString(context.sessionId, "the session id");
      const firstAck = context.goalAck;
      if (firstAck === undefined) throw new Error("`replay-first-submit` did not finish");
      // The retry a client performs after a dropped reply: the SAME commandId
      // and the SAME payload. `Connection.command` itself verifies the ack is
      // value-identical to the remembered one, so a divergence would throw
      // here rather than pass silently.
      const replayAck = await host.msp.connection.command(
        "goal/set",
        { sessionId, objective: GOAL_OBJECTIVE },
        { maxAttempts: 1, commandId: GOAL_SET_COMMAND_ID },
      );
      equals(replayAck["turnId"], firstAck["turnId"], "the replay ack's turnId");
      equals(replayAck["status"], firstAck["status"], "the replay ack's status");
      // Exactly-once effect: the goal folded once. A second submission would
      // have folded a second session/goalChanged by now — every server line
      // precedes the replay ack we already hold.
      const goalChanges = host
        .notifications()
        .filter((notification) => notification.method === "session/goalChanged");
      equals(goalChanges.length, 1, "how many times the goal folded");
    },
  },
  {
    id: "replay-payload-identity",
    title: "Reusing the commandId with a different payload is refused locally",
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireString(context.sessionId, "the session id");
      // A different payload under a reused commandId is a client bug, not a
      // retry. The SDK refuses it before anything reaches the wire — which is
      // also why this cannot diverge the fixture: no frame is sent.
      let refused: unknown;
      try {
        await host.msp.connection.command(
          "goal/set",
          { sessionId, objective: "A different objective entirely" },
          { maxAttempts: 1, commandId: GOAL_SET_COMMAND_ID },
        );
      } catch (error) {
        refused = error;
      }
      // `includes`, not a regex literal: the example publisher's comment
      // scanner refuses `/` in regex position rather than risk misreading one.
      if (!(refused instanceof Error) || !refused.message.includes("different payload")) {
        throw new Error(
          `a reused commandId with a different payload must be refused locally; got ${String(refused)}`,
        );
      }
    },
  },
  {
    id: "replay-drain",
    title: "Close stdin and let the fixture host exit cleanly",
    async run(context) {
      const host = requireHost(context);
      const exit = await host.close(CLOSE_BUDGET_MS);
      equals(exit.code, 0, "the fixture host's exit code after stdin EOF");
      context.host = undefined;
    },
  },
];

const MATERIALIZE_SEGMENTS: ReadonlyArray<Segment<Context>> = [
  spawnSegment("materialize-spawn", "pending-command-ack-launch"),
  ...startTrackedTurnSegments("materialize", LAUNCH_FIRST_PROMPT),
  queueSecondTurnSegment("materialize", LAUNCH_QUEUED_COMMAND_ID, LAUNCH_QUEUED_PROMPT),
  {
    id: "materialize-launch",
    title: "Queue movement demands a replay; the launch materializes the entry first",
    async run(context) {
      const host = requireHost(context);
      const pending = context.pending;
      if (pending === undefined) throw new Error("`session` did not finish");
      const firstTurnId = requireString(context.firstTurnId, "the first turn's id");
      const queuedTurnId = requireString(context.queuedTurnId, "the queued turn's id");
      // The running turn completes: queue movement. A queued entry's fate is
      // decided at its launch boundary, so this is the moment the fold asks
      // the client to re-verify the entry by replaying its commandId.
      await host.waitFor(
        "the first turn's terminal",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" &&
          notification.params["turnId"] === firstTurnId,
      );
      const demanded = pending.observedQueueMovement(firstTurnId);
      equals(demanded.length, 1, "how many entries queue movement demands a replay for");
      equals(demanded[0], LAUNCH_QUEUED_COMMAND_ID, "the entry queue movement names");
      // Here the launch wins the race the replay exists to referee: the
      // queued turn starts and folds its commandId-bearing userMessage, which
      // retires the entry as materialized — no replay left to send.
      const folded = await host.waitFor(
        "the queued turn's commandId-bearing userMessage item",
        COMMAND_BUDGET_MS,
        (notification) => {
          if (notification.method !== "item/completed") return false;
          const item = notification.params["item"] as Record<string, unknown> | undefined;
          return item?.["commandId"] === LAUNCH_QUEUED_COMMAND_ID;
        },
      );
      const item = objectAt(folded.params, "item", "item/completed params");
      const retirement = pending.observedUserMessage(
        LAUNCH_QUEUED_COMMAND_ID,
        stringAt(item, "itemId", "the queued turn's userMessage item"),
      );
      equals(retirement?.kind, "materialized", "the queued entry's retirement");
      equals(pending.size, 0, "entries left after the launch");
      const completed = await host.waitFor(
        "the queued turn's terminal",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" &&
          notification.params["turnId"] === queuedTurnId,
      );
      equals(completed.params["terminal"], "completed", "the launched queued turn's terminal");
    },
  },
  {
    id: "materialize-drain",
    title: "Close stdin and let the fixture host exit cleanly",
    async run(context) {
      const host = requireHost(context);
      const exit = await host.close(CLOSE_BUDGET_MS);
      equals(exit.code, 0, "the fixture host's exit code after stdin EOF");
      context.host = undefined;
    },
  },
];

const REJECT_SEGMENTS: ReadonlyArray<Segment<Context>> = [
  spawnSegment("reject-spawn", "pending-command-ack-reject"),
  ...startTrackedTurnSegments("reject", REJECT_FIRST_PROMPT),
  queueSecondTurnSegment("reject", REJECT_QUEUED_COMMAND_ID, REJECT_QUEUED_PROMPT),
  {
    id: "reject-launch-fails",
    title: "The queued launch fails: a failed terminal for a turn that never started",
    async run(context) {
      const host = requireHost(context);
      const pending = context.pending;
      if (pending === undefined) throw new Error("`session` did not finish");
      const firstTurnId = requireString(context.firstTurnId, "the first turn's id");
      const queuedTurnId = requireString(context.queuedTurnId, "the queued turn's id");
      await host.waitFor(
        "the first turn's terminal",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" &&
          notification.params["turnId"] === firstTurnId,
      );
      const demanded = pending.observedQueueMovement(firstTurnId);
      equals(demanded[0], REJECT_QUEUED_COMMAND_ID, "the entry queue movement names");
      // The no-run exit: the pre-minted turn folds a FAILED terminal with a
      // launch error and no turn/started ever arrives for it.
      const failed = await host.waitFor(
        "the queued turn's failed terminal",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" &&
          notification.params["turnId"] === queuedTurnId,
      );
      equals(failed.params["terminal"], "failed", "the queued turn's terminal");
      const error = objectAt(failed.params, "error", "the failed turn/completed params");
      equals(error["kind"], "launchError", "the failed terminal's error kind");
      const started = host
        .notifications()
        .some(
          (notification) =>
            notification.method === "turn/started" &&
            notification.params["turnId"] === queuedTurnId,
        );
      equals(started, false, "whether the failed turn ever started");
    },
  },
  {
    id: "reject-replay",
    title: "Replay the commandId; the durable rejection retires the entry to the composer",
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireString(context.sessionId, "the session id");
      const pending = context.pending;
      if (pending === undefined) throw new Error("`session` did not finish");
      // The replay the fold demanded: same commandId, same payload. This time
      // the answer is the settlement — a durable -32030 commandRejected.
      let rejection: MspError | undefined;
      try {
        await host.msp.connection.command(
          "turn/start",
          {
            sessionId,
            input: [{ type: "text", text: REJECT_QUEUED_PROMPT }],
            ifBusy: "queue",
          },
          { maxAttempts: 1, commandId: REJECT_QUEUED_COMMAND_ID },
        );
      } catch (error) {
        if (error instanceof MspError) rejection = error;
        else throw error;
      }
      if (rejection === undefined) {
        throw new Error("replaying a durably rejected commandId must answer the rejection");
      }
      equals(rejection.code, -32030, "the rejection's JSON-RPC code");
      equals(rejection.kind, "commandRejected", "the rejection's kind");
      const reason = rejection.data["reason"];
      equals(reason, "deferred_start_failed", "the rejection's reason");
      // Feed the answer back into the fold: a durable rejection retires the
      // entry with the original input, marked for the composer. Nothing is
      // lost and nothing runs twice.
      const retirement = pending.replayAnswered(REJECT_QUEUED_COMMAND_ID, {
        kind: "error",
        error: { code: rejection.code, kind: rejection.kind, reason: String(reason) },
      });
      // A plain guard narrows the discriminated union — no cast. This file is
      // published verbatim, so it shows the pattern a reader should copy.
      if (retirement === "held" || retirement.kind !== "rejected") {
        throw new Error(
          `a durable rejection must retire the entry as rejected; got ${JSON.stringify(retirement)}`,
        );
      }
      equals(retirement.reason, "deferred_start_failed", "the retirement's reason");
      equals(retirement.restoreToComposer, true, "whether the input goes back to the composer");
      equals(retirement.input, REJECT_QUEUED_PROMPT, "the input restored to the composer");
      equals(pending.size, 0, "entries left after the rejection");
    },
  },
  {
    id: "reject-drain",
    title: "Close stdin and let the fixture host exit cleanly",
    async run(context) {
      const host = requireHost(context);
      const exit = await host.close(CLOSE_BUDGET_MS);
      equals(exit.code, 0, "the fixture host's exit code after stdin EOF");
      context.host = undefined;
    },
  },
];

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  ...REPLAY_SEGMENTS,
  ...MATERIALIZE_SEGMENTS,
  ...REJECT_SEGMENTS,
];

export const retryWithoutDoubleSubmitting: Recipe = {
  id: "retry-without-double-submitting",
  title: "Retry a command without double-submitting",
  docsPage: "developer-docs/src/content/docs/cookbook/retry-without-double-submitting.mdx",
  needs: ["conformanceBin"],
  async run(hosts: RecipeHosts): Promise<JourneyReport> {
    const conformanceBin = hosts.conformanceBin;
    if (conformanceBin === undefined) throw new Error("conformanceBin is required");
    const context: Context = {
      conformanceBin,
      transcriptRoot: hosts.transcriptRoot,
    };
    return await runJourney(SEGMENTS, context, async (owned) => {
      await owned.host?.abandon(CLOSE_BUDGET_MS);
    });
  },
};
