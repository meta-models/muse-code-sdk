/**
 * T031 / TEST-013 `approval_callback_round_trip` — FR-019.
 *
 * The ROUND TRIP is the contract, and the task's NOTE is explicit that a
 * handler-registration half does not satisfy it: every arm below either drives
 * a real `approval/decide` frame out of the fake duplex, or asserts that none
 * was written.
 *
 * SHAPE NOTE, established from the bundle rather than assumed. `approval/request`
 * as a SERVER REQUEST is not enrolled — the schema carries `approval/requested`
 * as a NOTIFICATION only — so the round trip is inbound notification → fold →
 * handler → outbound `approval/decide` command, which is exactly the pair
 * FR-019 names. The server-request form would be a #206 enrollment request
 * (INV-001: a shape the generated layer lacks is never a local interface).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Session } from "../src/index.js";
import type { ApprovalFailure } from "../src/index.js";
import {
  answer,
  answerError,
  FakeDuplex,
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
} from "@muse/msp";

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
  "T031/TEST-013: approval/updated refreshes the stage without authoring a decision",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The update path carries no `approval/request` shape (no itemId/turnId/
    // toolName), so it cannot honestly call a handler typed on the request.
    // SS5.6.3 says a re-issued REQUEST embodies the refresh; that is the frame
    // that drives the handler, and the update alone must not.
    const { session, transport } = wired();
    session.onApproval(() => ({ choiceId: "allow_once" }));
    const first = session.apply(approvalRequested());
    await waitForWrites(transport, 1);
    answer(transport, 0, decideResult("mint-0"));
    await first.io;

    const update: ApprovalUpdatedParams = {
      approvalId: "a-1",
      availableChoices: CHOICES,
      change: { kind: "stageAdvanced" },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
      sessionId: SESSION,
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:3",
    } as unknown as ApprovalUpdatedParams;
    const outcome = session.apply({ method: "approval/updated", params: update });
    await outcome.io;
    await settleMicrotasks();

    assert.equal(transport.writes.length, 1);
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
    // weakening it. The server-request half stays out of scope per the SHAPE
    // note atop this file.
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const transcriptDir = join(projectRoot, "schema", "msp", "transcripts", "approval-round-trip");
    const manifest = JSON.parse(readFileSync(join(transcriptDir, "manifest.json"), "utf8")) as {
      normalize: readonly string[];
    };
    // The seed-minted params members ("params.commandId" → "commandId"); the
    // frame-level entries ("id") never appear inside params.
    const normalizedParamKeys = manifest.normalize
      .filter((entry) => entry.startsWith("params."))
      .map((entry) => entry.slice("params.".length));
    assert.ok(normalizedParamKeys.includes("commandId"), "sanity: the mint is per-run");
    const stripNormalized = (params: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(
        Object.entries(params).filter(([key]) => !normalizedParamKeys.includes(key)),
      );
    const lines = readFileSync(join(transcriptDir, "transcript.ndjson"), "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { dir: "client" | "server"; raw: string })
      .map((line) => ({ dir: line.dir, frame: JSON.parse(line.raw) as Record<string, unknown> }));
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
