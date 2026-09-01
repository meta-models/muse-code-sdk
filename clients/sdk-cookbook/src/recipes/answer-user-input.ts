/**
 * Recipe: answer the agent's question (userInput).
 *
 * Runs against `muse-conformance serve-fixture` playing the committed golden
 * transcript `schema/msp/transcripts/userinput-answer-round-trip`, so this
 * recipe is deterministic and needs no credentials and no model.
 *
 * What it teaches (and what the docs page walks through):
 *  - mid-turn the agent can stop and ask the USER a structured question via
 *    the `request_user_input` tool. Like an approval, the ask arrives twice
 *    for two audiences: `userInput/requested` is a view-stream event for your
 *    UI, and `userInput/request` is a JSON-RPC request the SDK must answer.
 *    If you never register a server-request handler, the SDK answers "method
 *    not found" on your behalf — so answer it. The reply means "this client
 *    is showing the question", NOT "here is the answer".
 *  - a pending question SURVIVES the client: this transcript resumes an
 *    existing session and finds the question waiting in the resume result's
 *    `pendingRequests`, after which the host re-issues `userInput/request`
 *    to the late joiner.
 *  - answer with `userInput/answer`, picking a `selectedLabel` the host
 *    OFFERED in the question's `options`. Do not invent one.
 *  - the ack is not the outcome. `userInput/settled` is where the outcome,
 *    the recorded answers, and the deciding command land; then the tool call
 *    completes with the answer as its visible output and the turn runs on to
 *    its own terminal.
 *
 * Fixture mechanics, so the code below reads honestly: serve-fixture matches
 * our frames structurally against the transcript's client lines and then
 * replays the recorded server lines byte-exactly. This transcript recorded
 * plain sequential client request ids, so the SDK's default minter correlates
 * every reply and no recorded-id seam is needed — but acks echo the RECORDED
 * commandId, and `Connection.command` verifies that echo, so each command
 * below passes the transcript's commandId explicitly. Values we learn from
 * the wire (userInputId, turnId, question ids) are used as received, exactly
 * as a real client uses them.
 *
 * The two writes around the server request are ORDERED, and the fixture
 * enforces it: the transcript records our reply to `userInput/request` before
 * our next request, so a command that overtakes the reply is a frame
 * divergence at that line, not a tolerated reordering. The connection writes
 * the reply on the microtask AFTER the handler settles, so the handler's
 * signal is deliberately scheduled one hop late, and the next segment then
 * flushes before writing anything else — the same deterministic ordering the
 * approve-or-deny recipe uses, with no timing constants.
 */

import { Host, arrayAt, equals, objectAt, requireHost, stringAt, within } from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

/**
 * The transcript's own client-side values. A real client knows the session id
 * because it persisted it when the session started; the commandIds are the
 * recorded ones because the canned host's acks echo them (see the module
 * comment).
 */
const SESSION_ID = "0198f0aa-1111-7000-8000-0000000000bb";
const SESSION_RESUME_COMMAND_ID = "0198f0ab-8888-7000-8000-0000000000d2";
const USER_INPUT_ANSWER_COMMAND_ID = "018f6a2b-3333-7abc-8def-00000000d002";

/** The answer this recipe picks; asserted to be a label the host offered. */
const ANSWER_LABEL = "Postgres";

interface Context {
  readonly conformanceBin: string;
  readonly transcriptRoot: string;
  host?: Host;
  /** Settles with the `userInput/request` params once the host asks. */
  asked?: Promise<Record<string, unknown>>;
  /** Settles once the reply to `userInput/request` has been written. */
  answered?: Promise<void>;
  /** From the resume result's `pendingRequests`. */
  pendingUserInputId?: string;
  /** From the `userInput/request` params, used as received. */
  userInputId?: string;
  turnId?: string;
  itemId?: string;
  questionId?: string;
}

function requireString(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`${what} is not known: an earlier segment did not finish`);
  return value;
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "spawn",
    title: "Spawn the canned host playing the userinput-answer-round-trip transcript",
    async run(context) {
      const host = await Host.spawn(
        {
          command: context.conformanceBin,
          args: [
            "serve-fixture",
            "--transcript",
            `${context.transcriptRoot}/userinput-answer-round-trip`,
          ],
          env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          clientInfo: { name: "conformance", version: "0.0.0" },
        },
        HANDSHAKE_BUDGET_MS,
      );
      // Answer `userInput/request` — the JSON-RPC request half of the ask.
      // The reply is an empty acknowledgement: it means "this client is
      // showing the question to the user", NOT an answer. The actual answer
      // travels separately as `userInput/answer`. Registered before the
      // resume is sent, because the host re-issues the pending request the
      // moment the resume completes.
      //
      // The `replied` signal is scheduled one microtask late on purpose: the
      // connection writes the reply on the microtask AFTER this handler
      // settles, and resolving inline would let the journey continue while
      // the reply write was still unqueued — see the module comment.
      let received: (params: Record<string, unknown>) => void = () => {};
      context.asked = new Promise<Record<string, unknown>>((resolve) => {
        received = resolve;
      });
      let replied = (): void => {};
      context.answered = new Promise<void>((resolve) => {
        replied = () => {
          resolve();
        };
      });
      host.msp.connection.onServerRequest(async (request) => {
        // Check the method, exactly as the page teaches: one handler serves
        // the whole connection, so a bare `{}` ack would also tell the host
        // this client is handling requests it has no UI for. The canned
        // transcript only ever sends `userInput/request`, so the throw arm
        // is never taken during replay.
        if (request.method !== "userInput/request") {
          throw new Error(`unhandled server request: ${request.method}`);
        }
        received((request.params ?? {}) as Record<string, unknown>);
        queueMicrotask(() => {
          replied();
        });
        return {};
      });
      context.host = host;
    },
  },
  {
    id: "resume",
    title: "Resume the session and find the question waiting in pendingRequests",
    async run(context) {
      const host = requireHost(context);
      const resumed = await host.msp.connection.command(
        "session/resume",
        { sessionId: SESSION_ID, excludeItems: true },
        { maxAttempts: 1, commandId: SESSION_RESUME_COMMAND_ID },
      );
      const session = objectAt(resumed, "session", "session/resume result");
      equals(session["sessionId"], SESSION_ID, "the resumed session's id");
      // A question the user has not answered holds the turn open, so the
      // session comes back running, not idle.
      equals(session["status"], "running", "the resumed session's status");
      // This is the field a resuming client must read: unanswered requests
      // survive the client that received them first, and a UI that skips
      // this list resumes into a turn that looks stuck for no reason.
      const pending = arrayAt(resumed, "pendingRequests", "session/resume result");
      const userInput = pending.find(
        (entry) => (entry as Record<string, unknown>)["kind"] === "userInput",
      );
      if (userInput === undefined) {
        throw new Error(
          `the resume result lists no pending userInput request; it listed ${JSON.stringify(pending)}`,
        );
      }
      context.pendingUserInputId = stringAt(
        userInput as Record<string, unknown>,
        "userInputId",
        "a pendingRequests entry",
      );
    },
  },
  {
    id: "question",
    title: "Take the re-issued userInput/request and read the offered options",
    async run(context) {
      if (context.asked === undefined) throw new Error("`spawn` did not finish");
      const pendingUserInputId = requireString(
        context.pendingUserInputId,
        "the pending userInputId",
      );
      const params = await within("the userInput/request from the host", COMMAND_BUDGET_MS, context.asked);
      equals(params["sessionId"], SESSION_ID, "the question's session id");
      // The re-issued request IS the pending one the resume result named:
      // same userInputId, so a client that tracked the pending list can tell
      // it is not being asked something new.
      const userInputId = stringAt(params, "userInputId", "userInput/request params");
      equals(userInputId, pendingUserInputId, "the re-issued request's userInputId");
      context.userInputId = userInputId;
      context.turnId = stringAt(params, "turnId", "userInput/request params");
      // The item the question belongs to: the `request_user_input` tool call
      // that completes once the answer settles.
      context.itemId = stringAt(params, "itemId", "userInput/request params");

      // What a UI puts in front of the user: the questions, each with the
      // options the host offered. Pick from what was OFFERED. A hardcoded
      // label is the bug this assertion exists to catch: the options come
      // from the agent's own question, so a client that assumes one can send
      // an answer the host will reject.
      const questions = arrayAt(params, "questions", "userInput/request params");
      const first = questions[0];
      if (first === undefined) {
        throw new Error("the userInput/request carried no questions");
      }
      const question = first as Record<string, unknown>;
      context.questionId = stringAt(question, "id", "the first question");
      stringAt(question, "question", "the first question");
      const selection = objectAt(question, "selection", "the first question");
      equals(selection["mode"], "single", "the first question's selection mode");
      const options = arrayAt(question, "options", "the first question");
      const offered = options.map((option) =>
        stringAt(option as Record<string, unknown>, "label", "an options entry"),
      );
      if (!offered.includes(ANSWER_LABEL)) {
        throw new Error(
          `the host did not offer "${ANSWER_LABEL}"; it offered ${JSON.stringify(offered)}`,
        );
      }
      // The page teaches this field as a UI deadline, so the journey pins it.
      // Only the field's presence and value are pinnable here: the timedOut
      // settlement arm needs its own golden transcript (#26035).
      equals(params["autoResolutionMs"], 120_000, "the question's auto-resolution window");
    },
  },
  {
    id: "backfill",
    title: "Reply first, then page the view the question came from",
    async run(context) {
      const host = requireHost(context);
      const userInputId = requireString(context.userInputId, "the userInputId");
      // Reply first, next request second — see the module comment. Bounded,
      // so a handler that never fires reports that instead of hanging.
      if (context.answered === undefined) throw new Error("`spawn` did not finish");
      await within("the reply to userInput/request", COMMAND_BUDGET_MS, context.answered);
      await host.msp.connection.flush();
      // The resume above excluded items, so the UI has nothing to render
      // yet. `view/page` backfills it — and the question is IN the view, as
      // a `userInput/requested` event after the tool call that asked it, so
      // a client rendering the view shows the question in place.
      const page = await host.msp.connection.request("view/page", {
        sessionId: SESSION_ID,
        direction: "forward",
        limit: 200,
      });
      const events = arrayAt(page, "events", "view/page result");
      const requested = events.find(
        (event) => (event as Record<string, unknown>)["method"] === "userInput/requested",
      );
      if (requested === undefined) {
        throw new Error("the paged view carries no userInput/requested event");
      }
      const requestedParams = objectAt(
        requested as Record<string, unknown>,
        "params",
        "the userInput/requested event",
      );
      equals(requestedParams["userInputId"], userInputId, "the viewed question's userInputId");
    },
  },
  {
    id: "answer",
    title: `Answer with "${ANSWER_LABEL}"`,
    async run(context) {
      const host = requireHost(context);
      const userInputId = requireString(context.userInputId, "the userInputId");
      const questionId = requireString(context.questionId, "the question id");
      const ack = await host.msp.connection.command(
        "userInput/answer",
        {
          sessionId: SESSION_ID,
          userInputId,
          answers: [{ questionId, selectedLabel: ANSWER_LABEL }],
        },
        { maxAttempts: 1, commandId: USER_INPUT_ANSWER_COMMAND_ID },
      );
      equals(ack["status"], "accepted", "userInput/answer ack status");
      equals(ack["userInputId"], userInputId, "the userInputId the ack echoes");
    },
  },
  {
    id: "settled",
    title: "Read the outcome off userInput/settled, then let the turn finish",
    async run(context) {
      const host = requireHost(context);
      const userInputId = requireString(context.userInputId, "the userInputId");
      const questionId = requireString(context.questionId, "the question id");
      const itemId = requireString(context.itemId, "the tool call's itemId");
      const turnId = requireString(context.turnId, "the turn id");
      const settled = await host.waitFor(
        "the userInput/settled notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "userInput/settled" &&
          notification.params["userInputId"] === userInputId,
      );
      // The ack said "accepted". THIS says how the question ended: answered
      // by a user, with which answers, decided by which command.
      equals(settled.params["outcome"], "answered", "the settlement outcome");
      const answers = arrayAt(settled.params, "answers", "userInput/settled params");
      const answer = answers[0] as Record<string, unknown> | undefined;
      if (answer === undefined) {
        throw new Error("the settlement carried no answers");
      }
      equals(answer["questionId"], questionId, "the settled answer's questionId");
      equals(answer["selectedLabel"], ANSWER_LABEL, "the settled answer's selectedLabel");
      equals(
        settled.params["decidedByCommandId"],
        USER_INPUT_ANSWER_COMMAND_ID,
        "the command the settlement credits",
      );

      // The question was a tool call, and the answer is its result: the item
      // completes with the selected label as its visible output.
      const completed = await host.waitFor(
        "the tool call's item/completed notification",
        COMMAND_BUDGET_MS,
        (notification) => {
          if (notification.method !== "item/completed") return false;
          const item = notification.params["item"] as Record<string, unknown> | undefined;
          return item?.["itemId"] === itemId;
        },
      );
      const item = objectAt(completed.params, "item", "item/completed params");
      equals(item["status"], "completed", "the tool call's status");
      equals(item["visibleOutput"], ANSWER_LABEL, "the tool call's visible output");

      // Answering unblocks the agent: the turn runs on to its own terminal.
      const turn = await host.waitFor(
        "the turn/completed notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" && notification.params["turnId"] === turnId,
      );
      equals(turn.params["terminal"], "completed", "the turn's terminal");
    },
  },
  {
    id: "drain",
    title: "Close stdin and let the fixture host exit cleanly",
    async run(context) {
      const host = requireHost(context);
      const exit = await host.close(CLOSE_BUDGET_MS);
      equals(exit.code, 0, "the fixture host's exit code after stdin EOF");
      // Only the host slot, so journey-end teardown does not re-abandon a
      // host this segment already closed cleanly.
      context.host = undefined;
    },
  },
];

export const answerUserInput: Recipe = {
  id: "answer-user-input",
  title: "Answer the agent's question (userInput)",
  docsPage: "developer-docs/src/content/docs/cookbook/answer-the-agents-question.mdx",
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
