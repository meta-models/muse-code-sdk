/**
 * Recipe: approve or deny the agent's permission request.
 *
 * Runs against `muse-conformance serve-fixture` playing four committed golden
 * transcripts — `schema/msp/transcripts/approval-round-trip` (allow),
 * `approval-deny-round-trip` (deny), `approval-choice-invalid` (a choice the
 * host never offered, refused, then a listed choice) and
 * `approval-requirement-stale` (a requirement token the host never issued,
 * refused, then the token the refusal carried) — so this recipe is
 * deterministic and needs no credentials and no model. It plays the deny arm
 * because that path is the one an integrator gets wrong and the quickstart
 * never shows it, and the two refusal arms because a wrong answer is the
 * other thing an integrator ships: both earn a typed error that leaves the
 * approval pending, never a failed turn.
 *
 * What it teaches (and what the docs page walks through):
 *  - the host asks TWICE, for two different audiences: `approval/requested` is
 *    a notification for your UI, and `approval/request` is a JSON-RPC request
 *    the SDK must answer. On a bare connection, if you never register a
 *    server-request handler, the SDK answers "method not found" on your
 *    behalf — so answer it. (A `MuseClient` answers it for you and routes it
 *    to `session.onApproval`.)
 *  - answer with `approval/decide`, picking a `choiceId` the host OFFERED in
 *    `availableChoices`. Do not invent one, and do not hardcode a choice the
 *    host may not offer for this subject.
 *  - the ack is not the outcome. `approval/resolved` is where the decision,
 *    the policy result, and any session-scoped rule amendment land.
 *  - denying is a normal answer, not an error: the turn keeps running and the
 *    agent tells the user what it did not do.
 *  - a wrong answer is refused, typed, and changes nothing: a `choiceId` the
 *    host did not list is `-32052 approvalChoiceInvalid` echoing the refused
 *    id; a `requirementId` that is not the current one is `-32053
 *    approvalRequirementStale` carrying `currentRequirementId`, the token to
 *    answer with. The approval stays pending and the corrected decide is
 *    accepted like any other.
 *
 * Fixture mechanics, so the code below reads honestly: serve-fixture matches
 * our frames structurally against the transcript's client lines and then
 * replays the recorded server lines byte-exactly — except that a reply to
 * one of our requests comes back under the id WE sent (#25143), so the SDK's
 * own request-id minting correlates replies here exactly as it does against
 * a real host. Acks still echo the RECORDED commandId — and
 * `Connection.command` verifies that echo — so each command below passes the
 * transcript's commandId explicitly. Values we learn from the wire
 * (sessionId, approvalId, requirementId) are used as received, exactly as a
 * real client uses them.
 */

import type { ApprovalRequirementRef } from "@muse-code/msp";
import { MspError } from "@muse-code/sdk";

import { Host, arrayAt, equals, objectAt, requireHost, stringAt, within } from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

/** The transcripts' own client-side values; see the module comment. */
const WORKSPACE_ROOT = "/home/me/src/proj";
const PROMPT = "Update Cargo.toml to bump the version";
const SESSION_START_COMMAND_ID = "0198f0ab-9999-7000-8000-0000000000c1";
const TURN_START_COMMAND_ID = "018f6a1e-9b3c-7c21-a54a-2f30bd3c9f10";
const APPROVAL_DECIDE_COMMAND_ID = "018f6a2a-3333-7abc-8def-00000000d001";
/** The commandId the refusal transcripts record for the decide the host refuses. */
const REFUSED_DECIDE_COMMAND_ID = "018f6a2a-3333-7abc-8def-00000000d002";

/** A deliberately wrong first decide and the typed refusal it must earn. */
interface Refusal {
  /** What the client got wrong, for the segment title and failure text. */
  readonly what: string;
  /** The JSON-RPC code the host must answer with. */
  readonly code: number;
  /** The `data.kind` the host must answer with; the branch key, never message text. */
  readonly kind: string;
  /** Sent instead of the arm's choice; the request segment proves the host did not offer it. */
  readonly unofferedChoiceId?: string;
  /** Send a requirement token the host did not issue instead of the current one. */
  readonly staleRequirement?: true;
}

/** One arm of the recipe: the same round trip, a different answer. */
interface Arm {
  /** Segment-id prefix, so the report names which arm a line belongs to. */
  readonly id: string;
  /** The transcript directory name under the corpus root. */
  readonly scenario: string;
  /** The choice this arm picks; asserted to be one the host offered. */
  readonly choiceId: string;
  /** Sent only when the chosen option accepts feedback. */
  readonly feedback?: string;
  /** The decision `approval/resolved` must report. */
  readonly decision: string;
  /** The policy result `approval/resolved` must report. */
  readonly policyResult: string;
  /** Present on the arms that first send a wrong answer and read the refusal. */
  readonly refusal?: Refusal;
}

const ALLOW: Arm = {
  id: "allow",
  scenario: "approval-round-trip",
  choiceId: "allow_session",
  decision: "approvedForSession",
  policyResult: "allow",
};

const DENY: Arm = {
  id: "deny",
  scenario: "approval-deny-round-trip",
  choiceId: "abort",
  feedback: "Do not modify the manifest",
  decision: "abort",
  policyResult: "deny",
};

const INVALID_CHOICE: Arm = {
  id: "invalid-choice",
  scenario: "approval-choice-invalid",
  choiceId: "allow_once",
  decision: "approved",
  policyResult: "allow",
  refusal: {
    what: 'a hardcoded choice id the host never offered ("allow")',
    code: -32052,
    kind: "approvalChoiceInvalid",
    unofferedChoiceId: "allow",
  },
};

const STALE_REQUIREMENT: Arm = {
  id: "stale-requirement",
  scenario: "approval-requirement-stale",
  choiceId: "allow_once",
  decision: "approved",
  policyResult: "allow",
  refusal: {
    what: "a requirement token the host never issued",
    code: -32053,
    kind: "approvalRequirementStale",
    staleRequirement: true,
  },
};

interface Context {
  readonly conformanceBin: string;
  readonly transcriptRoot: string;
  host?: Host;
  sessionId?: string;
  turnId?: string;
  approvalId?: string;
  requirementId?: ApprovalRequirementRef;
  /** Settles once the reply to `approval/request` has been written. */
  answered?: Promise<void>;
}

function requireString(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`${what} is not known: an earlier segment did not finish`);
  return value;
}

function requireRequirement(context: Context): ApprovalRequirementRef {
  if (context.requirementId === undefined) {
    throw new Error("the current requirement is not known: an earlier segment did not finish");
  }
  return context.requirementId;
}

/** Run `action` and hand back the MspError it must raise; anything else is a failure. */
async function refusedBy(what: string, action: () => Promise<unknown>): Promise<MspError> {
  try {
    await action();
  } catch (error) {
    if (error instanceof MspError) return error;
    throw error;
  }
  throw new Error(`the host accepted ${what}; it must answer a typed refusal`);
}

/**
 * The refusal arms' extra step: send the wrong answer first, read the typed
 * refusal, and prove it changed nothing. Lives between the request and the
 * (now corrected) decide.
 */
function refusedSegment(arm: Arm, refusal: Refusal): Segment<Context> {
  return {
    id: `${arm.id}-refused`,
    title: `Send ${refusal.what} and read the typed refusal`,
    async run(context) {
      const host = requireHost(context);
      const sessionId = requireString(context.sessionId, "the session id");
      const approvalId = requireString(context.approvalId, "the approval id");
      const current = requireRequirement(context);
      // Reply first, decision second — see the spawn segment. This is the
      // arm's first decide, so the ordering wait lives here.
      if (context.answered === undefined) throw new Error("`spawn` did not finish");
      await within("the reply to approval/request", COMMAND_BUDGET_MS, context.answered);
      await host.msp.connection.flush();

      // The wrong answer, built the way a buggy client builds it: a token it
      // computed itself instead of quoting the host's, or a choice id copied
      // from somewhere this host never offered it.
      let requirementId: ApprovalRequirementRef = current;
      if (refusal.staleRequirement) {
        if (!Number.isInteger(current.sourceIndex)) {
          throw new Error(`currentRequirementId.sourceIndex is not an integer: ${JSON.stringify(current)}`);
        }
        requirementId = { ...current, sourceIndex: current.sourceIndex + 1 };
      }
      const choiceId = refusal.unofferedChoiceId ?? arm.choiceId;
      const refused = await refusedBy(refusal.what, () =>
        host.msp.connection.command(
          "approval/decide",
          { sessionId, approvalId, requirementId, choiceId },
          { maxAttempts: 1, commandId: REFUSED_DECIDE_COMMAND_ID },
        ),
      );
      // Branch on code and kind, never on message text.
      equals(refused.code, refusal.code, "the refusal's code");
      equals(refused.kind, refusal.kind, "the refusal's kind");
      equals(refused.data["approvalId"], approvalId, "the approval the refusal names");
      if (refusal.unofferedChoiceId !== undefined) {
        equals(refused.data["choiceId"], refusal.unofferedChoiceId, "the choice id the refusal echoes");
      }
      if (refusal.staleRequirement) {
        // The refusal carries the token to answer with. Take it from there,
        // as a real client would, and check it is the one the request taught.
        const recovered = objectAt(refused.data, "currentRequirementId", "approvalRequirementStale data");
        equals(recovered["approvalId"], current.approvalId, "the current requirement's approval id");
        equals(recovered["sourceIndex"], current.sourceIndex, "the current requirement's source index");
        context.requirementId = recovered as unknown as ApprovalRequirementRef;
      }
      // Nothing was decided: no outcome followed the refusal, so the approval
      // is still pending and the corrected answer below is a first answer.
      const resolved = host
        .notifications()
        .some(
          (notification) =>
            notification.method === "approval/resolved" &&
            notification.params["approvalId"] === approvalId,
        );
      if (resolved) {
        throw new Error("the refused decide resolved the approval; a refusal must leave it pending");
      }
    },
  };
}

function armSegments(arm: Arm): ReadonlyArray<Segment<Context>> {
  const refusal = arm.refusal;
  return [
    {
      id: `${arm.id}-spawn`,
      title: `Spawn the canned host playing the ${arm.scenario} transcript`,
      async run(context) {
        // Reclaim before overwriting the slot. A previous arm whose drain
        // threw leaves its child in `context.host`; assigning over it would
        // orphan that child with no warning and leave later segments of a
        // failed arm talking to the stale host (PR #25153 review).
        await context.host?.abandon(CLOSE_BUDGET_MS);
        context.host = undefined;
        // THE authoritative reset of everything an arm learns from its own
        // wire. It lives here, not in `-drain`, because `-drain` runs after
        // close assertions that can throw — a failed drain would then leave
        // this arm's state for the next one, and a segment would burn its
        // whole budget on a stale id instead of failing immediately with
        // "an earlier segment did not finish". Keeping the only copy here
        // also means the two lists cannot drift apart, which they already
        // had (PR #25153 review).
        context.sessionId = undefined;
        context.turnId = undefined;
        context.approvalId = undefined;
        context.requirementId = undefined;
        context.answered = undefined;
        const host = await Host.spawn(
          {
            command: context.conformanceBin,
            args: ["serve-fixture", "--transcript", `${context.transcriptRoot}/${arm.scenario}`],
            env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
            clientInfo: { name: "conformance", version: "0.0.0" },
          },
          HANDSHAKE_BUDGET_MS,
        );
        // Answer `approval/request` — the JSON-RPC request half of the ask.
        // The reply is an empty acknowledgement: it means "this client is
        // handling the approval", NOT "approved". The actual answer travels
        // separately as `approval/decide`. Registered before any turn starts,
        // because the host may ask the moment the agent reaches for a tool.
        //
        // The two writes are ORDERED, and the fixture enforces it: the
        // transcript records the reply before the decide, so a decide that
        // overtakes the reply is a frame divergence at that line, not a
        // tolerated reordering. The connection writes the reply on the
        // microtask AFTER this handler settles, so the signal below is
        // deliberately scheduled one hop late — resolving it inline would let
        // the journey continue while the reply write was still unqueued. The
        // decide segment then flushes, so the reply is on its way to the host
        // before the decision is even written.
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
          // transcripts only ever send `approval/request`, so the throw arm
          // is never taken during replay (PR #25153 review).
          if (request.method !== "approval/request") {
            throw new Error(`unhandled server request: ${request.method}`);
          }
          queueMicrotask(() => {
            replied();
          });
          return {};
        });
        context.host = host;
      },
    },
    {
      id: `${arm.id}-turn`,
      title: "Start a session and a turn that will need permission",
      async run(context) {
        const host = requireHost(context);
        const started = await host.msp.connection.command(
          "session/start",
          { workspaceRoot: WORKSPACE_ROOT },
          { maxAttempts: 1, commandId: SESSION_START_COMMAND_ID },
        );
        const session = objectAt(started, "session", "session/start result");
        const sessionId = stringAt(session, "sessionId", "session/start session");
        // The recorded client discovers the model catalog right at session
        // acquisition (the T041 posture the reference ACP adapter ships) —
        // one read-only `model/list`, taught in depth by the
        // list-models-and-switch-mid-session recipe.
        await host.msp.connection.request("model/list", { sessionId });
        const ack = await host.msp.connection.command(
          "turn/start",
          { sessionId, input: [{ type: "text", text: PROMPT }] },
          { maxAttempts: 1, commandId: TURN_START_COMMAND_ID },
        );
        equals(ack["status"], "accepted", "turn/start ack status");
        context.sessionId = sessionId;
        context.turnId = stringAt(ack, "turnId", "turn/start ack");
      },
    },
    {
      id: `${arm.id}-request`,
      title: "Take the request off the wire and read the choices the host offers",
      async run(context) {
        const host = requireHost(context);
        const turnId = requireString(context.turnId, "the turn id");
        // Race the turn's own terminal: without it, a turn that ended WITHOUT
        // ever asking for permission would sit here until the budget expired
        // and report a timeout instead of what actually happened.
        const event = await host.waitFor(
          "an approval/requested notification",
          COMMAND_BUDGET_MS,
          (notification) =>
            notification.method === "approval/requested" ||
            (notification.method === "turn/completed" && notification.params["turnId"] === turnId),
        );
        if (event.method !== "approval/requested") {
          throw new Error(
            `the turn ended (terminal ${JSON.stringify(event.params["terminal"])}) without asking for approval`,
          );
        }
        equals(event.params["turnId"], turnId, "the approval's turn id");

        // What a UI puts in front of the user: which tool, acting on what.
        const subject = objectAt(event.params, "subject", "approval/requested params");
        stringAt(subject, "kind", "approval/requested subject");
        stringAt(event.params, "toolName", "approval/requested params");

        // Pick from what the host OFFERED. A hardcoded choiceId is the bug
        // this assertion exists to catch: the offered set depends on the
        // subject, so a client that assumes one can send an answer the host
        // will reject.
        const choices = arrayAt(event.params, "availableChoices", "approval/requested params");
        const offered = choices.map((choice) =>
          stringAt(choice as Record<string, unknown>, "choiceId", "an availableChoices entry"),
        );
        if (!offered.includes(arm.choiceId)) {
          throw new Error(
            `the host did not offer "${arm.choiceId}"; it offered ${JSON.stringify(offered)}`,
          );
        }
        if (refusal?.unofferedChoiceId !== undefined && offered.includes(refusal.unofferedChoiceId)) {
          // The refusal arm sends this id BECAUSE the host never offered it;
          // an offered id would make the arm's refusal pass vacuously.
          throw new Error(
            `the host offered "${refusal.unofferedChoiceId}", so sending it is not a wrong answer; it offered ${JSON.stringify(offered)}`,
          );
        }
        if (arm.feedback !== undefined) {
          // Feedback rides along only where the host says it is accepted.
          const chosen = choices.find(
            (choice) => (choice as Record<string, unknown>)["choiceId"] === arm.choiceId,
          ) as Record<string, unknown>;
          equals(chosen["acceptsFeedback"], true, `whether "${arm.choiceId}" accepts feedback`);
        }

        context.approvalId = stringAt(event.params, "approvalId", "approval/requested params");
        // The requirement being answered, quoted back verbatim on the decide.
        context.requirementId = objectAt(
          event.params,
          "currentRequirementId",
          "approval/requested params",
        ) as unknown as ApprovalRequirementRef;
      },
    },
    ...(refusal === undefined ? [] : [refusedSegment(arm, refusal)]),
    {
      id: `${arm.id}-decide`,
      title: refusal === undefined ? `Answer with "${arm.choiceId}"` : `Answer again with "${arm.choiceId}"`,
      async run(context) {
        const host = requireHost(context);
        const sessionId = requireString(context.sessionId, "the session id");
        const approvalId = requireString(context.approvalId, "the approval id");
        const requirementId = requireRequirement(context);
        // Reply first, decision second — see the spawn segment. Bounded, so a
        // handler that never fires reports that instead of hanging. (On a
        // refusal arm the refused decide already waited; this is a no-op.)
        if (context.answered === undefined) throw new Error("`spawn` did not finish");
        await within("the reply to approval/request", COMMAND_BUDGET_MS, context.answered);
        await host.msp.connection.flush();
        const ack = await host.msp.connection.command(
          "approval/decide",
          {
            sessionId,
            approvalId,
            requirementId,
            choiceId: arm.choiceId,
            ...(arm.feedback === undefined ? {} : { feedback: arm.feedback }),
          },
          { maxAttempts: 1, commandId: APPROVAL_DECIDE_COMMAND_ID },
        );
        equals(ack["status"], "accepted", "approval/decide ack status");
        equals(ack["approvalId"], approvalId, "the approval id the ack echoes");
        // `terminal: true` means this approval will not come back for more:
        // the requirement is fully answered.
        equals(ack["terminal"], true, "whether the decision settles the approval");
      },
    },
    {
      id: `${arm.id}-resolved`,
      title: "Read the outcome off approval/resolved, then let the turn finish",
      async run(context) {
        const host = requireHost(context);
        const approvalId = requireString(context.approvalId, "the approval id");
        const turnId = requireString(context.turnId, "the turn id");
        const resolved = await host.waitFor(
          "the approval/resolved notification",
          COMMAND_BUDGET_MS,
          (notification) =>
            notification.method === "approval/resolved" &&
            notification.params["approvalId"] === approvalId,
        );
        // The ack said "accepted". THIS says what was decided.
        equals(resolved.params["decision"], arm.decision, "the decision");
        equals(resolved.params["policyResult"], arm.policyResult, "the policy result");
        equals(resolved.params["resolvedBy"], "user", "who resolved the approval");
        // Which decide won: the corrected (or only) decide, never a refused one.
        equals(
          resolved.params["decidedByCommandId"],
          APPROVAL_DECIDE_COMMAND_ID,
          "the command that decided",
        );

        // A session-scoped choice also amends policy, so the same subject is
        // not asked about again for the rest of the session. A once-scoped or
        // denying choice carries no amendment — that difference IS the scope.
        const amendment = resolved.params["amendment"];
        if (arm.choiceId === "allow_session") {
          const durability = objectAt(resolved.params, "amendment", "approval/resolved params");
          equals(durability["durability"], "session", "the amendment's durability");
        } else if (amendment !== undefined) {
          throw new Error(
            `a "${arm.choiceId}" decision should amend no policy, but carried ${JSON.stringify(amendment)}`,
          );
        }

        // Denied or allowed, the turn runs on to its own terminal. A denial is
        // an answer, not a failure.
        const completed = await host.waitFor(
          "the turn/completed notification",
          COMMAND_BUDGET_MS,
          (notification) =>
            notification.method === "turn/completed" && notification.params["turnId"] === turnId,
        );
        equals(completed.params["terminal"], "completed", "the turn's terminal");

        if (arm.policyResult === "deny") {
          // ...and the user is told. A denied tool call that ends in silence
          // is a UI that looks broken.
          const spoke = host.notifications().some((notification) => {
            if (notification.method !== "item/completed") return false;
            const item = notification.params["item"] as Record<string, unknown> | undefined;
            return (
              item?.["kind"] === "agentMessage" &&
              typeof item["text"] === "string" &&
              item["text"].length > 0
            );
          });
          if (!spoke) {
            throw new Error("the denied turn ended without the agent saying what it did not do");
          }
        }
      },
    },
    {
      id: `${arm.id}-drain`,
      title: "Close stdin and let the fixture host exit cleanly",
      async run(context) {
        const host = requireHost(context);
        const exit = await host.close(CLOSE_BUDGET_MS);
        equals(exit.code, 0, "the fixture host's exit code after stdin EOF");
        // Only the host slot, so journey-end teardown does not re-abandon a
        // host this segment already closed cleanly. Everything this arm
        // learned from its wire is reset by the NEXT arm's spawn, which is
        // the one place that runs whether or not this drain succeeded.
        context.host = undefined;
      },
    },
  ];
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  ...armSegments(ALLOW),
  ...armSegments(DENY),
  ...armSegments(INVALID_CHOICE),
  ...armSegments(STALE_REQUIREMENT),
];

export const approveOrDeny: Recipe = {
  id: "approve-or-deny",
  title: "Approve or deny the agent's permission request",
  docsPage: "developer-docs/src/content/docs/cookbook/approve-or-deny-a-tool-call.mdx",
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
