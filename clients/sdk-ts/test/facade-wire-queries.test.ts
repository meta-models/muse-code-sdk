import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MuseClient, Session } from "../src/index.js";
import type { MuseClientOptions } from "../src/index.js";
import { FakeDuplex, frame, waitForWrites } from "./helpers/fake-duplex.js";

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
    await pending;
  }
});

test("pauseWorkflow/resumeWorkflow/requestRecap/submitFeedback/openSideChat send their wire methods", async () => {
  const cases: Array<[string, (s: Session) => Promise<unknown>, Record<string, unknown>]> = [
    ["workflow/pause", (s) => s.pauseWorkflow("run-1"), { commandId: "c", status: "accepted" }],
    ["workflow/resume", (s) => s.resumeWorkflow("run-1"), { commandId: "c", status: "accepted", turnId: "t-9" }],
    ["recap/request", (s) => s.requestRecap(), { commandId: "c", status: "accepted" }],
    ["feedback/submit", (s) => s.submitFeedback({ classification: "bug", note: "n", withFiles: false }), { bundlePath: "/b", outcome: "recorded", sessionRecordAttached: false, sessionRecordTruncated: false }],
    ["session/sideChat", (s) => s.openSideChat(), { session: { sessionId: "side-1", status: "idle" }, history: { mode: "none", items: [] }, pendingRequests: [], viewCursor: "v" }],
  ];
  for (const [method, call, result] of cases) {
    const { session, transport } = wiredSession();
    const pending = call(session);
    await waitForWrites(transport, 1);
    const sent = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
    const echoed = { ...result, commandId: (sent["params"] as Record<string, unknown>)["commandId"] };
    transport.chunks.push(frame({ jsonrpc: "2.0", id: sent["id"], result: echoed }));
    assert.equal(sent["method"], method);
    assert.equal((sent["params"] as Record<string, unknown>)["sessionId"], "s-1");
    await pending;
  }
});

test("fold-only Session refuses wire queries without a connection", async () => {
  const session = new Session({ sessionId: "s-1", durability: { kind: "durable" } });
  await assert.rejects(session.listTasks(), /needs a connection/);
});

test("MuseClient.listSessions sends session/list with text filter", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);
  const pending = client.listSessions({ filter: { text: { allOf: ["check"], fields: ["title"] } } });
  const sent = await exchange(transport, { sessions: [], nextCursor: null });
  assert.equal(sent["method"], "session/list");
  assert.deepEqual(((sent["params"] as Record<string, unknown>)["filter"] as Record<string, unknown>)["text"], { allOf: ["check"], fields: ["title"] });
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
