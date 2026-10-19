/**
 * An approval still pending at resume is re-sent as an `approval/request`
 * server request (tdd SS5.6). The client that owns the connection routes it
 * to its session's approval routing and answers with the SS5.3.3 receipt
 * `{}`. The resume options' `onApproval` handler is installed before the
 * frames held during the open are applied, so it receives a re-send that
 * arrives with the resume reply.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MuseClient, Session } from "../src/index.js";
import type { MuseClientOptions, ResumeSessionOptions } from "../src/index.js";
import type { ApprovalRequestParams } from "@muse-code/msp";
import { answer, FakeDuplex, frame, sentFrame, settleMicrotasks, waitForWrites } from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
const SOURCE = {
  first: { recordIndex: 0, streamOffset: 0 },
  last: { recordIndex: 0, streamOffset: 0 },
  stream: { kind: "run", runId: "r-1" },
};

function approval(viewCursor: string): Record<string, unknown> {
  return {
    approvalId: "a-1",
    availableChoices: [
      { choiceId: "allow_once", decision: "approved", label: "Allow once", scope: "once" },
      { choiceId: "deny", decision: "denied", label: "Deny", scope: "once" },
    ],
    currentRequirementId: { approvalId: "a-1", sourceIndex: 0 },
    itemId: "i-1",
    judgeEscalated: false,
    protectedWrite: false,
    rawArgs: "{}",
    sessionId: "s-9",
    sourceRange: SOURCE,
    subject: { kind: "shell", command: "ls" },
    taskId: "task-1",
    toolCallId: "call-1",
    toolName: "shell",
    turnId: "turn-1",
    viewCursor,
  };
}

function resumeAck(transport: FakeDuplex): string {
  return frame({
    jsonrpc: "2.0",
    id: sentFrame(transport, 0)["id"],
    result: {
      session: { sessionId: "s-9", status: "idle" },
      history: { mode: "none", items: [] },
      pendingRequests: [],
      viewCursor: "cursor-1",
    },
  });
}

function resend(viewCursor: string): string {
  return frame({ jsonrpc: "2.0", id: 7, method: "approval/request", params: approval(viewCursor) });
}

function frames(transport: FakeDuplex): Record<string, unknown>[] {
  return transport.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function decides(transport: FakeDuplex): Record<string, unknown>[] {
  return frames(transport).filter((sent) => sent["method"] === "approval/decide");
}

async function resume(
  transport: FakeDuplex,
  options: Partial<ResumeSessionOptions>,
  sameChunk: string,
): Promise<Session> {
  const client = new MuseClient(new Connection(transport), DURABLE);
  const pending = client.resumeSession({ sessionId: "s-9", ...options });
  await waitForWrites(transport, 1);
  transport.chunks.push(resumeAck(transport) + sameChunk);
  return pending;
}

test("a re-sent approval read with the resume reply reaches the resume onApproval handler", async () => {
  const transport = new FakeDuplex();
  const seen: ApprovalRequestParams[] = [];
  await resume(
    transport,
    {
      onApproval: async (request) => {
        seen.push(request);
        return { choiceId: "deny" };
      },
    },
    // The host re-sends the params it folded, so the request keeps the
    // approval's own cursor, behind the resume cursor.
    resend("cursor-0"),
  );
  await waitForWrites(transport, 3);
  const { commandId: _commandId, ...resumeParams } = sentFrame(transport, 0)["params"] as Record<string, unknown>;
  assert.deepEqual(resumeParams, { sessionId: "s-9" }, "onApproval is never sent");

  assert.ok(
    frames(transport).some((sent) => sent["id"] === 7 && JSON.stringify(sent["result"]) === "{}"),
    "the re-sent request gets the {} receipt",
  );
  assert.equal(seen.length, 1);
  const [decide] = decides(transport);
  const params = decide?.["params"] as Record<string, unknown>;
  assert.equal(params["approvalId"], "a-1");
  assert.equal(params["choiceId"], "deny");
});

test("with no handler, a re-sent approval is receipted and authors nothing", async () => {
  const transport = new FakeDuplex();
  await resume(transport, {}, resend("cursor-0"));
  await waitForWrites(transport, 2);
  await settleMicrotasks();

  assert.deepEqual(sentFrame(transport, 1), { jsonrpc: "2.0", id: 7, result: {} });
  assert.equal(transport.writes.length, 2, "no approval/decide without a handler");
});

test("a re-sent approval the session already saw resolved authors nothing", async () => {
  const transport = new FakeDuplex();
  const seen: ApprovalRequestParams[] = [];
  const resolved = frame({
    jsonrpc: "2.0",
    method: "approval/resolved",
    params: {
      approvalId: "a-1",
      decision: "approved",
      itemId: "i-1",
      policyResult: "allow",
      resolvedBy: "user",
      sessionId: "s-9",
      sourceRange: SOURCE,
      stageEvidence: [],
      turnId: "turn-1",
      viewCursor: "cursor-2",
    },
  });
  await resume(
    transport,
    {
      onApproval: async (request) => {
        seen.push(request);
        return { choiceId: "deny" };
      },
    },
    resolved + resend("cursor-0"),
  );
  await waitForWrites(transport, 2);
  await settleMicrotasks();

  assert.deepEqual(sentFrame(transport, 1), { jsonrpc: "2.0", id: 7, result: {} });
  assert.equal(seen.length, 0);
  assert.equal(decides(transport).length, 0);
});

test("the notification and the re-sent request for one stage ask the handler once", async () => {
  const transport = new FakeDuplex();
  const seen: ApprovalRequestParams[] = [];
  const notification = frame({
    jsonrpc: "2.0",
    method: "approval/requested",
    params: approval("cursor-2"),
  });
  await resume(
    transport,
    {
      onApproval: async (request) => {
        seen.push(request);
        return { choiceId: "deny" };
      },
    },
    notification + resend("cursor-2"),
  );
  await waitForWrites(transport, 3);
  await settleMicrotasks();

  assert.equal(seen.length, 1);
  assert.equal(decides(transport).length, 1);
});

test("a resume onApproval handler receives an approval/requested read with the resume reply", async () => {
  const transport = new FakeDuplex();
  const seen: ApprovalRequestParams[] = [];
  // A notification is routed synchronously, so it is always held while the
  // resume is in flight: this pins the handler's install before held frames.
  const notification = frame({
    jsonrpc: "2.0",
    method: "approval/requested",
    params: approval("cursor-2"),
  });
  await resume(
    transport,
    {
      onApproval: async (request) => {
        seen.push(request);
        return { choiceId: "deny" };
      },
    },
    notification,
  );
  await waitForWrites(transport, 2);

  assert.equal(seen.length, 1);
  assert.equal(decides(transport).length, 1);
});

test("a malformed re-sent approval read with the resume reply is dropped, not thrown", async () => {
  const transport = new FakeDuplex();
  const seen: ApprovalRequestParams[] = [];
  const { currentRequirementId: _dropped, ...malformed } = approval("cursor-0");
  const session = await resume(
    transport,
    {
      onApproval: async (request) => {
        seen.push(request);
        return { choiceId: "deny" };
      },
    },
    frame({ jsonrpc: "2.0", id: 7, method: "approval/request", params: malformed }),
  );
  await waitForWrites(transport, 2);
  await settleMicrotasks();

  assert.equal(session.sessionId, "s-9", "resumeSession resolved");
  assert.deepEqual(sentFrame(transport, 1), { jsonrpc: "2.0", id: 7, result: {} });
  assert.equal(seen.length, 0);
});

test("a re-sent approval naming an unknown session still gets the {} receipt", async () => {
  const transport = new FakeDuplex();
  const seen: ApprovalRequestParams[] = [];
  await resume(
    transport,
    {
      onApproval: async (request) => {
        seen.push(request);
        return { choiceId: "deny" };
      },
    },
    "",
  );
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: 8,
      method: "approval/request",
      params: { ...approval("cursor-0"), sessionId: "s-other" },
    }),
  );
  await waitForWrites(transport, 2);
  await settleMicrotasks();

  assert.deepEqual(sentFrame(transport, 1), { jsonrpc: "2.0", id: 8, result: {} });
  assert.equal(seen.length, 0);
});

for (const [name, onApproval, kind] of [
  [
    "throws",
    () => {
      throw new Error("boom");
    },
    "handlerThrew",
  ],
  ["picks an unoffered choice", () => ({ choiceId: "not-offered" }), "unofferedChoice"],
] as const) {
  test(`a resume onApprovalError hears a held approval whose resume handler ${name}`, async () => {
    // The held frame is applied inside `resumeSession`, before the caller has
    // the session to register `onApprovalError` on, so the observer rides in
    // the resume options too.
    const transport = new FakeDuplex();
    const failures: string[] = [];
    await resume(
      transport,
      { onApproval, onApprovalError: (failure) => failures.push(failure.kind) },
      resend("cursor-0"),
    );
    await waitForWrites(transport, 2);
    await settleMicrotasks();

    assert.deepEqual(failures, [kind]);
    const { commandId: _commandId, ...resumeParams } = sentFrame(transport, 0)["params"] as Record<string, unknown>;
    assert.deepEqual(resumeParams, { sessionId: "s-9" }, "neither handler is sent");
  });
}

for (const duringFill of [false, true]) {
  test(`a re-sent request ${duringFill ? "buffered during" : "after"} a gap fill leaves the notification's overlap slot to its twin`, async () => {
    // A fill pages `approval/requested@v:3` and a stage-advancing
    // `approval/updated@v:4`. The request shares its notification's cursor and
    // rides its own presenter lane, so it can land before the late live twin,
    // while the fill runs (buffered, then drained) or after it.
    const transport = new FakeDuplex();
    const session = new Session({
      connection: new Connection(transport),
      durability: { kind: "durable" },
      sessionId: "s-9",
    });
    const update = {
      approvalId: "a-1",
      availableChoices: [{ choiceId: "deny", decision: "denied", label: "Deny", scope: "once" }],
      change: {
        choiceId: "allow_once",
        decision: "approved",
        kind: "stageResolved",
        requirementId: { approvalId: "a-1", sourceIndex: 0 },
      },
      currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
      sessionId: "s-9",
      sourceRange: SOURCE,
      subject: { kind: "shell", command: "ls" },
      viewCursor: "v:4",
    };
    const request = { method: "approval/request", params: approval("v:3") };
    const gap = session.apply({ method: "view/gap", params: { after: "v:1", next: "v:3", sessionId: "s-9" } });
    await waitForWrites(transport, 1);
    if (duringFill) assert.equal(session.apply(request).fold.kind, "bufferedDuringGap");
    answer(transport, 0, {
      events: [
        { method: "approval/requested", params: approval("v:3") },
        { method: "approval/updated", params: update },
      ],
      nextCursor: "v:4",
    });
    await gap.io;
    if (!duringFill) session.apply(request);
    const twin = session.apply({ method: "approval/requested", params: approval("v:3") });

    assert.deepEqual(twin.fold, { kind: "ignoredGapOverlap", method: "approval/requested", viewCursor: "v:3" });
    const [pending] = session.fold.pendingApprovals();
    assert.equal(pending?.latestUpdate?.viewCursor, "v:4", "the paged stage advance is kept");
  });
}

const { availableChoices: _choices, ...noChoices } = approval("cursor-0");
const MALFORMED: readonly (readonly [string, unknown])[] = [
  ["null params", null],
  ["array params", []],
  ["string params", "nope"],
  ["a non-string approvalId", { ...approval("cursor-0"), approvalId: 7 }],
  ["a null currentRequirementId", { ...approval("cursor-0"), currentRequirementId: null }],
  ["an empty currentRequirementId", { ...approval("cursor-0"), currentRequirementId: {} }],
  ["a requirement with no approvalId", { ...approval("cursor-0"), currentRequirementId: { sourceIndex: 0 } }],
  [
    "a string sourceIndex",
    { ...approval("cursor-0"), currentRequirementId: { approvalId: "a-1", sourceIndex: "0" } },
  ],
  [
    "a boolean sourceIndex",
    { ...approval("cursor-0"), currentRequirementId: { approvalId: "a-1", sourceIndex: true } },
  ],
  [
    "a fractional sourceIndex",
    { ...approval("cursor-0"), currentRequirementId: { approvalId: "a-1", sourceIndex: 1.5 } },
  ],
  ["no availableChoices", noChoices],
  ["a choice with no choiceId", { ...approval("cursor-0"), availableChoices: [{ decision: "denied" }] }],
  ["a null choice", { ...approval("cursor-0"), availableChoices: [null] }],
];

test("Session.apply drops an approval/request missing a member the router reads", async () => {
  const cases: (readonly [string, { method: string; params?: unknown }])[] = [
    ["no params", { method: "approval/request" }],
    ...MALFORMED.map(([name, params]) => [name, { method: "approval/request", params }] as const),
  ];
  for (const [name, event] of cases) {
    const session = new Session({ sessionId: "s-9", durability: { kind: "durable" } });
    const seen: ApprovalRequestParams[] = [];
    const failures: unknown[] = [];
    session.onApproval((request) => {
      seen.push(request);
      return { choiceId: "deny" };
    });
    session.onApprovalError((failure) => failures.push(failure));

    const outcome = session.apply(event);
    await outcome.io;

    // A request with no params object reports what every such frame does; one
    // with params is the sanctioned interim verdict (#62835).
    const params = event.params;
    const hasParams = params !== null && typeof params === "object" && !Array.isArray(params);
    const kind = hasParams ? "ignoredUnrecognizedMethod" : "ignoredMissingParams";
    assert.deepEqual(outcome.fold, { kind, method: "approval/request" }, name);
    assert.equal(seen.length, 0, name);
    assert.deepEqual(failures, [], name);
  }

  // A well-formed request reaches the router, which refuses it on this
  // fold-only session before asking: each row above is dropped by its own member.
  const session = new Session({ sessionId: "s-9", durability: { kind: "durable" } });
  const failures: { kind: string }[] = [];
  session.onApproval(() => ({ choiceId: "deny" }));
  session.onApprovalError((failure) => failures.push(failure));
  const outcome = session.apply({ method: "approval/request", params: approval("cursor-0") });
  await outcome.io;
  assert.deepEqual(outcome.fold, { kind: "ignoredUnrecognizedMethod", method: "approval/request" });
  assert.deepEqual(
    failures.map((failure) => failure.kind),
    ["submitFailed"],
  );
});
