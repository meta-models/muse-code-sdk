/**
 * Recipe: handle errors by class.
 *
 * Runs against `muse-conformance serve-fixture` playing five committed golden
 * transcripts, so this recipe is deterministic and needs no credentials and
 * no model. It is the executable companion to the errors guide.
 *
 * What it teaches, and what the docs page walks through: every MSP error
 * carries `error.data.kind`, and every kind maps to exactly one next move for
 * the client. `classify` below is that mapping: a table over the whole
 * generated `ErrorKind` union, so a kind the table forgets fails to compile,
 * plus the two members that outrank the table, `data.retryable` and the
 * `missingAnchor` reason of `notFound`. One arm per transcript:
 *
 *  - `usershell-without-grant`: `capabilityRequired` (-32010), terminal for
 *    this connection; grants happen only at the handshake, so `reconnect`.
 *  - `cursor-never-existed`: `notFound` with `reason: "missingAnchor"`
 *    (-32011), the position rather than the reference is wrong; `resync`.
 *  - `cursor-truncated`: `viewTruncated` (-32040) with `earliestCursor`,
 *    a `resync` that says where from.
 *  - `goal-missing-goal-rejection`: `commandRejected` (-32030) with the
 *    snake_case reason `missing_goal`, durable and user-facing; `tellTheUser`.
 *  - `provider-failure-turn`: no error response at all. The accepted turn
 *    fails later on the session view, a `turn/completed` with
 *    `terminal: "failed"` and `error.retryable: true`; the retry is a NEW
 *    turn under a NEW commandId, and the arm plays that too.
 *
 * Fixture mechanics: serve-fixture matches our frames structurally against
 * the transcript's client lines and replays the recorded server lines. Each
 * command passes the transcript's recorded commandId explicitly because the
 * last transcript matches it byte for byte; against a real host the SDK mints
 * a fresh commandId per logical command, and nothing in `classify` reads it.
 */

import type { ErrorKind, ErrorObject } from "@muse-code/msp";
import { MspError } from "@muse-code/sdk";

import { Host, equals, objectAt, requireHost, stringAt } from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

/**
 * The five moves, in three classes: `retry` (retryable: the same command under
 * the same commandId, after a backoff), `tellTheUser` (user-facing: a durable
 * answer to the user's intent), and three terminal moves that differ in what
 * you do instead of resending.
 */
export type ClientMove = "retry" | "tellTheUser" | "reconnect" | "resync" | "stop";

const CLIENT_MOVES: ReadonlyArray<ClientMove> = ["retry", "tellTheUser", "reconnect", "resync", "stop"];

/** One row per kind. The compiler refuses this table when a kind is missing. */
export const CLIENT_MOVE: Record<ErrorKind, ClientMove> = {
  // Retryable: nothing was admitted; the same commandId may go again.
  overloaded: "retry",
  backpressured: "retry",
  approvalBrokerUnavailable: "retry",
  // User-facing: a durable answer to the user's intent.
  commandRejected: "tellTheUser",
  sessionNotFound: "tellTheUser",
  sessionInUse: "tellTheUser",
  sessionAmbiguous: "tellTheUser",
  forkBoundaryInvalid: "tellTheUser",
  skillNotFound: "tellTheUser",
  marketplaceNotFound: "tellTheUser",
  pluginNotFound: "tellTheUser",
  marketplaceAlreadyExists: "tellTheUser",
  pluginMutationsDisabled: "tellTheUser",
  uploadNotFound: "tellTheUser",
  outputUnavailable: "tellTheUser",
  approvalAlreadyResolved: "tellTheUser",
  approvalReviewerUnavailable: "tellTheUser",
  userInputAlreadySettled: "tellTheUser",
  userInputAnswerInvalid: "tellTheUser",
  // Terminal, reconnect: granted only at the handshake.
  capabilityRequired: "reconnect",
  experimentalRequired: "reconnect",
  // Terminal, resync: the position is gone, or the answer is on the view.
  viewTruncated: "resync",
  boundaryPruned: "resync",
  boundaryUnusable: "resync",
  noBoundary: "resync",
  interrupted: "resync",
  cancelled: "resync",
  approvalNotFound: "resync",
  approvalRequirementStale: "resync",
  approvalResolving: "resync",
  userInputNotFound: "resync",
  // Terminal, stop: a precondition or a client bug; fix the request.
  parseError: "stop",
  invalidRequest: "stop",
  notInitialized: "stop",
  alreadyInitialized: "stop",
  methodNotFound: "stop",
  invalidParams: "stop",
  internal: "stop",
  pageEventTooLarge: "stop",
  outputResultTooLarge: "stop",
  inputTooLarge: "stop",
  notFound: "stop", // a missing view anchor becomes "resync" below
  sessionNotLoaded: "stop",
  sessionStreamMismatch: "stop",
  computerUseUnavailable: "stop",
  approvalChoiceInvalid: "stop",
};

/** The move for a typed request error. Branches on `kind`, never on message text. */
export function classify(error: MspError): ClientMove {
  // An explicit retryable from the host outranks the table.
  if (error.retryable === true) return "retry";
  if (error.kind === "notFound" && error.data["reason"] === "missingAnchor") return "resync";
  // A newer host can send a kind this table has never seen: terminal until
  // you learn it, unless the host marked it retryable above.
  const known: Readonly<Partial<Record<string, ClientMove>>> = CLIENT_MOVE;
  const move = known[error.kind] ?? "stop";
  return move === "retry" && error.retryable === false ? "stop" : move;
}

/**
 * The second layer. A turn that was accepted can still fail, and that failure
 * is a `turn/completed` on the session view, never an error response. A
 * failed terminal whose error is retryable asks for a NEW turn under a NEW
 * commandId; any other failure is told to the user; everything else settled.
 */
export type TurnMove = "settled" | "newTurn" | "tellTheUser";

export function classifyTerminal(params: Record<string, unknown>): TurnMove {
  if (params["terminal"] !== "failed") return "settled";
  const error = params["error"];
  const retryable = isObject(error) ? error["retryable"] : undefined;
  return retryable === true ? "newTurn" : "tellTheUser";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The transcripts' own client-side values; see the module comment. */
const SESSION_ID = "0198f0aa-1111-7000-8000-0000000000aa";
const WORKSPACE_ROOT = "/home/me/src/proj";
/** `usershell-without-grant`: the gated call. */
const USERSHELL_COMMAND_ID = "018f6a24-9999-7bbb-8ccc-00000000feed";
const USERSHELL_COMMAND_TEXT = "git status";
/** `cursor-never-existed`: a cursor this host never issued. */
const UNISSUED_RESUME_COMMAND_ID = "0198f0ab-8888-7000-8000-0000000000c4";
const UNISSUED_CURSOR = "v10:0198f0aa-2222-7000-8000-0000000000bb:9";
/** `cursor-truncated`: a cursor older than the retained view. */
const STALE_RESUME_COMMAND_ID = "0198f0ab-8888-7000-8000-0000000000c3";
const STALE_CURSOR = "v10:0198f0aa-1111-7000-8000-0000000000aa:3";
/** `goal-missing-goal-rejection`: a session with no goal, then goal/pause. */
const SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1";
const GOAL_PAUSE_COMMAND_ID = "018f6a22-400f-7000-8000-00000000d00f";
/** `provider-failure-turn`: a subscribed view, a failing turn, a new turn. */
const VIEW_SESSION_ID = "018f7294-0000-7000-8000-5f0e73500000";
const VIEW_SUBSCRIBE_AFTER = "v10:018f7294-0000-7000-8000-5f0e73500000:4";
const FAILING_TURN_COMMAND_ID = "018f7294-0000-7000-8000-5f0e73500105";
const FAILING_TURN_PROMPT = "summarize the failing tests";
const NEW_TURN_COMMAND_ID = "018f7294-0000-7000-8000-5f0e73500114";
const NEW_TURN_PROMPT = "try again";

interface Context {
  readonly conformanceBin: string;
  readonly transcriptRoot: string;
  host?: Host;
  sessionId?: string;
  failedTurnId?: string;
}

function requireString(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`${what} is not known: an earlier segment did not finish`);
  return value;
}

/** Run `action` and hand back the MspError it must raise; anything else is a failure. */
async function expectMspError(what: string, action: () => Promise<unknown>): Promise<MspError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof MspError) return error;
    throw error;
  }
  throw new Error(`${what} must answer a typed MSP error; it succeeded instead`);
}

/** Spawn a fresh fixture host for one arm, reclaiming the previous arm's child first. */
function spawnSegment(id: string, scenario: string): Segment<Context> {
  return {
    id,
    title: `Spawn the canned host playing the ${scenario} transcript`,
    async run(context) {
      await context.host?.abandon(CLOSE_BUDGET_MS);
      context.host = undefined;
      context.sessionId = undefined;
      context.failedTurnId = undefined;
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

function drainSegment(arm: string): Segment<Context> {
  return {
    id: `${arm}-drain`,
    title: "Close stdin and let the fixture host exit cleanly",
    async run(context) {
      const host = requireHost(context);
      const exit = await host.close(CLOSE_BUDGET_MS);
      equals(exit.code, 0, "the fixture host's exit code after stdin EOF");
      context.host = undefined;
    },
  };
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "table-covers-the-catalogue",
    title: "The table maps every known error kind to one of the five moves",
    async run() {
      // The compiler checks the keys (`Record<ErrorKind, ClientMove>` refuses a
      // missing kind); the values are checked here, so a typo cannot hide.
      for (const [kind, move] of Object.entries(CLIENT_MOVE)) {
        if (!CLIENT_MOVES.includes(move)) {
          throw new Error(`${kind} maps to ${String(move)}, which is not one of the five moves`);
        }
      }
      equals(CLIENT_MOVE.overloaded, "retry", "the move for overloaded");
      equals(CLIENT_MOVE.commandRejected, "tellTheUser", "the move for commandRejected");
      equals(CLIENT_MOVE.notFound, "stop", "the move for a notFound that names no view anchor");
    },
  },
  {
    id: "moves-off-the-wire",
    title: "The moves for answers no committed transcript produces: overloaded, an explicit retryable, an unknown kind",
    async run() {
      // These errors are built locally from the error objects a host would
      // send, because no committed transcript produces them; the function
      // never looks at anything but the error, so the answer is the same.
      const overloaded = new MspError({
        code: -32001,
        message: "ingress saturated",
        data: { kind: "overloaded" },
      });
      equals(classify(overloaded), "retry", "the move for overloaded");
      // An explicit retryable from the host outranks the table either way.
      const pinned = new MspError({
        code: -32001,
        message: "ingress saturated, do not retry",
        data: { kind: "overloaded", retryable: false },
      });
      equals(classify(pinned), "stop", "the move for overloaded pinned not retryable");
      // A kind this table has never seen is terminal until you learn it. The
      // union has no such member, which is the point: a newer host sends one.
      const unknownData = { kind: "notYetInvented" } as unknown as ErrorObject["data"];
      const unknown = new MspError({ code: -32099, message: "from a newer host", data: unknownData });
      equals(classify(unknown), "stop", "the move for a kind the table does not know");
      // Unless the host says so: an unknown kind marked retryable is a retry,
      // the way a host still starting up answers before it can serve.
      const startingData = { kind: "startupPending", retryable: true } as unknown as ErrorObject["data"];
      const starting = new MspError({ code: -32015, message: "startup pending", data: startingData });
      equals(classify(starting), "retry", "the move for an unknown kind the host marks retryable");
    },
  },
  spawnSegment("capability-spawn", "usershell-without-grant"),
  {
    id: "capability-denied",
    title: "Call a capability-gated method without the grant: capabilityRequired, move reconnect",
    async run(context) {
      const host = requireHost(context);
      // The handshake granted nothing, because this client asked for nothing.
      const granted = host.msp.initializeResult.grantedCapabilities;
      equals(Array.isArray(granted) ? granted.length : 0, 0, "capabilities granted at the handshake");
      const denial = await expectMspError("session/userShell without the grant", () =>
        host.msp.connection.command(
          "session/userShell",
          { sessionId: SESSION_ID, commandText: USERSHELL_COMMAND_TEXT },
          { maxAttempts: 1, commandId: USERSHELL_COMMAND_ID },
        ),
      );
      equals(denial.kind, "capabilityRequired", "the denial's error kind");
      equals(denial.code, -32010, "the denial's JSON-RPC code");
      equals(denial.data["capability"], "userShell", "the capability the denial names");
      equals(denial.retryable, false, "whether the denial is retryable");
      // Terminal for this connection: grants happen only at the handshake,
      // so the client's next move is a new connection that asks for the grant.
      equals(classify(denial), "reconnect", "the move for a missing capability");
    },
  },
  drainSegment("capability"),
  spawnSegment("anchor-spawn", "cursor-never-existed"),
  {
    id: "anchor-missing",
    title: "Resume from a cursor the host never issued: notFound with missingAnchor, move resync",
    async run(context) {
      const host = requireHost(context);
      const refusal = await expectMspError("session/resume with an unissued cursor", () =>
        host.msp.connection.command(
          "session/resume",
          { sessionId: SESSION_ID, cursor: UNISSUED_CURSOR },
          { maxAttempts: 1, commandId: UNISSUED_RESUME_COMMAND_ID },
        ),
      );
      equals(refusal.kind, "notFound", "the refusal's error kind");
      equals(refusal.code, -32011, "the refusal's JSON-RPC code");
      equals(refusal.data["reason"], "missingAnchor", "the refusal's reason");
      equals(refusal.data["sessionId"], SESSION_ID, "the session the refusal names");
      // The reason is what turns a terminal notFound into a resync: the
      // position is wrong, not the reference. Reopen without a cursor.
      equals(classify(refusal), "resync", "the move for a missing view anchor");
    },
  },
  drainSegment("anchor"),
  spawnSegment("truncated-spawn", "cursor-truncated"),
  {
    id: "truncated",
    title: "Resume from a cursor older than the retained view: viewTruncated, move resync",
    async run(context) {
      const host = requireHost(context);
      const refusal = await expectMspError("session/resume with a stale cursor", () =>
        host.msp.connection.command(
          "session/resume",
          { sessionId: SESSION_ID, cursor: STALE_CURSOR },
          { maxAttempts: 1, commandId: STALE_RESUME_COMMAND_ID },
        ),
      );
      equals(refusal.kind, "viewTruncated", "the refusal's error kind");
      equals(refusal.code, -32040, "the refusal's JSON-RPC code");
      // The error says where to resync from: the oldest position still served.
      const earliest = stringAt(refusal.data, "earliestCursor", "the viewTruncated data");
      equals(earliest, "v10:0198f0aa-1111-7000-8000-0000000000aa:200", "the earliest servable cursor");
      equals(classify(refusal), "resync", "the move for a truncated view");
    },
  },
  drainSegment("truncated"),
  spawnSegment("rejected-spawn", "goal-missing-goal-rejection"),
  {
    id: "rejected-session",
    title: "Start a session that has no goal",
    async run(context) {
      const host = requireHost(context);
      const started = await host.msp.connection.command(
        "session/start",
        { sessionId: SESSION_ID, workspaceRoot: WORKSPACE_ROOT },
        { maxAttempts: 1, commandId: SESSION_START_COMMAND_ID },
      );
      const session = objectAt(started, "session", "session/start result");
      context.sessionId = stringAt(session, "sessionId", "session/start session");
    },
  },
  {
    id: "rejected",
    title: "Pause the goal that does not exist: commandRejected, move tellTheUser",
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireString(context.sessionId, "the session id");
      const rejection = await expectMspError("goal/pause with no goal set", () =>
        host.msp.connection.command(
          "goal/pause",
          { sessionId },
          { maxAttempts: 1, commandId: GOAL_PAUSE_COMMAND_ID },
        ),
      );
      equals(rejection.kind, "commandRejected", "the rejection's error kind");
      equals(rejection.code, -32030, "the rejection's JSON-RPC code");
      equals(rejection.data["reason"], "missing_goal", "the rejection's reason");
      equals(rejection.data["commandId"], GOAL_PAUSE_COMMAND_ID, "the command the rejection settles");
      equals(rejection.retryable, false, "whether the rejection is retryable");
      // Durable and user-facing: the same commandId gets the same answer, so
      // the client tells the user and leaves the composer as it was.
      equals(classify(rejection), "tellTheUser", "the move for a durable rejection");
    },
  },
  drainSegment("rejected"),
  spawnSegment("view-spawn", "provider-failure-turn"),
  {
    id: "view-subscribe",
    title: "Subscribe to the session view the turn will report on",
    async run(context) {
      const host = requireHost(context);
      const subscribed = await host.msp.connection.request("view/subscribe", {
        sessionId: VIEW_SESSION_ID,
        after: VIEW_SUBSCRIBE_AFTER,
      });
      stringAt(subscribed, "viewCursor", "view/subscribe result");
    },
  },
  {
    id: "view-turn-fails",
    title: "An accepted turn fails on the view, not as an error response: move newTurn",
    async run(context) {
      const host = requireHost(context);
      // The request itself is answered with a result: admission accepted it.
      const ack = await host.msp.connection.command(
        "turn/start",
        { sessionId: VIEW_SESSION_ID, input: [{ type: "text", text: FAILING_TURN_PROMPT }] },
        { maxAttempts: 1, commandId: FAILING_TURN_COMMAND_ID },
      );
      equals(ack["status"], "accepted", "turn/start ack status");
      const turnId = stringAt(ack, "turnId", "turn/start ack");
      // The failure arrives later, on the view, as the turn's terminal.
      const completed = await host.waitFor(
        "the failing turn's terminal",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" && notification.params["turnId"] === turnId,
      );
      equals(completed.params["terminal"], "failed", "the failing turn's terminal");
      const error = objectAt(completed.params, "error", "the failed turn/completed params");
      equals(error["kind"], "modelError", "the terminal's error kind");
      equals(error["retryable"], true, "whether the terminal's error is retryable");
      // The turn is over; a retryable terminal asks for a NEW turn, never a
      // replay of this commandId.
      equals(classifyTerminal(completed.params), "newTurn", "the move for a retryable failed terminal");
      context.failedTurnId = turnId;
    },
  },
  {
    id: "view-new-turn",
    title: "Retry as a new turn under a new commandId, and watch it complete",
    async run(context) {
      const host = requireHost(context);
      const failedTurnId = requireString(context.failedTurnId, "the failed turn's id");
      const ack = await host.msp.connection.command(
        "turn/start",
        { sessionId: VIEW_SESSION_ID, input: [{ type: "text", text: NEW_TURN_PROMPT }] },
        { maxAttempts: 1, commandId: NEW_TURN_COMMAND_ID },
      );
      equals(ack["status"], "accepted", "the new turn/start ack status");
      const turnId = stringAt(ack, "turnId", "the new turn/start ack");
      if (turnId === failedTurnId) throw new Error("the retry must be a new turn, not the failed one");
      const completed = await host.waitFor(
        "the new turn's terminal",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" && notification.params["turnId"] === turnId,
      );
      equals(completed.params["terminal"], "completed", "the new turn's terminal");
      equals(classifyTerminal(completed.params), "settled", "the move for a completed terminal");
    },
  },
  drainSegment("view"),
];

export const handleErrorsByClass: Recipe = {
  id: "handle-errors-by-class",
  title: "Handle errors by class",
  docsPage: "developer-docs/src/content/docs/cookbook/handle-errors-by-class.mdx",
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
