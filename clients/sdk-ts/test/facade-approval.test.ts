/**
 * T031 / TEST-013 `approval_callback_round_trip` — FR-019.
 *
 * The ROUND TRIP is the contract, and the task's NOTE is explicit that a
 * handler-registration half does not satisfy it: every arm below either drives
 * a real `approval/decide` frame out of the fake duplex, or asserts that none
 * was written.
 *
 * These arms drive the inbound `approval/requested` notification → fold →
 * handler → outbound `approval/decide` command, the pair FR-019 names, plus
 * one transcript arm that replays the recorded `approval/request` with a
 * resume reply. That server request's other arms (ADR 42116 D18) are in
 * `facade-approval-resend.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, MuseClient, Session } from "../src/index.js";
import type { ApprovalFailure } from "../src/index.js";
import {
  answer,
  answerError,
  FakeDuplex,
  frame,
  sentFrame,
  sentParams,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";
import type {
  ApprovalChoice,
  ApprovalRequestParams,
  ApprovalUpdatedParams,
  SourceRange,
} from "@muse-code/msp";

const ARM_TIMEOUT = 10_000;
const SESSION = "s-1";
const SOURCE: SourceRange = {
  first: { recordIndex: 0, streamOffset: 0 },
  last: { recordIndex: 0, streamOffset: 0 },
  stream: { kind: "run", runId: "r-1" },
} as unknown as SourceRange;

const CHOICES: ApprovalChoice[] = [
  { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
  {
    acceptsFeedback: true,
    choiceId: "deny",
    decision: "denied",
    label: "Deny",
    scope: "once",
  },
];

function approvalRequested(overrides: Partial<ApprovalRequestParams> = {}): {
  readonly method: "approval/requested";
  readonly params: ApprovalRequestParams;
} {
  const approvalId = overrides.approvalId ?? "a-1";
  return {
    method: "approval/requested",
    params: {
      approvalId,
      availableChoices: CHOICES,
      currentRequirementId: { approvalId, sourceIndex: 0 },
      itemId: "i-1",
      judgeEscalated: false,
      protectedWrite: false,
      rawArgs: "{}",
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      taskId: "task-1",
      toolCallId: "call-1",
      toolName: "shell",
      turnId: "turn-1",
      viewCursor: "v:1",
      ...overrides,
    },
  };
}

function decideResult(commandId: string, approvalId = "a-1"): Record<string, unknown> {
  return { approvalId, commandId, status: "accepted", terminal: true };
}

function wired(): {
  readonly transport: FakeDuplex;
  readonly session: Session<string>;
  readonly minted: string[];
} {
  const transport = new FakeDuplex();
  const minted: string[] = [];
  const connection = new Connection(transport, {
    mintCommandId: () => {
      const id = `mint-${minted.length}`;
      minted.push(id);
      return id;
    },
  });
  const session = new Session<string>({
    sessionId: SESSION,
    durability: { kind: "durable" },
    connection,
  });
  return { minted, session, transport };
}

test(
  "T031/TEST-013 approval_callback_round_trip: the handler's choice reaches the wire as approval/decide",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { minted, session, transport } = wired();
    const seen: ApprovalRequestParams[] = [];
    session.onApproval((request) => {
      seen.push(request);
      return { choiceId: "allow_once" };
    });

    const outcome = session.apply(approvalRequested());
    // Inbound half: the fold tracks it while the decision is in flight.
    assert.deepEqual(
      session.fold.pendingApprovals().map((a) => a.approvalId),
      ["a-1"],
    );

    await waitForWrites(transport, 1);
    assert.equal(sentFrame(transport, 0)["method"], "approval/decide");
    const { commandId, ...params } = sentParams(transport, 0);
    // INV-013: the connection's mint is still the only minter.
    assert.deepEqual(minted, ["mint-0"]);
    assert.equal(commandId, "mint-0");
    assert.deepEqual(params, {
      approvalId: "a-1",
      choiceId: "allow_once",
      requirementId: { approvalId: "a-1", sourceIndex: 0 },
      sessionId: SESSION,
    });
    // The handler saw the SERVER's request verbatim, choices included — that is
    // what makes "server-minted choices only" checkable by the consumer.
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0]?.availableChoices, CHOICES);

    answer(transport, 0, decideResult("mint-0"));
    await outcome.io;

    // Round trip closed: the authoritative outcome is the view stream's
    // approval/resolved, never the ack (tdd SS5.4), so the fold must move only
    // when that lands.
    assert.equal(session.fold.pendingApprovals().length, 1);
    session.apply({
      method: "approval/resolved",
      params: {
        approvalId: "a-1",
        decidedByCommandId: "mint-0",
        decision: "approved",
        itemId: "i-1",
        policyResult: { kind: "allowed" },
        resolvedBy: { kind: "client" },
        sessionId: SESSION,
        sourceRange: SOURCE,
        stageEvidence: [],
        turnId: "turn-1",
        viewCursor: "v:2",
      },
    } as unknown as Parameters<Session<string>["apply"]>[0]);
    assert.equal(session.fold.pendingApprovals().length, 0);
    assert.deepEqual(
      session.fold.resolvedApprovals().map((r) => r.decidedByCommandId),
      ["mint-0"],
    );
  },
);

test(
  "T031/TEST-013: a redelivered approval/requested decides ONCE and mints no second commandId",
  { timeout: ARM_TIMEOUT },
  async () => {
    // SS3.1.1 idempotency is about the SUBMISSION; the client half is not
    // sending a second one. A redelivered request for the same stage must not
    // author a second decide, or a two-stage approval races itself.
    const { minted, session, transport } = wired();
    let calls = 0;
    session.onApproval(() => {
      calls += 1;
      return { choiceId: "allow_once" };
    });

    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    answer(transport, 0, decideResult("mint-0"));
    await first.io;

    const second = session.apply(approvalRequested());
    await second.io;
    await settleMicrotasks();

    assert.equal(transport.writes.length, 1, "the redelivery must author no second decide");
    assert.equal(calls, 1, "the handler must not be asked twice for one stage");
    assert.deepEqual(minted, ["mint-0"]);
  },
);

test(
  "T031/TEST-013: a NEW requirementId is a new stage and gets its own decision",
  { timeout: ARM_TIMEOUT },
  async () => {
    // tdd SS5.4: `requirementId` is the multi-stage race guard — a decision
    // aimed at stage 1 can never satisfy stage 2. Memoizing on `approvalId`
    // alone would leave stage 2 undecided forever.
    const { minted, session, transport } = wired();
    session.onApproval(() => ({ choiceId: "allow_once" }));

    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    answer(transport, 0, decideResult("mint-0"));
    await first.io;

    const second = session.apply(
      approvalRequested({ currentRequirementId: { approvalId: "a-1", sourceIndex: 1 } }),
    );
    await waitForWrites(transport, 2);
    assert.deepEqual(sentParams(transport, 1)["requirementId"], {
      approvalId: "a-1",
      sourceIndex: 1,
    });
    assert.equal(sentParams(transport, 1)["commandId"], "mint-1");
    answer(transport, 1, decideResult("mint-1"));
    await second.io;
    assert.deepEqual(minted, ["mint-0", "mint-1"]);
  },
);

test(
  "T031/TEST-013: NO handler registered writes nothing and parks nothing (D-008)",
  { timeout: ARM_TIMEOUT },
  async () => {
    // FR-019: "no handler registered means the client runs under the server's
    // default-deny posture — the SDK parks nothing". A local park would be a
    // client-invented hold on a server-owned decision.
    const { session, transport } = wired();

    const outcome = session.apply(approvalRequested());
    // Settle the queue and assert BEFORE awaiting `io`: an implementation that
    // auto-answered would leave `io` pending on a round trip nobody answers, so
    // awaiting first turns a clean assertion failure into an arm timeout.
    await settleMicrotasks();
    assert.equal(transport.writes.length, 0, "no handler must produce no frame");
    assert.deepEqual(await outcome.io, []);
    // The approval is still VISIBLE — folding it is the inbound half and is
    // not a park; the server's own timeout resolves it.
    assert.deepEqual(
      session.fold.pendingApprovals().map((a) => a.approvalId),
      ["a-1"],
    );
    // And nothing was decided BEHIND the consumer's back either: registering a
    // handler afterwards must find the stage unclaimed, so the next delivery of
    // the same request still reaches it. A router that had quietly
    // auto-answered — or latched the stage while answering nothing — would
    // leave this handler never called, which is the D-008 violation that is
    // invisible from the write count alone.
    let calls = 0;
    session.onApproval(() => {
      calls += 1;
      return { choiceId: "allow_once" };
    });
    const second = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    assert.equal(calls, 1);
    answer(transport, 0, decideResult("mint-0"));
    await second.io;
  },
);

test(
  "T031/TEST-013: a choiceId the request never offered is refused BEFORE the wire (D-006)",
  { timeout: ARM_TIMEOUT },
  async () => {
    // D-006 is select-never-create: choices are server-minted. Sending an
    // invented one bounces -32052 a round trip later, and by then the stage may
    // have advanced — so the refusal belongs on this side of the transport.
    const { session, transport } = wired();
    const failures: ApprovalFailure[] = [];
    session.onApprovalError((failure) => failures.push(failure));
    session.onApproval(() => ({ choiceId: "allow_always" }));

    const outcome = session.apply(approvalRequested());
    await outcome.io;
    await settleMicrotasks();

    assert.equal(transport.writes.length, 0, "an unoffered choice must never reach the wire");
    assert.deepEqual(failures, [
      {
        kind: "unofferedChoice",
        approvalId: "a-1",
        choiceId: "allow_always",
        availableChoiceIds: ["allow_once", "deny"],
      },
    ]);
  },
);

test(
  "feedback on a choice that does not accept it is refused BEFORE the wire and answered with the offered reject",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The host refuses feedback on a choice without `acceptsFeedback` (-32052)
    // and leaves its approval open, so the refusal belongs on this side, and
    // the offered `denied` choice closes the approval instead.
    const { session, transport } = wired();
    const failures: ApprovalFailure[] = [];
    session.onApprovalError((failure) => failures.push(failure));
    session.onApproval(() => ({ choiceId: "allow_once", feedback: "looks safe" }));

    const outcome = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    assert.equal(sentParams(transport, 0)["choiceId"], "deny", "the offered reject is sent instead");
    assert.ok(!("feedback" in sentParams(transport, 0)), "the refused feedback never reaches the wire");
    answer(transport, 0, decideResult("mint-0"));
    await outcome.io;
    assert.equal(transport.writes.length, 1, "one decision only");
    assert.deepEqual(failures, [
      {
        kind: "feedbackNotAccepted",
        approvalId: "a-1",
        choiceId: "allow_once",
        feedbackChoiceIds: ["deny"],
      },
    ]);
  },
);

test(
  "a failed decide for the substituted reject is reported after the refusal",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    const failures: ApprovalFailure[] = [];
    session.onApprovalError((failure) => failures.push(failure));
    session.onApproval(() => ({ choiceId: "allow_once", feedback: "looks safe" }));

    const outcome = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    answerError(transport, 0, {
      code: -32053,
      message: "stale requirementId",
      data: { kind: "invalidParams" },
    });
    await outcome.io;

    assert.deepEqual(
      failures.map((failure) => failure.kind),
      ["feedbackNotAccepted", "submitFailed"],
    );
  },
);

test(
  "refused feedback falls back to the offered abort choice, and sends nothing when no reject is offered",
  { timeout: ARM_TIMEOUT },
  async () => {
    const allow: ApprovalChoice = {
      choiceId: "allow_once",
      decision: "approved",
      label: "Allow once",
      scope: "once",
    };
    const abort: ApprovalChoice = {
      acceptsFeedback: true,
      choiceId: "stop",
      decision: "abort",
      label: "Stop",
      scope: "once",
    };
    const { session, transport } = wired();
    session.onApproval(() => ({ choiceId: "allow_once", feedback: "looks safe" }));
    const outcome = session.apply(approvalRequested({ availableChoices: [allow, abort] }));
    await waitForWrites(transport, 1);
    assert.equal(sentParams(transport, 0)["choiceId"], "stop", "abort when no denied choice is offered");
    answer(transport, 0, decideResult("mint-0"));
    await outcome.io;

    // Denied wins over abort even when abort is offered first.
    const deny: ApprovalChoice = { choiceId: "deny", decision: "denied", label: "Deny", scope: "once" };
    const { session: both, transport: bothTransport } = wired();
    both.onApproval(() => ({ choiceId: "allow_once", feedback: "looks safe" }));
    const bothOutcome = both.apply(approvalRequested({ availableChoices: [allow, abort, deny] }));
    await waitForWrites(bothTransport, 1);
    assert.equal(sentParams(bothTransport, 0)["choiceId"], "deny", "denied wins over abort");
    answer(bothTransport, 0, decideResult("mint-0"));
    await bothOutcome.io;

    const { session: bare, transport: bareTransport } = wired();
    const failures: ApprovalFailure[] = [];
    bare.onApprovalError((failure) => failures.push(failure));
    bare.onApproval(() => ({ choiceId: "allow_once", feedback: "looks safe" }));
    const bareOutcome = bare.apply(approvalRequested({ availableChoices: [allow] }));
    await bareOutcome.io;
    await settleMicrotasks();
    assert.equal(bareTransport.writes.length, 0, "no reject offered, so nothing is sent");
    assert.deepEqual(
      failures.map((failure) => failure.kind),
      ["feedbackNotAccepted"],
    );
  },
);

test(
  "T031/TEST-013: feedback is forwarded when offered and OMITTED when unset (SS1.2)",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    session.onApproval(() => ({ choiceId: "deny", feedback: "not this path" }));

    const outcome = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    assert.equal(sentParams(transport, 0)["feedback"], "not this path");
    answer(transport, 0, decideResult("mint-0"));
    await outcome.io;

    // The twin: an unset feedback is absent, never null.
    const { session: second, transport: secondTransport } = wired();
    second.onApproval(() => ({ choiceId: "deny", feedback: null } as never));
    const secondOutcome = second.apply(approvalRequested());
    await waitForWrites(secondTransport, 1);
    assert.ok(!("feedback" in sentParams(secondTransport, 0)), "feedback must be omitted, not null");
    answer(secondTransport, 0, decideResult("mint-0"));
    await secondOutcome.io;
  },
);

test(
  "an explicit null feedback on a choice that does not accept feedback is still sent, as no feedback",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The wire reads omitted and explicit `null` alike as no feedback, so only
    // a real string on a choice without `acceptsFeedback` is refused.
    const { session, transport } = wired();
    const failures: ApprovalFailure[] = [];
    session.onApprovalError((failure) => failures.push(failure));
    session.onApproval(() => ({ choiceId: "allow_once", feedback: null } as never));

    const outcome = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    assert.equal(sentParams(transport, 0)["choiceId"], "allow_once");
    assert.ok(!("feedback" in sentParams(transport, 0)), "feedback must be omitted, not null");
    answer(transport, 0, decideResult("mint-0"));
    await outcome.io;
    assert.deepEqual(failures, []);
  },
);

test(
  "T031/TEST-013: a handler that throws surfaces the failure and writes nothing",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    const failures: ApprovalFailure[] = [];
    session.onApprovalError((failure) => failures.push(failure));
    session.onApproval(() => {
      throw new Error("handler blew up");
    });

    const outcome = session.apply(approvalRequested());
    // A throwing handler must not become an unhandled rejection out of the
    // notification pump, and must not take the fold down with it.
    await outcome.io;
    await settleMicrotasks();

    assert.equal(transport.writes.length, 0);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.kind, "handlerThrew");
    assert.equal(session.fold.pendingApprovals().length, 1);
  },
);

test(
  "T031/TEST-013: a rejected approval/decide surfaces as a submitFailed failure, never a silent drop",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    const failures: ApprovalFailure[] = [];
    session.onApprovalError((failure) => failures.push(failure));
    session.onApproval(() => ({ choiceId: "allow_once" }));

    const outcome = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    // -32053: the stale-requirement bounce. The client learns the stage moved.
    answerError(transport, 0, {
      code: -32053,
      message: "stale requirementId",
      data: { kind: "invalidParams" },
    });
    await outcome.io;

    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.kind, "submitFailed");
  },
);

test(
  "T031/TEST-013: onApproval does not fire for a fold-only session's approvals",
  { timeout: ARM_TIMEOUT },
  async () => {
    // A handler on a session with no connection cannot answer, and calling it
    // would ask the consumer for a decision the SDK then drops on the floor.
    const session = new Session<string>({ sessionId: SESSION, durability: { kind: "durable" } });
    const failures: ApprovalFailure[] = [];
    let calls = 0;
    session.onApprovalError((failure) => failures.push(failure));
    session.onApproval(() => {
      calls += 1;
      return { choiceId: "allow_once" };
    });

    const outcome = session.apply(approvalRequested());
    await outcome.io;

    assert.equal(calls, 0);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.kind, "submitFailed");
  },
);

test(
  "T031/TEST-013: an approval/updated whose requirement is ALREADY DECIDED authors no decision",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The refresh route (#36949) reuses the per-stage latch, so an update that
    // does NOT advance the requirement — a `policyPersistence` report for the
    // stage just decided, say — must not re-ask the handler or author a second
    // decide against the same requirementId.
    const { session, transport } = wired();
    let calls = 0;
    session.onApproval(() => {
      calls += 1;
      return { choiceId: "allow_once" };
    });
    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    answer(transport, 0, decideResult("mint-0"));
    await first.io;

    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: CHOICES,
      change: { kind: "policyPersistence", status: "succeeded" },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 0 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:3",
    } as unknown as ApprovalUpdatedParams;
    const outcome = session.apply({ method: "approval/updated", params: update });
    await outcome.io;
    await settleMicrotasks();

    assert.equal(calls, 1, "an already-decided stage must not re-ask the handler");
    assert.equal(transport.writes.length, 1);
  },
);

test(
  "T031/TEST-013 #36949: an approval/updated that ADVANCES the requirement re-asks the handler and decides the new stage",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The reporter's exact sequence (#36949): a 3-stage shell
    // approval where stages 0 and 2 need decisions. The host resolves stage 0,
    // advances `currentRequirementId` 0 → 2 via `approval/updated`
    // (`change.kind: stageResolved`) and re-issues NO second
    // `approval/requested` — the SS5.6 item-3 re-issue is the `approval/request`
    // server request, which reaches the router only through `Session.apply`
    // (a client-owned connection delivers it). Here it never arrives, so routing only
    // `approval/requested` would leave stage 2 undecided and the turn pending
    // forever.
    const { minted, session, transport } = wired();
    const seen: ApprovalRequestParams[] = [];
    session.onApproval((request) => {
      seen.push(request);
      // Stage 2 answers with a choice stage 0 NEVER offered, so a router that
      // handed the handler stage 0's retained choices — or validated against
      // them — refuses it and this arm reds (D-006 runs on `availableChoices`).
      return {
        choiceId: request.currentRequirementId.sourceIndex === 2 ? "allow_write" : "allow_once",
      };
    });

    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    // The stage decision is accepted but the APPROVAL is not terminal.
    answer(transport, 0, { approvalId: "a-1", commandId: "mint-0", status: "accepted", terminal: false });
    await first.io;

    const STAGE_TWO_CHOICES: ApprovalChoice[] = [
      ...CHOICES,
      { choiceId: "allow_write", decision: "approved", label: "Allow write", scope: "once" },
    ];
    const SUBAGENT_ORIGIN = {
      childRunId: "run-9",
      childSessionId: "s-child",
      subagentId: "sub-1",
    };
    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: STAGE_TWO_CHOICES,
      change: {
        choiceId: "allow_once",
        decision: "approved",
        kind: "stageResolved",
        requirementId: { approvalId: "a-1", sourceIndex: 0 },
      },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 2 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subagentOrigin: SUBAGENT_ORIGIN,
      subject: { kind: "shell", command: "echo two > b.txt" },
      viewCursor: "v:3",
    } as unknown as ApprovalUpdatedParams;
    const updated = session.apply({ method: "approval/updated", params: update });

    // The advanced stage reaches the wire as its own decision, choosing from
    // the UPDATE's refreshed choices.
    await waitForWrites(transport, 2);
    assert.equal(sentFrame(transport, 1)["method"], "approval/decide");
    assert.deepEqual(sentParams(transport, 1)["requirementId"], {
      approvalId: "a-1",
      sourceIndex: 2,
    });
    assert.equal(sentParams(transport, 1)["choiceId"], "allow_write");
    assert.deepEqual(minted, ["mint-0", "mint-1"]);
    // The handler saw an HONEST refreshed request: stage-scoped members from
    // the update — choices, subject, and the #36182 child provenance included —
    // identity members from the retained original request.
    assert.equal(seen.length, 2);
    assert.deepEqual(seen[1]?.currentRequirementId, { approvalId: "a-1", sourceIndex: 2 });
    assert.deepEqual(seen[1]?.availableChoices, STAGE_TWO_CHOICES);
    assert.deepEqual(seen[1]?.subagentOrigin, SUBAGENT_ORIGIN);
    assert.deepEqual(seen[1]?.subject, { kind: "shell", command: "echo two > b.txt" });
    assert.equal(seen[1]?.itemId, "i-1");
    assert.equal(seen[1]?.turnId, "turn-1");
    assert.equal(seen[1]?.toolName, "shell");
    answer(transport, 1, { approvalId: "a-1", commandId: "mint-1", status: "accepted", terminal: true });
    await updated.io;

    // A LATE re-issued approval/requested for the same stage (a host that does
    // both) authors no second decide: the stage latch already claimed it.
    const reissued = session.apply(
      approvalRequested({
        availableChoices: CHOICES,
        currentRequirementId: { approvalId: "a-1", sourceIndex: 2 },
      }),
    );
    await reissued.io;
    await settleMicrotasks();
    assert.equal(seen.length, 2, "one stage asks the consumer once, whichever frame delivers it");
    assert.equal(transport.writes.length, 2, "the re-issued request must author no third decide");

    // The round trip closes exactly as the reporter's raw-decide control did.
    session.apply({
      method: "approval/resolved",
      params: {
        approvalId: "a-1",
        decidedByCommandId: "mint-1",
        decision: "approved",
        itemId: "i-1",
        policyResult: { kind: "allowed" },
        resolvedBy: { kind: "client" },
        sessionId: SESSION,
        sourceRange: SOURCE,
        stageEvidence: [],
        turnId: "turn-1",
        viewCursor: "v:4",
      },
    } as unknown as Parameters<Session<string>["apply"]>[0]);
    assert.equal(session.fold.pendingApprovals().length, 0);
  },
);

for (const withFacts of [true, false]) {
  test(
    `#63862: a stage advance keeps the request's cuaCardFacts (${withFacts ? "with" : "without"} facts)`,
    { timeout: ARM_TIMEOUT },
    async () => {
      // `cuaCardFacts` belongs to the call and `approval/updated` doesn't carry
      // it, so the refreshed stage-2 request keeps the original request's
      // facts, and a request without facts stays without the key.
      const FACTS: ApprovalRequestParams["cuaCardFacts"] = {
        page: { host: "shop.example.com", hostAscii: "shop.example.com" },
        steps: [
          {
            step: 1,
            kind: "verb:buy",
            action: "click",
            effect: "may buy or pay with your account",
            roleWord: "button",
            label: "Place order",
          },
        ],
      };
      const { minted, session, transport } = wired();
      const seen: ApprovalRequestParams[] = [];
      session.onApproval((request) => {
        seen.push(request);
        return { choiceId: "allow_once" };
      });
      const first = session.apply(approvalRequested(withFacts ? { cuaCardFacts: FACTS } : {}));
      await waitForWrites(transport, 1);
      answer(transport, 0, { approvalId: "a-1", commandId: "mint-0", status: "accepted", terminal: false });
      await first.io;

      const update = {
        approvalId: "a-1",
        availableChoices: CHOICES,
        change: {
          choiceId: "allow_once",
          decision: "approved",
          kind: "stageResolved",
          requirementId: { approvalId: "a-1", sourceIndex: 0 },
        },
        currentRequirementId: { approvalId: "a-1", sourceIndex: 2 },
        sessionId: SESSION,
        sourceRange: SOURCE,
        subject: { kind: "shell", command: "echo two > b.txt" },
        viewCursor: "v:3",
      } as unknown as ApprovalUpdatedParams;
      const updated = session.apply({ method: "approval/updated", params: update });
      await waitForWrites(transport, 2);
      assert.deepEqual(minted, ["mint-0", "mint-1"]);
      assert.equal(seen.length, 2);
      if (withFacts) {
        assert.deepEqual(seen[1]?.cuaCardFacts, FACTS);
      } else {
        assert.equal("cuaCardFacts" in (seen[1] ?? {}), false);
      }
      answer(transport, 1, { approvalId: "a-1", commandId: "mint-1", status: "accepted", terminal: true });
      await updated.io;
    },
  );
}

for (const withReason of [true, false]) {
  test(
    `#49908: a stage advance keeps the request's reviewerReason (${withReason ? "with" : "without"} reason)`,
    { timeout: ARM_TIMEOUT },
    async () => {
      // `reviewerReason` belongs to the call and `approval/updated` doesn't
      // carry it, so the refreshed stage-2 request keeps the original
      // request's reason, and a request without one stays without the key.
      const REASON = "pipes a downloaded script into sh";
      const { minted, session, transport } = wired();
      const seen: ApprovalRequestParams[] = [];
      session.onApproval((request) => {
        seen.push(request);
        return { choiceId: "allow_once" };
      });
      const first = session.apply(approvalRequested(withReason ? { reviewerReason: REASON } : {}));
      await waitForWrites(transport, 1);
      answer(transport, 0, { approvalId: "a-1", commandId: "mint-0", status: "accepted", terminal: false });
      await first.io;

      const update = {
        approvalId: "a-1",
        availableChoices: CHOICES,
        change: {
          choiceId: "allow_once",
          decision: "approved",
          kind: "stageResolved",
          requirementId: { approvalId: "a-1", sourceIndex: 0 },
        },
        currentRequirementId: { approvalId: "a-1", sourceIndex: 2 },
        sessionId: SESSION,
        sourceRange: SOURCE,
        subject: { kind: "shell", command: "echo two > b.txt" },
        viewCursor: "v:3",
      } as unknown as ApprovalUpdatedParams;
      const updated = session.apply({ method: "approval/updated", params: update });
      await waitForWrites(transport, 2);
      assert.deepEqual(minted, ["mint-0", "mint-1"]);
      assert.equal(seen.length, 2);
      if (withReason) {
        assert.equal(seen[1]?.reviewerReason, REASON);
      } else {
        assert.equal("reviewerReason" in (seen[1] ?? {}), false);
      }
      answer(transport, 1, { approvalId: "a-1", commandId: "mint-1", status: "accepted", terminal: true });
      await updated.io;
    },
  );
}

test(
  "T031/TEST-013 #50244: a stageResolved update read in the SAME chunk as a terminal decide ack asks nothing and writes nothing",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The #37538 producer race again, but the `terminal: true` ack and the
    // trailing `stageResolved` update arrive in one read: the update is
    // routed before the decide resumes from its ack, so the router must wait
    // for that ack instead of asking the consumer about a closed stage.
    const { session, transport } = wired();
    let calls = 0;
    session.onApproval(() => {
      calls += 1;
      return { choiceId: "allow_once" };
    });
    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);

    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: CHOICES,
      change: {
        choiceId: "allow_once",
        decision: "approved",
        kind: "stageResolved",
        requirementId: { approvalId: "a-1", sourceIndex: 0 },
      },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:3",
    } as unknown as ApprovalUpdatedParams;
    // Same chunk, as the router sees it: the update is applied before the
    // decide resumes from its ack (here, before the Connection even reads it).
    answer(transport, 0, { approvalId: "a-1", commandId: "mint-0", status: "accepted", terminal: true });
    const outcome = session.apply({ method: "approval/updated", params: update });
    await first.io;
    // Settle and assert BEFORE awaiting the update's `io`: a regression
    // authors a decide nobody answers, and that `io` would pend forever.
    await settleMicrotasks();
    assert.equal(calls, 1, "a stage the host closed in the same read must not re-ask the handler");
    assert.equal(transport.writes.length, 1, "no decide may chase a terminal ack read in the same chunk");
    await outcome.io;
  },
);

test(
  "T031/TEST-013 #50244: a stageResolved update read in the SAME chunk as a NON-terminal decide ack still asks for the next stage",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The same-chunk wait must only defer the update until our ack is in,
    // never swallow it: a non-terminal ack leaves stage 1 open, so the
    // consumer is asked for it once the ack lands.
    const { session, transport } = wired();
    const asked: number[] = [];
    session.onApproval((request) => {
      asked.push(request.currentRequirementId.sourceIndex);
      return { choiceId: "allow_once" };
    });
    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);

    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: CHOICES,
      change: {
        choiceId: "allow_once",
        decision: "approved",
        kind: "stageResolved",
        requirementId: { approvalId: "a-1", sourceIndex: 0 },
      },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:3",
    } as unknown as ApprovalUpdatedParams;
    answer(transport, 0, { approvalId: "a-1", commandId: "mint-0", status: "accepted", terminal: false });
    const outcome = session.apply({ method: "approval/updated", params: update });
    await first.io;
    await waitForWrites(transport, 2);
    assert.deepEqual(asked, [0, 1], "the next stage is asked once the non-terminal ack lands");
    answer(transport, 1, { approvalId: "a-1", commandId: "mint-1", status: "accepted", terminal: true });
    await outcome.io;
  },
);

test(
  "T031/TEST-013 #50244: a stage update waiting on a decide that FAILS is still asked once the failure lands",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The wait must end on a failed decide too: the stage-0 decide bounces,
    // so no terminal ack was ever recorded and the waiting stage-1 update is
    // the consumer's question.
    const { session, transport } = wired();
    const failures: ApprovalFailure[] = [];
    session.onApprovalError((failure) => failures.push(failure));
    const asked: number[] = [];
    session.onApproval((request) => {
      asked.push(request.currentRequirementId.sourceIndex);
      return { choiceId: "allow_once" };
    });
    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);

    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: CHOICES,
      change: {
        choiceId: "allow_once",
        decision: "approved",
        kind: "stageResolved",
        requirementId: { approvalId: "a-1", sourceIndex: 0 },
      },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:3",
    } as unknown as ApprovalUpdatedParams;
    const outcome = session.apply({ method: "approval/updated", params: update });
    await settleMicrotasks();
    assert.deepEqual(asked, [0], "the update waits while the stage-0 decide is on the wire");
    answerError(transport, 0, {
      code: -32053,
      message: "stale requirementId",
      data: { kind: "invalidParams" },
    });
    await first.io;
    await waitForWrites(transport, 2);
    assert.deepEqual(asked, [0, 1], "a failed decide releases the waiting stage");
    assert.equal(failures[0]?.kind, "submitFailed");
    answer(transport, 1, { approvalId: "a-1", commandId: "mint-1", status: "accepted", terminal: true });
    await outcome.io;
  },
);

test(
  "T031/TEST-013 #50244: a stage-0 handler that is still OPEN does not hold back the next stage's update",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The wait starts only when a decide is sent, after its handler returned:
    // a stage-0 handler still deciding (never released here) must not stall
    // the stage-1 update behind it.
    const { session, transport } = wired();
    const asked: number[] = [];
    session.onApproval(async (request) => {
      asked.push(request.currentRequirementId.sourceIndex);
      if (request.currentRequirementId.sourceIndex === 0) await new Promise<never>(() => {});
      return { choiceId: "allow_once" };
    });
    session.apply(approvalRequested());
    await settleMicrotasks();
    assert.deepEqual(asked, [0], "stage 0 is being decided and has sent nothing");

    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: CHOICES,
      change: {
        choiceId: "allow_once",
        decision: "approved",
        kind: "stageResolved",
        requirementId: { approvalId: "a-1", sourceIndex: 0 },
      },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:3",
    } as unknown as ApprovalUpdatedParams;
    const outcome = session.apply({ method: "approval/updated", params: update });
    await waitForWrites(transport, 1);
    assert.deepEqual(asked, [0, 1], "the open stage-0 handler must not hold back stage 1");
    answer(transport, 0, { approvalId: "a-1", commandId: "mint-0", status: "accepted", terminal: true });
    await outcome.io;
  },
);

test(
  "T031/TEST-013 #50244: with two decides in flight, the earlier ack does not release the later decide's wait",
  { timeout: ARM_TIMEOUT },
  async () => {
    // Two decides for one approval on the wire at once: the stage-0 ack must
    // clear only its own wait, so a stage update read in the same chunk as
    // the stage-1 terminal ack still waits for it and asks nothing.
    const { session, transport } = wired();
    const asked: number[] = [];
    session.onApproval((request) => {
      asked.push(request.currentRequirementId.sourceIndex);
      return { choiceId: "allow_once" };
    });
    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    const second = session.apply(
      approvalRequested({ currentRequirementId: { approvalId: "a-1", sourceIndex: 1 }, viewCursor: "v:2" }),
    );
    await waitForWrites(transport, 2);
    assert.deepEqual(asked, [0, 1]);

    answer(transport, 0, { approvalId: "a-1", commandId: "mint-0", status: "accepted", terminal: false });
    await first.io;
    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: CHOICES,
      change: {
        choiceId: "allow_once",
        decision: "approved",
        kind: "stageResolved",
        requirementId: { approvalId: "a-1", sourceIndex: 1 },
      },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 2 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:4",
    } as unknown as ApprovalUpdatedParams;
    answer(transport, 1, { approvalId: "a-1", commandId: "mint-1", status: "accepted", terminal: true });
    const outcome = session.apply({ method: "approval/updated", params: update });
    await second.io;
    await settleMicrotasks();
    assert.deepEqual(asked, [0, 1], "the stage-1 terminal ack must close the approval before stage 2 is asked");
    assert.equal(transport.writes.length, 2, "no decide may chase the stage-1 terminal ack");
    await outcome.io;
  },
);

test(
  "T031/TEST-013 #36949: a stageResolved update AFTER a terminal decide ack asks nothing and writes nothing",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The #37538 producer race: a stage-0 answer whose rule also satisfies the
    // remaining stages terminalizes the approval in one submission, but the
    // runtime records only the RESOLVED stage, so the view fold emits one
    // trailing `stageResolved` update naming a frontier the host already
    // closed — right before `approval/resolved`. The ack's `terminal: true`
    // is the router's evidence that stage names nobody's question.
    const { session, transport } = wired();
    let calls = 0;
    session.onApproval(() => {
      calls += 1;
      return { choiceId: "allow_once" };
    });
    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    // The host closed the WHOLE approval on this decision.
    answer(transport, 0, { approvalId: "a-1", commandId: "mint-0", status: "accepted", terminal: true });
    await first.io;

    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: CHOICES,
      change: {
        choiceId: "allow_once",
        decision: "approved",
        kind: "stageResolved",
        requirementId: { approvalId: "a-1", sourceIndex: 0 },
      },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:3",
    } as unknown as ApprovalUpdatedParams;
    const outcome = session.apply({ method: "approval/updated", params: update });
    // Settle and assert BEFORE awaiting `io` (same shape as the arm below): a
    // regression authors a decide nobody answers, and `io` would pend forever.
    await settleMicrotasks();
    assert.equal(calls, 1, "a stage the host already closed must not re-ask the handler");
    assert.equal(transport.writes.length, 1, "no decide may chase a terminal ack");
    await outcome.io;

    session.apply({
      method: "approval/resolved",
      params: {
        approvalId: "a-1",
        decidedByCommandId: "mint-0",
        decision: "approved",
        itemId: "i-1",
        policyResult: { kind: "allowed" },
        resolvedBy: { kind: "client" },
        sessionId: SESSION,
        sourceRange: SOURCE,
        stageEvidence: [],
        turnId: "turn-1",
        viewCursor: "v:4",
      },
    } as unknown as Parameters<Session<string>["apply"]>[0]);
    assert.equal(session.fold.pendingApprovals().length, 0);
  },
);

test(
  "T031/TEST-013 #36949: an alreadyTerminal approval/updated asks nothing and writes nothing",
  { timeout: ARM_TIMEOUT },
  async () => {
    // `alreadyTerminal` says the host holds a durable terminal the resolve
    // frame has not delivered yet — a decision against it can only bounce
    // -32051, so asking the consumer for one would be a pointless question.
    const { session, transport } = wired();
    let calls = 0;
    session.onApproval(() => {
      calls += 1;
      return { choiceId: "allow_once" };
    });
    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    answer(transport, 0, decideResult("mint-0"));
    await first.io;

    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: CHOICES,
      change: { kind: "alreadyTerminal" },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 2 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:3",
    } as unknown as ApprovalUpdatedParams;
    const outcome = session.apply({ method: "approval/updated", params: update });
    // Settle and assert BEFORE awaiting `io`: a regression here authors a
    // second decide nobody answers, so `io` would pend forever and the failure
    // would surface only as the arm timeout instead of these asserts.
    await settleMicrotasks();
    assert.equal(calls, 1, "an alreadyTerminal update must not re-ask the handler");
    assert.equal(transport.writes.length, 1);
    await outcome.io;
  },
);

test(
  "T031/TEST-013 #36949: an approval/updated the fold IGNORED asks nothing and writes nothing",
  { timeout: ARM_TIMEOUT },
  async () => {
    // FR-019's fourth author-nothing case, and a real wire sequence: a FAILED
    // `localPersistent` policy write arrives as `approval/updated` AFTER
    // `approval/resolved` (tdd SS5.5), when the fold no longer holds the
    // entry. The fold's `ignoredStaleFrame` verdict must gate the route.
    const { session, transport } = wired();
    let calls = 0;
    session.onApproval(() => {
      calls += 1;
      return { choiceId: "allow_once" };
    });
    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    answer(transport, 0, decideResult("mint-0"));
    await first.io;
    session.apply({
      method: "approval/resolved",
      params: {
        approvalId: "a-1",
        decidedByCommandId: "mint-0",
        decision: "approved",
        itemId: "i-1",
        policyResult: { kind: "allowed" },
        resolvedBy: { kind: "client" },
        sessionId: SESSION,
        sourceRange: SOURCE,
        stageEvidence: [],
        turnId: "turn-1",
        viewCursor: "v:2",
      },
    } as unknown as Parameters<Session<string>["apply"]>[0]);

    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: CHOICES,
      change: { kind: "policyPersistence", reason: "disk", status: "failed" },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 5 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:4",
    } as unknown as ApprovalUpdatedParams;
    const outcome = session.apply({ method: "approval/updated", params: update });
    await settleMicrotasks();

    assert.equal(
      (outcome.fold as { kind: string }).kind,
      "ignoredStaleFrame",
      "the fold must drop a post-resolve update",
    );
    assert.equal(calls, 1, "a dropped update must not re-ask the handler");
    assert.equal(transport.writes.length, 1, "a dropped update must author nothing");
    await outcome.io;
  },
);

test(
  "T031/TEST-013: a THROWING onApprovalError observer still lets io resolve",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The failure observer is a consumer entry point too. If its throw
    // escaped #report, it would ride Promise.all into
    // `SessionApplyOutcome.io` — and since most consumers never await `io`
    // (its own doc says so), that is an unhandled rejection that kills the
    // embedder, the exact failure the "io never rejects" contract exists to
    // prevent. `onApproval` already has its `handlerThrew` containment; this
    // pins the one other consumer entry.
    const { session, transport } = wired();
    session.onApprovalError(() => {
      throw new Error("observer boom");
    });
    // An unoffered choice drives #report without needing any wire I/O.
    session.onApproval(() => ({ choiceId: "not-offered" }));

    const outcome = session.apply(approvalRequested());
    await outcome.io; // must RESOLVE — a rejection here fails the arm.

    // The invalid choice authored nothing; the observer's throw changed that
    // nothing into nothing.
    assert.equal(transport.writes.length, 0);
  },
);

/**
 * The approval-round-trip transcript's frames, and a stripper for the params
 * members its manifest normalizes ("params.commandId" → "commandId"; the
 * frame-level "id" never appears inside params), READ from manifest.json.
 */
function approvalTranscript(): {
  readonly lines: readonly { readonly dir: "client" | "server"; readonly frame: Record<string, unknown> }[];
  readonly stripNormalized: (params: Record<string, unknown>) => Record<string, unknown>;
} {
  const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const transcriptDir = join(projectRoot, "schema", "msp", "transcripts", "approval-round-trip");
  const manifest = JSON.parse(readFileSync(join(transcriptDir, "manifest.json"), "utf8")) as {
    normalize: readonly string[];
  };
  const normalizedParamKeys = manifest.normalize
    .filter((entry) => entry.startsWith("params."))
    .map((entry) => entry.slice("params.".length));
  assert.ok(normalizedParamKeys.includes("commandId"), "sanity: the mint is per-run");
  const lines = readFileSync(join(transcriptDir, "transcript.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { dir: "client" | "server"; raw: string })
    .map((line) => ({ dir: line.dir, frame: JSON.parse(line.raw) as Record<string, unknown> }));
  return {
    lines,
    stripNormalized: (params) =>
      Object.fromEntries(Object.entries(params).filter(([key]) => !normalizedParamKeys.includes(key))),
  };
}

test(
  "T031/TEST-013: the approval-round-trip TRANSCRIPT drives the recorded decide frame back out",
  { timeout: ARM_TIMEOUT },
  async () => {
    // TEST-013 names "the approval-round-trip transcript + serve-fixture" as
    // its vehicle, and hand-built params are exactly the drift the transcript
    // guards against — its manifest records a hand-authored/binary
    // disagreement (#22785). The notification half is replayable today: fold
    // the recorded `approval/requested` frame, decide with the recorded
    // choice, and require the outbound `approval/decide` to match the
    // recorded frame modulo the manifest's normalize list, READ from
    // manifest.json rather than hand-copied — a regenerated transcript with a
    // different list re-derives this arm's exclusions instead of silently
    // weakening it. The next arm replays the server-request half.
    const { lines, stripNormalized } = approvalTranscript();
    const requested = lines.find(
      (line) => line.dir === "server" && line.frame["method"] === "approval/requested",
    );
    const recordedDecide = lines.find(
      (line) => line.dir === "client" && line.frame["method"] === "approval/decide",
    );
    assert.ok(requested !== undefined && recordedDecide !== undefined);
    const requestedParams = requested.frame["params"] as ApprovalRequestParams;
    const recordedParams = recordedDecide.frame["params"] as Record<string, unknown>;

    const transport = new FakeDuplex();
    const session = new Session<string>({
      sessionId: requestedParams.sessionId,
      durability: { kind: "durable" },
      connection: new Connection(transport),
    });
    session.onApproval(() => ({ choiceId: recordedParams["choiceId"] as string }));

    const outcome = session.apply({ method: "approval/requested", params: requestedParams });
    await waitForWrites(transport, 1);
    assert.equal(sentFrame(transport, 0)["method"], "approval/decide");
    const sent = sentParams(transport, 0);
    const commandId = sent["commandId"];
    assert.ok(typeof commandId === "string" && commandId.length > 0);
    assert.deepEqual(stripNormalized(sent), stripNormalized(recordedParams));

    answer(transport, 0, {
      approvalId: recordedParams["approvalId"],
      commandId,
      status: "accepted",
      terminal: true,
    });
    await outcome.io;
  },
);

test(
  "T031/TEST-013: the transcript's recorded approval/request, read with the resume reply, drives the recorded decide back out",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The server-request half over the same transcript (FR-53910-1): the
    // recorded request has to pass the routing guard, or a resume hangs while
    // every hand-built arm still passes.
    const { lines, stripNormalized } = approvalTranscript();
    const request = lines.find((line) => line.dir === "server" && line.frame["method"] === "approval/request");
    const recordedDecide = lines.find(
      (line) => line.dir === "client" && line.frame["method"] === "approval/decide",
    );
    assert.ok(request !== undefined && recordedDecide !== undefined);
    const requestParams = request.frame["params"] as ApprovalRequestParams;
    const recordedParams = recordedDecide.frame["params"] as Record<string, unknown>;

    const transport = new FakeDuplex();
    const client = new MuseClient(new Connection(transport), { durability: { kind: "durable" } });
    const pending = client.resumeSession({
      sessionId: requestParams.sessionId,
      onApproval: () => ({ choiceId: recordedParams["choiceId"] as string }),
    });
    await waitForWrites(transport, 1);
    transport.chunks.push(
      frame({
        jsonrpc: "2.0",
        id: sentFrame(transport, 0)["id"],
        result: {
          session: { sessionId: requestParams.sessionId, status: "idle" },
          history: { mode: "none", items: [] },
          pendingRequests: [],
          viewCursor: "v:resume",
        },
      }) + frame(request.frame),
    );
    await pending;
    await waitForWrites(transport, 3);

    const sent = transport.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(
      sent.some((out) => out["id"] === request.frame["id"] && JSON.stringify(out["result"]) === "{}"),
      "the recorded request gets the {} receipt",
    );
    const decide = sent.find((out) => out["method"] === "approval/decide");
    assert.ok(decide !== undefined, "the recorded request reached the resume handler");
    assert.deepEqual(stripNormalized(decide["params"] as Record<string, unknown>), stripNormalized(recordedParams));
    await client.close();
  },
);

test(
  "T031/TEST-013: a request REDELIVERED after approval/resolved authors no second decide",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The `approvalPending` gate's own splitting arm. A post-resolution
    // redelivery arrives with an ADVANCED `sourceIndex`, so the router's
    // stage latch does NOT cover it — only the fold's verdict stands between
    // the handler and a doomed second decide (no second resolution is coming).
    const { session, transport } = wired();
    let calls = 0;
    session.onApproval(() => {
      calls += 1;
      return { choiceId: "allow_once" };
    });
    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    answer(transport, 0, decideResult("mint-0"));
    await first.io;
    session.apply({
      method: "approval/resolved",
      params: {
        approvalId: "a-1",
        decidedByCommandId: "mint-0",
        decision: "approved",
        itemId: "i-1",
        policyResult: { kind: "allowed" },
        resolvedBy: { kind: "client" },
        sessionId: SESSION,
        sourceRange: SOURCE,
        stageEvidence: [],
        turnId: "turn-1",
        viewCursor: "v:2",
      },
    } as unknown as Parameters<Session<string>["apply"]>[0]);

    const redelivered = session.apply(
      approvalRequested({
        currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
      } as Partial<ApprovalRequestParams>),
    );
    await redelivered.io;
    await settleMicrotasks();

    assert.equal(calls, 1, "the handler must not be asked about a resolved approval");
    assert.equal(transport.writes.length, 1, "no second approval/decide may reach the wire");
  },
);

test(
  "T031/TEST-013: a redelivery DURING an in-flight decide authors no second decide",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The latch-before-first-await guard's own splitting arm: the handler
    // spans a microtask, and the same stage folds again with NO await in
    // between. A latch moved past the first await lets both frames pass the
    // decided-stages check — two handler calls, two decide frames, the
    // double-decide SS5.4 forbids.
    const { session, transport } = wired();
    let calls = 0;
    session.onApproval(async () => {
      calls += 1;
      await settleMicrotasks();
      return { choiceId: "allow_once" };
    });

    const first = session.apply(approvalRequested());
    const second = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    answer(transport, 0, decideResult("mint-0"));
    await Promise.all([first.io, second.io]);
    await settleMicrotasks();

    assert.equal(calls, 1, "one stage asks the consumer once");
    assert.equal(transport.writes.length, 1, "one stage authors one decide");
  },
);
