/**
 * An explicit `data.retryable: false` on the auto-retried nothing-admitted
 * pair (`-32001 overloaded`, `-32031 backpressured`) stops the
 * same-`commandId` retry. The MSP `ErrorData` contract says a present
 * `retryable` overrides the error table default for the code. The absent-flag
 * arm is the paired control: it differs only in the flag and must still retry,
 * so the retried set and the attempt budget are unchanged.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MspError } from "../src/index.js";
import { FakeDuplex, frame, sentFrame, waitForWrites } from "./helpers/fake-duplex.js";

const PAIR = [
  { code: -32001, kind: "overloaded" },
  { code: -32031, kind: "backpressured" },
] as const;

for (const { code, kind } of PAIR) {
  test(`${kind} with retryable false is not auto-retried`, async () => {
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const command = connection.command("turn/start", { n: 1 }, {
      maxAttempts: 3,
      // Fails at the first scheduled retry, so the RED is bounded: a retry
      // would otherwise wait forever for a second answer.
      retryDelay: async () => assert.fail("an explicit retryable false must never schedule a retry"),
    });
    await waitForWrites(transport, 1);
    transport.chunks.push(
      frame({
        jsonrpc: "2.0",
        id: sentFrame(transport, 0)["id"],
        error: { code, message: "refused", data: { kind, retryable: false } },
      }),
    );
    await assert.rejects(command, (error: unknown) => {
      assert.ok(error instanceof MspError);
      assert.equal(error.code, code);
      assert.equal(error.kind, kind);
      assert.equal(error.retryable, false, "the parsed error keeps the explicit flag");
      return true;
    });
    assert.equal(transport.writes.length, 1, "no second submission was sent");
    await connection.close();
  });

  test(`control: ${kind} with no retryable flag still retries`, async () => {
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const command = connection.command("turn/start", { n: 1 }, {
      maxAttempts: 2,
      retryDelay: async () => {},
    });
    await waitForWrites(transport, 1);
    const first = sentFrame(transport, 0);
    transport.chunks.push(
      frame({
        jsonrpc: "2.0",
        id: first["id"],
        error: { code, message: "busy", data: { kind } },
      }),
    );
    await waitForWrites(transport, 2);
    const retry = sentFrame(transport, 1);
    const commandId = (retry["params"] as Record<string, unknown>)["commandId"];
    assert.equal(commandId, (first["params"] as Record<string, unknown>)["commandId"]);
    const ack = { commandId, status: "accepted" };
    transport.chunks.push(frame({ jsonrpc: "2.0", id: retry["id"], result: ack }));
    assert.deepEqual(await command, ack);
    await connection.close();
  });
}
