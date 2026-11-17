/**
 * #97920: `session.reload()` catches a session the client already holds up
 * in place. It sends `session/resume` with the session's current cursor, and
 * the suffix the host streams back folds into the SAME `Session`, keeping its
 * fold, handlers and pending turns. A frame the replay repeats is dropped by
 * cursor equality.
 *
 * Causal, never time-based: every wait is a bounded microtask pump.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Connection,
  MuseCapabilityNotGrantedError,
  MuseClient,
  ProtocolError,
} from "../src/index.js";
import type { MuseClientOptions, PendingRetirement, Session } from "../src/index.js";
import { FakeDuplex, frame, sentFrame, sentParams, settleMicrotasks, waitForWrites } from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
const SESSION = "s-1";
const SOURCE = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: SESSION, kind: "session" },
};

function view(method: string, params: Record<string, unknown>): string {
  return frame({ jsonrpc: "2.0", method, params: { sessionId: SESSION, sourceRange: SOURCE, ...params } });
}

function itemStarted(itemId: string, viewCursor: string): string {
  return view("item/started", {
    viewCursor,
    item: { itemId, kind: "agentMessage", revision: 1, sessionId: SESSION, status: "inProgress", turnId: "t-1" },
  });
}

function delta(text: string, viewCursor: string): string {
  return view("item/delta", { viewCursor, itemId: "i-1", delta: text, field: "text" });
}

/** The reply to the outbound request at `index`, echoing its `commandId`. */
function reply(transport: FakeDuplex, index: number, result: Record<string, unknown>): string {
  const commandId = sentParams(transport, index)["commandId"];
  return frame({ jsonrpc: "2.0", id: sentFrame(transport, index)["id"], result: { ...result, commandId } });
}

function resumeResult(viewCursor: string): Record<string, unknown> {
  return {
    session: { sessionId: SESSION, status: "idle" },
    history: { mode: "none", items: null, snapshot: null, noneReason: "cursorSuffix" },
    pendingRequests: [],
    viewCursor,
  };
}

/** One element of a `view/page` result: an unframed `item/delta` notification. */
function pagedDelta(text: string, viewCursor: string): Record<string, unknown> {
  return { method: "item/delta", params: { sessionId: SESSION, viewCursor, itemId: "i-1", delta: text, field: "text" } };
}

function viewGap(after: string, next: string): string {
  return frame({ jsonrpc: "2.0", method: "view/gap", params: { after, next, sessionId: SESSION } });
}

/** Answer the outbound `view/page` at `index` with `events`, ending at `nextCursor`. */
function pageReply(transport: FakeDuplex, index: number, events: unknown[], nextCursor: string | null): string {
  assert.equal(sentFrame(transport, index)["method"], "view/page");
  return frame({ jsonrpc: "2.0", id: sentFrame(transport, index)["id"], result: { events, nextCursor } });
}

/** An approval pending on `t-1`, as `approval/requested` and its re-sent `approval/request` carry it. */
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
    sessionId: SESSION,
    sourceRange: SOURCE,
    subject: { kind: "shell", command: "ls" },
    taskId: "task-1",
    toolCallId: "call-1",
    toolName: "shell",
    turnId: "t-1",
    viewCursor,
  };
}

/** What `work` settled to within a bounded microtask pump: a hang fails the arm instead of wedging the file. */
async function settled(work: Promise<unknown>): Promise<{ resolved: unknown } | { rejected: unknown }> {
  const seen: { outcome?: { resolved: unknown } | { rejected: unknown } } = {};
  work.then(
    (value: unknown) => (seen.outcome = { resolved: value }),
    (error: unknown) => (seen.outcome = { rejected: error }),
  );
  await settleMicrotasks();
  if (seen.outcome === undefined) assert.fail("the promise is still pending");
  return seen.outcome;
}

/** A resumed session that has folded `i-1` at `v:1`. */
async function held(
  onApproval?: (approvalId: string) => void,
): Promise<{ client: MuseClient; session: Session; transport: FakeDuplex }> {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);
  const opening = client.resumeSession({
    sessionId: SESSION,
    ...(onApproval === undefined
      ? {}
      : {
          onApproval: (request) => {
            onApproval(request.approvalId);
            return { choiceId: "deny" };
          },
        }),
  });
  await waitForWrites(transport, 1);
  transport.chunks.push(itemStarted("i-1", "v:1") + reply(transport, 0, resumeResult("v:1")));
  return { client, session: await opening, transport };
}

test("reload() resumes from the session's cursor and folds the suffix into the same Session", async () => {
  const { session, transport } = await held();
  // The same Session's stream, opened before the reload, hears the suffix.
  const heard: string[] = [];
  const stream = session.events();
  const reading = (async () => {
    for await (const event of stream) heard.push(event.frame.method);
  })();

  const reloading = session.reload();
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "session/resume");
  const { commandId: _commandId, ...params } = sentParams(transport, 1);
  assert.deepEqual(params, { sessionId: SESSION, cursor: "v:1" }, "only the id and the fold's cursor");
  transport.chunks.push(itemStarted("i-2", "v:2") + reply(transport, 1, resumeResult("v:2")));
  const result = await reloading;

  assert.equal(result.viewCursor, "v:2", "reload resolves to the resume result");
  assert.ok(session.fold.items.get("i-1") !== undefined, "the fold keeps what it held");
  assert.ok(session.fold.items.get("i-2") !== undefined, "and folds the suffix");
  await stream.return?.(undefined);
  await reading;
  assert.deepEqual(heard, ["item/started"], "its existing events() stream hears the suffix");
});

test("a frame the replay repeats is dropped by cursor, so text is not doubled", async () => {
  const { session, transport } = await held();
  const reloading = session.reload();
  await waitForWrites(transport, 2);
  // A live frame lands, then the replay repeats it before the reply, and the
  // live stream repeats it once more after the reply (#32223's window).
  transport.chunks.push(delta("a", "v:2"));
  await settleMicrotasks();
  transport.chunks.push(delta("a", "v:2") + delta("b", "v:3") + reply(transport, 1, resumeResult("v:3")));
  await reloading;
  transport.chunks.push(delta("b", "v:3") + delta("c", "v:4"));
  await settleMicrotasks();
  assert.equal(session.fold.items.accumulated("i-1"), "abc");
});

test("a frame the replay repeats is not yielded twice by events()", async () => {
  const { session, transport } = await held();
  const heard: string[] = [];
  const stream = session.events();
  const reading = (async () => {
    for await (const event of stream) heard.push(event.outcome.fold.kind + "@" + String((event.frame as { params?: { viewCursor?: unknown } }).params?.viewCursor));
  })();
  const reloading = session.reload();
  await waitForWrites(transport, 2);
  transport.chunks.push(delta("a", "v:2"));
  await settleMicrotasks();
  transport.chunks.push(delta("a", "v:2") + reply(transport, 1, resumeResult("v:2")));
  await reloading;
  await settleMicrotasks();
  await stream.return?.(undefined);
  await reading;
  assert.equal(heard.filter((entry) => entry.endsWith("@v:2")).length, 1, `v:2 reaches the stream once: ${heard.join(", ")}`);
});

test("the idle session/closed after a reload folds, though it names the last replayed cursor", async () => {
  const { session, transport } = await held();
  const kinds: string[] = [];
  const stream = session.events();
  const reading = (async () => {
    for await (const event of stream) if (event.frame.method === "session/closed") kinds.push(event.outcome.fold.kind);
  })();
  const reloading = session.reload();
  await waitForWrites(transport, 2);
  transport.chunks.push(delta("a", "v:2") + reply(transport, 1, resumeResult("v:2")));
  await reloading;
  transport.chunks.push(view("session/closed", { reason: "idle", viewCursor: "v:2" }));
  await settleMicrotasks();
  await stream.return?.(undefined);
  await reading;
  assert.equal(kinds.length, 1, "the unload notice reaches the stream");
  assert.notEqual(kinds[0], "ignoredReplayDuplicate", "it is not dropped as a repeat");
});

test("a session/statusChanged after the reply does not end the replay record", async () => {
  const { session, transport } = await held();
  const reloading = session.reload();
  await waitForWrites(transport, 2);
  transport.chunks.push(delta("a", "v:2") + reply(transport, 1, resumeResult("v:2")));
  await reloading;
  // Its cursor is newer, but it is no resume cursor, so the live copy of v:2 is still a repeat.
  transport.chunks.push(view("session/statusChanged", { status: "idle", viewCursor: "v:20" }) + delta("a", "v:2"));
  await settleMicrotasks();
  assert.equal(session.fold.items.accumulated("i-1"), "a", "replayed text is not doubled");
});

test("reload() catches up a session the host unloaded while idle", async () => {
  const { session, transport } = await held();
  // The host unloads the idle session and names its final head.
  transport.chunks.push(view("session/closed", { reason: "idle", viewCursor: "v:5" }));
  await settleMicrotasks();

  const reloading = session.reload();
  await waitForWrites(transport, 2);
  assert.equal(sentParams(transport, 1)["cursor"], "v:5", "resumes from the head the unload named");
  transport.chunks.push(itemStarted("i-6", "v:6") + reply(transport, 1, resumeResult("v:6")));
  await reloading;
  assert.ok(session.fold.items.get("i-1") !== undefined);
  assert.ok(session.fold.items.get("i-6") !== undefined);
});

test("a re-sent server request does not move the cursor reload resumes from", async () => {
  const { session, transport } = await held();
  transport.chunks.push(itemStarted("i-2", "v:2"));
  // A question still open at resume is re-sent with the cursor that opened
  // it, older than what the session has folded.
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: 70,
      method: "userInput/request",
      params: {
        itemId: "i-1",
        questions: [],
        sessionId: SESSION,
        toolCallId: "call-1",
        toolName: "ask",
        turnId: "t-1",
        userInputId: "u-1",
        viewCursor: "v:1",
      },
    }),
  );
  // The re-send is receipted with `{}`.
  await waitForWrites(transport, 2);
  const reloading = session.reload();
  await waitForWrites(transport, 3);
  assert.equal(sentParams(transport, 2)["cursor"], "v:2");
  transport.chunks.push(reply(transport, 2, resumeResult("v:2")));
  await reloading;
});

test("pending turns survive a reload: a queued turn's reclaim still comes back from unqueue()", async () => {
  const { session, transport } = await held();
  const submitting = session.sendUserTurn({ composerInput: "draft", input: [{ type: "text", text: "q" }] });
  await waitForWrites(transport, 2);
  const queued = sentParams(transport, 1)["commandId"] as string;
  transport.chunks.push(
    reply(transport, 1, { disposition: "queued", startedNewTurn: true, status: "accepted", turnId: "t-2" }),
  );
  const turn = await submitting;

  const reloading = session.reload();
  await waitForWrites(transport, 3);
  transport.chunks.push(reply(transport, 2, resumeResult("v:1")));
  await reloading;
  assert.equal(session.pending.has(queued), true, "the queued submit is still pending");
  assert.equal(session.turn("t-2"), turn, "the same turn handle");

  const unqueuing = turn.unqueue();
  await waitForWrites(transport, 4);
  transport.chunks.push(
    view("turn/unqueued", { commandId: queued, turnId: "t-2", viewCursor: "v:2" }) +
      reply(transport, 3, { status: "accepted", turnId: "t-2" }),
  );
  const reclaimed: PendingRetirement<unknown> = {
    commandId: queued,
    input: "draft",
    kind: "reclaimed",
    restoreToComposer: true,
  };
  assert.deepEqual((await unqueuing).retirement, reclaimed);
  assert.equal((await turn.completed).kind, "unqueued");
});

test("a reload reply without `session` rejects with a ProtocolError", async () => {
  const { session, transport } = await held();
  const reloading = session.reload();
  await waitForWrites(transport, 2);
  transport.chunks.push(reply(transport, 1, { viewCursor: "v:1", pendingRequests: [] }));
  await assert.rejects(reloading, ProtocolError);
  // The refusal refuses only that reload (Constitution XIII): the session folds and reloads again.
  transport.chunks.push(itemStarted("i-2", "v:2"));
  await settleMicrotasks();
  assert.ok(session.fold.items.get("i-2") !== undefined, "a later frame still folds");
  void session.reload().catch(() => undefined);
  await waitForWrites(transport, 3);
  assert.equal(sentParams(transport, 2)["cursor"], "v:2", "a later reload resumes from the new cursor");
});

test("a resumeSession reply without `session` rejects with a ProtocolError, not a TypeError", async () => {
  const fresh = new FakeDuplex();
  const client = new MuseClient(new Connection(fresh), DURABLE);
  const resuming = client.resumeSession({ sessionId: "s-2" });
  await waitForWrites(fresh, 1);
  fresh.chunks.push(reply(fresh, 0, { viewCursor: "v:1", pendingRequests: [] }));
  await assert.rejects(resuming, ProtocolError);
});

test("reload() refuses before anything is sent when the session has folded no cursor", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);
  const opening = client.resumeSession({ sessionId: SESSION });
  await waitForWrites(transport, 1);
  // A reply with no view cursor and no frame since: nothing to resume from.
  const { viewCursor: _viewCursor, ...noCursor } = resumeResult("v:0");
  transport.chunks.push(reply(transport, 0, noCursor));
  const session = await opening;
  const outcome = await settled(session.reload());
  assert.ok("rejected" in outcome && outcome.rejected instanceof Error);
  assert.match(String(outcome.rejected), /no view cursor/);
  assert.equal(transport.writes.length, 1, "a resume without a cursor would not catch the fold up");
  // Once a view frame folds, the same session reloads from it.
  transport.chunks.push(itemStarted("i-2", "v:2"));
  await settleMicrotasks();
  assert.ok(session.fold.items.get("i-2") !== undefined, "a later frame still folds");
  void session.reload().catch(() => undefined);
  await waitForWrites(transport, 2);
  assert.equal(sentParams(transport, 1)["cursor"], "v:2");
});

test("session/statusChanged does not move the cursor reload resumes from", async () => {
  const { session, transport } = await held();
  // Its cursor is not a resume cursor (tdd SS4.6.10), and the fold ignores the frame.
  transport.chunks.push(view("session/statusChanged", { status: "idle", viewCursor: "v:20" }));
  await settleMicrotasks();
  void session.reload().catch(() => undefined);
  await waitForWrites(transport, 2);
  assert.equal(sentParams(transport, 1)["cursor"], "v:1", "resumes after the last folded view event");
});

test("a reply that serves history instead of the suffix resolves, but the fold is not caught up", async () => {
  // The contract: the fold is caught up only when the reply says
  // `noneReason: "cursorSuffix"`; otherwise the caller resumes it again with resumeSession.
  const { session, transport } = await held();
  const reloading = session.reload();
  await waitForWrites(transport, 2);
  transport.chunks.push(
    reply(transport, 1, {
      ...resumeResult("v:9"),
      history: {
        mode: "snapshot",
        items: null,
        snapshot: {
          items: [{ itemId: "i-9", kind: "agentMessage", revision: 1, sessionId: SESSION, status: "completed", turnId: "t-1" }],
          viewCursor: "v:9",
        },
      },
    }),
  );
  const result = await reloading;
  assert.equal(result.history.mode, "snapshot");
  assert.equal(result.history.noneReason, undefined, "not a cursor suffix");
  assert.equal(session.fold.items.get("i-9"), undefined, "reload folds no served history");
  assert.deepEqual([...session.fold.items.list()].map((item) => item.itemId), ["i-1"]);
  // What streams after the snapshot folds over a gap, so a later reload refuses before sending.
  transport.chunks.push(itemStarted("i-10", "v:10"));
  await settleMicrotasks();
  assert.ok(session.fold.items.get("i-10") !== undefined, "frames after the gap still fold");
  const again = await settled(session.reload());
  assert.ok("rejected" in again && again.rejected instanceof Error);
  assert.match(String(again.rejected), /resumeSession/);
  assert.equal(transport.writes.length, 2, "the second reload writes nothing");
  // The refusal refuses only reload (Constitution XIII): other verbs still reach the wire.
  void session.rename("n").catch(() => undefined);
  await waitForWrites(transport, 3);
  assert.equal(sentFrame(transport, 2)["method"], "session/rename");
});

test("a reload during a gap fill folds each frame once (replay held with the live tail)", async () => {
  const { session, transport } = await held();
  transport.chunks.push(viewGap("v:1", "v:3"));
  await waitForWrites(transport, 2); // the fill's view/page
  transport.chunks.push(delta("a", "v:3") + delta("b", "v:4")); // held for the fill
  await settleMicrotasks();

  const reloading = session.reload();
  await waitForWrites(transport, 3);
  assert.equal(sentParams(transport, 2)["cursor"], "v:1");
  transport.chunks.push(delta("h", "v:2") + delta("a", "v:3") + delta("b", "v:4") + reply(transport, 2, resumeResult("v:4")));
  await settleMicrotasks();
  transport.chunks.push(pageReply(transport, 1, [pagedDelta("h", "v:2"), pagedDelta("a", "v:3")], "v:3"));
  await reloading;
  await settleMicrotasks();
  assert.equal(session.fold.items.accumulated("i-1"), "hab");
});

test("a reload whose replay lands after the gap fill finished folds each frame once", async () => {
  const { session, transport } = await held();
  transport.chunks.push(viewGap("v:1", "v:3"));
  await waitForWrites(transport, 2);
  transport.chunks.push(delta("a", "v:3") + delta("b", "v:4"));
  await settleMicrotasks();

  const reloading = session.reload();
  await waitForWrites(transport, 3);
  transport.chunks.push(pageReply(transport, 1, [pagedDelta("h", "v:2"), pagedDelta("a", "v:3")], "v:3"));
  await settleMicrotasks();
  assert.equal(session.fold.items.accumulated("i-1"), "hab", "the fill spliced the hole and the live tail");
  transport.chunks.push(delta("h", "v:2") + delta("a", "v:3") + delta("b", "v:4") + reply(transport, 2, resumeResult("v:4")));
  await reloading;
  transport.chunks.push(delta("c", "v:5"));
  await settleMicrotasks();
  assert.equal(session.fold.items.accumulated("i-1"), "habc");
});

test("concurrent reload() calls share one resume", async () => {
  const { session, transport } = await held();
  const first = session.reload();
  const second = session.reload();
  assert.equal(second, first);
  await waitForWrites(transport, 2);
  transport.chunks.push(reply(transport, 1, resumeResult("v:1")));
  await first;
  await settleMicrotasks();
  assert.equal(transport.writes.length, 2, "one session/resume");
});

test("a host death during reload rejects it", async () => {
  const { session, transport } = await held();
  const reloading = session.reload();
  await waitForWrites(transport, 2);
  transport.chunks.end();
  const outcome = await settled(reloading);
  assert.ok("rejected" in outcome);
});

test("an approval the reload replays and the host re-sends reaches onApproval once", async () => {
  const seen: string[] = [];
  const { session, transport } = await held((approvalId) => seen.push(approvalId));
  const reloading = session.reload();
  await waitForWrites(transport, 2);
  transport.chunks.push(
    view("approval/requested", approval("v:2")) +
      reply(transport, 1, resumeResult("v:2")) +
      frame({ jsonrpc: "2.0", id: 71, method: "approval/request", params: approval("v:2") }),
  );
  await reloading;
  await settleMicrotasks();
  assert.deepEqual(seen, ["a-1"]);
  const decides = transport.writes.filter((line) => line.includes('"approval/decide"'));
  assert.equal(decides.length, 1, "one decision");
});

test("with no handshake on record, reload() refuses config naming servers; one naming none reaches the wire", async () => {
  const { session, transport } = await held();
  const servers = { mcpServers: { docs: { transport: "stdio" as const, command: "docs-mcp" } } };
  const outcome = await settled(session.reload({ config: servers }));
  assert.ok("rejected" in outcome && outcome.rejected instanceof MuseCapabilityNotGrantedError);
  assert.equal(transport.writes.length, 1, "the refused reload sent nothing");

  const reloading = session.reload({ config: { mcpServers: {} } });
  await waitForWrites(transport, 2);
  assert.deepEqual(sentParams(transport, 1)["config"], { mcpServers: {} });
  transport.chunks.push(reply(transport, 1, resumeResult("v:1")));
  await reloading;
});

test("a reload with config while another is in flight is refused, never silently dropped", async () => {
  const { session, transport } = await held();
  const first = session.reload();
  const outcome = await settled(session.reload({ config: { mcpServers: {} } }));
  assert.ok("rejected" in outcome);
  assert.match(String(outcome.rejected), /already in flight/);
  await waitForWrites(transport, 2);
  transport.chunks.push(reply(transport, 1, resumeResult("v:1")));
  await first;
  await settleMicrotasks();
  assert.equal(transport.writes.length, 2, "one session/resume");
});
