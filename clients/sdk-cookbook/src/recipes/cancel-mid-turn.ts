/**
 * Recipe: stop a turn while it is running — the user's Stop button, and the
 * programmatic cancel.
 *
 * Runs against `muse-conformance serve-fixture` playing three committed golden
 * transcripts — `schema/msp/transcripts/cancel-mid-turn` (the plain cancel),
 * `schema/msp/transcripts/turn-interrupt-queued-successor` (the Stop
 * gesture, with a second turn queued behind the running one) and
 * `schema/msp/transcripts/turn-interrupt-queued-successor-burst` (the same
 * exchange with the queued turn's `turn/started` written right after the
 * stopped turn's terminal, before the replay exchange, as a live host may
 * write it) — the canned stdio host, so this recipe is deterministic and
 * needs no credentials and no model.
 *
 * What it teaches (and what the docs page walks through):
 *  - a stop is a REQUEST, not an outcome. The ack to `turn/cancel` or
 *    `turn/interrupt` says the host will try; the turn is over only when
 *    `turn.completed` settles with the terminal `"cancelled"`.
 *  - a stopped turn keeps a balanced history: the in-flight toolCall item
 *    is completed as `"cancelled"`, never dropped.
 *  - the two stop lanes: `turn.interrupt()` is the user's Stop/Esc gesture,
 *    on the priority lane; `turn.cancel()` is programmatic cleanup on the
 *    normal lane. Neither consumes a turn queued behind the stopped one: the
 *    queued submit stays pending, the SDK re-verifies it at the stopped
 *    turn's terminal (the queue moves up), and it launches and completes on
 *    its own.
 *
 * Fixture mechanics, so the code below reads honestly: serve-fixture matches
 * our frames structurally against the transcript's client lines and then
 * replays the recorded server lines byte-exactly. Request ids unify, but acks
 * echo the RECORDED commandId — and the SDK verifies that echo — so the
 * connection's one commandId minter is scripted with each transcript's ids in
 * send order (the queue-movement replay re-sends an id it already holds, so
 * it takes none). Everything else goes through the `MuseClient` facade, and the values
 * we learn from the wire (sessionId, turnId) are used as received.
 */

import { MuseClient, readSessionDurability, spawnMspConnection } from "@muse-code/sdk";
import type {
  FoldedItem,
  PendingCommandEntry,
  Session,
  SessionEvent,
  Turn,
  ViewFrame,
} from "@muse-code/sdk";

import { HOST_DRAIN_WINDOW_MS, drainQuietly, equals, within } from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

/** The transcripts' own client-side values; see the module comment. */
const WORKSPACE_ROOT = "/home/me/src/proj";
const PROMPT = "Run the flaky integration suite";
const QUEUED_PROMPT = "Summarize the last failing test";
const SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1";
/** `cancel-mid-turn`: the running turn and the cancel. */
const CANCEL_TURN_COMMAND_ID = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10";
const TURN_CANCEL_COMMAND_ID = "018f6a21-0f0f-7aaa-bbbb-0123456789ab";
/** `turn-interrupt-queued-successor`: the running turn, the queued one, the interrupt. */
const INTERRUPT_TURN_COMMAND_ID = "018f6a41-1111-7000-8000-0000000000a1";
const QUEUED_TURN_COMMAND_ID = "018f6a41-2222-7000-8000-0000000000b2";
const TURN_INTERRUPT_COMMAND_ID = "018f6a41-3333-7000-8000-0000000000c3";

/** One arm of the recipe: one transcript, one stop lane. */
interface Arm {
  /** Segment-id prefix, so the report names which arm a line belongs to. */
  readonly id: string;
  /** The transcript directory name under the corpus root. */
  readonly scenario: string;
  /** The transcript's client-minted commandIds, in send order. */
  readonly commandIds: readonly string[];
}

const CANCEL: Arm = {
  id: "cancel",
  scenario: "cancel-mid-turn",
  commandIds: [SESSION_START_COMMAND_ID, CANCEL_TURN_COMMAND_ID, TURN_CANCEL_COMMAND_ID],
};

const INTERRUPT: Arm = {
  id: "interrupt",
  scenario: "turn-interrupt-queued-successor",
  commandIds: [
    SESSION_START_COMMAND_ID,
    INTERRUPT_TURN_COMMAND_ID,
    QUEUED_TURN_COMMAND_ID,
    TURN_INTERRUPT_COMMAND_ID,
  ],
};

/**
 * The same exchange with the queued turn's `turn/started` in the same burst as
 * the stopped turn's terminal: the order that reads wrong to a check made
 * after an await, and right on the wire. Same ids, same send order.
 */
const INTERRUPT_BURST: Arm = {
  id: "interrupt-burst",
  scenario: "turn-interrupt-queued-successor-burst",
  commandIds: INTERRUPT.commandIds,
};

interface Context {
  readonly conformanceBin: string;
  readonly transcriptRoot: string;
  client?: MuseClient;
  session?: Session;
  turn?: Turn;
  /** The toolCall that was running when we asked for the stop. */
  toolCallId?: string;
  /** The interrupt arm: the submit queued behind the running turn. */
  queued?: Turn;
  /** The queued submit's pending entry, as `session.pending` showed it. */
  queuedEntry?: PendingCommandEntry<unknown>;
  /** The interrupt arm: the stop segment's wire-order watch; see `queuedStartsAfterTerminal`. */
  launchOrder?: Promise<boolean>;
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

function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} is not known: an earlier segment did not finish`);
  return value;
}

async function firstRunningToolCall(turn: Turn): Promise<FoldedItem> {
  for await (const item of turn.items()) {
    if (item.kind === "toolCall" && item.status === "inProgress") return item;
  }
  throw new Error("the turn ended without a running toolCall");
}

/** The stop's outcome: the turn's own terminal, and the balanced history. */
async function expectStoppedTurn(context: Context, what: string): Promise<void> {
  const session = required(context.session, "the session");
  const turn = required(context.turn, "the running turn");
  const toolCallId = required(context.toolCallId, "the running toolCall");
  // The ack is a promise to try, not the outcome. The outcome is the
  // turn's terminal.
  const outcome = await within(`the ${what} turn's outcome`, COMMAND_BUDGET_MS, turn.completed);
  if (outcome.kind !== "completed") {
    throw new Error(`the ${what} turn should complete; got ${JSON.stringify(outcome)}`);
  }
  equals(outcome.params.terminal, "cancelled", "the turn's terminal");
  // Balanced history: the in-flight toolCall was completed as cancelled,
  // not dropped on the floor.
  equals(session.fold.items.get(toolCallId)?.status, "cancelled", "the toolCall's final status");
}

/** Whether the turn's items hold a completed agent message; the walk ends with the turn. */
async function agentAnswered(turn: Turn): Promise<boolean> {
  let answered = false;
  for await (const item of turn.items()) {
    if (item.kind === "agentMessage" && item.status === "completed") answered = true;
  }
  return answered;
}

/** The turn a `turn/*` notification names, read off the frame's params. */
function turnIdOf(frame: ViewFrame): string | undefined {
  const turnId = (frame.params as { turnId?: unknown } | undefined)?.turnId;
  return typeof turnId === "string" ? turnId : undefined;
}

/**
 * Wire order at the stop boundary, read from the session's event stream: true
 * when the queued turn's `turn/started` arrives after the stopped turn's
 * `turn/completed`, false when it arrives before it (an early launch). The
 * stream is opened before the Stop is sent, so it holds both frames. The
 * handle's `observedStart` cannot answer this after an await: a host may write
 * the terminal and the launch in one chunk, and both fold before the
 * continuation runs.
 */
async function queuedStartsAfterTerminal(
  events: AsyncIterableIterator<SessionEvent>,
  stopped: Turn,
  queued: Turn,
): Promise<boolean> {
  let terminalSeen = false;
  for await (const event of events) {
    const turnId = turnIdOf(event.frame);
    if (event.frame.method === "turn/completed" && turnId === stopped.turnId) terminalSeen = true;
    else if (event.frame.method === "turn/started" && turnId === queued.turnId) return terminalSeen;
  }
  throw new Error("the session's events ended before the queued turn started");
}

/** The opening every arm shares: spawn, start the session, run a turn into its tool call. */
function openingSegments(arm: Arm): ReadonlyArray<Segment<Context>> {
  return [
    {
      id: `${arm.id}-spawn`,
      title: `Spawn the canned host playing the ${arm.scenario} transcript`,
      async run(context) {
        // Reclaim before overwriting the slot: a previous arm whose drain
        // threw leaves its client here, and the arm's own wire state goes
        // with it, so a failed arm cannot feed a stale id to the next one.
        const previous = context.client;
        if (previous !== undefined) {
          await drainQuietly("the previous arm's fixture host", CLOSE_BUDGET_MS, () => previous.close());
        }
        context.client = undefined;
        context.session = undefined;
        context.turn = undefined;
        context.toolCallId = undefined;
        context.queued = undefined;
        context.queuedEntry = undefined;
        context.launchOrder = undefined;
        const stderr: string[] = [];
        // Built by hand rather than with `MuseClient.spawn`: spawn asks for an
        // extra capability the recorded `initialize` line does not carry.
        const handshake = spawnMspConnection({
          command: context.conformanceBin,
          args: ["serve-fixture", "--transcript", `${context.transcriptRoot}/${arm.scenario}`],
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          shutdownTimeoutMs: HOST_DRAIN_WINDOW_MS,
          onStderr: (chunk) => stderr.push(chunk),
          connection: { mintCommandId: scriptedCommandIds(arm.commandIds) },
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
      id: `${arm.id}-session`,
      title: "Start the session the turn will run in",
      async run(context) {
        const client = required(context.client, "the client");
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
      id: `${arm.id}-turn-start`,
      title: "Start a turn and watch its work stream in",
      async run(context) {
        const session = required(context.session, "the session");
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
  ];
}

function drainSegment(arm: Arm): Segment<Context> {
  return {
    id: `${arm.id}-drain`,
    title: "Close stdin and let the fixture host exit cleanly",
    async run(context) {
      const client = required(context.client, "the client");
      await within("the fixture host's orderly drain and exit", CLOSE_BUDGET_MS, client.close());
      equals((await client.exit).kind, "cleanShutdown", "the fixture host's exit classification");
      context.client = undefined;
    },
  };
}

const CANCEL_SEGMENTS: ReadonlyArray<Segment<Context>> = [
  ...openingSegments(CANCEL),
  {
    id: `${CANCEL.id}-stop`,
    title: "Ask for the cancel, then wait for the turn's own terminal",
    async run(context) {
      const turn = required(context.turn, "the running turn");
      const ack = await within("the turn/cancel ack", COMMAND_BUDGET_MS, turn.cancel());
      equals(ack.status, "accepted", "turn/cancel ack status");
      await expectStoppedTurn(context, "cancelled");
    },
  },
  drainSegment(CANCEL),
];

/** The interrupt arm over one of the two interrupt transcripts: queue, Stop, successor, drain. */
function interruptSegments(arm: Arm): ReadonlyArray<Segment<Context>> {
  return [
    ...openingSegments(arm),
    {
      id: `${arm.id}-queue`,
      title: 'Submit a second turn while the first runs: disposition "queued"',
      async run(context) {
        const session = required(context.session, "the session");
        const queued = await within(
          "the queued submit's ack",
          COMMAND_BUDGET_MS,
          session.sendUserTurn({
            input: [{ type: "text", text: QUEUED_PROMPT }],
            ifBusy: "queue",
          }),
        );
        // The handle names a turn that does not run yet: the entry stays in
        // `session.pending`, acked "queued", until the wire says launched,
        // rejected, or reclaimed.
        const entry = session.pending.list().find((held) => held.ack?.turnId === queued.turnId);
        if (entry === undefined) throw new Error("the queued submit left no pending entry");
        equals(entry.ack?.disposition, "queued", "the busy submit's disposition");
        equals(queued.observedStart, false, "queued input starts no turn yet");
        context.queued = queued;
        context.queuedEntry = entry;
      },
    },
    {
      id: `${arm.id}-stop`,
      title: "Press Stop: interrupt the running turn, then wait for its own terminal",
      async run(context) {
        const session = required(context.session, "the session");
        const turn = required(context.turn, "the running turn");
        const queued = required(context.queued, "the queued turn");
        // Still queued, in the same tick: the watch below sees only frames from
        // here on, so a launch before Stop must fail by name, not as the
        // successor segment's timeout.
        equals(queued.observedStart, false, "the queued turn had not started before Stop");
        // Watch the wire before pressing Stop: the queued turn launches when the
        // stopped turn reaches its terminal, and only the frames' order on the
        // wire says which came first. The successor segment reads the answer.
        const launchOrder = queuedStartsAfterTerminal(session.events(), turn, queued);
        // Observed here, so a host death before the successor segment reads it
        // is that segment's failure, not an unhandled rejection.
        launchOrder.catch(() => undefined);
        context.launchOrder = launchOrder;
        // The user's stop gesture is `turn/interrupt`, the priority lane; its
        // ack is admission only, exactly like the cancel's.
        const ack = await within("the turn/interrupt ack", COMMAND_BUDGET_MS, turn.interrupt());
        equals(ack.status, "accepted", "turn/interrupt ack status");
        equals(ack.turnId, turn.turnId, "the turn the interrupt ack names");
        await expectStoppedTurn(context, "interrupted");
      },
    },
    {
      id: `${arm.id}-successor`,
      title: "The queued turn was not consumed by the stop: it launches and completes",
      async run(context) {
        const session = required(context.session, "the session");
        const queued = required(context.queued, "the queued turn");
        const entry = required(context.queuedEntry, "the queued entry");
        const launchOrder = required(context.launchOrder, "the launch-order watch");
        // A stop is scoped to the ACTIVE turn. The queued submit's fate is
        // decided at the launch boundary, where the SDK re-verified it and the
        // host launched it.
        const outcome = await within("the queued turn's outcome", COMMAND_BUDGET_MS, queued.completed);
        if (outcome.kind !== "completed") {
          throw new Error(`the queued turn should run to completion; got ${JSON.stringify(outcome)}`);
        }
        equals(outcome.params.terminal, "completed", "the queued turn's terminal");
        // Wire order, not continuation order: the watch opened before the Stop
        // saw the stopped turn's terminal and then this turn's `turn/started`.
        const startedAfterTerminal = await within("the queued turn's launch", COMMAND_BUDGET_MS, launchOrder);
        equals(
          startedAfterTerminal,
          true,
          "the queued turn's turn/started came after the stopped turn's terminal",
        );
        equals(queued.observedStart, true, "the handle saw the queued turn start");
        equals(session.pending.has(entry.commandId), false, "the launched entry left the pending set");
        const answered = await within("the queued turn's items", COMMAND_BUDGET_MS, agentAnswered(queued));
        if (!answered) throw new Error("the queued turn completed without the agent's message");
      },
    },
    drainSegment(arm),
  ];
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  ...CANCEL_SEGMENTS,
  ...interruptSegments(INTERRUPT),
  ...interruptSegments(INTERRUPT_BURST),
];

export const cancelMidTurn: Recipe = {
  id: "cancel-mid-turn",
  title: "Stop a turn while it is running",
  docsPage: "developer-docs/src/content/docs/cookbook/cancel-a-running-turn.mdx",
  needs: ["conformanceBin"],
  async run(hosts: RecipeHosts): Promise<JourneyReport> {
    const conformanceBin = hosts.conformanceBin;
    if (conformanceBin === undefined) throw new Error("conformanceBin is required");
    const context: Context = { conformanceBin, transcriptRoot: hosts.transcriptRoot };
    return await runJourney(SEGMENTS, context, async (owned) => {
      const client = owned.client;
      if (client !== undefined) {
        await drainQuietly("the fixture host", CLOSE_BUDGET_MS, () => client.close());
      }
    });
  },
};
