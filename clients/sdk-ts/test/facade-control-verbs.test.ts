/**
 * Turn and session control verbs the host already serves: the turn
 * handle's `cancel`/`interrupt`/`steer`/`unqueue`, the `Session` control and
 * subagent/plugin/skill verbs, and `MuseClient.listModels`/`readUsage`.
 *
 * Every arm drives a real frame out of the fake duplex, or asserts that none
 * was written. Causal, never time-based: every wait is a bounded microtask pump.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMMAND_REJECTED_CODE,
  COMMAND_REJECTED_KIND,
  Connection,
  MuseClient,
  MuseSessionDiscardedError,
  Session,
} from "../src/index.js";
import type { ExitClassification, MuseClientOptions, Turn } from "../src/index.js";
import {
  answer,
  answerError,
  FakeDuplex,
  sentFrame,
  sentParams,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";
import type { Item, SourceRange } from "@muse-code/msp";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
const SOURCE: SourceRange = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: "str-1", kind: "session" },
};

function wired(): { session: Session<string>; transport: FakeDuplex } {
  const transport = new FakeDuplex();
  let next = 0;
  const connection = new Connection(transport, { mintCommandId: () => `mint-${next++}` });
  const session = new Session<string>({ sessionId: "s-1", durability: { kind: "durable" }, connection });
  return { session, transport };
}

/** The sent params minus the minted `commandId`. */
function withoutCommandId(transport: FakeDuplex, index: number): Record<string, unknown> {
  const params = { ...sentParams(transport, index) };
  delete params["commandId"];
  return params;
}

/** Answer frame `index` with `result` plus the `commandId` it carried. */
function ack(transport: FakeDuplex, index: number, result: Record<string, unknown>): void {
  answer(transport, index, { ...result, commandId: sentParams(transport, index)["commandId"] });
}

function userMessage(itemId: string, turnId: string, commandId?: string): Item {
  return {
    itemId,
    kind: "userMessage",
    revision: 1,
    sessionId: "s-1",
    status: "completed",
    turnId,
    ...(commandId === undefined ? {} : { commandId }),
  } as unknown as Item;
}

function discardedSession(): { session: Session<string>; transport: FakeDuplex } {
  const transport = new FakeDuplex();
  const session = new Session<string>({
    sessionId: "s-9",
    durability: { kind: "ephemeral" },
    connection: new Connection(transport),
  });
  const crash: ExitClassification = {
    exitCode: 77,
    exitSignal: null,
    kind: "crash",
    stderrTail: ["thread 'main' panicked"],
  };
  assert.equal(session.hostExited(crash).kind, "discharged");
  return { session, transport };
}

/** Every Session and turn control verb, each called once on `session`. */
function everyVerb(session: Session<string>, turn: Turn<string>): Array<[string, () => Promise<unknown>]> {
  return [
    ["turn.cancel", () => turn.cancel()],
    ["turn.interrupt", () => turn.interrupt()],
    ["turn.steer", () => turn.steer({ input: [{ type: "text", text: "s" }] })],
    ["turn.unqueue", () => turn.unqueue()],
    ["fork", () => session.fork()],
    ["compact", () => session.compact()],
    ["setModel", () => session.setModel({ modelId: "m" })],
    ["setReasoningEffort", () => session.setReasoningEffort("high")],
    ["setApprovalMode", () => session.setApprovalMode("onRequest")],
    ["rename", () => session.rename("n")],
    ["leave", () => session.leave()],
    ["sendSubagentMessage", () => session.sendSubagentMessage("sa-1", "b")],
    ["followupSubagentTask", () => session.followupSubagentTask("sa-1", "b")],
    ["interruptSubagent", () => session.interruptSubagent("sa-1")],
    ["stopSubagent", () => session.stopSubagent("sa-1")],
    ["resumeSubagent", () => session.resumeSubagent("sa-1")],
    ["reopenSubagent", () => session.reopenSubagent("sa-1")],
    ["closeSubagent", () => session.closeSubagent("sa-1")],
    ["readSubagentResult", () => session.readSubagentResult("sa-1")],
    ["listPlugins", () => session.listPlugins()],
    ["installPlugin", () => session.installPlugin({ localPath: { path: "/p" } })],
    [
      "setSkillActivation",
      () => session.setSkillActivation({ activation: "off", scope: "user", selector: "k" }),
    ],
  ];
}

test("turn cancel/interrupt/unqueue target the handle's own turn and resolve the ack", async () => {
  const cases: Array<{
    method: string;
    call: (t: Turn<string>) => Promise<unknown>;
    params: Record<string, unknown>;
  }> = [
    { method: "turn/cancel", call: (t) => t.cancel(), params: { sessionId: "s-1", turnId: "t-1" } },
    { method: "turn/interrupt", call: (t) => t.interrupt(), params: { sessionId: "s-1", turnId: "t-1" } },
    {
      method: "turn/interrupt",
      call: (t) => t.interrupt({ retract: true }),
      params: { retract: true, sessionId: "s-1", turnId: "t-1" },
    },
    {
      method: "turn/unqueue",
      call: async (t) => (await t.unqueue()).ack,
      params: { sessionId: "s-1", turnId: "t-1" },
    },
  ];
  for (const { method, call, params } of cases) {
    const { session, transport } = wired();
    const pending = call(session.turn("t-1"));
    await waitForWrites(transport, 1);
    assert.equal(sentFrame(transport, 0)["method"], method);
    assert.deepEqual(withoutCommandId(transport, 0), params, `${method} sends the full params`);
    assert.equal(typeof sentParams(transport, 0)["commandId"], "string", `${method} is a command`);
    ack(transport, 0, { status: "accepted", turnId: "t-1" });
    assert.equal(((await pending) as Record<string, unknown>)["turnId"], "t-1");
  }
});

test("steer records the pending entry before the ack and materializes on its userMessage", async () => {
  const { session, transport } = wired();
  session.apply({
    method: "item/completed",
    params: { sessionId: "s-1", turnId: "t-1", item: userMessage("i-0", "t-1") },
  } as never);
  const steering = session.turn("t-1").steer({
    composerInput: "draft",
    input: [{ type: "text", text: "only the agent crate" }],
    reasoningEffort: "high",
  });
  await waitForWrites(transport, 1);
  assert.equal(sentFrame(transport, 0)["method"], "turn/steer");
  assert.deepEqual(withoutCommandId(transport, 0), {
    expectedTurnId: "t-1",
    input: [{ type: "text", text: "only the agent crate" }],
    reasoningEffort: "high",
    sessionId: "s-1",
  });
  const commandId = sentParams(transport, 0)["commandId"] as string;
  // SS4.13: the entry exists BEFORE the ack, anchored after the last folded item.
  const entry = session.pending.get(commandId);
  assert.equal(entry?.input, "draft");
  assert.equal(entry?.anchorAfterItemId, "i-0");

  ack(transport, 0, { status: "accepted", turnId: "t-1" });
  assert.equal((await steering).turnId, "t-1");
  assert.deepEqual(session.pending.get(commandId)?.ack, { disposition: "steered", turnId: "t-1" });

  const applied = session.apply({
    method: "item/completed",
    params: { sessionId: "s-1", turnId: "t-1", item: userMessage("i-1", "t-1", commandId) },
  } as never);
  assert.deepEqual(applied.retirements, [
    { commandId, itemId: "i-1", kind: "materialized", matchedBy: "userMessage" },
  ]);
  assert.equal(session.pending.has(commandId), false);
});

test("a durably rejected steer retires to the composer", async () => {
  const { session, transport } = wired();
  const steering = session.turn("t-1").steer({ composerInput: "draft", input: [{ type: "text", text: "s" }] });
  await waitForWrites(transport, 1);
  const commandId = sentParams(transport, 0)["commandId"] as string;
  answerError(transport, 0, {
    code: COMMAND_REJECTED_CODE,
    message: "turn already finished",
    data: { kind: COMMAND_REJECTED_KIND, reason: "already_terminal" },
  });
  await assert.rejects(steering);
  assert.equal(session.pending.has(commandId), false);
});

test("an acked steer is replayed as turn/steer under its own commandId at reconnect", async () => {
  const { session, transport } = wired();
  const steering = session.turn("t-1").steer({ input: [{ type: "text", text: "s" }] });
  await waitForWrites(transport, 1);
  const commandId = sentParams(transport, 0)["commandId"] as string;
  ack(transport, 0, { status: "accepted", turnId: "t-1" });
  await steering;

  const resolving = session.resolveReconnect();
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "turn/steer");
  assert.deepEqual(sentParams(transport, 1), sentParams(transport, 0), "the replay re-sends the same command");
  ack(transport, 1, { status: "accepted", turnId: "t-1" });
  assert.deepEqual(await resolving, []);
  assert.equal(session.pending.has(commandId), true, "a still-pending steered ack holds");
});

/**
 * Prove a retired command's `turn/start` params left the replay memory (the
 * `facade-submit.test.ts` probe): re-seed the SAME `commandId` beside one live,
 * unacked submit and drive the no-snapshot reconnect. A pruned memory has
 * nothing to replay for the re-seeded id and sends exactly one frame, the live
 * entry's; a leaked one re-sends the retired `turn/start` first.
 */
async function assertReplayMemoryPruned(
  session: Session<string>,
  transport: FakeDuplex,
  retiredCommandId: string,
): Promise<void> {
  session.pending.submitted({ commandId: retiredCommandId, input: "re-seeded" });
  const live = session.sendUserTurn({ composerInput: "again", input: [{ type: "text", text: "again" }] });
  const liveWrite = transport.writes.length;
  await waitForWrites(transport, liveWrite + 1);
  const liveCommandId = sentParams(transport, liveWrite)["commandId"];
  // Admits nothing, so the live entry holds unacked for the resubmit.
  answerError(transport, liveWrite, { code: -32602, message: "invalid params", data: { kind: "invalidParams" } });
  await live.catch(() => undefined);

  const reconnected = session.resolveReconnect();
  const replayWrite = transport.writes.length;
  await waitForWrites(transport, replayWrite + 1);
  assert.equal(
    sentParams(transport, replayWrite)["commandId"],
    liveCommandId,
    `the reconnect re-sent retired ${retiredCommandId}: its replay memory was not pruned`,
  );
  ack(transport, replayWrite, { disposition: "started", startedNewTurn: true, status: "accepted", turnId: "t-live" });
  assert.deepEqual(await reconnected, []);
  await settleMicrotasks();
  assert.equal(transport.writes.length, replayWrite + 1, "only the live entry is resubmitted");
}

/** A `Session` holding one queued submit for `t-2`, acked; returns its handle. */
async function queuedTurn(): Promise<{
  session: Session<string>;
  transport: FakeDuplex;
  turn: Turn<string>;
  queuedCommandId: string;
}> {
  const { session, transport } = wired();
  const submitting = session.sendUserTurn({ composerInput: "queued text", input: [{ type: "text", text: "q" }] });
  await waitForWrites(transport, 1);
  const queuedCommandId = sentParams(transport, 0)["commandId"] as string;
  ack(transport, 0, { disposition: "queued", startedNewTurn: true, status: "accepted", turnId: "t-2" });
  return { session, transport, turn: await submitting, queuedCommandId };
}

test("an accepted unqueue retires the queued entry at once; the later turn/unqueued retires nothing twice", async () => {
  const { session, transport, turn, queuedCommandId } = await queuedTurn();

  const unqueuing = turn.unqueue();
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "turn/unqueue");
  assert.equal(sentParams(transport, 1)["turnId"], "t-2");
  assert.notEqual(sentParams(transport, 1)["commandId"], queuedCommandId, "a fresh commandId, never the queued one");
  ack(transport, 1, { status: "accepted", turnId: "t-2" });
  const outcome = await unqueuing;
  // SS4.13 Reclaimed: the client's own accepted reclaim ack retires the entry
  // then and there, with the same composer restore (an admitted reclaim means
  // the turn never launches, tdd SS3.6).
  assert.equal(outcome.ack.turnId, "t-2");
  assert.deepEqual(outcome.retirement, {
    commandId: queuedCommandId,
    input: "queued text",
    kind: "reclaimed",
    restoreToComposer: true,
  });
  assert.equal(session.pending.has(queuedCommandId), false);

  const applied = session.apply({
    method: "turn/unqueued",
    params: { commandId: queuedCommandId, sessionId: "s-1", sourceRange: SOURCE, turnId: "t-2", viewCursor: "v:1" },
  } as never);
  assert.deepEqual(applied.retirements, [], "the view event finds nothing left to retire");
  assert.equal((await turn.completed).kind, "unqueued", "the turn still settles on the view event");
  // The accepted unqueue is the only retirement of this entry, so it alone must
  // clear the queued turn's replay memory.
  await assertReplayMemoryPruned(session, transport, queuedCommandId);
});

test("a turn/unqueued folded before the unqueue ack retires the entry there, once", async () => {
  const { session, transport, turn, queuedCommandId } = await queuedTurn();
  const unqueuing = turn.unqueue();
  await waitForWrites(transport, 2);

  // The view event wins the race with the ack: `apply` retires the entry.
  const applied = session.apply({
    method: "turn/unqueued",
    params: { commandId: queuedCommandId, sessionId: "s-1", sourceRange: SOURCE, turnId: "t-2", viewCursor: "v:1" },
  } as never);
  assert.deepEqual(applied.retirements, [
    { commandId: queuedCommandId, input: "queued text", kind: "reclaimed", restoreToComposer: true },
  ]);
  assert.equal(session.pending.has(queuedCommandId), false);

  ack(transport, 1, { status: "accepted", turnId: "t-2" });
  const outcome = await unqueuing;
  assert.equal(outcome.ack.status, "accepted");
  assert.equal(outcome.retirement, undefined, "apply already returned the retirement; the ack retires nothing twice");
  assert.equal((await turn.completed).kind, "unqueued");
  await assertReplayMemoryPruned(session, transport, queuedCommandId);
});

test("a rejected unqueue retires nothing: the queued entry holds", async () => {
  const { session, transport, turn, queuedCommandId } = await queuedTurn();
  const unqueuing = turn.unqueue();
  await waitForWrites(transport, 2);
  answerError(transport, 1, {
    code: COMMAND_REJECTED_CODE,
    message: "turn already launched",
    data: { kind: COMMAND_REJECTED_KIND, reason: "run_active" },
  });
  await assert.rejects(unqueuing);
  assert.equal(session.pending.has(queuedCommandId), true);
});

test("Session control, subagent, plugin and skill verbs send full params and resolve acks", async () => {
  const commands: Array<{
    method: string;
    call: (s: Session<string>) => Promise<unknown>;
    params: Record<string, unknown>;
    result: Record<string, unknown>;
  }> = [
    {
      method: "session/fork",
      call: (s) => s.fork({ cutPoint: { lastTurnId: "t-1" }, excludeItems: true }),
      params: { cutPoint: { lastTurnId: "t-1" }, excludeItems: true, sessionId: "s-1" },
      result: { history: { mode: "none", items: null, snapshot: null }, pendingRequests: [], session: { sessionId: "f-1" }, viewCursor: "v" },
    },
    { method: "session/fork", call: (s) => s.fork(), params: { sessionId: "s-1" }, result: { viewCursor: "v" } },
    { method: "session/compact", call: (s) => s.compact({ turnId: "t-1" }), params: { sessionId: "s-1", turnId: "t-1" }, result: { status: "accepted" } },
    { method: "session/compact", call: (s) => s.compact(), params: { sessionId: "s-1" }, result: { status: "noop", reason: "no_compactable_history" } },
    {
      method: "session/setModel",
      call: (s) => s.setModel({ modelId: "m-1", providerId: "p" }),
      params: { model: { modelId: "m-1", providerId: "p" }, sessionId: "s-1" },
      result: { status: "accepted" },
    },
    {
      method: "session/setReasoningEffort",
      call: (s) => s.setReasoningEffort("high"),
      params: { reasoningEffort: "high", sessionId: "s-1" },
      result: { status: "accepted" },
    },
    {
      method: "session/setApprovalMode",
      call: (s) => s.setApprovalMode("denyUnmatched"),
      params: { mode: "denyUnmatched", sessionId: "s-1" },
      result: { applyOutcome: "applied", status: "accepted" },
    },
    { method: "session/rename", call: (s) => s.rename("n-1"), params: { name: "n-1", sessionId: "s-1" }, result: { name: "n-1", status: "accepted" } },
    { method: "session/leave", call: (s) => s.leave({ stop: true }), params: { sessionId: "s-1", stop: true }, result: { status: "accepted" } },
    { method: "session/leave", call: (s) => s.leave(), params: { sessionId: "s-1" }, result: { status: "accepted" } },
    {
      method: "subagent/sendMessage",
      call: (s) => s.sendSubagentMessage("sa-1", "note"),
      params: { body: "note", sessionId: "s-1", subagentId: "sa-1" },
      result: { status: "accepted" },
    },
    {
      method: "subagent/followupTask",
      call: (s) => s.followupSubagentTask("sa-1", "task"),
      params: { body: "task", sessionId: "s-1", subagentId: "sa-1" },
      result: { status: "accepted" },
    },
    {
      method: "subagent/interrupt",
      call: (s) => s.interruptSubagent("sa-1", { reason: "r" }),
      params: { reason: "r", sessionId: "s-1", subagentId: "sa-1" },
      result: { status: "accepted" },
    },
    { method: "subagent/stop", call: (s) => s.stopSubagent("sa-1"), params: { sessionId: "s-1", subagentId: "sa-1" }, result: { status: "accepted" } },
    { method: "subagent/resume", call: (s) => s.resumeSubagent("sa-1"), params: { sessionId: "s-1", subagentId: "sa-1" }, result: { status: "accepted" } },
    { method: "subagent/reopen", call: (s) => s.reopenSubagent("sa-1"), params: { sessionId: "s-1", subagentId: "sa-1" }, result: { status: "accepted" } },
    {
      method: "subagent/close",
      call: (s) => s.closeSubagent("sa-1", { reason: "done" }),
      params: { reason: "done", sessionId: "s-1", subagentId: "sa-1" },
      result: { status: "accepted" },
    },
    {
      method: "subagent/readResult",
      call: (s) => s.readSubagentResult("sa-1"),
      params: { sessionId: "s-1", subagentId: "sa-1" },
      result: { status: "accepted" },
    },
    {
      method: "plugin/install",
      call: (s) => s.installPlugin({ marketplace: { marketplace: "store", name: "p" } }),
      params: { sessionId: "s-1", target: { marketplace: { marketplace: "store", name: "p" } } },
      result: { enabled: true, id: "p@store", source: "marketplace", status: "accepted", version: "1" },
    },
    {
      method: "skill/setActivation",
      call: (s) => s.setSkillActivation({ activation: "off", scope: "project", selector: "lint" }),
      params: { activation: "off", scope: "project", selector: "lint", sessionId: "s-1" },
      result: { activation: "off", previous: "on", scope: "project", selector: "lint", status: "accepted" },
    },
  ];
  for (const { method, call, params, result } of commands) {
    const { session, transport } = wired();
    const pending = call(session);
    await waitForWrites(transport, 1);
    assert.equal(sentFrame(transport, 0)["method"], method);
    assert.equal(typeof sentParams(transport, 0)["commandId"], "string", `${method} is a command`);
    assert.deepEqual(withoutCommandId(transport, 0), params, `${method} sends the full params`);
    const echoed = { ...result, commandId: sentParams(transport, 0)["commandId"] };
    answer(transport, 0, echoed);
    assert.deepEqual(await pending, echoed, `${method} resolves the wire result`);
  }
});

test("listPlugins is a read-only query: no commandId", async () => {
  const { session, transport } = wired();
  const pending = session.listPlugins();
  await waitForWrites(transport, 1);
  assert.equal(sentFrame(transport, 0)["method"], "plugin/list");
  assert.deepEqual(sentParams(transport, 0), { sessionId: "s-1" });
  answer(transport, 0, { plugins: [] });
  assert.deepEqual(await pending, { plugins: [] });
});

test("MuseClient.listModels and readUsage are queries, with and without params", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const listing = client.listModels({ sessionId: "s-1" });
  await waitForWrites(transport, 1);
  assert.equal(sentFrame(transport, 0)["method"], "model/list");
  assert.deepEqual(sentParams(transport, 0), { sessionId: "s-1" });
  const catalog = { models: [], profileId: null, providerId: "p", source: "bundled" };
  answer(transport, 0, catalog);
  assert.deepEqual(await listing, catalog);

  const bare = client.listModels();
  await waitForWrites(transport, 2);
  assert.deepEqual(sentParams(transport, 1), {}, "no session: nothing is flagged active");
  answer(transport, 1, catalog);
  await bare;

  const usage = client.readUsage();
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "usage/read");
  assert.equal("params" in sentFrame(transport, 2), false, "usage/read has no params");
  answer(transport, 2, {});
  assert.deepEqual(await usage, {});
});

test("a fold-only Session refuses every control verb, and its fold still applies", async () => {
  const session = new Session<string>({ sessionId: "s-1", durability: { kind: "durable" } });
  for (const [verb, call] of everyVerb(session, session.turn("t-1"))) {
    await assert.rejects(call(), /needs a connection/, `${verb} refuses fold-only`);
  }
  // The refusal refuses only the send (Constitution XIII): local folding stays usable.
  session.apply({
    method: "item/completed",
    params: { sessionId: "s-1", turnId: "t-1", item: userMessage("m-1", "t-1") },
  } as never);
  assert.equal(session.fold.items.get("m-1")?.itemId, "m-1");
});

test("a discarded session refuses every control verb before sending anything", async () => {
  const { session, transport } = discardedSession();
  const turn = session.turn("t-1");
  for (const [verb, call] of everyVerb(session, turn)) {
    await assert.rejects(call(), MuseSessionDiscardedError, `${verb} refuses after the discard`);
  }
  await settleMicrotasks();
  assert.equal(transport.writes.length, 0);
  // Its own read surface keeps SS2.13.3b's discard semantics: the waiter was told.
  assert.equal((await turn.completed).kind, "terminalUnknown");
});
