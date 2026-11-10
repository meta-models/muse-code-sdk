/**
 * `Session.run`: one call from a prompt to the turn's final answer, and its
 * AbortSignal arms (spec 14990 FR-79108-1).
 *
 * Every arm drives real frames through the fake duplex and `Session.apply`.
 * Causal, never time-based: every wait is a bounded microtask pump.
 */

import { getEventListeners } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  Item,
  ItemCompletedParams,
  SourceRange,
  TokenUsage,
  TurnCompletedParams,
  TurnStartedParams,
  TurnUnqueuedParams,
} from "@muse-code/msp";

import {
  COMMAND_REJECTED_CODE,
  COMMAND_REJECTED_KIND,
  Connection,
  MspError,
  MuseHostDiedError,
  Session,
} from "../src/index.js";
import type { ExitClassification, RunResult, ViewEvent } from "../src/index.js";
import {
  answer,
  answerError,
  FakeDuplex,
  sentFrame,
  sentParams,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";

const SESSION = "s-1";
const SOURCE: SourceRange = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: "str-1", kind: "session" },
};
const USAGE: TokenUsage = { inputTokens: 12, outputTokens: 34 } as TokenUsage;

let cursor = 0;
function nextCursor(): string {
  cursor += 1;
  return `v:${cursor}`;
}

function wired(durability: "durable" | "ephemeral" = "durable"): { session: Session<string>; transport: FakeDuplex } {
  const transport = new FakeDuplex();
  let next = 0;
  const connection = new Connection(transport, { mintCommandId: () => `mint-${next++}` });
  const session = new Session<string>({ sessionId: SESSION, durability: { kind: durability }, connection });
  return { session, transport };
}

/** Answer frame `index` with `result` plus the `commandId` it carried. */
function ack(transport: FakeDuplex, index: number, result: Record<string, unknown>): void {
  answer(transport, index, { ...result, commandId: sentParams(transport, index)["commandId"] });
}

function ackStart(transport: FakeDuplex, index: number, turnId: string, disposition: string): void {
  ack(transport, index, { disposition, startedNewTurn: disposition !== "steered", status: "accepted", turnId });
}

function turnStarted(turnId: string): ViewEvent {
  const params: TurnStartedParams = {
    commandId: turnId,
    sessionId: SESSION,
    sourceRange: SOURCE,
    turnId,
    viewCursor: nextCursor(),
  };
  return { method: "turn/started", params };
}

function turnCompleted(turnId: string, terminal: string, usage?: TokenUsage): ViewEvent {
  const params: TurnCompletedParams = {
    sessionId: SESSION,
    sourceRange: SOURCE,
    terminal,
    turnId,
    viewCursor: nextCursor(),
    ...(usage === undefined ? {} : { usage }),
  };
  return { method: "turn/completed", params };
}

function turnUnqueued(turnId: string, commandId: string): ViewEvent {
  const params: TurnUnqueuedParams = {
    commandId,
    sessionId: SESSION,
    sourceRange: SOURCE,
    turnId,
    viewCursor: nextCursor(),
  };
  return { method: "turn/unqueued", params };
}

function completed(item: Item): ViewEvent {
  const params: ItemCompletedParams = { item, sessionId: SESSION, sourceRange: SOURCE, viewCursor: nextCursor() };
  return { method: "item/completed", params };
}

function agentMessage(itemId: string, turnId: string, extra: Partial<Item>): Item {
  return { itemId, kind: "agentMessage", revision: 1, status: "completed", turnId, ...extra };
}

/** Start `run`, answer its `turn/start` with `disposition`, and fold `turn/started` when it ran. */
async function runTo(
  disposition: "started" | "queued",
  options: Parameters<Session<string>["run"]>[1] = {},
): Promise<{ session: Session<string>; transport: FakeDuplex; running: Promise<RunResult>; commandId: string }> {
  const { session, transport } = wired();
  const running = session.run("go", options);
  await waitForWrites(transport, 1);
  const commandId = sentParams(transport, 0)["commandId"] as string;
  ackStart(transport, 0, "t-1", disposition);
  await settleMicrotasks();
  if (disposition === "started") session.apply(turnStarted("t-1"));
  return { commandId, running, session, transport };
}

/** Track whether a promise has settled, without consuming its rejection. */
function watch(promise: Promise<unknown>): { readonly settled: boolean } {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

test("run sends one turn/start and resolves the outcome, final text, items and usage", async () => {
  const { session, transport } = wired();
  const running = session.run("Summarize this repository.", { ifBusy: "queue", reasoningEffort: "high" });
  await waitForWrites(transport, 1);
  assert.equal(sentFrame(transport, 0)["method"], "turn/start");
  const params = { ...sentParams(transport, 0) };
  assert.equal(typeof params["commandId"], "string");
  delete params["commandId"];
  assert.deepEqual(params, {
    ifBusy: "queue",
    input: [{ text: "Summarize this repository.", type: "text" }],
    reasoningEffort: "high",
    sessionId: SESSION,
  });
  ackStart(transport, 0, "t-1", "started");
  await settleMicrotasks();

  session.apply(turnStarted("t-1"));
  session.apply(completed(agentMessage("a-1", "t-1", { messagePhase: "commentary", text: "Looking around." })));
  session.apply(completed(agentMessage("a-2", "t-1", { messagePhase: "finalAnswer", text: "It is an SDK." })));
  session.apply(completed(agentMessage("x-1", "t-other", { text: "another turn's reply" })));
  session.apply(turnCompleted("t-1", "completed", USAGE));

  const result = await running;
  assert.equal(result.turnId, "t-1");
  assert.equal(result.outcome.kind, "completed");
  assert.equal(result.finalText, "It is an SDK.");
  assert.deepEqual(
    result.items.map((item) => item.itemId),
    ["a-1", "a-2"],
    "the turn's own items, in first-opened order",
  );
  assert.deepEqual(result.usage, USAGE);
  assert.equal(transport.writes.length, 1, "run sends nothing but the turn/start");
});

test("run forwards input parts verbatim", async () => {
  const { session, transport } = wired();
  const parts = [
    { text: "look at", type: "text" as const },
    { text: "@README.md", type: "text" as const },
  ];
  void session.run(parts).catch(() => undefined);
  await waitForWrites(transport, 1);
  assert.deepEqual(sentParams(transport, 0)["input"], parts);
});

test("finalText is the last completed agentMessage that is not commentary", async () => {
  const cases: Array<{ name: string; items: Item[]; expected: string | undefined }> = [
    {
      expected: "answer",
      items: [
        agentMessage("a-1", "t-1", { messagePhase: "finalAnswer", text: "answer" }),
        agentMessage("a-2", "t-1", { messagePhase: "commentary", text: "trailing note" }),
      ],
      name: "a later commentary item is skipped",
    },
    {
      expected: "second",
      items: [
        agentMessage("a-1", "t-1", { messagePhase: "finalAnswer", text: "first" }),
        agentMessage("a-2", "t-1", { text: "second" }),
      ],
      name: "the last of several answers wins",
    },
    {
      expected: "no phase",
      items: [agentMessage("a-1", "t-1", { text: "no phase" })],
      name: "an absent phase on a completed item reads as finalAnswer",
    },
    {
      expected: "newer phase",
      items: [agentMessage("a-1", "t-1", { messagePhase: "summary", text: "newer phase" })],
      name: "an unknown phase on a completed item reads as finalAnswer",
    },
    {
      expected: "kept",
      items: [
        agentMessage("a-1", "t-1", { text: "kept" }),
        agentMessage("a-2", "t-1", { status: "failed", text: "broken" }),
      ],
      name: "a failed item is not the final answer",
    },
    {
      expected: undefined,
      items: [agentMessage("a-1", "t-1", { messagePhase: "commentary", text: "only commentary" })],
      name: "no final answer",
    },
    {
      expected: undefined,
      items: [{ itemId: "r-1", kind: "reasoning", revision: 1, status: "completed", text: "thinking", turnId: "t-1" }],
      name: "other kinds never count",
    },
  ];
  for (const { name, items, expected } of cases) {
    const { session, transport } = wired();
    const running = session.run("go");
    await waitForWrites(transport, 1);
    ackStart(transport, 0, "t-1", "started");
    await settleMicrotasks();
    for (const item of items) session.apply(completed(item));
    session.apply(turnCompleted("t-1", "completed"));
    assert.equal((await running).finalText, expected, name);
  }
});

test("a failed turn resolves rather than rejects, with no usage when the terminal carries none", async () => {
  const { session, running } = await runTo("started");
  session.apply(turnCompleted("t-1", "failed"));
  const result = await running;
  assert.equal(result.outcome.kind, "completed");
  assert.equal(result.outcome.kind === "completed" ? result.outcome.params.terminal : undefined, "failed");
  assert.equal(result.usage, undefined);
  assert.equal(result.finalText, undefined);
});

test("an ephemeral host death resolves terminalUnknown with the items folded so far", async () => {
  const { session, transport } = wired("ephemeral");
  const running = session.run("go");
  await waitForWrites(transport, 1);
  ackStart(transport, 0, "t-1", "started");
  await settleMicrotasks();
  session.apply(completed(agentMessage("a-1", "t-1", { text: "partial" })));
  const crash: ExitClassification = { exitCode: 77, exitSignal: null, kind: "crash", stderrTail: [] };
  session.hostExited(crash);
  const result = await running;
  assert.equal(result.outcome.kind, "terminalUnknown");
  assert.deepEqual(
    result.items.map((item) => item.itemId),
    ["a-1"],
  );
  assert.equal(result.usage, undefined);
});

test("a refused submit rejects with its own error", async () => {
  const { session, transport } = wired();
  const running = session.run("go");
  await waitForWrites(transport, 1);
  answerError(transport, 0, {
    code: COMMAND_REJECTED_CODE,
    message: "busy",
    data: { kind: COMMAND_REJECTED_KIND, reason: "busy" },
  });
  await assert.rejects(running, MspError);
});

test("an already-aborted signal rejects with its reason and sends nothing", async () => {
  const { session, transport } = wired();
  const reason = new Error("stop before start");
  const running = session.run("go", { signal: AbortSignal.abort(reason) });
  const state = watch(running);
  await settleMicrotasks();
  assert.equal(transport.writes.length, 0);
  assert.equal(state.settled, true, "rejected without waiting on the wire");
  await assert.rejects(running, (error) => error === reason);
});

test("an abort while the turn runs cancels it, waits for the terminal, then rejects with the reason", async () => {
  const controller = new AbortController();
  const { session, transport, running } = await runTo("started", { signal: controller.signal });
  const state = watch(running);
  const reason = new Error("user gave up");
  controller.abort(reason);
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "turn/cancel");
  assert.equal(sentParams(transport, 1)["turnId"], "t-1");
  ack(transport, 1, { status: "accepted", turnId: "t-1" });
  await settleMicrotasks();
  assert.equal(state.settled, false, "run waits for the server's terminal");

  session.apply(turnCompleted("t-1", "cancelled"));
  await assert.rejects(running, (error) => error === reason);
  assert.equal(transport.writes.length, 2);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0, "the abort listener is removed");
});

test("an abort while the turn is queued unqueues it and sends no cancel", async () => {
  const controller = new AbortController();
  const { session, transport, running, commandId } = await runTo("queued", { signal: controller.signal });
  const state = watch(running);
  controller.abort();
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "turn/unqueue");
  assert.equal(sentParams(transport, 1)["turnId"], "t-1");
  ack(transport, 1, { status: "accepted", turnId: "t-1" });
  await settleMicrotasks();
  assert.equal(session.pending.has(commandId), false, "the accepted unqueue retired the queued entry");
  assert.equal(state.settled, false, "run waits for turn/unqueued");

  session.apply(turnUnqueued("t-1", commandId));
  await assert.rejects(running, (error) => (error as Error).name === "AbortError");
  assert.equal(transport.writes.length, 2, "no turn/cancel follows an accepted unqueue");
});

test("an unqueue that loses the launch race falls back to cancel", async () => {
  const controller = new AbortController();
  const { session, transport, running } = await runTo("queued", { signal: controller.signal });
  const reason = new Error("stop");
  controller.abort(reason);
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "turn/unqueue");
  answerError(transport, 1, {
    code: COMMAND_REJECTED_CODE,
    message: "turn already launched",
    data: { kind: COMMAND_REJECTED_KIND, reason: "run_active" },
  });
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "turn/cancel");
  assert.equal(sentParams(transport, 2)["turnId"], "t-1");
  ack(transport, 2, { status: "accepted", turnId: "t-1" });
  session.apply(turnStarted("t-1"));
  session.apply(turnCompleted("t-1", "cancelled"));
  await assert.rejects(running, (error) => error === reason);
});

test("an unqueue acked without acceptance falls back to cancel", async () => {
  // `status` is an open enum: any answer but `accepted` reclaimed nothing.
  const controller = new AbortController();
  const { session, transport, running, commandId } = await runTo("queued", { signal: controller.signal });
  controller.abort();
  await waitForWrites(transport, 2);
  ack(transport, 1, { status: "deferred", turnId: "t-1" });
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "turn/cancel");
  assert.equal(session.pending.has(commandId), true, "an unaccepted unqueue retires nothing");
  ack(transport, 2, { status: "accepted", turnId: "t-1" });
  session.apply(turnCompleted("t-1", "cancelled"));
  await assert.rejects(running);
});

// TEST-77912-10 (spec 207, ADR 77912 D1): an unqueue the session runtime did
// not take wrote nothing, so the abort sends it again after the connection's
// backoff instead of reading it as a lost launch race.

/** The connection's retry backoff never waits longer than this. */
const BACKOFF_CAP_MS = 2_000;

/** FR-77912-2's answer to a `turn/unqueue` the session runtime did not take in time. */
function untaken(transport: FakeDuplex, index: number): Record<string, unknown> {
  return {
    code: COMMAND_REJECTED_CODE,
    message: "turn/unqueue was not taken: the session runtime did not take the reclaim in time",
    data: {
      commandId: sentParams(transport, index)["commandId"],
      kind: COMMAND_REJECTED_KIND,
      reason: "runtime_busy",
      retryable: true,
    },
  };
}

test("an unqueue the runtime did not take goes out again, with no cap and no cancel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const { session, transport, running, commandId } = await runTo("queued", { signal: controller.signal });
  controller.abort();
  await waitForWrites(transport, 2);
  answerError(transport, 1, untaken(transport, 1));
  await settleMicrotasks();
  assert.equal(transport.writes.length, 2, "nothing goes out before the backoff");
  t.mock.timers.tick(BACKOFF_CAP_MS);
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "turn/unqueue", "the untaken unqueue goes out again");
  assert.equal(sentParams(transport, 2)["turnId"], "t-1");
  const firstCommandId = sentParams(transport, 1)["commandId"];
  assert.equal(sentParams(transport, 2)["commandId"], firstCommandId, "the resend keeps the first unqueue's commandId");

  answerError(transport, 2, untaken(transport, 2));
  await settleMicrotasks();
  assert.equal(transport.writes.length, 3, "nothing goes out before the second backoff");
  t.mock.timers.tick(BACKOFF_CAP_MS);
  await waitForWrites(transport, 4);
  assert.equal(sentFrame(transport, 3)["method"], "turn/unqueue", "a second busy answer is sent again too");
  assert.equal(sentParams(transport, 3)["commandId"], firstCommandId, "every resend keeps that commandId");
  ack(transport, 3, { status: "accepted", turnId: "t-1" });
  await settleMicrotasks();
  assert.equal(session.pending.has(commandId), false, "the accepted resend retired the queued entry");

  session.apply(turnUnqueued("t-1", commandId));
  await assert.rejects(running, (error) => (error as Error).name === "AbortError");
  assert.equal(transport.writes.length, 4, "no turn/cancel follows an accepted resend");
});

test("an untaken unqueue whose resend loses the launch race falls back to cancel", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const { session, transport, running } = await runTo("queued", { signal: controller.signal });
  const reason = new Error("stop");
  controller.abort(reason);
  await waitForWrites(transport, 2);
  answerError(transport, 1, untaken(transport, 1));
  await settleMicrotasks();
  assert.equal(transport.writes.length, 2, "nothing goes out before the backoff");
  t.mock.timers.tick(BACKOFF_CAP_MS);
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "turn/unqueue", "the untaken unqueue goes out again");
  assert.equal(
    sentParams(transport, 2)["commandId"],
    sentParams(transport, 1)["commandId"],
    "the resend keeps the first unqueue's commandId",
  );
  answerError(transport, 2, {
    code: COMMAND_REJECTED_CODE,
    message: "turn already launched",
    data: { kind: COMMAND_REJECTED_KIND, reason: "run_active" },
  });
  await waitForWrites(transport, 4);
  assert.equal(sentFrame(transport, 3)["method"], "turn/cancel");
  assert.equal(sentParams(transport, 3)["turnId"], "t-1");
  ack(transport, 3, { status: "accepted", turnId: "t-1" });
  session.apply(turnStarted("t-1"));
  session.apply(turnCompleted("t-1", "cancelled"));
  await assert.rejects(running, (error) => error === reason);
});

test("an untaken unqueue whose turn started meanwhile is cancelled at once, not sent again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const controller = new AbortController();
  const { session, transport, running } = await runTo("queued", { signal: controller.signal });
  controller.abort();
  await waitForWrites(transport, 2);
  session.apply(turnStarted("t-1"));
  answerError(transport, 1, untaken(transport, 1));
  // No timer tick: a turn that started needs no backoff before its cancel.
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "turn/cancel");
  ack(transport, 2, { status: "accepted", turnId: "t-1" });
  session.apply(turnCompleted("t-1", "cancelled"));
  await assert.rejects(running);
  assert.equal(transport.writes.length, 3);
});

test("a queued turn whose turn/started already folded is cancelled, not unqueued", async () => {
  const controller = new AbortController();
  const { session, transport, running } = await runTo("queued", { signal: controller.signal });
  session.apply(turnStarted("t-1"));
  controller.abort();
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "turn/cancel");
  ack(transport, 1, { status: "accepted", turnId: "t-1" });
  session.apply(turnCompleted("t-1", "cancelled"));
  await assert.rejects(running);
});

test("an abort during submission stops the turn once its ack names it", async () => {
  const controller = new AbortController();
  const { session, transport } = wired();
  const running = session.run("go", { signal: controller.signal });
  await waitForWrites(transport, 1);
  const reason = new Error("too slow");
  controller.abort(reason);
  await settleMicrotasks();
  assert.equal(transport.writes.length, 1, "nothing more is sent before the ack names the turn");

  ackStart(transport, 0, "t-1", "started");
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "turn/cancel");
  ack(transport, 1, { status: "accepted", turnId: "t-1" });
  session.apply(turnCompleted("t-1", "cancelled"));
  await assert.rejects(running, (error) => error === reason);
});

test("a refused cancel still waits for the turn's own terminal", async () => {
  const controller = new AbortController();
  const { session, transport, running } = await runTo("started", { signal: controller.signal });
  const state = watch(running);
  controller.abort();
  await waitForWrites(transport, 2);
  answerError(transport, 1, {
    code: COMMAND_REJECTED_CODE,
    message: "already finished",
    data: { kind: COMMAND_REJECTED_KIND, reason: "missing_run" },
  });
  await settleMicrotasks();
  assert.equal(state.settled, false);
  session.apply(turnCompleted("t-1", "completed"));
  await assert.rejects(running, (error) => (error as Error).name === "AbortError");
});

test("an abort after the turn ended changes nothing", async () => {
  const controller = new AbortController();
  const { session, transport, running } = await runTo("started", { signal: controller.signal });
  session.apply(turnCompleted("t-1", "completed"));
  assert.equal((await running).outcome.kind, "completed");
  assert.equal(getEventListeners(controller.signal, "abort").length, 0, "the abort listener is removed");
  controller.abort();
  await settleMicrotasks();
  assert.equal(transport.writes.length, 1, "no stop is sent");
});

test("an abort in the same tick as the terminal sends nothing", async () => {
  const controller = new AbortController();
  const { session, transport, running } = await runTo("started", { signal: controller.signal });
  session.apply(turnCompleted("t-1", "completed"));
  controller.abort();
  await settleMicrotasks();
  assert.equal(transport.writes.length, 1, "the terminal won: no stop is sent");
  assert.equal((await running).outcome.kind, "completed");
});

test("an abort during submission sends nothing when the terminal beat the ack", async () => {
  const controller = new AbortController();
  const { session, transport } = wired();
  const running = session.run("go", { signal: controller.signal });
  await waitForWrites(transport, 1);
  controller.abort();
  session.apply(turnStarted("t-1"));
  session.apply(turnCompleted("t-1", "completed"));
  ackStart(transport, 0, "t-1", "started");
  await settleMicrotasks();
  assert.equal(transport.writes.length, 1, "the turn had already ended: no stop is sent");
  assert.equal((await running).outcome.kind, "completed");
});

test("a durable host death rejects with the host-exit error", async () => {
  const { session, transport, running } = await runTo("started");
  const crash: ExitClassification = { exitCode: 77, exitSignal: null, kind: "crash", stderrTail: [] };
  session.hostExited(crash);
  await assert.rejects(running, MuseHostDiedError);
  assert.equal(transport.writes.length, 1);
});
