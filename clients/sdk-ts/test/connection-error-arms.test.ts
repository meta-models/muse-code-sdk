/**
 * TEST-015 `connection_error_arm_coverage` + TEST-016
 * `default_command_id_mint_is_uuidv7` (spec 14990 slice 2a, T025/T026;
 * the PR #15620 review round).
 *
 * Every fail-closed error arm of `Connection` is reached by a violating
 * frame (FR-012/014/015, FM-007/009, INV-012/013). The FakeDuplex harness
 * mirrors connection.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MspError, ProtocolError } from "../src/index.js";
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

/** A transport whose writes always fail, like a child dead mid-approval (FM-009). */
class BrokenWriteDuplex implements DuplexTransport {
  readonly chunks = new AsyncChunks();
  readonly incoming = this.chunks;

  async write(): Promise<void> {
    throw new Error("EPIPE: broken pipe");
  }

  async close(): Promise<void> {
    this.chunks.end();
  }
}

function frame(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

async function waitForWrites(transport: FakeDuplex, count: number): Promise<void> {
  for (let turn = 0; turn < 100 && transport.writes.length < count; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(transport.writes.length, count, `expected ${count} write(s)`);
}

/** Observe a promise's settlement within bounded macrotask turns — never hang the suite. */
async function settlement(
  promise: Promise<unknown>,
  turns = 50,
): Promise<{ state: "pending" | "resolved" | "rejected"; value: unknown }> {
  let state: "pending" | "resolved" | "rejected" = "pending";
  let value: unknown;
  void promise.then(
    (resolved) => {
      state = "resolved";
      value = resolved;
    },
    (rejected) => {
      state = "rejected";
      value = rejected;
    },
  );
  for (let turn = 0; turn < turns && state === "pending"; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return { state, value };
}

async function pumpMacrotasks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

test("TEST-015: line-shape violations each surface a protocol error and never tear the connection down", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const errors: ProtocolError[] = [];
  connection.onProtocolError((error) => errors.push(error));

  transport.chunks.push("not json\n"); // non-JSON line
  transport.chunks.push("[1,2]\n"); // JSON, not an object
  transport.chunks.push('{"jsonrpc":"1.0","id":1,"result":{}}\n'); // wrong jsonrpc
  transport.chunks.push('{"jsonrpc":"2.0","result":{}}\n'); // response with no usable id
  transport.chunks.push('{"jsonrpc":"2.0","id":99,"result":{}}\n'); // unknown request id
  transport.chunks.push('{"jsonrpc":"2.0","id":"s-1","method":"m"}\n'); // string server-request id
  transport.chunks.push('{"jsonrpc":"2.0","id":0,"method":"m"}\n'); // non-positive server-request id

  const alive = connection.request("still/works");
  await waitForWrites(transport, 1);
  transport.chunks.push(frame({ jsonrpc: "2.0", id: 1, result: { ok: true } }));
  assert.deepEqual(await alive, { ok: true }, "one bad frame never tears the transport down (FM-007)");

  const messages = errors.map((error) => error.message);
  assert.ok(messages.some((m) => m.includes("not valid JSON")), "non-JSON line arm");
  assert.equal(
    messages.filter((m) => m.includes("not a JSON-RPC 2.0 object")).length,
    2,
    "array and wrong-jsonrpc arms",
  );
  assert.ok(messages.some((m) => m.includes("no usable id")), "no-usable-id arm");
  assert.ok(messages.some((m) => m.includes("unknown request id 99")), "unknown-id arm");
  assert.equal(
    messages.filter((m) => m.includes("server request id must be a positive integer")).length,
    2,
    "string and non-positive server-request-id arms",
  );
  await connection.close();
});

test("TEST-015: a matched malformed response rejects the caller, never hangs it (FR-014)", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const errors: ProtocolError[] = [];
  connection.onProtocolError((error) => errors.push(error));

  // Arm 1: result AND error both set.
  const both = connection.request("malformed/both");
  await waitForWrites(transport, 1);
  transport.chunks.push(
    frame({
      jsonrpc: "2.0",
      id: 1,
      result: {},
      error: { code: -32603, message: "x", data: { kind: "internal" } },
    }),
  );
  const bothOutcome = await settlement(both);
  assert.equal(bothOutcome.state, "rejected", "the matched caller must settle, not hang (INV-006)");
  assert.ok(bothOutcome.value instanceof ProtocolError);
  assert.ok(bothOutcome.value.message.includes("exactly one of result or error"));

  // Arm 2: NEITHER result nor error.
  const neither = connection.request("malformed/neither");
  await waitForWrites(transport, 2);
  transport.chunks.push(frame({ jsonrpc: "2.0", id: 2 }));
  const neitherOutcome = await settlement(neither);
  assert.equal(neitherOutcome.state, "rejected", "the neither-member caller must settle too");
  assert.ok(neitherOutcome.value instanceof ProtocolError);

  // The violation is still reported as a protocol error alongside the reject.
  assert.ok(errors.some((error) => error.message.includes("exactly one of result or error")));

  // The connection stays alive after both violations.
  const alive = connection.request("still/works");
  await waitForWrites(transport, 3);
  transport.chunks.push(frame({ jsonrpc: "2.0", id: 3, result: {} }));
  assert.deepEqual(await alive, {});
  await connection.close();
});

test("TEST-015: malformed matched-response payloads reject with the sibling arms' errors", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);

  const nonObject = connection.request("bad/result");
  await waitForWrites(transport, 1);
  transport.chunks.push(frame({ jsonrpc: "2.0", id: 1, result: 5 }));
  await assert.rejects(nonObject, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.ok(error.message.includes("result must be an object"));
    return true;
  });

  const badError = connection.request("bad/error");
  await waitForWrites(transport, 2);
  transport.chunks.push(frame({ jsonrpc: "2.0", id: 2, error: { code: "nope" } }));
  await assert.rejects(badError, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.ok(error.message.includes("invalid error object"));
    return true;
  });

  const noKind = connection.request("bad/kind");
  await waitForWrites(transport, 3);
  transport.chunks.push(frame({ jsonrpc: "2.0", id: 3, error: { code: -1, message: "m" } }));
  await assert.rejects(noKind, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.ok(error.message.includes("no data.kind"));
    return true;
  });
  await connection.close();
});

test("TEST-015: request-after-close, commandId reuse, and a non-echoing ack all fail closed", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport, {
    mintCommandId: () => "018f6a1e-9b3c-7c21-a54a-000000000001",
  });

  // A non-echoing ack rejects (FR-016).
  const command = connection.command("turn/start", { n: 1 }, { maxAttempts: 1 });
  await waitForWrites(transport, 1);
  const sent = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
  transport.chunks.push(frame({ jsonrpc: "2.0", id: sent["id"], result: { commandId: "different" } }));
  await assert.rejects(command, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.ok(error.message.includes("did not echo"));
    return true;
  });

  // Reusing a commandId with a different payload rejects (INV-013).
  await assert.rejects(
    connection.command("turn/start", { n: 2 }, { commandId: "018f6a1e-9b3c-7c21-a54a-000000000001", maxAttempts: 1 }),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.ok(error.message.includes("reused with a different payload"));
      return true;
    },
  );

  // Requests after close reject immediately.
  await connection.close();
  await assert.rejects(connection.request("late/call"), (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.ok(error.message.includes("connection is closed"));
    return true;
  });
});

test("TEST-015: the -32601 no-handler and -32603 handler-failure replies are written (FR-015)", async () => {
  const noHandler = new FakeDuplex();
  const bare = new Connection(noHandler);
  noHandler.chunks.push(frame({ jsonrpc: "2.0", id: 7, method: "approval/request" }));
  await waitForWrites(noHandler, 1);
  const reply = JSON.parse(noHandler.writes[0] as string) as Record<string, unknown>;
  const replyError = reply["error"] as Record<string, unknown>;
  assert.equal(reply["id"], 7);
  assert.equal(replyError["code"], -32601);
  assert.equal((replyError["data"] as Record<string, unknown>)["kind"], "methodNotFound");
  await bare.close();

  const throwing = new FakeDuplex();
  const handled = new Connection(throwing);
  handled.onServerRequest(async () => {
    throw new Error("boom");
  });
  throwing.chunks.push(frame({ jsonrpc: "2.0", id: 8, method: "approval/request" }));
  await waitForWrites(throwing, 1);
  const failure = JSON.parse(throwing.writes[0] as string) as Record<string, unknown>;
  const failureError = failure["error"] as Record<string, unknown>;
  assert.equal(failure["id"], 8);
  assert.equal(failureError["code"], -32603);
  assert.equal(failureError["message"], "boom");
  assert.equal((failureError["data"] as Record<string, unknown>)["kind"], "internal");
  await handled.close();
});

test("TEST-015: EOF mid-frame surfaces the dangling buffer and settles closed", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const errors: ProtocolError[] = [];
  connection.onProtocolError((error) => errors.push(error));
  const pending = connection.request("never/answered");
  await waitForWrites(transport, 1);
  transport.chunks.push('{"jsonrpc":"2.0","id":1,"resu'); // no newline, then EOF
  transport.chunks.end();
  await connection.closed;
  assert.ok(errors.some((error) => error.message.includes("ended without a newline")));
  // Bounded like the FM-009 test below: an unbounded `assert.rejects` here
  // would wedge the whole suite (not go RED) under a mutation that settles
  // `closed` without rejecting pending requests (PR #15632 review round).
  const eofOutcome = await settlement(pending, 100);
  assert.equal(eofOutcome.state, "rejected", "EOF rejects the dangling request");
  assert.ok(eofOutcome.value instanceof ProtocolError);
  assert.match(eofOutcome.value.message, /EOF/);
});

test("TEST-015: the oversized drop/resume path drops exactly one frame and keeps the evidence byte-bounded (FM-007)", async () => {
  const transport = new FakeDuplex();
  const limit = 128;
  const connection = new Connection(transport, { frameLimitBytes: limit });
  const errors: ProtocolError[] = [];
  connection.onProtocolError((error) => errors.push(error));

  const pending = connection.request("survives/oversize");
  await waitForWrites(transport, 1);

  // Mid-buffer overflow: a multibyte >limit chunk with NO newline (60 x '€' = 180 bytes).
  transport.chunks.push("€".repeat(60));
  await pumpMacrotasks(2);
  assert.equal(errors.length, 1, "the mid-buffer overflow arm fired");
  assert.ok(errors[0]?.message.includes(`exceeds ${limit} bytes`));
  assert.ok(
    utf8Bytes(errors[0]?.line ?? "") <= limit,
    `mid-buffer evidence is byte-bounded (got ${utf8Bytes(errors[0]?.line ?? "")} bytes)`,
  );

  // The tail newline ends the dropped frame; the very next frame must parse (drop-flag cleanup).
  transport.chunks.push("tail-of-oversized-frame\n");
  transport.chunks.push(frame({ jsonrpc: "2.0", id: 1, result: { revived: true } }));
  assert.deepEqual(await pending, { revived: true }, "the frame after the drop parses cleanly");
  assert.equal(errors.length, 1, "the dropped tail itself raises no second error");

  // Complete oversized line arriving whole (with its newline) in one chunk.
  transport.chunks.push(`${"€".repeat(60)}\n`);
  await pumpMacrotasks(2);
  assert.equal(errors.length, 2, "the complete-oversized-line arm fired");
  assert.ok(
    utf8Bytes(errors[1]?.line ?? "") <= limit,
    `complete-line evidence is byte-bounded (got ${utf8Bytes(errors[1]?.line ?? "")} bytes)`,
  );
  await connection.close();
});

test("TEST-015: a failed reply write finishes the connection and never escapes as an unhandled rejection (FM-009)", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const transport = new BrokenWriteDuplex();
    const connection = new Connection(transport);
    connection.onServerRequest(async () => ({ approved: true }));
    transport.chunks.push(frame({ jsonrpc: "2.0", id: 41, method: "approval/request" }));
    const closed = await settlement(connection.closed, 100);
    assert.equal(closed.state, "resolved", "the write failure finishes the connection");
    await pumpMacrotasks(20);
    assert.deepEqual(rejections, [], "no unhandled rejection escapes the reply write (FM-009)");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

/** Writes fail ONLY for server-response frames: the client's own outbound
 * requests still succeed, so a request can be in flight when the reply write
 * dies (the fifth-guard case from the PR #15632 review round). */
class ResponseWriteBrokenDuplex implements DuplexTransport {
  readonly chunks = new AsyncChunks();
  readonly writes: string[] = [];
  readonly incoming = this.chunks;

  async write(chunk: string): Promise<void> {
    const parsed = JSON.parse(chunk) as Record<string, unknown>;
    if ("result" in parsed || "error" in parsed) throw new Error("EPIPE: broken pipe");
    this.writes.push(chunk);
  }

  async close(): Promise<void> {
    this.chunks.end();
  }
}

test("TEST-015: a reply write failing with a request in flight settles closed and rejects the pending request (FM-009)", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const transport = new ResponseWriteBrokenDuplex();
    const connection = new Connection(transport);
    connection.onServerRequest(async () => ({ approved: true }));

    // The outbound request write succeeds; only the reply write below dies.
    // Capture the bounded settlement NOW: the caller owns its promise, so a
    // handler must exist before the reply-write failure rejects it — and the
    // bound means a future change that settles `closed` without rejecting
    // pending requests goes RED here instead of hanging the suite (FM-009).
    const pending = connection.request("client/inflight");
    const pendingOutcome = settlement(pending, 100);
    await pumpMacrotasks(2);
    assert.equal(transport.writes.length, 1, "the client request reached the transport");

    transport.chunks.push(frame({ jsonrpc: "2.0", id: 41, method: "approval/request" }));
    const closed = await settlement(connection.closed, 100);
    assert.equal(closed.state, "resolved", "the reply write failure finishes the connection");
    const outcome = await pendingOutcome;
    assert.equal(outcome.state, "rejected", "the pending request rejects when the reply write dies");
    assert.ok(outcome.value instanceof Error);
    assert.match(outcome.value.message, /EPIPE/);
    await pumpMacrotasks(20);
    assert.deepEqual(rejections, [], "no unhandled rejection escapes the reply-write failure (FM-009)");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("TEST-016: the default commandId mint produces distinct RFC-9562 UUIDv7 ids (INV-013)", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport); // no mintCommandId injected
  const v7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const first = connection.command("turn/start", { n: 1 }, { maxAttempts: 1 });
  await waitForWrites(transport, 1);
  const firstSent = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
  const firstId = (firstSent["params"] as Record<string, unknown>)["commandId"] as string;
  assert.match(firstId, v7, "the minted id is v7-shaped with the 10xx variant");
  transport.chunks.push(frame({ jsonrpc: "2.0", id: firstSent["id"], result: { commandId: firstId } }));
  await first;

  const second = connection.command("turn/start", { n: 2 }, { maxAttempts: 1 });
  await waitForWrites(transport, 2);
  const secondSent = JSON.parse(transport.writes[1] as string) as Record<string, unknown>;
  const secondId = (secondSent["params"] as Record<string, unknown>)["commandId"] as string;
  assert.match(secondId, v7);
  assert.notEqual(secondId, firstId, "two logical commands mint distinct ids");
  transport.chunks.push(frame({ jsonrpc: "2.0", id: secondSent["id"], result: { commandId: secondId } }));
  await second;
  await connection.close();
});

test("TEST-015: a failed ERROR-reply write finishes the connection and never escapes as an unhandled rejection (FM-009 error-reply arm)", async () => {
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const transport = new BrokenWriteDuplex();
    const connection = new Connection(transport);
    connection.onServerRequest(async () => {
      throw new Error("boom");
    });
    transport.chunks.push(frame({ jsonrpc: "2.0", id: 42, method: "approval/request" }));
    const closed = await settlement(connection.closed, 100);
    assert.equal(closed.state, "resolved", "the error-reply write failure finishes the connection");
    await pumpMacrotasks(20);
    assert.deepEqual(rejections, [], "no unhandled rejection escapes the error-reply write (FM-009)");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("TEST-017: chunk-split surrogate pairs never drift the byte counter into a false frame-limit trip (FR-012)", async () => {
  const transport = new FakeDuplex();
  const limit = 64;
  const connection = new Connection(transport, { frameLimitBytes: limit });
  const errors: ProtocolError[] = [];
  connection.onProtocolError((error) => errors.push(error));
  connection.onServerRequest(async () => ({ ok: true }));

  // Each frame is legal (well under the 64-byte limit) and carries one surrogate
  // pair, delivered split across a chunk boundary: the lone halves count 3+3
  // UTF-8 bytes at append, the joined pair counts 4 at line-extract. Without
  // exact accounting the +2 residue accumulates per frame until a legal frame
  // false-trips the limit and gets silently dropped.
  const frames = 40;
  for (let k = 1; k <= frames; k += 1) {
    const line = frame({ jsonrpc: "2.0", id: k, method: "m\u{1F600}" });
    const split = line.indexOf("\uD83D") + 1; // cut between the surrogate halves
    transport.chunks.push(line.slice(0, split));
    if (k % 2 === 0) {
      // FR-012(a): an empty chunk delivered BETWEEN the split halves must not
      // disturb the reconciliation — DuplexTransport is public, so '' chunks
      // are legal; only the length-0 early-return keeps the tail code intact.
      transport.chunks.push("");
    }
    transport.chunks.push(line.slice(split));
    await pumpMacrotasks(2);
  }

  // Interleaved chunking: one chunk carries frame k's newline PLUS frame k+1's
  // prefix up through its high surrogate. The drain consumes frame k, so the
  // retained buffer ends mid-pair — tail-code maintenance must survive the
  // drain or the next chunk's low surrogate never reconciles (+2 drift each,
  // then a false trip). Pins the post-drain tail state through refactors.
  const extra = 40; // must CROSS the 64-byte trigger under a lost-tail regression (+2 drift each)
  let carried = "";
  for (let k = 1; k <= extra; k += 1) {
    const line = frame({ jsonrpc: "2.0", id: frames + k, method: "m\u{1F600}" });
    const split = line.indexOf("\uD83D") + 1;
    transport.chunks.push(carried + line.slice(0, split)); // ...prev \n + next head incl. high surrogate
    carried = "";
    const rest = line.slice(split);
    transport.chunks.push(rest.slice(0, -1)); // low surrogate + body, NO newline
    carried = rest.slice(-1); // the newline rides the NEXT chunk, before frame k+2's head
    await pumpMacrotasks(2);
  }
  transport.chunks.push(carried);
  await pumpMacrotasks(10);
  assert.deepEqual(
    errors.map((error) => error.message),
    [],
    "no legal frame ever trips the frame limit",
  );
  assert.equal(
    transport.writes.length,
    frames + extra,
    "every split frame parsed and was replied to",
  );
  await connection.close();
});

test("TEST-015: a whitespace-only inbound line is ignored like an empty line, never a protocol error (client-local tolerance beyond SS1.1, DECISIONS #15)", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const errors: ProtocolError[] = [];
  connection.onProtocolError((error) => errors.push(error));
  connection.onServerRequest(async () => ({ ok: true }));

  transport.chunks.push("   \n"); // whitespace-only: a separator, not a frame
  transport.chunks.push("\t\r\n"); // tabs + CR count as whitespace too
  transport.chunks.push(frame({ jsonrpc: "2.0", id: 7, method: "m" }));
  await pumpMacrotasks(4);

  assert.deepEqual(
    errors.map((error) => error.message),
    [],
    "whitespace-only lines raise no protocol error",
  );
  assert.equal(transport.writes.length, 1, "the frame after the separators still parses");
  await connection.close();
});
