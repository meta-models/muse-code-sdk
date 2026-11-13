import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MuseClient, MuseSessionDiscardedError, Session } from "../src/index.js";
import type { ExitClassification, MuseClientOptions } from "../src/index.js";
import { FakeDuplex, frame, settleMicrotasks, waitForWrites } from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };

async function exchange(
  transport: FakeDuplex,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await waitForWrites(transport, 1);
  const sent = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
  transport.chunks.push(frame({ jsonrpc: "2.0", id: sent["id"], result }));
  return sent;
}

function wiredSession(): { session: Session; transport: FakeDuplex } {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const session = new Session({
    sessionId: "s-1",
    durability: { kind: "durable" },
    connection,
  });
  return { session, transport };
}

test("listTasks sends task/list for this session and returns rows", async () => {
  const { session, transport } = wiredSession();
  const pending = session.listTasks();
  const sent = await exchange(transport, { tasks: [{ taskId: "t-1", kind: "tool", status: "inProgress" }] });
  assert.equal(sent["method"], "task/list");
  assert.equal((sent["params"] as Record<string, unknown>)["sessionId"], "s-1");
  assert.equal("commandId" in (sent["params"] as Record<string, unknown>), false, "a read-only list mints no commandId");
  assert.deepEqual((await pending).tasks[0]?.taskId, "t-1");
});

test("listSkills and listHooks send skill/list and hook/list", async () => {
  for (const [call, method] of [
    [(s: Session) => s.listSkills(), "skill/list"],
    [(s: Session) => s.listHooks(), "hook/list"],
  ] as const) {
    const { session, transport } = wiredSession();
    const pending = call(session);
    const sent = await exchange(transport, method === "skill/list" ? { skills: [] } : { hooks: [] });
    assert.equal(sent["method"], method);
    const sentParams = sent["params"] as Record<string, unknown>;
    assert.deepEqual(sentParams, { sessionId: "s-1" }, `${method} sends only this session's id: a read-only list mints no commandId`);
    await pending;
  }
});

test("pauseWorkflow/resumeWorkflow/requestRecap/submitFeedback/openSideChat send full params and resolve acks", async () => {
  const cases: Array<{
    method: string;
    call: (s: Session) => Promise<unknown>;
    params: Record<string, unknown>;
    result: Record<string, unknown>;
    ackField: string;
    ackValue: unknown;
    /** Rides `command()` and so mints a `commandId`; `feedback/submit` defines none, so it rides `request()`. */
    mints: boolean;
  }> = [
    {
      method: "workflow/pause",
      call: (s) => s.pauseWorkflow("run-1"),
      params: { sessionId: "s-1", workflowRunId: "run-1" },
      result: { commandId: "c", status: "accepted" },
      ackField: "status",
      ackValue: "accepted",
      mints: true,
    },
    {
      method: "workflow/resume",
      call: (s) => s.resumeWorkflow("run-1"),
      params: { sessionId: "s-1", workflowRunId: "run-1" },
      result: { commandId: "c", status: "accepted", turnId: "t-9" },
      ackField: "turnId",
      ackValue: "t-9",
      mints: true,
    },
    {
      method: "recap/request",
      call: (s) => s.requestRecap(),
      params: { sessionId: "s-1" },
      result: { commandId: "c", status: "accepted" },
      ackField: "status",
      ackValue: "accepted",
      mints: true,
    },
    {
      method: "feedback/submit",
      call: (s) => s.submitFeedback({ classification: "bug", note: "n", withFiles: false }),
      params: { classification: "bug", note: "n", withFiles: false, sessionId: "s-1" },
      result: { bundlePath: "/b", outcome: "recorded", sessionRecordAttached: false, sessionRecordTruncated: false },
      ackField: "bundlePath",
      ackValue: "/b",
      mints: false,
    },
    {
      method: "session/sideChat",
      call: (s) => s.openSideChat(),
      params: { sessionId: "s-1" },
      result: { session: { sessionId: "side-1", status: "idle" }, history: { mode: "none", items: [] }, pendingRequests: [], viewCursor: "v" },
      ackField: "viewCursor",
      ackValue: "v",
      mints: true,
    },
  ];
  for (const { method, call, params, result, ackField, ackValue, mints } of cases) {
    const { session, transport } = wiredSession();
    const pending = call(session);
    await waitForWrites(transport, 1);
    const sent = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
    assert.equal(sent["method"], method);
    const sentParams = { ...(sent["params"] as Record<string, unknown>) };
    const echoed: Record<string, unknown> = { ...result };
    if (mints) {
      const commandId = sentParams["commandId"];
      assert.equal(typeof commandId === "string" && commandId.length > 0, true, `${method} mints a non-empty commandId`);
      delete sentParams["commandId"];
      echoed["commandId"] = commandId;
    } else {
      assert.equal("commandId" in sentParams, false, `${method} mints no commandId: its wire params define none`);
    }
    assert.deepEqual(sentParams, params, `${method} sends the full params`);
    transport.chunks.push(frame({ jsonrpc: "2.0", id: sent["id"], result: echoed }));
    const ack = (await pending) as Record<string, unknown>;
    assert.deepEqual(ack[ackField], ackValue, `${method} resolves its ack`);
  }
});

test("fold-only Session refuses wire queries without a connection, and its fold still applies", async () => {
  const session = new Session({ sessionId: "s-1", durability: { kind: "durable" } });
  await assert.rejects(session.listTasks(), /needs a connection/);

  // The refusal refuses only the send: local folding stays usable.
  session.apply({
    method: "item/completed",
    params: {
      sessionId: "s-1",
      turnId: "turn-1",
      item: { itemId: "m-1", kind: "agentMessage", revision: 1, status: "completed", text: "kept" },
    },
  } as never);
  assert.equal(session.fold.items.list().length, 1);
});

test("a discarded session refuses wire verbs before sending anything", async () => {
  const transport = new FakeDuplex();
  const crash: ExitClassification = {
    exitCode: 77,
    exitSignal: null,
    kind: "crash",
    stderrTail: ["thread 'main' panicked"],
  };
  const session = new Session({
    sessionId: "s-9",
    durability: { kind: "ephemeral" },
    connection: new Connection(transport),
  });
  assert.equal(session.hostExited(crash).kind, "discharged");

  const listing = session.listTasks();
  const pausing = session.pauseWorkflow("run-1");
  await settleMicrotasks();
  assert.equal(transport.writes.length, 0);
  await assert.rejects(listing, MuseSessionDiscardedError);
  await assert.rejects(pausing, MuseSessionDiscardedError);
});

test("MuseClient.listSessions forwards every option and resolves the result", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);
  const options: Parameters<MuseClient["listSessions"]>[0] = {
    cursor: "cur-1",
    filter: { text: { allOf: ["check"], fields: ["title"] } },
    limit: 5,
    updatedAfter: "2026-01-01T00:00:00Z",
    workspaceRoot: "/repo",
  };
  const pending = client.listSessions(options);
  const sent = await exchange(transport, { sessions: [], nextCursor: null });
  assert.equal(sent["method"], "session/list");
  const sentParams = sent["params"] as Record<string, unknown>;
  assert.equal("commandId" in sentParams, false, "a read-only list mints no commandId");
  assert.deepEqual(sentParams, options);
  assert.deepEqual(await pending, { sessions: [], nextCursor: null });
});

test("fold surfaces agentMessage messagePhase verbatim (commentary before tool call)", () => {
  const session = new Session({ sessionId: "s-1", durability: { kind: "durable" } });
  const item = (itemId: string, kind: string, extra: Record<string, unknown> = {}) => ({
    sessionId: "s-1",
    turnId: "turn-1",
    item: { itemId, kind, revision: 1, status: "completed", ...extra },
  });
  session.apply({ method: "item/completed", params: item("m-1", "agentMessage", { messagePhase: "commentary", text: "working" }) } as never);
  session.apply({ method: "item/completed", params: item("tc-1", "toolCall") } as never);
  session.apply({ method: "item/completed", params: item("m-2", "agentMessage", { messagePhase: "finalAnswer", text: "done" }) } as never);
  const items = session.fold.items.list();
  const commentary = items.find((i) => i.itemId === "m-1");
  assert.equal((commentary as unknown as Record<string, unknown>)["messagePhase"], "commentary");
});
