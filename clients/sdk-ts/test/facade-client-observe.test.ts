/**
 * TEST-97338-1 (spec 14990 FR-97338-1): `MuseClient` lets a caller observe the
 * connection it owns — every notification (after an opened session applies
 * it, on arrival for one held while its session's open is in flight),
 * protocol errors, and the connection closing for any reason — and no
 * observer's failure ends the connection.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MuseClient, ProtocolError } from "../src/index.js";
import type { MuseClientOptions } from "../src/index.js";
import {
  answer,
  FakeDuplex,
  frame,
  sentFrame,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
// Failure-only cap for arms that wait on the transport.
const ARM_TIMEOUT = 20_000;

function wiredClient(): { client: MuseClient; connection: Connection; transport: FakeDuplex } {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  return { client: new MuseClient(connection, DURABLE), connection, transport };
}

function notification(method: string, params: Record<string, unknown>): string {
  return frame({ jsonrpc: "2.0", method, params });
}

const SOURCE = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: "str-1", kind: "session" },
};

/** A view frame for `s-1`, shaped as in `facade-client-open-chunk.test.ts`. */
function view(method: string, params: Record<string, unknown>): string {
  return notification(method, { sessionId: "s-1", sourceRange: SOURCE, ...params });
}

/** Whether `promise` has settled once the queue is drained; never a timer. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  return Promise.race([promise.then(() => true), settleMicrotasks().then(() => false)]);
}

/**
 * Record unhandled rejections across one macrotask turn: Node reports them
 * only after the microtask queue drains.
 */
async function unhandledRejectionsDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    await body();
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

test("onNotification: a notification naming no session reaches every listener", { timeout: ARM_TIMEOUT }, async () => {
  const { client, transport } = wiredClient();
  const first: string[] = [];
  const second: string[] = [];
  client.onNotification((n) => first.push(n.method));
  client.onNotification((n) => second.push(n.method));

  transport.chunks.push(notification("usage/changed", { usage: {} }));
  transport.chunks.push(notification("account/loginCompleted", { success: true }));
  await settleMicrotasks();

  assert.deepEqual(first, ["usage/changed", "account/loginCompleted"]);
  assert.deepEqual(second, ["usage/changed", "account/loginCompleted"]);
});

test(
  "onNotification: a session notification reaches the listener only after its session folded it",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const opening = client.startSession();
    await waitForWrites(transport, 1);
    answer(transport, 0, { session: { sessionId: "s-1", status: "idle" }, viewCursor: "c-0" });
    const session = await opening;

    const seen: Array<{ method: string; folded: boolean }> = [];
    client.onNotification((n) => {
      seen.push({ method: n.method, folded: session.fold.items.get("i-1") !== undefined });
    });

    transport.chunks.push(
      notification("item/started", {
        sessionId: "s-1",
        item: { itemId: "i-1", kind: "toolCall", revision: 1, status: "inProgress" },
        viewCursor: "c-1",
      }),
    );
    await settleMicrotasks();

    assert.deepEqual(seen, [{ method: "item/started", folded: true }]);
  },
);

test(
  "onNotification: a frame arriving while its session fills a gap reaches the listener before the buffered fold",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const opening = client.startSession();
    await waitForWrites(transport, 1);
    answer(transport, 0, { session: { sessionId: "s-1", status: "idle" }, viewCursor: "v:0" });
    const session = await opening;
    const seen: Array<{ method: string; folded: boolean }> = [];
    client.onNotification((n) => {
      seen.push({ method: n.method, folded: session.fold.items.get("i-1") !== undefined });
    });

    // The gap starts a `view/page` walk; leaving it unanswered keeps the fill open.
    transport.chunks.push(notification("view/gap", { after: "v:0", next: "v:5", sessionId: "s-1" }));
    await waitForWrites(transport, 2);
    assert.equal(sentFrame(transport, 1)["method"], "view/page");
    transport.chunks.push(
      notification("item/started", {
        sessionId: "s-1",
        item: { itemId: "i-1", kind: "toolCall", revision: 1, status: "inProgress" },
        viewCursor: "v:6",
      }),
    );
    await settleMicrotasks();

    assert.deepEqual(seen, [
      { method: "view/gap", folded: false },
      { method: "item/started", folded: false },
    ]);

    // Ending the view completes the fill: the buffered frame folds, and the
    // drain plays it to no listener a second time.
    answer(transport, 1, { events: [], nextCursor: null });
    await settleMicrotasks();
    assert.ok(session.fold.items.get("i-1") !== undefined, "the buffered frame folded when the fill completed");
    assert.equal(seen.length, 2);
  },
);

test("onNotification: the frame a listener receives is read-only, since the session may fold it later", () => {
  const { client } = wiredClient();
  client.onNotification((n) => {
    // @ts-expect-error -- the frame is shared with the session that folds it
    n.method = "changed";
  });
  client.onNotificationError((_, n) => {
    // @ts-expect-error -- the same frame, read-only here too
    n.method = "changed";
  });
});

test(
  "onNotification: a frame for a session this client never opens reaches the listener",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const heard: string[] = [];
    client.onNotification((n) => {
      if ((n.params as { sessionId?: unknown } | undefined)?.sessionId === "s-2") heard.push(n.method);
    });

    // One `s-2` frame while `s-1`'s open is in flight (held, then cleared), one after.
    const opening = client.startSession();
    await waitForWrites(transport, 1);
    transport.chunks.push(
      notification("turn/started", { commandId: "c-1", sessionId: "s-2", turnId: "t-1", viewCursor: "v:1" }),
    );
    await settleMicrotasks();
    answer(transport, 0, { session: { sessionId: "s-1", status: "idle" }, viewCursor: "c-0" });
    await opening;
    transport.chunks.push(
      notification("turn/started", { commandId: "c-2", sessionId: "s-2", turnId: "t-2", viewCursor: "v:2" }),
    );
    await settleMicrotasks();

    assert.deepEqual(heard, ["turn/started", "turn/started"]);
  },
);

test(
  "onNotification: a frame that arrives while its session's open is in flight reaches the listener once, in wire order, and is folded when the verb returns",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const heard: Array<{ method: string; opened: boolean }> = [];
    let opened = false;
    client.onNotification((n) => heard.push({ method: n.method, opened }));

    const pending = client.resumeSession({ sessionId: "s-1" }).then((session) => {
      opened = true;
      return session;
    });
    await waitForWrites(transport, 1);
    // The host flushes the replay before the result, all in one read; the
    // session-less frame between them pins wire order across the hold.
    transport.chunks.push(
      view("turn/started", { commandId: "c-1", turnId: "t-1", viewCursor: "v:1" }) +
        notification("usage/changed", { usage: {} }) +
        view("item/started", {
          viewCursor: "v:2",
          item: {
            itemId: "i-1",
            kind: "agentMessage",
            revision: 1,
            sessionId: "s-1",
            status: "inProgress",
            turnId: "t-1",
          },
        }) +
        frame({
          jsonrpc: "2.0",
          id: sentFrame(transport, 0)["id"],
          result: {
            session: { sessionId: "s-1", status: "idle" },
            history: { mode: "none", items: [] },
            pendingRequests: [],
            viewCursor: "v:2",
          },
        }),
    );
    const session = await pending;
    await settleMicrotasks();

    assert.deepEqual(heard, [
      { method: "turn/started", opened: false },
      { method: "usage/changed", opened: false },
      { method: "item/started", opened: false },
    ]);
    assert.ok(session.fold.items.get("i-1") !== undefined, "the held frame folded before resumeSession returned");
    assert.deepEqual(session.fold.turns().map((turn) => turn.turnId), ["t-1"]);
  },
);

test(
  "onNotification: a re-sent approval/request or userInput/request reaches its session, never the listener",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const opening = client.startSession();
    await waitForWrites(transport, 1);
    answer(transport, 0, { session: { sessionId: "s-1", status: "idle" }, viewCursor: "c-0" });
    const session = await opening;
    const approvals: string[] = [];
    session.onApproval(async (request) => {
      approvals.push(request.approvalId);
      return { choiceId: "deny" };
    });
    const heard: string[] = [];
    client.onNotification((n) => heard.push(n.method));

    transport.chunks.push(
      frame({
        jsonrpc: "2.0",
        id: 7,
        method: "approval/request",
        params: {
          approvalId: "a-1",
          availableChoices: [{ choiceId: "deny", decision: "denied", label: "Deny", scope: "once" }],
          currentRequirementId: { approvalId: "a-1", sourceIndex: 0 },
          itemId: "i-1",
          judgeEscalated: false,
          protectedWrite: false,
          rawArgs: "{}",
          sessionId: "s-1",
          sourceRange: SOURCE,
          subject: { kind: "shell", command: "ls" },
          taskId: "task-1",
          toolCallId: "call-1",
          toolName: "shell",
          turnId: "turn-1",
          viewCursor: "c-1",
        },
      }) +
        frame({
          jsonrpc: "2.0",
          id: 8,
          method: "userInput/request",
          params: {
            itemId: "i-2",
            questions: [],
            sessionId: "s-1",
            toolCallId: "call-2",
            toolName: "ask",
            turnId: "turn-1",
            userInputId: "input-1",
            viewCursor: "c-2",
          },
        }),
    );
    await settleMicrotasks();

    const receipts = transport.writes
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((sent) => sent["id"] === 7 || sent["id"] === 8);
    assert.deepEqual(receipts, [
      { jsonrpc: "2.0", id: 7, result: {} },
      { jsonrpc: "2.0", id: 8, result: {} },
    ]);
    assert.deepEqual(approvals, ["a-1"], "the approval reached the session's handler");
    assert.deepEqual(
      session.fold.pendingUserInputs().map((input) => input.userInputId),
      ["input-1"],
      "the question reached the session",
    );
    assert.deepEqual(heard, [], "server requests are not notifications");
  },
);

test("onNotification: an unsubscribed listener hears nothing more", { timeout: ARM_TIMEOUT }, async () => {
  const { client, transport } = wiredClient();
  const dropped: string[] = [];
  const kept: string[] = [];
  const unsubscribe = client.onNotification((n) => dropped.push(n.method));
  client.onNotification((n) => kept.push(n.method));

  transport.chunks.push(notification("usage/changed", { usage: {} }));
  await settleMicrotasks();
  unsubscribe();
  transport.chunks.push(notification("account/loginCompleted", { success: true }));
  await settleMicrotasks();

  assert.deepEqual(dropped, ["usage/changed"]);
  assert.deepEqual(kept, ["usage/changed", "account/loginCompleted"]);
});

test(
  "onNotification: one function added twice hears each frame twice, and one unsubscribe removes one subscription",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const heard: string[] = [];
    const listener = (n: { method: string }): void => {
      heard.push(n.method);
    };
    const unsubscribeFirst = client.onNotification(listener);
    client.onNotification(listener);

    transport.chunks.push(notification("usage/changed", { usage: {} }));
    await settleMicrotasks();
    unsubscribeFirst();
    transport.chunks.push(notification("account/loginCompleted", { success: true }));
    await settleMicrotasks();

    assert.deepEqual(heard, ["usage/changed", "usage/changed", "account/loginCompleted"]);
  },
);

test(
  "onNotification: a throwing listener goes to onNotificationError and neither starves other listeners nor closes the connection",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, connection, transport } = wiredClient();
    const failures: Array<{ error: unknown; method: string }> = [];
    const kept: string[] = [];
    const boom = new Error("listener bug");
    client.onNotificationError((error, n) => failures.push({ error, method: n.method }));
    client.onNotification(() => {
      throw boom;
    });
    client.onNotification((n) => kept.push(n.method));

    transport.chunks.push(notification("usage/changed", { usage: {} }));
    transport.chunks.push(notification("account/loginCompleted", { success: true }));
    await settleMicrotasks();

    assert.deepEqual(failures, [
      { error: boom, method: "usage/changed" },
      { error: boom, method: "account/loginCompleted" },
    ]);
    assert.deepEqual(kept, ["usage/changed", "account/loginCompleted"]);
    assert.equal(await settled(connection.closed), false, "a listener's throw must not close the connection");
  },
);

test(
  "onNotification: a throwing listener with no error observer, or a throwing observer, keeps the pump running",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const kept: string[] = [];
    client.onNotification(() => {
      throw new Error("listener bug");
    });
    client.onNotification((n) => kept.push(n.method));

    transport.chunks.push(notification("usage/changed", { usage: {} }));
    await settleMicrotasks();
    client.onNotificationError(() => {
      throw new Error("observer bug");
    });
    transport.chunks.push(notification("account/loginCompleted", { success: true }));
    await settleMicrotasks();

    assert.deepEqual(kept, ["usage/changed", "account/loginCompleted"]);
  },
);

test(
  "onNotification: an async listener's rejection goes to onNotificationError, never to the process",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const failures: Array<{ error: unknown; method: string }> = [];
    const boom = new Error("async listener bug");
    client.onNotificationError((error, n) => failures.push({ error, method: n.method }));
    client.onNotification(async () => {
      await Promise.resolve();
      throw boom;
    });

    const unhandled = await unhandledRejectionsDuring(async () => {
      transport.chunks.push(notification("usage/changed", { usage: {} }));
      await settleMicrotasks();
    });

    assert.deepEqual(unhandled, []);
    assert.deepEqual(failures, [{ error: boom, method: "usage/changed" }]);
  },
);

test(
  "onNotification: an async onNotificationError that rejects is swallowed, never left to the process",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    client.onNotificationError(async () => {
      throw new Error("async observer bug");
    });
    client.onNotification(() => {
      throw new Error("listener bug");
    });

    const unhandled = await unhandledRejectionsDuring(async () => {
      transport.chunks.push(notification("usage/changed", { usage: {} }));
      await settleMicrotasks();
    });

    assert.deepEqual(unhandled, []);
  },
);

test("onProtocolError: a frame the connection refuses reaches the handler", { timeout: ARM_TIMEOUT }, async () => {
  const { client, transport } = wiredClient();
  const errors: ProtocolError[] = [];
  client.onProtocolError((error) => errors.push(error));

  transport.chunks.push("not json\n");
  await settleMicrotasks();

  assert.equal(errors.length, 1);
  assert.ok(errors[0] instanceof ProtocolError);
  assert.equal(errors[0].line, "not json");
});

test(
  "onProtocolError: a handler that throws or rejects neither closes the connection nor reaches the process",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const calls: string[] = [];
    const heard: string[] = [];
    client.onNotification((n) => heard.push(n.method));

    const unhandled = await unhandledRejectionsDuring(async () => {
      client.onProtocolError(() => {
        calls.push("sync");
        throw new Error("handler bug");
      });
      client.onProtocolError(async () => {
        calls.push("async");
        throw new Error("async handler bug");
      });
      transport.chunks.push("not json\n");
      await settleMicrotasks();
    });
    transport.chunks.push(notification("usage/changed", { usage: {} }));
    await settleMicrotasks();

    assert.deepEqual(calls, ["sync", "async"]);
    assert.deepEqual(unhandled, []);
    assert.deepEqual(heard, ["usage/changed"], "the read loop is still running");
    assert.equal(await settled(client.closed), false, "a handler's failure must not close the connection");
  },
);

test(
  "onNotificationError: every handler hears each listener failure until its unsubscribe runs",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const first: string[] = [];
    const second: string[] = [];
    client.onNotificationError((_, n) => first.push(n.method));
    const unsubscribeSecond = client.onNotificationError((_, n) => second.push(n.method));
    client.onNotification(() => {
      throw new Error("listener bug");
    });

    transport.chunks.push(notification("usage/changed", { usage: {} }));
    await settleMicrotasks();
    unsubscribeSecond();
    transport.chunks.push(notification("account/loginCompleted", { success: true }));
    await settleMicrotasks();

    assert.deepEqual(first, ["usage/changed", "account/loginCompleted"]);
    assert.deepEqual(second, ["usage/changed"]);
  },
);

test(
  "onProtocolError: a client nobody observes leaves the connection's own handler in place",
  { timeout: ARM_TIMEOUT },
  async () => {
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const own: Array<string | undefined> = [];
    connection.onProtocolError((error) => own.push(error.line));
    new MuseClient(connection, DURABLE);

    transport.chunks.push("not json\n");
    await settleMicrotasks();

    assert.deepEqual(own, ["not json"]);
  },
);

test(
  "onProtocolError: every handler hears each refused frame until its unsubscribe runs",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    const first: Array<string | undefined> = [];
    const second: Array<string | undefined> = [];
    client.onProtocolError((error) => first.push(error.line));
    const unsubscribeSecond = client.onProtocolError((error) => second.push(error.line));

    transport.chunks.push("not json\n");
    await settleMicrotasks();
    unsubscribeSecond();
    transport.chunks.push("still not json\n");
    await settleMicrotasks();

    assert.deepEqual(first, ["not json", "still not json"]);
    assert.deepEqual(second, ["not json"]);
  },
);

test("closed stays pending while the connection is live, then settles on close()", { timeout: ARM_TIMEOUT }, async () => {
  const { client } = wiredClient();
  assert.equal(await settled(client.closed), false);
  await client.close();
  await client.closed;
});

test(
  "closed stays pending while the connection is live, then settles when the host hangs up",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { client, transport } = wiredClient();
    assert.equal(await settled(client.closed), false);
    transport.chunks.end();
    await client.closed;
  },
);
