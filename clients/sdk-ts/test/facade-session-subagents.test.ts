/**
 * `session.events({ subagents: true })` also yields each sub-agent's
 * step-by-step events, in wire order with the parent's, tagged with the
 * sub-agent they belong to. The SDK follows the child sessions itself while
 * such a stream is open: `view/subscribe` when a `subagent` item carries a
 * running child session, `view/unsubscribe` when the item ends or no stream
 * needs it. Approvals stay on the parent.
 *
 * Causal, never time-based: every wait is a bounded microtask pump.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MuseClient, MuseHostDiedError, Session } from "../src/index.js";
import type { MuseClientOptions, SessionEvent } from "../src/index.js";
import { followedSubagentCount } from "../src/facade/session.js";
import {
  answer,
  answerError,
  FakeDuplex,
  frame,
  sentFrame,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
const PARENT = "s-parent";
const CHILD = "s-child";
const TAG = { itemId: "it-sub", subagentId: "sa-1", childSessionId: CHILD };
const SOURCE = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: "str-1", kind: "session" },
};

function view(sessionId: string, method: string, params: Record<string, unknown>): string {
  return frame({ jsonrpc: "2.0", method, params: { sessionId, sourceRange: SOURCE, ...params } });
}

/** The parent's `subagent` item at `revision`; `childSessionId` once the child's start is attested. */
function subagent(
  method: "item/started" | "item/updated" | "item/completed",
  revision: number,
  viewCursor: string,
  extra: Record<string, unknown> = {},
): string {
  return view(PARENT, method, {
    viewCursor,
    item: {
      itemId: TAG.itemId,
      kind: "subagent",
      turnId: "t-1",
      revision,
      status: method === "item/completed" ? "completed" : "inProgress",
      subagentId: TAG.subagentId,
      agentPath: "researcher",
      depth: 1,
      controlStatus: method === "item/completed" ? "closed" : "running",
      ...extra,
    },
  });
}

function message(sessionId: string, itemId: string, viewCursor: string): string {
  return view(sessionId, "item/started", {
    viewCursor,
    item: { itemId, kind: "agentMessage", revision: 1, sessionId, status: "inProgress", turnId: "t-1" },
  });
}

async function opened(onApproval?: () => void): Promise<{ client: MuseClient; session: Session; transport: FakeDuplex }> {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);
  const opening = client.startSession();
  await waitForWrites(transport, 1);
  answer(transport, 0, {
    commandId: (sentFrame(transport, 0)["params"] as Record<string, unknown>)["commandId"],
    session: { sessionId: PARENT, status: "idle" },
    viewCursor: "v:0",
  });
  const session = await opening;
  if (onApproval !== undefined) {
    session.onApproval(() => {
      onApproval();
      return { choiceId: "deny" };
    });
  }
  return { client, session, transport };
}

/** Every event `stream` has buffered, without waiting for more. */
async function buffered(stream: AsyncIterableIterator<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for (;;) {
    let next: IteratorResult<SessionEvent> | undefined;
    // A failure is read by the caller's own next(); this read only drains the buffer.
    void stream.next().then(
      (result) => (next = result),
      () => undefined,
    );
    await settleMicrotasks();
    // A read still pending here would take a later event; callers read once, at the end.
    if (next === undefined || next.done === true) return out;
    out.push(next.value);
  }
}

/** `[session the frame names, method, tag or undefined]` for each event. */
function shape(events: readonly SessionEvent[]): unknown[] {
  return events.map((event) => [
    (event.frame.params as { sessionId?: string }).sessionId,
    event.frame.method,
    event.subagent,
  ]);
}

function methods(transport: FakeDuplex): string[] {
  return transport.writes.map((line) => (JSON.parse(line) as { method?: string }).method ?? "reply");
}

test("without the opt-in, events() yields the parent's events only and follows nothing", async () => {
  const { session, transport } = await opened();
  const stream = session.events();
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }) + message(CHILD, "c-1", "c:1"));
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start"], "no view/subscribe");
  assert.deepEqual(shape(await buffered(stream)), [[PARENT, "item/started", undefined]]);
});

test("with subagents: true, a sub-agent's events stream in wire order with the parent's, tagged", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });

  transport.chunks.push(subagent("item/started", 1, "v:1", { controlStatus: "accepted" }));
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start"], "no child session yet: nothing to follow");

  transport.chunks.push(subagent("item/updated", 2, "v:2", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "view/subscribe");
  assert.deepEqual(sentFrame(transport, 1)["params"], { sessionId: CHILD });
  answer(transport, 1, { viewCursor: "c:0" });

  transport.chunks.push(message(CHILD, "c-1", "c:1") + message(PARENT, "p-2", "v:3") + message(CHILD, "c-2", "c:2"));
  await settleMicrotasks();
  // A later revision of the running item follows nothing twice.
  transport.chunks.push(subagent("item/updated", 3, "v:4", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe"]);

  const events = await buffered(stream);
  assert.deepEqual(shape(events), [
    [PARENT, "item/started", undefined],
    [PARENT, "item/updated", undefined],
    [CHILD, "item/started", TAG],
    [PARENT, "item/started", undefined],
    [CHILD, "item/started", TAG],
    [PARENT, "item/updated", undefined],
  ]);
  assert.equal(events[2]?.item?.itemId, "c-1", "a sub-agent event carries the sub-agent's item");
  assert.equal(session.fold.items.get("c-1"), undefined, "the parent's own state holds none of it");
});

test("two sub-agents are followed side by side, each tagged as its own; one ending stops only that one", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });
  const A = { itemId: "it-a", subagentId: "sa-a", childSessionId: "s-a" };
  const B = { itemId: "it-b", subagentId: "sa-b", childSessionId: "s-b" };
  transport.chunks.push(subagent("item/started", 1, "v:1", A) + subagent("item/started", 1, "v:2", B));
  await waitForWrites(transport, 3);
  assert.deepEqual([sentFrame(transport, 1)["params"], sentFrame(transport, 2)["params"]], [
    { sessionId: "s-a" },
    { sessionId: "s-b" },
  ]);
  answer(transport, 1, { viewCursor: "a:0" });
  answer(transport, 2, { viewCursor: "b:0" });
  transport.chunks.push(message("s-a", "a-1", "a:1") + message("s-b", "b-1", "b:1"));
  await settleMicrotasks();

  // A's turn ends with its item, so its follow finishes; B's turn runs on.
  transport.chunks.push(
    view("s-a", "turn/completed", { terminal: "completed", turnId: "t-1", viewCursor: "a:2" }) +
      subagent("item/completed", 2, "v:3", A),
  );
  await waitForWrites(transport, 4);
  assert.deepEqual(sentFrame(transport, 3)["params"], { sessionId: "s-a" });
  transport.chunks.push(message("s-b", "b-2", "b:2") + message("s-a", "a-late", "a:9"));
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe", "view/subscribe", "view/unsubscribe"]);
  const children = (shape(await buffered(stream)) as [string, string, unknown][]).filter(([sessionId]) => sessionId !== PARENT);
  assert.deepEqual(children, [
    ["s-a", "item/started", A],
    ["s-b", "item/started", B],
    ["s-a", "turn/completed", A],
    ["s-b", "item/started", B],
  ]);
});

test("a sub-agent already running when the stream opens is followed at once", async () => {
  const { session, transport } = await opened();
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start"]);

  const stream = session.events({ subagents: true });
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "view/subscribe");
  answer(transport, 1, { viewCursor: "c:5" });
  transport.chunks.push(message(CHILD, "c-6", "c:6"));
  await settleMicrotasks();
  assert.deepEqual(shape(await buffered(stream)), [[CHILD, "item/started", TAG]]);
});

test("the sub-agent's item ending unsubscribes, and its later events are not yielded", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:0" });

  transport.chunks.push(subagent("item/completed", 2, "v:2", { childSessionId: CHILD }));
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "view/unsubscribe");
  assert.deepEqual(sentFrame(transport, 2)["params"], { sessionId: CHILD });
  answer(transport, 2, {});
  transport.chunks.push(message(CHILD, "c-late", "c:9"));
  await settleMicrotasks();
  assert.deepEqual(shape(await buffered(stream)), [
    [PARENT, "item/started", undefined],
    [PARENT, "item/completed", undefined],
  ]);
});

test("a sub-agent's last steps that arrive after its item ended still stream, then the follow stops", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:0" });
  transport.chunks.push(view(CHILD, "turn/started", { commandId: "c-x", turnId: "t-1", viewCursor: "c:1" }));
  await settleMicrotasks();

  // Each session drains to the connection on its own, so the parent's item can
  // end before the child's final steps arrive.
  transport.chunks.push(subagent("item/completed", 2, "v:2", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe"], "the child's turn is still running");
  transport.chunks.push(
    message(CHILD, "c-last", "c:2") +
      view(CHILD, "turn/completed", { terminal: "completed", turnId: "t-1", viewCursor: "c:3" }),
  );
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "view/unsubscribe");
  transport.chunks.push(message(CHILD, "c-after", "c:4"));
  await settleMicrotasks();
  const children = (shape(await buffered(stream)) as [string, string, unknown][]).filter(([sessionId]) => sessionId === CHILD);
  assert.deepEqual(children, [
    [CHILD, "turn/started", TAG],
    [CHILD, "item/started", TAG],
    [CHILD, "turn/completed", TAG],
  ]);
});

test("a sub-agent followed mid-turn (its turn/started never seen) still streams its last steps", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:5" });
  // The child's turn started before the subscribe: only its later frames come.
  transport.chunks.push(message(CHILD, "c-mid", "c:6"));
  await settleMicrotasks();
  transport.chunks.push(subagent("item/completed", 2, "v:2", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe"], "the child's turn is still running");
  transport.chunks.push(
    message(CHILD, "c-last", "c:7") + view(CHILD, "turn/completed", { terminal: "completed", turnId: "t-1", viewCursor: "c:8" }),
  );
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "view/unsubscribe");
  const children = (shape(await buffered(stream)) as [string, string, unknown][]).filter(([sessionId]) => sessionId === CHILD);
  assert.deepEqual(children, [
    [CHILD, "item/started", TAG],
    [CHILD, "item/started", TAG],
    [CHILD, "turn/completed", TAG],
  ]);
  // Observability only: a stopped follow keeps nothing (its child fold) alive.
  assert.equal(session[followedSubagentCount](), 0);
});

test("a follow that joined mid-message (deltas only) still streams the message's end and its turn's", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:5" });
  // The message opened before the subscribe: its deltas carry no turnId.
  transport.chunks.push(view(CHILD, "item/delta", { viewCursor: "c:6", itemId: "c-msg", delta: "hel", field: "text" }));
  await settleMicrotasks();
  transport.chunks.push(subagent("item/completed", 2, "v:2", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe"], "the child is mid-message");
  transport.chunks.push(
    view(CHILD, "item/completed", {
      viewCursor: "c:7",
      item: { itemId: "c-msg", kind: "agentMessage", revision: 2, sessionId: CHILD, status: "completed", turnId: "t-1", text: "hello" },
    }) + view(CHILD, "turn/completed", { terminal: "completed", turnId: "t-1", viewCursor: "c:8" }),
  );
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "view/unsubscribe");
  const children = (shape(await buffered(stream)) as [string, string, unknown][]).filter(([sessionId]) => sessionId === CHILD);
  assert.deepEqual(children, [
    [CHILD, "item/delta", TAG],
    [CHILD, "item/completed", TAG],
    [CHILD, "turn/completed", TAG],
  ]);
});

test("closing the last stream while a follow is finishing unsubscribes at once", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:5" });
  transport.chunks.push(message(CHILD, "c-mid", "c:6") + subagent("item/completed", 2, "v:2", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe"], "finishing: the child's turn runs");
  await stream.return?.();
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "view/unsubscribe");
});

test("a sub-agent ending while the caller's resume of it is in flight does not unsubscribe", async () => {
  const { client, session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:0" });
  const resuming = client.resumeSession({ sessionId: CHILD });
  await waitForWrites(transport, 3);
  // The follow stops before the resume replies: the subscription is per
  // connection and session, so an unsubscribe now would starve the resume.
  transport.chunks.push(subagent("item/completed", 2, "v:2", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.equal(session[followedSubagentCount](), 0, "the follow stopped");
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe", "session/resume"], "no view/unsubscribe");
  answer(transport, 2, {
    commandId: (sentFrame(transport, 2)["params"] as Record<string, unknown>)["commandId"],
    session: { sessionId: CHILD, status: "running" },
    history: { mode: "none", items: null, snapshot: null, noneReason: "cursorSuffix" },
    pendingRequests: [],
    viewCursor: "c:0",
  });
  const own = await resuming;
  transport.chunks.push(message(CHILD, "c-1", "c:1"));
  await settleMicrotasks();
  assert.ok(own.fold.items.get("c-1") !== undefined, "the resumed session keeps folding");
  void stream;
});

test("a caller resuming a followed child still gets the frames sent before the resume reply", async () => {
  const { client, session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:0" });
  const resuming = client.resumeSession({ sessionId: CHILD });
  await waitForWrites(transport, 3);
  transport.chunks.push(
    message(CHILD, "c-early", "c:1") +
      frame({
        jsonrpc: "2.0",
        id: sentFrame(transport, 2)["id"],
        result: {
          commandId: (sentFrame(transport, 2)["params"] as Record<string, unknown>)["commandId"],
          session: { sessionId: CHILD, status: "running" },
          history: { mode: "none", items: null, snapshot: null, noneReason: "cursorSuffix" },
          pendingRequests: [],
          viewCursor: "c:1",
        },
      }),
  );
  const own = await resuming;
  assert.ok(own.fold.items.get("c-early") !== undefined, "the caller's fold holds the frame read with the reply");
  void stream;
});

test("the last opted-in stream closing unsubscribes; one still open keeps the sub-agent followed", async () => {
  const { session, transport } = await opened();
  const first = session.events({ subagents: true });
  const second = session.events({ subagents: true });
  const plain = session.events();
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:0" });

  await first.return?.();
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe"], "the other stream still needs it");
  transport.chunks.push(message(CHILD, "c-1", "c:1"));
  await settleMicrotasks();
  assert.deepEqual(shape(await buffered(second)).at(-1), [CHILD, "item/started", TAG]);

  await second.return?.();
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "view/unsubscribe");
  assert.deepEqual(shape(await buffered(plain)), [[PARENT, "item/started", undefined]], "the plain stream never saw the child");
  answer(transport, 2, {});

  // Reopening while the sub-agent still runs follows it again.
  const third = session.events({ subagents: true });
  await waitForWrites(transport, 4);
  assert.equal(sentFrame(transport, 3)["method"], "view/subscribe");
  answer(transport, 3, { viewCursor: "c:1" });
  transport.chunks.push(message(CHILD, "c-2", "c:2"));
  await settleMicrotasks();
  assert.deepEqual(shape(await buffered(third)), [[CHILD, "item/started", TAG]]);
});

test("a child gap fill that lands after the follow stopped is not yielded", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:0" });
  // A delivery gap on the child starts a fill: its view/page is in flight.
  transport.chunks.push(frame({ jsonrpc: "2.0", method: "view/gap", params: { after: "c:1", next: "c:3", sessionId: CHILD } }));
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "view/page");

  transport.chunks.push(subagent("item/completed", 2, "v:2", { childSessionId: CHILD }));
  await waitForWrites(transport, 4);
  assert.equal(sentFrame(transport, 3)["method"], "view/unsubscribe");
  // The page answers after the follow stopped: nothing of it reaches the stream.
  answer(transport, 2, {
    events: [{ method: "item/started", params: { sessionId: CHILD, sourceRange: SOURCE, viewCursor: "c:2", item: { itemId: "c-paged", kind: "agentMessage", revision: 1, sessionId: CHILD, status: "inProgress", turnId: "t-1" } } }],
    nextCursor: null,
  });
  await settleMicrotasks();
  const child = (shape(await buffered(stream)) as [string, string, unknown][]).filter(([sessionId]) => sessionId === CHILD);
  assert.deepEqual(child, [
    [CHILD, "view/gap", TAG],
  ]);
});

test("the unsubscribe is skipped while a session the caller opened routes the child", async () => {
  const { client, session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:0" });
  const resuming = client.resumeSession({ sessionId: CHILD });
  await waitForWrites(transport, 3);
  answer(transport, 2, {
    commandId: (sentFrame(transport, 2)["params"] as Record<string, unknown>)["commandId"],
    session: { sessionId: CHILD, status: "running" },
    history: { mode: "none", items: null, snapshot: null, noneReason: "cursorSuffix" },
    pendingRequests: [],
    viewCursor: "c:0",
  });
  const own = await resuming;

  transport.chunks.push(subagent("item/completed", 2, "v:2", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.equal(session[followedSubagentCount](), 0, "the follow stopped");
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe", "session/resume"], "no view/unsubscribe");
  transport.chunks.push(message(CHILD, "c-1", "c:1"));
  await settleMicrotasks();
  assert.ok(own.fold.items.get("c-1") !== undefined, "the caller's own session keeps folding");
  void stream;
});

test("a child the caller already resumed is followed on its subscription, not subscribed again", async () => {
  const { client, session, transport } = await opened();
  const resuming = client.resumeSession({ sessionId: CHILD });
  await waitForWrites(transport, 2);
  answer(transport, 1, {
    commandId: (sentFrame(transport, 1)["params"] as Record<string, unknown>)["commandId"],
    session: { sessionId: CHILD, status: "running" },
    history: { mode: "none", items: null, snapshot: null, noneReason: "cursorSuffix" },
    pendingRequests: [],
    viewCursor: "c:0",
  });
  const own = await resuming;
  const stream = session.events({ subagents: true });
  // A second subscribe would replace the connection's subscription with an
  // empty one at head: the child frames queued for the caller would be lost.
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start", "session/resume"], "no second view/subscribe");
  assert.equal(session[followedSubagentCount](), 1);
  transport.chunks.push(
    message(CHILD, "c-1", "c:1") + view(CHILD, "turn/completed", { terminal: "completed", turnId: "t-1", viewCursor: "c:2" }),
  );
  await settleMicrotasks();
  transport.chunks.push(subagent("item/completed", 2, "v:2", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.deepEqual(shape(await buffered(stream)), [
    [PARENT, "item/started", undefined],
    [CHILD, "item/started", TAG],
    [CHILD, "turn/completed", TAG],
    [PARENT, "item/completed", undefined],
  ]);
  assert.ok(own.fold.items.get("c-1") !== undefined, "the caller's session folds the same frame");
  assert.equal(session[followedSubagentCount](), 0, "the follow stopped");
  assert.deepEqual(methods(transport), ["session/start", "session/resume"], "no view/unsubscribe");
});

test("a refused caller resume of a followed child does not keep the follow's unsubscribe back", async () => {
  const { client, session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:0" });
  const resuming = client.resumeSession({ sessionId: CHILD });
  await waitForWrites(transport, 3);
  answerError(transport, 2, { code: -32020, message: "not running", data: { kind: "sessionNotFound" } });
  await resuming.catch(() => undefined);
  transport.chunks.push(subagent("item/completed", 2, "v:2", { childSessionId: CHILD }));
  await waitForWrites(transport, 4);
  assert.equal(sentFrame(transport, 3)["method"], "view/unsubscribe");
  void stream;
});

test("a stream closed while the subscribe is pending unsubscribes once the subscribe settles", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  await stream.return?.();
  await settleMicrotasks();
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe"], "nothing to unsubscribe yet");
  answer(transport, 1, { viewCursor: "c:0" });
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "view/unsubscribe");
});

/**
 * Set and Map elements iterated while `run` routes frames: the seam a scan of
 * every session would walk. Fold work that does not depend on how many
 * sub-agents are followed counts the same at every K.
 */
async function collectionVisits(run: () => Promise<void>): Promise<number> {
  let visits = 0;
  const patched: [object, PropertyKey, unknown][] = [];
  const count = (proto: object, key: PropertyKey): void => {
    const original = Reflect.get(proto, key) as (this: unknown, ...args: unknown[]) => unknown;
    patched.push([proto, key, original]);
    if (key === "forEach") {
      Reflect.set(proto, key, function (this: unknown, callback: (...args: unknown[]) => void, thisArg?: unknown) {
        return original.call(this, (...args: unknown[]) => {
          visits += 1;
          callback.apply(thisArg, args);
        });
      });
      return;
    }
    Reflect.set(proto, key, function* (this: unknown, ...args: unknown[]) {
      for (const element of original.apply(this, args) as Iterable<unknown>) {
        visits += 1;
        yield element;
      }
    });
  };
  for (const proto of [Set.prototype, Map.prototype]) {
    for (const key of [Symbol.iterator, "values", "keys", "entries", "forEach"]) count(proto, key);
  }
  try {
    await run();
  } finally {
    for (const [proto, key, original] of patched.reverse()) Reflect.set(proto, key, original);
  }
  return visits;
}

test("routing one sub-agent's frames costs the same however many sub-agents are followed", async () => {
  const FRAMES = 16;
  const routed = async (followed: number): Promise<number> => {
    const { session, transport } = await opened();
    const stream = session.events({ subagents: true });
    for (let index = 0; index < followed; index += 1) {
      transport.chunks.push(
        subagent("item/started", 1, `v:${index + 1}`, {
          itemId: `it-${index}`,
          subagentId: `sa-${index}`,
          childSessionId: `s-${index}`,
        }),
      );
    }
    await waitForWrites(transport, 1 + followed);
    for (let index = 0; index < followed; index += 1) answer(transport, 1 + index, { viewCursor: `c${index}:0` });
    await settleMicrotasks();
    assert.equal(session[followedSubagentCount](), followed);
    const visits = await collectionVisits(async () => {
      for (let index = 0; index < FRAMES; index += 1) transport.chunks.push(message("s-0", `m-${index}`, `c0:${index + 1}`));
      await settleMicrotasks();
    });
    assert.equal((await buffered(stream)).length, followed + FRAMES, "every frame reached the stream");
    return visits;
  };
  // A scan of every session would add FRAMES x (K - 1) visits at K = 8.
  assert.equal(await routed(8), await routed(1));
});

test("a sub-agent's approval is answered once, on the parent", async () => {
  let asked = 0;
  const { session, transport } = await opened(() => (asked += 1));
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:0" });

  // The host presents a child's approval on the parent, and re-issues it once
  // to a connection that subscribes to the child.
  const params = {
    approvalId: "a-1",
    availableChoices: [{ choiceId: "deny", decision: "denied", label: "Deny", scope: "once" }],
    currentRequirementId: { approvalId: "a-1", sourceIndex: 0 },
    itemId: "i-1",
    judgeEscalated: false,
    protectedWrite: false,
    rawArgs: "{}",
    sessionId: PARENT,
    sourceRange: SOURCE,
    subagentOrigin: { childRunId: "r-1", childSessionId: CHILD, subagentId: TAG.subagentId },
    subject: { kind: "shell", command: "ls" },
    taskId: "task-1",
    toolCallId: "call-1",
    toolName: "shell",
    turnId: "t-1",
    viewCursor: "v:2",
  };
  transport.chunks.push(
    frame({ jsonrpc: "2.0", method: "approval/requested", params }) +
      frame({ jsonrpc: "2.0", id: 70, method: "approval/request", params }),
  );
  await settleMicrotasks();
  // The copy the child subscription gets names the child: the follow's
  // internal session holds no handler and asks no one.
  const { subagentOrigin: _origin, ...onChild } = params;
  transport.chunks.push(
    frame({ jsonrpc: "2.0", method: "approval/requested", params: { ...onChild, sessionId: CHILD, viewCursor: "c:1" } }) +
      frame({ jsonrpc: "2.0", id: 71, method: "approval/request", params: { ...onChild, sessionId: CHILD, viewCursor: "c:1" } }),
  );
  await settleMicrotasks();
  assert.equal(asked, 1);
  const decides = transport.writes.filter((line) => line.includes('"approval/decide"'));
  assert.equal(decides.length, 1);
  assert.equal((JSON.parse(decides[0] as string) as { params: { sessionId: string } }).params.sessionId, PARENT);
  void stream;
});

test("a refused child subscribe leaves the parent's stream running", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answerError(transport, 1, { code: -32020, message: "not running", data: { kind: "sessionNotFound" } });
  await settleMicrotasks();
  transport.chunks.push(message(PARENT, "p-2", "v:2") + subagent("item/completed", 2, "v:3", { childSessionId: CHILD }));
  await settleMicrotasks();
  assert.deepEqual(shape(await buffered(stream)), [
    [PARENT, "item/started", undefined],
    [PARENT, "item/started", undefined],
    [PARENT, "item/completed", undefined],
  ]);
  assert.deepEqual(methods(transport), ["session/start", "view/subscribe"], "nothing to unsubscribe");
});

test("a host death while following ends the stream as events() does", async () => {
  const { session, transport } = await opened();
  const stream = session.events({ subagents: true });
  transport.chunks.push(subagent("item/started", 1, "v:1", { childSessionId: CHILD }));
  await waitForWrites(transport, 2);
  answer(transport, 1, { viewCursor: "c:0" });
  transport.chunks.push(message(CHILD, "c-1", "c:1"));
  await settleMicrotasks();
  transport.chunks.end();
  await settleMicrotasks();
  assert.deepEqual(shape(await buffered(stream)), [
    [PARENT, "item/started", undefined],
    [CHILD, "item/started", TAG],
  ]);
  let failure: unknown;
  stream.next().catch((error: unknown) => (failure = error));
  await settleMicrotasks();
  assert.ok(failure instanceof MuseHostDiedError, "a durable death rejects the stream");
  assert.equal(session[followedSubagentCount](), 0, "a death drops every follow");
});

test("a session no MuseClient opened refuses the sub-agent opt-in", () => {
  const session = new Session({ sessionId: PARENT, durability: { kind: "durable" } });
  assert.throws(
    () => session.events({ subagents: true }),
    (error: unknown) => error instanceof Error && error.constructor === Error && /MuseClient/.test(error.message),
  );
  session.events().return?.();
});
