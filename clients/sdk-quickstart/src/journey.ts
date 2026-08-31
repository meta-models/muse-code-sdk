/**
 * The `@muse-code/sdk` first-session journey, end to end, against a release-built
 * `tbh serve`.
 *
 * This is the acceptance artifact for issue #21932: it is cited as proof that
 * the SDK works, so it holds itself to two rules.
 *
 * 1. **Every assertion states the spec-correct behavior.** Where today's host
 *    is wrong, the segment carries an `expectBlock` naming the open issue.
 *    Nothing here pins a known-wrong result as golden — a journey that froze
 *    today's resume state would become the thing that blocks the fix.
 * 2. **An expect-block cannot rot.** It names the issues, and it names the
 *    SIGNATURE of the failure those issues cause. A failure that does not
 *    match the signature is a real failure, not an excused one. A segment
 *    that starts passing while blocked FAILS the journey so it gets promoted.
 *
 * As of the #24410 clause-4 promotion NOTHING here is expect-blocked: #19535,
 * #19806 and #18945 all landed, and all twelve segments are required. Rule 2
 * is what surfaced that — the journey reported all six blocks `unblocked` the
 * first time it ran against a host with a provider configured. Rule 1 is why
 * the promotion was a deletion and not a rewrite: no assertion had been bent
 * to match the blocked behavior, so there was nothing to unbend.
 *
 * The journey has two modes. {@link runConfiguredJourney} is the ACCEPTANCE
 * mode: it seeds `JourneyOptions.home` with a HOME pointing at a loopback fake
 * first-party endpoint (`provider.ts`), so the host really runs a model and
 * every segment is exercised. {@link runJourney} with no seeded `home` is the
 * credential-free degradation path — still supported, never the acceptance
 * artifact.
 *
 * Read `README.md` next to this file for the same journey in plain words.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXPECTED_SCHEMA_FINGERPRINT, MspError } from "@muse-code/sdk";

import {
  Host,
  STUB_VIEW_CURSOR,
  arrayAt,
  equals,
  objectAt,
  stringAt,
} from "./host.js";
import type { RecordedNotification } from "./host.js";
import { startConfiguredProvider } from "./provider.js";
import { runJourney as runKitJourney } from "./segments.js";
import type { JourneyReport, Segment } from "./segments.js";

/**
 * How this journey identifies itself to the host's session/audit attribution.
 * Named at both spawn sites rather than defaulted in the kit, so a cookbook
 * recipe can never inherit the quickstart's identity by omission (T-24225-6).
 */
const QUICKSTART_CLIENT_INFO = { name: "muse-sdk-quickstart", version: "0.0.0" };

/**
 * The artifact the approval prompt asks for. The provider-configured mode
 * routes its ONE scripted `shell` tool call on this name plus the tool's own,
 * so the discriminator and the prompt can never drift apart.
 */
const APPROVAL_ARTIFACT = "approved.txt";

/** The prompt every turn segment sends. Plain, deterministic, harmless. */
const PROMPT = "Reply with the single word: hello";
/** The single word {@link PROMPT} asks for, and what the fake provider replies. */
const REPLY_TEXT = "hello";
/** A prompt that must make the agent ask permission before touching the disk. */
const APPROVAL_PROMPT = `Create a file called ${APPROVAL_ARTIFACT} containing the word yes`;

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const STREAM_BUDGET_MS = 60_000;
const CLOSE_BUDGET_MS = 30_000;

export interface JourneyOptions {
  /** Absolute path to the release-built binary under test. */
  readonly museBin: string;
  /**
   * Isolated HOME. Defaults to a fresh temp dir, which is the CREDENTIAL-FREE
   * degradation path: with no provider configured the host cannot run a model,
   * so the six model-dependent segments fail for real. The acceptance run uses
   * {@link runConfiguredJourney}, which seeds this with a HOME pointing at a
   * loopback fake first-party endpoint.
   */
  readonly home?: string;
  /** Workspace root a session is started in. Defaults to a fresh temp dir. */
  readonly workspaceRoot?: string;
}

/** Everything the segments read and write as the journey proceeds. */
interface Context {
  readonly museBin: string;
  readonly home: string;
  readonly workspaceRoot: string;
  /** The session started by `session-new` and resumed later. */
  sessionId?: string;
  /** The live host segments 1-4 share; closed before the resume segments. */
  host?: Host;
  /** The resume host, opened by `resume` and closed by `terminate`. */
  resumeHost?: Host;
  /** The `session/resume` result the resume segments all read. */
  resumed?: Record<string, unknown>;
}

function agentText(notification: RecordedNotification): string | undefined {
  const item = notification.params["item"];
  if (item === null || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  if (record["kind"] !== "agentMessage") return undefined;
  return typeof record["text"] === "string" ? record["text"] : undefined;
}

function requireHost(context: Context): Host {
  const host = context.host;
  if (host === undefined) throw new Error("no live host: an earlier segment did not finish");
  return host;
}

function requireSessionId(context: Context): string {
  const sessionId = context.sessionId;
  if (sessionId === undefined) throw new Error("no session: `session-new` did not finish");
  return sessionId;
}

/**
 * Runs one complete turn on the given host and returns the `turn/completed`
 * notification. Shared by the turn, approval and cancel segments so all three
 * observe the same streaming contract.
 */
async function startTurn(
  host: Host,
  sessionId: string,
  prompt: string,
): Promise<{ turnId: string }> {
  const ack = await host.msp.connection.command(
    "turn/start",
    { sessionId, input: [{ type: "text", text: prompt }] },
    { maxAttempts: 1 },
  );
  equals(ack["status"], "accepted", "turn/start ack status");
  // `started` and `queued` are BOTH correct answers, so pinning `started` was a
  // real-bug detector that also fired on legal behavior. When `turn/start` lands
  // after the previous turn completed but before the session settles to idle,
  // the host mints a queued turn instead of a fresh one — the ack then says
  // `queued` with `startedNewTurn: false`, and its `turnId` names the queued
  // stream, never the running turn (`turn_start_ack_disposition`, tdd SS3.1.4).
  // Either way the turn is admitted and `turn/started` still fires for that id,
  // so the journey's contract holds. `steered` is deliberately NOT accepted: it
  // merges into a RUNNING turn, which is not what any segment here asks for.
  const disposition = ack["disposition"];
  if (disposition !== "started" && disposition !== "queued") {
    throw new Error(
      `turn/start ack disposition: expected "started" or "queued", got ${JSON.stringify(disposition)}`,
    );
  }
  equals(ack["startedNewTurn"], disposition === "started", "turn/start ack startedNewTurn");
  return { turnId: stringAt(ack, "turnId", "turn/start ack") };
}

/** Fails with the host's own reason text when a turn ends non-`completed`. */
function requireTerminal(
  completed: RecordedNotification,
  expected: string,
): void {
  const terminal = completed.params["terminal"];
  if (terminal !== expected) {
    const reason = completed.params["reason"];
    throw new Error(
      `turn/completed terminal was ${JSON.stringify(terminal)}, expected ${JSON.stringify(expected)}` +
        (typeof reason === "string" ? `; host reason: ${reason}` : ""),
    );
  }
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "spawn",
    title: "Spawn the release-built host and keep it alive",
    async run(context) {
      // Host.start spawns and handshakes in one step, which is what a
      // consumer writes. Spawn is proven by the handshake answering at all:
      // a host that dies on launch (closed SDK gate = exit 5, bad config =
      // exit 3) surfaces its classified exit here instead of a hang.
      context.host = await Host.start(
        {
          museBin: context.museBin,
          home: context.home,
          workspaceRoot: context.workspaceRoot,
          clientInfo: QUICKSTART_CLIENT_INFO,
        },
        HANDSHAKE_BUDGET_MS,
      );
    },
  },
  {
    id: "handshake",
    title: "The handshake result describes the host and matches the SDK's schema pin",
    async run(context) {
      const host = requireHost(context);
      const result = host.msp.initializeResult as unknown as Record<string, unknown>;
      const serverInfo = objectAt(result, "serverInfo", "initialize result");
      stringAt(serverInfo, "name", "initialize serverInfo");
      stringAt(serverInfo, "version", "initialize serverInfo");
      stringAt(result, "museHome", "initialize result");
      stringAt(result, "sessionDurability", "initialize result");
      const schema = objectAt(result, "schema", "initialize result");
      equals(
        stringAt(schema, "fingerprint", "initialize schema"),
        EXPECTED_SCHEMA_FINGERPRINT,
        "the served schema fingerprint vs the fingerprint @muse-code/sdk pins",
      );
      // A mismatch is a warning, never an error (tdd SS1.4.1) — so the
      // equality above is what actually binds, and this asserts the SDK drew
      // the same conclusion.
      equals(host.msp.fingerprintWarning, undefined, "SDK fingerprint warning");
    },
  },
  {
    id: "session-new",
    title: "Start a new session in the workspace",
    async run(context) {
      const host = requireHost(context);
      const result = await host.msp.connection.command(
        "session/start",
        { workspaceRoot: context.workspaceRoot },
        { maxAttempts: 1 },
      );
      const session = objectAt(result, "session", "session/start result");
      const sessionId = stringAt(session, "sessionId", "session/start session");
      equals(session["status"], "idle", "a fresh session's status");
      equals(
        session["workspaceRoot"],
        context.workspaceRoot,
        "the session's workspace root",
      );
      // A DEFAULT start writes no durable fact, so the served fold has no
      // view events yet and the cursor is pinned to exactly the before-genesis
      // `""` (tdd SS2.5.1/SS4.1 as amended by #24240; D-044) — the same pin
      // the serve assembly asserts. `stringAt`'s non-empty read predated the
      // amendment and rejected the legitimate `""` (#26057); the exact pin
      // also rejects the pre-Seam-C stub sentinel and any wrongly-minted
      // non-empty cursor.
      const cursor = result["viewCursor"];
      equals(cursor, "", "a default start's before-genesis view cursor");
      // The push side of the same fact: the host announces the session it
      // just created, and it is the same session.
      const started = await host.waitFor(
        "the session/started notification",
        COMMAND_BUDGET_MS,
        (notification) => notification.method === "session/started",
      );
      const announced = objectAt(started.params, "session", "session/started params");
      equals(announced["sessionId"], sessionId, "the announced session id");

      context.sessionId = sessionId;
      // NOTE: the committed golden `schema/msp/transcripts/session-start`
      // also carries `approvalMode` in this result; the release host omits it
      // here and pushes `session/approvalModeChanged` instead. That deviation
      // has no owning issue yet, so it is reported rather than asserted — see
      // the #21932 PR body.
    },
  },
  {
    id: "session-effective-model",
    title: "The new session names the provider and model it will actually use",
    // No `expectBlock`: #19806 landed, an MSP session carries its effective
    // model, and the anchored journey requires it (#24410 clause 4).
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireSessionId(context);
      const read = await host.msp.connection.request("session/read", {
        sessionId,
        excludeItems: true,
      });
      const session = objectAt(read, "session", "session/read result");
      stringAt(session, "providerId", "session/read session");
      stringAt(session, "modelId", "session/read session");
    },
  },
  {
    id: "turn",
    title: "Send a prompt and receive the agent's answer as a stream",
    // No `expectBlock`: #19535 landed, a configured serve host runs the model,
    // and the anchored journey requires the streamed answer (#24410 clause 4).
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireSessionId(context);
      const { turnId } = await startTurn(host, sessionId, PROMPT);

      await host.waitFor(
        "the turn/started notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/started" && notification.params["turnId"] === turnId,
      );
      const completed = await host.waitFor(
        "the turn/completed notification",
        STREAM_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" && notification.params["turnId"] === turnId,
      );
      requireTerminal(completed, "completed");

      // The turn is only useful if the agent actually said something, and it
      // must have arrived incrementally, not in one final lump.
      const deltas = host
        .notifications()
        .filter((notification) => notification.method === "item/delta");
      if (deltas.length === 0) {
        throw new Error("the turn completed without streaming a single item/delta");
      }
      const answers = host.notifications().map(agentText).filter((text) => text !== undefined);
      const answer = answers.at(-1);
      if (answer === undefined || answer.length === 0) {
        throw new Error("the turn completed without a non-empty agentMessage item");
      }
    },
  },
  {
    id: "approval",
    title: "Answer the agent's permission request and see it resolved",
    // No `expectBlock`: #19535 landed, the agent reaches the tool, and the
    // anchored journey requires the approval round trip (#24410 clause 4).
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireSessionId(context);
      const { turnId } = await startTurn(host, sessionId, APPROVAL_PROMPT);

      // Racing turn/completed against approval/requested turns "the turn died
      // before asking" into that sentence rather than a bare timeout.
      const event = await host.waitFor(
        "an approval/requested notification",
        STREAM_BUDGET_MS,
        (notification) =>
          notification.method === "approval/requested" ||
          (notification.method === "turn/completed" && notification.params["turnId"] === turnId),
      );
      if (event.method !== "approval/requested") {
        const reason = event.params["reason"];
        throw new Error(
          `the turn ended before asking for approval` +
            (typeof reason === "string" ? `; host reason: ${reason}` : ""),
        );
      }

      const approvalId = stringAt(event.params, "approvalId", "approval/requested params");
      const decided = await host.msp.connection.command(
        "approval/decide",
        {
          sessionId,
          approvalId,
          requirementId: { approvalId, sourceIndex: 0 },
          choiceId: "allow_once",
          feedback: null,
        },
        { maxAttempts: 1 },
      );
      equals(decided["terminal"], true, "the approval decision is terminal");
      const resolved = await host.waitFor(
        "the approval/resolved notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "approval/resolved" &&
          notification.params["approvalId"] === approvalId,
      );
      equals(resolved.params["approvalId"], approvalId, "the resolved approval id");
    },
  },
  {
    id: "cancel",
    title: "Cancel a turn while it is running",
    // No `expectBlock`: #19535 landed and the anchored journey requires a real
    // cancellation (#24410 clause 4). The block's second arm excused an
    // `already_terminal` race the retired logged-out provider caused by failing
    // every turn in milliseconds; the provider-configured mode removes that
    // race at the source by keeping the turn in flight (see `provider.ts`
    // `HOLD_MS`) rather than re-importing the excuse.
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireSessionId(context);
      const { turnId } = await startTurn(host, sessionId, PROMPT);
      await host.waitFor(
        "the turn/started notification",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "turn/started" && notification.params["turnId"] === turnId,
      );

      // The turn must still be running when the cancel lands. A turn that
      // already reached a terminal state cannot prove cancellation.
      const alreadyDone = host
        .notifications()
        .find(
          (notification) =>
            notification.method === "turn/completed" && notification.params["turnId"] === turnId,
        );
      if (alreadyDone !== undefined) {
        const reason = alreadyDone.params["reason"];
        throw new Error(
          `the turn reached ${JSON.stringify(alreadyDone.params["terminal"])} before it could be cancelled` +
            (typeof reason === "string" ? `; host reason: ${reason}` : ""),
        );
      }

      await host.msp.connection.command(
        "turn/cancel",
        { sessionId, turnId },
        { maxAttempts: 1 },
      );
      const completed = await host.waitFor(
        "the cancelled turn/completed notification",
        STREAM_BUDGET_MS,
        (notification) =>
          notification.method === "turn/completed" && notification.params["turnId"] === turnId,
      );
      requireTerminal(completed, "cancelled");
    },
  },
  {
    id: "resume",
    title: "Close the host, reopen it, and load the same session with its state",
    async run(context) {
      // The session lease belongs to the live host, so the first one has to
      // drain cleanly before a second can load the session. That drain is
      // itself the spec-14990 Scenario-4.4 contract: stdin closed, orderly
      // drain, exit 0.
      const first = requireHost(context);
      const firstExit = await first.close(CLOSE_BUDGET_MS);
      equals(firstExit.code, 0, "the first host's exit code after stdin EOF");
      context.host = undefined;

      const sessionId = requireSessionId(context);
      const host = await Host.start(
        {
          museBin: context.museBin,
          home: context.home,
          workspaceRoot: context.workspaceRoot,
          clientInfo: QUICKSTART_CLIENT_INFO,
        },
        HANDSHAKE_BUDGET_MS,
      );
      context.resumeHost = host;

      const resumed = await host.msp.connection.command(
        "session/resume",
        { sessionId, excludeItems: false },
        { maxAttempts: 1 },
      );
      context.resumed = resumed;

      const session = objectAt(resumed, "session", "session/resume result");
      equals(session["sessionId"], sessionId, "the resumed session id");
      equals(
        session["workspaceRoot"],
        context.workspaceRoot,
        "the resumed workspace root",
      );
      const cursor = stringAt(resumed, "viewCursor", "session/resume result");
      if (cursor === STUB_VIEW_CURSOR) {
        throw new Error(`session/resume returned the pre-Seam-C stub cursor ${cursor}`);
      }
      const history = objectAt(resumed, "history", "session/resume result");
      equals(history["mode"], "inline", "the resumed history mode for an include-items resume");
      arrayAt(history, "items", "session/resume history");
      arrayAt(resumed, "pendingRequests", "session/resume result");
    },
  },
  {
    id: "resume-effective-model",
    title: "The resumed session still names the provider and model it will use",
    // No `expectBlock`: #19806 landed, a loaded session restores its effective
    // model, and the anchored journey requires it (#24410 clause 4).
    async run(context) {
      const resumed = context.resumed;
      if (resumed === undefined) throw new Error("`resume` did not finish");
      const session = objectAt(resumed, "session", "session/resume result");
      stringAt(session, "providerId", "resumed session");
      stringAt(session, "modelId", "resumed session");
    },
  },
  {
    id: "resume-history",
    title: "The resumed history carries the turn that already happened",
    // No `expectBlock`: #19535 and #18945 landed, a resumed session replays the
    // agent's own messages, and the anchored journey requires it (#24410
    // clause 4).
    async run(context) {
      const resumed = context.resumed;
      if (resumed === undefined) throw new Error("`resume` did not finish");
      const history = objectAt(resumed, "history", "session/resume result");
      const items = arrayAt(history, "items", "session/resume history");
      const kinds = items.map((item) =>
        item !== null && typeof item === "object"
          ? (item as Record<string, unknown>)["kind"]
          : undefined,
      );
      if (!kinds.includes("userMessage")) {
        throw new Error(
          `resumed history has no userMessage; kinds were ${JSON.stringify(kinds)}`,
        );
      }
      if (!kinds.includes("agentMessage")) {
        throw new Error(
          `resumed history has no agentMessage; kinds were ${JSON.stringify(kinds)}`,
        );
      }
    },
  },
  {
    id: "resume-rejects-unknown-cursor",
    title: "Resuming from a cursor that never existed is refused",
    // No `expectBlock`: #19649 landed, `session/resume` honours `cursor`, and
    // the journey's own staleness subtest promoted this segment (#23839).
    async run(context) {
      const host = context.resumeHost;
      if (host === undefined) throw new Error("`resume` did not finish");
      const sessionId = requireSessionId(context);
      // A cursor for a different session at an impossible sequence. No host
      // can ever have minted it.
      const impossible = `v:${sessionId}:999999`;
      let result: Record<string, unknown> | undefined;
      try {
        result = await host.msp.connection.command(
          "session/resume",
          { sessionId, cursor: impossible, excludeItems: false },
          { maxAttempts: 1 },
        );
      } catch (error) {
        // ONLY the pinned refusal counts. A bare `instanceof MspError` lets any
        // unrelated protocol error (invalidParams, internal, a lease failure)
        // read as a correct refusal, so this segment would stay green on
        // MspError-shaped breakage once the expect-block comes off.
        // The shape is `notFound` / -32011 (spec 13929 tdd.md, resume cursor rules).
        if (error instanceof MspError && error.kind === "notFound") return;
        throw error;
      }
      throw new Error(
        `session/resume accepted a cursor that never existed (${impossible}) and returned ${JSON.stringify(
          result,
        ).slice(0, 400)}`,
      );
    },
  },
  {
    id: "terminate",
    title: "Close stdin and let the host drain and exit cleanly",
    async run(context) {
      const host = context.resumeHost;
      if (host === undefined) throw new Error("`resume` did not finish");
      // spec 14990 Scenario 4.4: stdin closed by close(), the SDK waits for
      // the orderly drain, and the exit code is what actually happened. The
      // budget is the JOURNEY's; #15943 owns making the bound the SDK's.
      const exit = await host.close(CLOSE_BUDGET_MS);
      equals(exit.code, 0, "the host's exit code after stdin EOF");
      equals(exit.signal, null, "the host's exit signal after stdin EOF");
      const classification = await host.msp.child.exit;
      equals(classification.kind, "cleanShutdown", "the SDK's exit classification");
      context.resumeHost = undefined;
    },
  },
];

/** Segment ids in run order. Exported so tests can pin the journey's shape. */
export const SEGMENT_IDS: readonly string[] = SEGMENTS.map((segment) => segment.id);

/**
 * Expect-blocked segment id → its issue numbers, in run order.
 *
 * This is the source of truth for FR-21932-5's disclosure, and the contract is
 * conditional: README.md carries a "What does not work yet" section IF AND ONLY
 * IF this list is non-empty, and the section's table then mirrors it exactly.
 * The list is empty today, so the section is absent — a heading that promises a
 * list of gaps and delivers the word "nothing" is scaffolding, not disclosure.
 *
 * Exporting the map lets one binary-free test hold the README to it in BOTH
 * directions, because D-013's self-retirement rots each one on its happiest
 * day. When a fix lands, the ONE required edit is deleting the segment's
 * `expectBlock`; every test then goes green while the README still calls the
 * segment broken. When a block RETURNS, the journey stays green — expect-blocked
 * is a pass — while the README still says nothing is wrong. Neither may be
 * silent, so a block cannot arrive or leave without the README saying so.
 */
export const EXPECT_BLOCKED: ReadonlyArray<{
  readonly id: string;
  readonly issues: readonly number[];
}> = SEGMENTS.filter((segment) => segment.expectBlock !== undefined).map((segment) => ({
  id: segment.id,
  issues: (segment.expectBlock as { issues: readonly number[] }).issues,
}));

/** What a provider-configured run observed, beyond the segment report. */
export interface ConfiguredJourneyResult {
  readonly report: JourneyReport;
  /** The loopback endpoint the host was pointed at. */
  readonly baseUrl: string;
  /** How many times the host fetched the model catalog. */
  readonly catalogGets: number;
  /**
   * How many scripted tool calls the endpoint served. The harness's own
   * contract is AT MOST ONE — see `provider.ts`. The acceptance test asserts
   * it, because serving a second one silently parks the `cancel` segment.
   */
  readonly scriptedToolCalls: number;
}

export interface ConfiguredJourneyOptions {
  /** Absolute path to the release-built binary under test. */
  readonly museBin: string;
  /** Workspace root a session is started in. Defaults to a fresh temp dir. */
  readonly workspaceRoot?: string;
}

/**
 * The ACCEPTANCE mode: the same twelve segments, against a host whose HOME
 * already has a provider configured.
 *
 * The provider is the loopback fake first-party endpoint from `provider.ts` —
 * no live provider, no API key, nothing off `127.0.0.1` — so this is the mode
 * CI runs. Every segment is required; none is expect-blocked.
 *
 * {@link runJourney} without a seeded `home` remains supported as the
 * credential-free degradation path. It is NOT the acceptance artifact: a host
 * with no provider cannot run a model, so its six model-dependent segments
 * fail for real and say so.
 */
export async function runConfiguredJourney(
  options: ConfiguredJourneyOptions,
): Promise<ConfiguredJourneyResult> {
  const provider = await startConfiguredProvider({
    scriptedToolCallWhen: [APPROVAL_ARTIFACT, `"shell"`],
    scriptedToolCallCommand: `printf yes > ${APPROVAL_ARTIFACT}`,
    replyText: REPLY_TEXT,
  });
  try {
    const report = await runJourney({
      museBin: options.museBin,
      home: provider.home,
      ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    });
    return {
      report,
      baseUrl: provider.baseUrl,
      catalogGets: provider.catalogGets(),
      scriptedToolCalls: provider.scriptedToolCalls(),
    };
  } finally {
    await provider.close();
  }
}

export async function runJourney(options: JourneyOptions): Promise<JourneyReport> {
  const context: Context = {
    museBin: options.museBin,
    home: options.home ?? (await mkdtemp(join(tmpdir(), "muse-quickstart-home-"))),
    workspaceRoot:
      options.workspaceRoot ?? (await mkdtemp(join(tmpdir(), "muse-quickstart-ws-"))),
  };
  // The loop, the always-run teardown, and the summary are the kit's
  // (`runJourney`), so this journey and every cookbook recipe cannot drift on
  // the part that leaks a spawned host when a segment throws (T-24225-6).
  return await runKitJourney(SEGMENTS, context, async (owned) => {
    await owned.host?.abandon(CLOSE_BUDGET_MS);
    await owned.resumeHost?.abandon(CLOSE_BUDGET_MS);
  });
}
