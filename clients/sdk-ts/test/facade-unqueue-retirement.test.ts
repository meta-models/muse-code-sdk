/**
 * #81734 / TEST-81734-1: under `MuseClient`, `turn.unqueue()` hands back this
 * session's reclaim whatever order the ack and `turn/unqueued` arrive in.
 *
 * A host routinely writes the `turn/unqueue` ack and the `turn/unqueued`
 * notification in one read. The connection resolves the ack's promise, but
 * the awaiting `unqueue()` resumes only after the whole read is dispatched, so
 * `MuseClient`'s pump folds `turn/unqueued` through `Session.apply` first. The
 * fold retires the queued entry and returns the retirement, and the pump has
 * nobody to hand it to: before the fix `unqueue()` then found no entry and the
 * app lost the queued input.
 *
 * Python twin: `clients/sdk-py/tests/test_facade_unqueue_retirement.py`.
 * Causal, never time-based: the fake-duplex arms wait on a bounded microtask
 * pump, and the fixture arm on the host's own replies.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMAND_REJECTED_CODE,
  COMMAND_REJECTED_KIND,
  Connection,
  MuseClient,
  readSessionDurability,
  spawnMspConnection,
} from "../src/index.js";
import type { MuseClientOptions, PendingRetirement, Session, Turn } from "../src/index.js";
import { FakeDuplex, frame, sentFrame, sentParams, settleMicrotasks, waitForWrites } from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
const SESSION = "s-1";
const QUEUED_TURN = "t-2";
const QUEUED_INPUT = "queued draft";
const SOURCE = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: SESSION, kind: "session" },
};

function reply(transport: FakeDuplex, index: number, result: Record<string, unknown>): string {
  const sent = sentFrame(transport, index);
  const commandId = sentParams(transport, index)["commandId"];
  return frame({ jsonrpc: "2.0", id: sent["id"], result: { ...result, commandId } });
}

function unqueued(commandId: string): string {
  return frame({
    jsonrpc: "2.0",
    method: "turn/unqueued",
    params: { commandId, sessionId: SESSION, sourceRange: SOURCE, turnId: QUEUED_TURN, viewCursor: "v:9" },
  });
}

/**
 * A `MuseClient`-opened session holding one acked queued submit, so every
 * view frame below reaches the session through the client's real router.
 */
async function clientQueuedTurn(): Promise<{
  client: MuseClient;
  session: Session;
  transport: FakeDuplex;
  turn: Turn;
  queuedCommandId: string;
}> {
  const transport = new FakeDuplex();
  let next = 0;
  const client = new MuseClient(new Connection(transport, { mintCommandId: () => `mint-${next++}` }), DURABLE);
  const opening = client.startSession();
  await waitForWrites(transport, 1);
  transport.chunks.push(reply(transport, 0, { session: { sessionId: SESSION, status: "idle" }, viewCursor: "v:1" }));
  const session = await opening;
  const submitting = session.sendUserTurn({ composerInput: QUEUED_INPUT, input: [{ type: "text", text: "q" }] });
  await waitForWrites(transport, 2);
  const queuedCommandId = sentParams(transport, 1)["commandId"] as string;
  transport.chunks.push(
    reply(transport, 1, { disposition: "queued", startedNewTurn: true, status: "accepted", turnId: QUEUED_TURN }),
  );
  return { client, session, transport, turn: await submitting, queuedCommandId };
}

function reclaimed(commandId: string): PendingRetirement<unknown> {
  return { commandId, input: QUEUED_INPUT, kind: "reclaimed", restoreToComposer: true };
}

for (const order of ["ack, then turn/unqueued", "turn/unqueued, then ack"] as const) {
  test(`TEST-81734-1: unqueue() returns the reclaim the router folded in the same read (${order})`, async () => {
    const { client, session, transport, turn, queuedCommandId } = await clientQueuedTurn();
    const unqueuing = turn.unqueue();
    await waitForWrites(transport, 3);
    assert.equal(sentFrame(transport, 2)["method"], "turn/unqueue");
    const ack = reply(transport, 2, { status: "accepted", turnId: QUEUED_TURN });
    // ONE read: the router folds turn/unqueued before the ack's await resumes.
    const sameRead = order === "ack, then turn/unqueued" ? ack + unqueued(queuedCommandId) : unqueued(queuedCommandId) + ack;
    transport.chunks.push(sameRead);
    const outcome = await unqueuing;
    assert.equal(outcome.ack.status, "accepted");
    assert.deepEqual(outcome.retirement, reclaimed(queuedCommandId), "the queued input comes back from unqueue()");
    assert.equal(session.pending.has(queuedCommandId), false, "the entry retired exactly once");
    assert.equal((await turn.completed).kind, "unqueued");
    await client.close();
  });
}

test("TEST-81734-1: a reclaim held for a refused unqueue is dropped, never handed to a later call", async () => {
  // Bounded memory: the held reclaim lives only while its own unqueue is in
  // flight. The refusal settles that call, so the hold goes with it and a
  // later unqueue of the same turn cannot hand the reclaim out a second time.
  const { client, session, transport, turn, queuedCommandId } = await clientQueuedTurn();
  const refused = turn.unqueue();
  await waitForWrites(transport, 3);
  transport.chunks.push(
    unqueued(queuedCommandId) +
      frame({
        jsonrpc: "2.0",
        id: sentFrame(transport, 2)["id"],
        error: {
          code: COMMAND_REJECTED_CODE,
          message: "turn already launched",
          data: { kind: COMMAND_REJECTED_KIND, reason: "run_active" },
        },
      }),
  );
  await assert.rejects(refused);
  assert.equal(session.pending.has(queuedCommandId), false, "the fold still retired the entry");

  const again = turn.unqueue();
  await waitForWrites(transport, 4);
  transport.chunks.push(reply(transport, 3, { status: "accepted", turnId: QUEUED_TURN }));
  assert.equal((await again).retirement, undefined, "the earlier reclaim is not handed out twice");
  await settleMicrotasks();
  await client.close();
});

// The committed transcript, through `MuseClient`, against the real canned
// host. `serve-fixture` writes the unqueue ack and `turn/unqueued` in one
// burst, so this is the order a real app meets on every run.
const projectRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const scenario = resolve(projectRoot, "schema/msp/transcripts/turn-unqueued-round-trip");

// timeout: failure-path bound only. A wedged fixture host (a frame the
// transcript does not expect) otherwise hangs the run; the green path takes
// seconds once the fixture host is built.
test("TEST-81734-1: turn-unqueued-round-trip through MuseClient returns the reclaim", { timeout: 300_000 }, async () => {
  // Acks echo the RECORDED commandId and the connection checks the echo, so
  // the one minter hands out the transcript's ids in send order.
  const recorded = [
    "0198f0ab-9999-7000-8000-0000000000c1",
    "018f6a32-1111-7000-8000-0000000000a1",
    "018f6a32-3333-7000-8000-0000000000c3",
    "018f6a32-5555-7000-8000-0000000000c5",
  ];
  const stderr: string[] = [];
  const handshake = spawnMspConnection({
    command: "cargo",
    args: [
      "run",
      "--quiet",
      "-p",
      "tbh-conformance",
      "--no-default-features",
      "--bin",
      "muse-conformance",
      "--",
      "serve-fixture",
      "--transcript",
      scenario,
    ],
    onStderr: (chunk) => stderr.push(chunk),
    connection: {
      mintCommandId: () => {
        const next = recorded.shift();
        assert.ok(next !== undefined, "sent more commands than the transcript records");
        return next;
      },
    },
  });
  // Built by hand, not with `MuseClient.spawn`: spawn requests a capability
  // the recorded `initialize` line does not carry.
  const spawned = await handshake.initialize({ clientInfo: { name: "conformance", version: "0.0.0" } });
  const client = new MuseClient(spawned.connection, {
    durability: readSessionDurability(spawned.initializeResult),
    host: spawned,
  });
  try {
    const session = await client.startSession({ workspaceRoot: "/home/me/src/proj" });
    const active = await session.sendUserTurn({
      composerInput: "Review the current deployment state",
      input: [{ type: "text", text: "Review the current deployment state" }],
    });
    // The queued submit must follow the active turn's userMessage, as recorded.
    for await (const item of active.items()) if (item.kind === "userMessage") break;
    const queued = await session.sendUserTurn({
      composerInput: "Run the queued deployment checks",
      ifBusy: "queue",
      input: [{ type: "text", text: "Run the queued deployment checks" }],
    });
    const entry = session.pending.list().find((held) => held.ack?.turnId === queued.turnId);
    assert.ok(entry !== undefined, "the queued submit holds a pending entry");

    const outcome = await queued.unqueue();
    assert.equal(outcome.ack.status, "accepted");
    assert.deepEqual(
      outcome.retirement,
      {
        commandId: entry.commandId,
        input: "Run the queued deployment checks",
        kind: "reclaimed",
        restoreToComposer: true,
      },
      `the reclaim comes back from unqueue(); fixture stderr: ${stderr.join("")}`,
    );
    assert.equal(session.pending.size, 0);
    assert.equal((await queued.completed).kind, "unqueued");
    assert.equal((await active.completed).kind, "completed");
  } finally {
    await client.close();
  }
  assert.equal((await client.exit).kind, "cleanShutdown", stderr.join(""));
});
