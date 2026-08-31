/**
 * TEST-010 `command_id_retry_and_value_identical_ack` plus the transport-
 * less FR-012/014/015 connection contract (spec 14990 slice 2, T024).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Connection,
  MspError,
  ProtocolError,
} from "../src/index.js";
import type { DuplexTransport } from "../src/index.js";

class AsyncChunks implements AsyncIterable<string> {
  readonly #chunks: string[] = [];
  readonly #waiters: Array<(value: IteratorResult<string>) => void> = [];
  #ended = false;

  push(chunk: string): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#chunks.push(chunk);
    else waiter({ done: false, value: chunk });
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        const chunk = this.#chunks.shift();
        if (chunk !== undefined) return { done: false, value: chunk };
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<string>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class FakeDuplex implements DuplexTransport {
  readonly chunks = new AsyncChunks();
  readonly writes: string[] = [];
  readonly incoming = this.chunks;

  async write(chunk: string): Promise<void> {
    this.writes.push(chunk);
  }

  async close(): Promise<void> {
    this.chunks.end();
  }
}

function frame(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

async function waitForWrites(transport: FakeDuplex, count: number): Promise<void> {
  for (let turn = 0; turn < 100 && transport.writes.length < count; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(transport.writes.length, count, `expected ${count} write(s)`);
}

test("requests are newline-framed, awaited, and correlated by typed id", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const first = connection.request("first/method", { n: 1 });
  const second = connection.request("second/method", { n: 2 });
  await waitForWrites(transport, 2);

  const sent = transport.writes.map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(transport.writes.every((line) => line.endsWith("\n") && !line.endsWith("\r\n")));
  assert.notEqual(sent[0]?.["id"], sent[1]?.["id"], "in-flight request ids are unique");

  // Responses may arrive in either order, split across arbitrary chunks;
  // a preceding CR is tolerated on input (SS1.1).
  transport.chunks.push('{"jsonrpc":"2.0","id":2,"result":{"value":"two"}}\r');
  transport.chunks.push('\n{"jsonrpc":"2.0","id":1,"result":{"value":"one"}}\n');
  assert.deepEqual(await second, { value: "two" });
  assert.deepEqual(await first, { value: "one" });
  await connection.close();
});

test("typed errors expose data.kind and preserve the payload verbatim (INV-012)", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const pending = connection.request("session/userShell", {});
  await waitForWrites(transport, 1);
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32010,
        message: "wording is not an API",
        data: { kind: "capabilityRequired", capability: "userShell", retryable: false },
      },
    }),
  );
  let observed: unknown;
  try {
    await pending;
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof MspError);
  assert.equal(observed.code, -32010);
  assert.equal(observed.kind, "capabilityRequired");
  assert.equal(observed.retryable, false);
  assert.deepEqual(observed.data, {
    kind: "capabilityRequired",
    capability: "userShell",
    retryable: false,
  });
  await connection.close();
});

test("server requests use their own id space and notifications reach their handler", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const notifications: string[] = [];
  connection.onNotification((notification) => notifications.push(notification.method));
  connection.onServerRequest(async (request) => ({ echoed: request.method }));
  transport.chunks.push(
    frame({ jsonrpc: "2.0", id: 41, method: "approval/request", params: { approvalId: "a" } }) +
      frame({ jsonrpc: "2.0", method: "item/delta", params: { delta: "x" }, emittedAtMs: 1 }),
  );
  await waitForWrites(transport, 1);
  assert.deepEqual(JSON.parse(transport.writes[0] as string), {
    jsonrpc: "2.0",
    id: 41,
    result: { echoed: "approval/request" },
  });
  assert.deepEqual(notifications, ["item/delta"]);
  await connection.close();
});

test("TEST-010: nothing-admitted retry reuses commandId and replay ack must be value-identical", async () => {
  const transport = new FakeDuplex();
  let minted = 0;
  const connection = new Connection(transport, {
    mintCommandId: () => `018f6a1e-9b3c-7c21-a54a-${String(++minted).padStart(12, "0")}`,
  });
  const params = { sessionId: "s-1", input: [{ type: "text", text: "hello" }] };
  const command = connection.command("turn/start", params, {
    maxAttempts: 2,
    retryDelay: async () => {},
  });
  await waitForWrites(transport, 1);
  const first = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: first["id"],
      error: { code: -32031, message: "full", data: { kind: "backpressured", capacity: 4 } },
    }),
  );
  await waitForWrites(transport, 2);
  const retry = JSON.parse(transport.writes[1] as string) as Record<string, unknown>;
  const firstParams = first["params"] as Record<string, unknown>;
  const retryParams = retry["params"] as Record<string, unknown>;
  assert.equal(retryParams["commandId"], firstParams["commandId"], "one logical command, one id");
  const ack = {
    commandId: retryParams["commandId"],
    status: "accepted",
    turnId: retryParams["commandId"],
  };
  transport.chunks.push(frame({ jsonrpc: "2.0", id: retry["id"], result: ack }));
  assert.deepEqual(await command, ack);

  // An explicit reconnect-style replay uses the same id and must receive a
  // recursively value-identical ack (member order is irrelevant).
  const replay = connection.command("turn/start", params, {
    commandId: String(retryParams["commandId"]),
    maxAttempts: 1,
  });
  await waitForWrites(transport, 3);
  const replayFrame = JSON.parse(transport.writes[2] as string) as Record<string, unknown>;
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: replayFrame["id"],
      result: { turnId: ack.turnId, status: ack.status, commandId: ack.commandId },
    }),
  );
  assert.deepEqual(await replay, ack);

  const badReplay = connection.command("turn/start", params, {
    commandId: String(retryParams["commandId"]),
    maxAttempts: 1,
  });
  await waitForWrites(transport, 4);
  const badFrame = JSON.parse(transport.writes[3] as string) as Record<string, unknown>;
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: badFrame["id"],
      result: { commandId: ack.commandId, status: "accepted", turnId: "different" },
    }),
  );
  let mismatch: unknown;
  try {
    await badReplay;
  } catch (error) {
    mismatch = error;
  }
  assert.ok(mismatch instanceof ProtocolError);
  assert.ok(mismatch.message.includes("value-identical"));
  await connection.close();
});

test("TEST-018: a session/start result may omit the redundant commandId echo", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const pending = connection.command(
    "session/start",
    { workspaceRoot: "/workspace" },
    { commandId: "018f6a1e-9b3c-7c21-a54a-000000000099" },
  );
  await waitForWrites(transport, 1);
  const sent = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: sent["id"],
      result: { session: { sessionId: "s-1" }, viewCursor: "v:s-1:1" },
    }),
  );
  assert.deepEqual(await pending, {
    session: { sessionId: "s-1" },
    viewCursor: "v:s-1:1",
  });
  await connection.close();
});

test("TEST-018: a session/resume result may omit the redundant commandId echo", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const pending = connection.command(
    "session/resume",
    { sessionId: "s-1" },
    { commandId: "018f6a1e-9b3c-7c21-a54a-00000000009a" },
  );
  await waitForWrites(transport, 1);
  const sent = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: sent["id"],
      result: { session: { sessionId: "s-1" }, viewCursor: "v:s-1:5" },
    }),
  );
  assert.deepEqual(await pending, {
    session: { sessionId: "s-1" },
    viewCursor: "v:s-1:5",
  });
  await connection.close();
});

test("TEST-018: a result that does carry commandId must still echo it exactly", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const pending = connection.command(
    "session/start",
    { workspaceRoot: "/workspace" },
    { commandId: "018f6a1e-9b3c-7c21-a54a-000000000099", maxAttempts: 1 },
  );
  await waitForWrites(transport, 1);
  const sent = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: sent["id"],
      result: { commandId: "different", session: { sessionId: "s-1" } },
    }),
  );
  await assert.rejects(pending, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.match(error.message, /did not echo/);
    return true;
  });
  await connection.close();
});

test("TEST-010: a contradictory command error is terminal, not retryable", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport, {
    mintCommandId: () => "018f6a1e-9b3c-7c21-a54a-000000000099",
  });
  const command = connection.command("turn/start", { sessionId: "s-1" }, {
    maxAttempts: 2,
    retryDelay: async () => assert.fail("contradictory errors must not retry"),
  });
  await waitForWrites(transport, 1);
  const request = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: request["id"],
      error: {
        code: -32030,
        message: "durable rejection",
        data: { kind: "overloaded", reason: "command_id_conflict" },
      },
    }),
  );
  await assert.rejects(command, (error: unknown) => {
    assert.ok(error instanceof MspError);
    assert.equal(error.code, -32030);
    return true;
  });
  assert.equal(transport.writes.length, 1);
  await connection.close();
});

test("a malformed or oversized inbound line is reported and later frames still work (FM-007)", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport, { frameLimitBytes: 128 });
  const errors: ProtocolError[] = [];
  connection.onProtocolError((error) => errors.push(error));
  transport.chunks.push("not json\n");
  transport.chunks.push(`${"x".repeat(129)}\n`);
  const request = connection.request("still/works");
  await waitForWrites(transport, 1);
  transport.chunks.push(frame({ jsonrpc: "2.0", id: 1, result: {} }));
  assert.deepEqual(await request, {});
  assert.equal(errors.length, 2);
  assert.ok(errors[0]?.line === "not json", "the offending line is preserved as evidence");
  await connection.close();
});

test("a duplicate injected request id is rejected while the first is in flight", { timeout: 10_000 }, async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport, { mintRequestId: () => 1 });
  const first = connection.request("first/method");
  await waitForWrites(transport, 1);
  await assert.rejects(connection.request("second/method"), /already in flight/);
  transport.chunks.push(frame({ jsonrpc: "2.0", id: 1, result: {} }));
  assert.deepEqual(await first, {});
  await connection.close();
});

test("a non-integer injected request id is rejected before any write", { timeout: 10_000 }, async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport, { mintRequestId: () => 1.5 });
  await assert.rejects(connection.request("bad/id"), /string or integer/);
  assert.equal(transport.writes.length, 0, "the malformed frame never reaches the wire");
  await connection.close();
});

test("flush rethrows a transport write failure instead of swallowing it", async () => {
  class OnceFailingDuplex extends FakeDuplex {
    #failed = false;
    override async write(chunk: string): Promise<void> {
      if (!this.#failed) {
        this.#failed = true;
        throw new Error("synthetic write failure");
      }
      await super.write(chunk);
    }
  }
  const transport = new OnceFailingDuplex();
  const connection = new Connection(transport);
  connection.notify("doomed/notification");
  await assert.rejects(connection.flush(), /synthetic write failure/);
});
