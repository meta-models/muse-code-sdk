/**
 * T030 / TEST-012 — the `MuseClient` arms: the two v1 verbs, `startSession`
 * and `resumeSession`, as a THIN wrapper over the landed connection.
 *
 * Scope note. These are the client-verb arms of TEST-012; the turn-iterator
 * and wait arms live in `facade-turn.test.ts` and the submit-verb arms in
 * `facade-submit.test.ts`. The two verbs now CONVERGE on `Session` (FR-018:
 * `startSession`/`resumeSession` → `Session`), which retires Design Delta 1
 * (DECISIONS-pr15620-review.md #26) — that delta existed only because the two
 * stacks landed on disjoint branches. The wire result is not lost in the
 * convergence: it rides the session as `opening`, so the params sent AND the
 * values resolved stay pinned here.
 *
 * Every arm is a property the schema at this base makes checkable: an optional
 * wire member is OMITTED and never sent as `null` (tdd SS1.2), the caller's
 * values actually reach the wire, and the commandId comes from the
 * connection's single minter (INV-013).
 *
 * This file also carries T030's obligation (b) — transport EOF without an
 * orderly SS2.1.2 close is an abnormal host death — and the submit-side half of
 * obligation (c), withholding `resumeSession` after an ephemeral discharge.
 * `MuseClient` is the subject of both: it is the only layer that knows whether
 * a close was its own.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Connection,
  EXPECTED_SCHEMA_FINGERPRINT,
  MuseClient,
  MuseHostDiedError,
  MuseSessionDiscardedError,
  Session,
} from "../src/index.js";
import type { MuseClientOptions } from "../src/index.js";
import {
  answer,
  FakeDuplex,
  frame,
  sentFrame,
  sentParams,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";
import { announcedPidProbe, PID_MARKER, reap, settledWithin } from "./helpers/host-lifetime.js";

/**
 * `durability` is REQUIRED on `MuseClient`, for the same reason it is required
 * on `SessionOptions`: it decides what happens to every in-flight item and
 * command when the host dies (SS2.13.3b), and a default would let a caller skip
 * reading the handshake and silently inherit the wrong obligation.
 * `MuseClient.spawn` supplies it from the handshake; a hand-built client says it.
 */
const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
const EPHEMERAL: MuseClientOptions = { durability: { kind: "ephemeral" } };
// Failure-only cap for process/transport arms that can otherwise hang forever.
const ARM_TIMEOUT = 20_000;

/** Read the single outgoing request frame and answer it with `result`. */
async function exchange(
  transport: FakeDuplex,
  result: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await waitForWrites(transport, 1);
  const sent = JSON.parse(transport.writes[0] as string) as Record<string, unknown>;
  transport.chunks.push(frame({ jsonrpc: "2.0", id: sent["id"], result }));
  return sent;
}

function startResult(sessionId: string): Record<string, unknown> {
  return { session: { sessionId, status: "idle" }, viewCursor: "cursor-0" };
}

function resumeResult(sessionId: string): Record<string, unknown> {
  return {
    session: { sessionId, status: "idle" },
    history: { mode: "none", items: [] },
    pendingRequests: [],
    viewCursor: "cursor-9",
  };
}

test("T030/TEST-012: startSession sends session/start and never mints its own commandId (INV-013)", async () => {
  const transport = new FakeDuplex();
  const minted: string[] = [];
  const connection = new Connection(transport, {
    mintCommandId: () => {
      const id = `mint-${minted.length}`;
      minted.push(id);
      return id;
    },
  });
  const client = new MuseClient(connection, DURABLE);

  const pending = client.startSession({ workspaceRoot: "/w" });
  const sent = await exchange(transport, startResult("s-1"));
  const session = await pending;

  assert.equal(sent["method"], "session/start");
  const params = sent["params"] as Record<string, unknown>;
  // The ONLY minter is the connection's. A facade-side second minter would
  // show up here as an id this mint never produced.
  assert.deepEqual(minted, ["mint-0"]);
  assert.equal(params["commandId"], "mint-0");
  // FR-018: the verb resolves to a `Session`, keyed by the id the SERVER
  // named — not the one the caller asked for, which start may not honour.
  assert.ok(session instanceof Session);
  assert.equal(session.sessionId, "s-1");
  // The wire result is not swallowed by the convergence: it rides `opening`,
  // discriminated by the verb that produced it.
  assert.equal(session.opening?.verb, "session/start");
  assert.equal(session.opening?.result.viewCursor, "cursor-0");
  assert.equal(session.opening?.result.session.sessionId, "s-1");
});

test("T030/TEST-012: startSession OMITS unset optional members and never sends null (SS1.2)", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const pending = client.startSession({ workspaceRoot: "/w" });
  const sent = await exchange(transport, startResult("s-1"));
  await pending;

  const params = sent["params"] as Record<string, unknown>;
  // The SDK AUTHORS omission for a member the caller left undefined. The
  // #23468 ruling (c) made the E5b members optional AND nullable on the
  // wire — an explicit `null` now validates — but nullable is a tolerance
  // for foreign callers, not a reason for this SDK to start spelling nulls;
  // omission stays the canonical spelling (tdd SS1.2 examples).
  for (const member of ["approvalMode", "providerId", "modelId", "sessionId"]) {
    assert.ok(!(member in params), `${member} must be omitted, never sent as null`);
  }
  assert.equal(params["workspaceRoot"], "/w");
});

test("T030/TEST-012: startSession forwards every caller-supplied member to the wire", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  // `approvalMode` is a CLOSED enum (D-006, select-never-create) — this is a
  // real member, so regenerating the enum would break this arm rather than
  // silently keeping a value no caller can send.
  const pending = client.startSession({
    workspaceRoot: "/w",
    sessionId: "caller-picked",
    approvalMode: "onRequest",
    providerId: "anthropic",
    modelId: "m-1",
  });
  const sent = await exchange(transport, startResult("caller-picked"));
  await pending;

  const { commandId, ...params } = sent["params"] as Record<string, unknown>;
  assert.ok(typeof commandId === "string" && commandId.length > 0);
  // Deep-equal, not member-by-member: a dropped forward fails even if no
  // individual assertion names it.
  assert.deepEqual(params, {
    workspaceRoot: "/w",
    sessionId: "caller-picked",
    approvalMode: "onRequest",
    providerId: "anthropic",
    modelId: "m-1",
  });
});

test("T030/TEST-012: startSession() with no arguments sends only the minted commandId", async () => {
  // The zero-arg path is the one that relies on the `options = {}` default; no
  // other arm exercises it, so a refactor dropping that default would ship
  // green. (Absent-`sessionId` is already covered by the omission arm above,
  // which is why this arm drives the bare call instead of repeating it.)
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const pending = client.startSession();
  const sent = await exchange(transport, startResult("server-minted"));
  await pending;

  const { commandId, ...params } = sent["params"] as Record<string, unknown>;
  assert.ok(typeof commandId === "string" && commandId.length > 0);
  assert.deepEqual(params, {});
});

test("T030/TEST-012: resumeSession OMITS cursor when unset — the exact ACP divergence (SS1.2)", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const pending = client.resumeSession({ sessionId: "s-9" });
  const sent = await exchange(transport, resumeResult("s-9"));
  const session = await pending;

  assert.equal(sent["method"], "session/resume");
  const params = sent["params"] as Record<string, unknown>;
  assert.equal(params["sessionId"], "s-9");
  // A consumer with no cursor surface at all (ACP wants the whole transcript)
  // must produce a frame with no `cursor` member.
  assert.ok(!("cursor" in params), "cursor must be omitted, never sent as null");
  assert.ok(!("excludeItems" in params), "excludeItems must be omitted when unset");
  assert.ok(!("history" in params), "history must be omitted when unset");
  assert.ok(session instanceof Session);
  assert.equal(session.sessionId, "s-9");
  assert.equal(session.opening?.verb, "session/resume");
  assert.equal(session.opening?.result.viewCursor, "cursor-9");
});

test("T030/TEST-012: resumeSession forwards every caller-supplied member to the wire", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  // Dropping `excludeItems`/`history` would silently turn a metadata-only
  // resume into a full-history one (tdd SS2.5.2).
  const pending = client.resumeSession({
    sessionId: "s-9",
    cursor: "cursor-4",
    excludeItems: true,
    history: "snapshot",
  });
  const sent = await exchange(transport, resumeResult("s-9"));
  await pending;

  const { commandId, ...params } = sent["params"] as Record<string, unknown>;
  assert.ok(typeof commandId === "string" && commandId.length > 0);
  assert.deepEqual(params, {
    sessionId: "s-9",
    cursor: "cursor-4",
    excludeItems: true,
    history: "snapshot",
  });
});

test("T030/TEST-012: startSession drops an explicit null on ALL five guards (SS1.2)", async () => {
  // The types bind only strict TS consumers. A JS caller reaching the built
  // dist can pass null, and a `!== undefined` guard would forward it verbatim
  // — the exact null-vs-omitted divergence this module exists to prevent.
  // Every guarded member is driven, not a sample: a partial arm let five of
  // the eight guards regress silently.
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const pending = client.startSession({
    approvalMode: null,
    providerId: null,
    sessionId: null,
    workspaceRoot: null,
    modelId: null,
  } as unknown as Parameters<MuseClient["startSession"]>[0]);
  const sent = await exchange(transport, startResult("s-1"));
  await pending;

  const { commandId, ...params } = sent["params"] as Record<string, unknown>;
  assert.ok(typeof commandId === "string" && commandId.length > 0);
  // Nothing but the minted commandId may survive.
  assert.deepEqual(params, {});
});

test("T030/TEST-012: resumeSession drops an explicit null on ALL three optional guards (SS1.2)", async () => {
  // The resume twin. `cursor` is the field whose null-vs-absent divergence
  // broke the serve-fixture replay (#23468), so it must be pinned on this verb
  // and not only on start.
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const pending = client.resumeSession({
    sessionId: "s-9",
    cursor: null,
    excludeItems: null,
    history: null,
  } as unknown as Parameters<MuseClient["resumeSession"]>[0]);
  const sent = await exchange(transport, resumeResult("s-9"));
  await pending;

  const { commandId, ...params } = sent["params"] as Record<string, unknown>;
  assert.ok(typeof commandId === "string" && commandId.length > 0);
  // `sessionId` is required and survives; every optional null is dropped.
  assert.deepEqual(params, { sessionId: "s-9" });
});

test("T030/TEST-012: excludeItems false is a real value and still serializes", async () => {
  // Guarding the loose-null guards: `false != null` is true, so an explicit
  // false must reach the wire rather than being swallowed as falsy.
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const pending = client.resumeSession({ sessionId: "s-9", excludeItems: false });
  const sent = await exchange(transport, resumeResult("s-9"));
  await pending;

  assert.equal((sent["params"] as Record<string, unknown>)["excludeItems"], false);
});

// ---- FR-018 convergence: the verbs hand back a WIRED Session --------------

test(
  "T030/TEST-012: the Session startSession returns is wired — sendUserTurn on it reaches the wire",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The convergence is only real if the returned session can SUBMIT. A
    // `Session` handed back with no connection would satisfy the type and
    // still leave the dm CLI writing raw MSP, which is what SC-001 forbids.
    const transport = new FakeDuplex();
    const client = new MuseClient(new Connection(transport), DURABLE);

    const opening = client.startSession({ workspaceRoot: "/w" });
    await exchange(transport, startResult("s-1"));
    const session = await opening;

    const submit = session.sendUserTurn({ input: [{ type: "text", text: "hi" }] });
    await waitForWrites(transport, 2);
    assert.equal(sentFrame(transport, 1)["method"], "turn/start");
    assert.equal(sentParams(transport, 1)["sessionId"], "s-1");
    answer(transport, 1, {
      commandId: sentParams(transport, 1)["commandId"],
      disposition: "started",
      startedNewTurn: true,
      status: "accepted",
      turnId: "t-1",
    });
    const turn = await submit;
    assert.equal(turn, session.turn("t-1"));
  },
);

test(
  "T030/TEST-012: the client's durability profile reaches the sessions it opens",
  { timeout: ARM_TIMEOUT },
  async () => {
    const transport = new FakeDuplex();
    const client = new MuseClient(new Connection(transport), EPHEMERAL);
    const opening = client.startSession();
    await exchange(transport, startResult("s-1"));
    const session = await opening;
    assert.deepEqual(session.durability, { kind: "ephemeral" });
  },
);

// ---- T030(b): transport EOF is a host death ------------------------------

test(
  "T030(b): transport EOF with no orderly close discharges an ephemeral session (SS2.13.3b)",
  { timeout: ARM_TIMEOUT },
  async () => {
    // SS2.13.3b says "process exit OR transport EOF". The landed detection had
    // only the exit half, so a host that closes stdout while still hung never
    // discharged — every pending command sat there as a durable-looking echo.
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const client = new MuseClient(connection, EPHEMERAL);
    const opening = client.startSession();
    await exchange(transport, startResult("s-1"));
    const session = await opening;
    session.pending.submitted({ commandId: "cmd-a", input: "hi" });

    // EOF, with no `close()` from this side: the host went away on its own.
    transport.chunks.end();
    await connection.closed;
    await settleMicrotasks();

    assert.equal(session.pending.discarded, true, "the ephemeral discard must have run");
    assert.equal(session.pending.size, 0);
  },
);

test(
  "T030(b): transport EOF rejects a DURABLE session's live waits with the death (FM-001)",
  { timeout: ARM_TIMEOUT },
  async () => {
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const client = new MuseClient(connection, DURABLE);
    const opening = client.startSession();
    await exchange(transport, startResult("s-1"));
    const session = await opening;
    const turn = session.turn("t-1");

    transport.chunks.end();
    await connection.closed;
    await settleMicrotasks();

    // A durable session's stores are left exactly as observed — the terminals
    // arrive on resume — so only the waiter is told.
    await assert.rejects(turn.completed, MuseHostDiedError);
    assert.equal(session.pending.discarded, false);
  },
);

test(
  "T030(b): an ORDERLY close is not a death — nothing is discharged and no wait is failed",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The discriminator, and the reason this obligation lives on `MuseClient`:
    // the same EOF means two different things depending on who caused it.
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const client = new MuseClient(connection, EPHEMERAL);
    const opening = client.startSession();
    await exchange(transport, startResult("s-1"));
    const session = await opening;
    session.pending.submitted({ commandId: "cmd-a", input: "hi" });
    const turn = session.turn("t-1");

    await client.close();
    await settleMicrotasks();

    assert.equal(session.pending.discarded, false, "an orderly close discharges nothing");
    assert.equal(session.pending.size, 1);
    const raced = await Promise.race([
      turn.completed.then(() => "settled" as const).catch(() => "failed" as const),
      Promise.resolve("pending" as const),
    ]);
    assert.equal(raced, "pending", "an orderly close must not settle a turn wait");
  },
);

test(
  "T030(b): the EOF discharge is the SAME latched discharge a process exit produces",
  { timeout: ARM_TIMEOUT },
  async () => {
    // Both notifications of one death must report the same thing — the exit
    // promise and the EOF routinely both fire. A second, unlatched discharge
    // would hand back a half-empty delta and lose the retired inputs.
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const client = new MuseClient(connection, EPHEMERAL);
    const opening = client.startSession();
    await exchange(transport, startResult("s-1"));
    const session = await opening;
    session.pending.submitted({ commandId: "cmd-a", input: "hi" });

    transport.chunks.end();
    await connection.closed;
    await settleMicrotasks();

    const replay = session.hostExited({
      kind: "crash",
      exitCode: null,
      exitSignal: "SIGKILL",
      stderrTail: [],
    });
    assert.equal(replay.kind, "discharged");
    assert.deepEqual(replay.exit, { kind: "transportEof" });
    assert.deepEqual(replay.retiredCommands, [
      { kind: "terminalUnknown", commandId: "cmd-a", input: "hi" },
    ]);
  },
);

// ---- T030(c): the reattach withholding -----------------------------------

test(
  "T030(c): resumeSession is WITHHELD after an ephemeral discharge and writes no frame",
  { timeout: ARM_TIMEOUT },
  async () => {
    // SS2.13.3b clause 2: "do not attempt to reattach". Until the submit verbs
    // landed there was no `resumeSession` to withhold, which is why T030b's own
    // arm could only name the gap.
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const client = new MuseClient(connection, EPHEMERAL);
    const opening = client.startSession();
    await exchange(transport, startResult("s-1"));
    await opening;

    transport.chunks.end();
    await connection.closed;
    await settleMicrotasks();

    const before = transport.writes.length;
    await assert.rejects(client.resumeSession({ sessionId: "s-1" }), MuseSessionDiscardedError);
    // Refused on THIS side of the transport: a reattach attempt that reaches
    // the wire has already violated the clause, whatever the server answers.
    assert.equal(transport.writes.length, before);
  },
);

test(
  "T030(c): after an ephemeral death, a NEVER-OPENED sessionId is refused the same way",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The hostDied clause's own splitting arm: "never-opened" is in no
    // discarded registry, so only the client-level latch can withhold it —
    // there is nothing on the other end to reattach TO, whatever id is asked
    // for. Deleting the hostDied check downgrades this rejection to a
    // transport error, so the two #assertReattachAllowed clauses each carry
    // their own arm (the close()-killed arm covers the registry clause).
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const client = new MuseClient(connection, EPHEMERAL);
    const opening = client.startSession();
    await exchange(transport, startResult("s-1"));
    await opening;

    transport.chunks.end();
    await connection.closed;
    await settleMicrotasks();

    const before = transport.writes.length;
    await assert.rejects(
      client.resumeSession({ sessionId: "never-opened" }),
      MuseSessionDiscardedError,
    );
    assert.equal(transport.writes.length, before);
  },
);

test(
  "T030(c): a DURABLE session's abnormal death leaves resumeSession available (FM-001)",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The negative control. FM-001's whole point is that a durable session
    // reconciles ON RESUME, so withholding resume there would strand it.
    const transport = new FakeDuplex();
    const connection = new Connection(transport);
    const client = new MuseClient(connection, DURABLE);
    const opening = client.startSession();
    await exchange(transport, startResult("s-1"));
    await opening;

    transport.chunks.end();
    await connection.closed;
    await settleMicrotasks();

    // The connection is gone, so the resume fails as a TRANSPORT error rather
    // than as the SS2.13.3b refusal — which is the distinction being pinned.
    await assert.rejects(client.resumeSession({ sessionId: "s-1" }), (error: unknown) => {
      assert.ok(!(error instanceof MuseSessionDiscardedError));
      return true;
    });
  },
);

// ---- FR-018's spawn verb --------------------------------------------------

/**
 * A minimal in-process MSP host, run through `node -e`.
 *
 * Deliberately NOT the Rust serve-fixture: this arm's subject is `spawn`'s own
 * composition (spawn → handshake → durability → client), and binding it to a
 * `cargo run` would make a facade unit depend on a Rust build. The serve
 * fixture stays the real-host control in `spawn-handshake.test.ts`.
 */
/**
 * `behavior` picks the death shape a given arm needs:
 *  - `orderly` exits 0 when stdin ends (the SS2.1.2 happy path);
 *  - `exitAfterSessionStart` replies to `session/start` and exits 3 in the
 *    write CALLBACK — event-ordered, so the death can never race the round
 *    trip on a loaded runner (a timer here was the suite's one timed death);
 *  - `wedged` ignores stdin EOF and never exits on its own, forcing `close()`
 *    to escalate to a kill (the P0 host-killed-during-close arm).
 */
function inlineHostSource(
  sessionDurability: string,
  behavior:
    | "orderly"
    | "exitAfterSessionStart"
    | "wedged"
    | "streamsTurn"
    | "initializeError" = "orderly",
): string {
  return [
    'const {createInterface} = require("node:readline")',
    'const send = (f, then) => process.stdout.write(JSON.stringify(f) + "\\n", then)',
    // The pid rides stderr so an arm can prove the process is GONE after a
    // failed-handshake cleanup (stderr is evidence, never parsed — INV-010).
    // It uses the shared PID_MARKER so arms AWAIT it through announcedPidProbe
    // instead of sync-matching whatever stderr happens to have arrived.
    `process.stderr.write("${PID_MARKER}" + process.pid + "\\n")`,
    'const rl = createInterface({input: process.stdin})',
    'rl.on("line", (line) => {',
    "  const frame = JSON.parse(line)",
    '  if (frame.method === "initialize") {',
    ...(behavior === "initializeError"
      ? [
          "    send({jsonrpc: '2.0', id: frame.id, error: {code: -32000, message: 'initialize refused (test)', data: {kind: 'testRefusal'}}})",
          "    return",
          "  }",
          '  if (frame.method === "never-initialize") {',
        ]
      : []),
    "    send({jsonrpc: '2.0', id: frame.id, result: {",
    "      experimentalApi: false, grantedCapabilities: [], museHome: '/nonexistent',",
    "      platformFamily: 'unix', platformOs: 'linux',",
    `      schema: {fingerprint: ${JSON.stringify(EXPECTED_SCHEMA_FINGERPRINT)}, version: 1},`,
    // `version` echoes the spawn env, so a dropped `env` forward is visible
    // in the handshake itself (FR-018 names `env?` in the spawn signature).
    "      serverInfo: {name: 'inline', version: process.env.SDK_TEST_MARK ?? '0.0.0'},",
    `      sessionDurability: ${JSON.stringify(sessionDurability)},`,
    "      userAgent: 'inline-host/0.0.0'}})",
    "    return",
    "  }",
    '  if (frame.method === "session/start") {',
    "    send({jsonrpc: '2.0', id: frame.id, result: {session: {sessionId: 's-1', status: 'idle'}, viewCursor: 'c-0'}}" +
      (behavior === "exitAfterSessionStart" ? ", () => process.exit(3))" : ")"),
    "  }",
    ...(behavior === "streamsTurn"
      ? [
          '  if (frame.method === "turn/start") {',
          "    send({jsonrpc: '2.0', id: frame.id, result: {commandId: frame.params.commandId, disposition: 'started', startedNewTurn: true, status: 'accepted', turnId: 't-1'}})",
          "    send({jsonrpc: '2.0', method: 'turn/started', params: {sessionId: 's-1', turnId: 't-1', viewCursor: 'c-1'}})",
          "    send({jsonrpc: '2.0', method: 'turn/completed', params: {sessionId: 's-1', turnId: 't-1', terminal: 'completed', viewCursor: 'c-2'}})",
          "  }",
        ]
      : []),
    "})",
    behavior === "wedged"
      ? 'rl.on("close", () => {}); setInterval(() => {}, 1000)'
      : 'rl.on("close", () => process.exit(0))',
  ].join("\n");
}

test(
  "T030/FR-018: MuseClient.spawn owns the host, runs the handshake, and reads its durability",
  { timeout: ARM_TIMEOUT },
  async () => {
    const client = await MuseClient.spawn({
      museBin: process.execPath,
      args: ["-e", inlineHostSource("ephemeral")],
      clientInfo: { name: "sdk_test", version: "0.0.0" },
      // The env forward is proved through the handshake: the inline host
      // echoes SDK_TEST_MARK as its serverInfo.version, so a silently dropped
      // `env` spread reads back as "0.0.0" here. `process.env` rides along
      // because a spawn env REPLACES the child's environment (PATH included).
      env: { ...process.env, SDK_TEST_MARK: "env-mark" },
    });
    try {
      // The profile is READ from the handshake, not asked of the caller: that
      // is the whole reason `spawn` exists beside the bare constructor.
      assert.deepEqual(client.durability, { kind: "ephemeral" });
      assert.equal(client.initializeResult.serverInfo.name, "inline");
      assert.equal(client.initializeResult.serverInfo.version, "env-mark");
      const session = await client.startSession({ workspaceRoot: "/w" });
      assert.equal(session.sessionId, "s-1");
      assert.deepEqual(session.durability, { kind: "ephemeral" });
    } finally {
      await client.close();
    }
    // An orderly close: the child is gone and the exit is the clean row.
    assert.deepEqual(await client.exit, { kind: "cleanShutdown" });
  },
);

test(
  "T030/FR-018 + (b): a spawned host that dies discharges through the SAME path",
  { timeout: ARM_TIMEOUT },
  async () => {
    // EVENT-ORDERED death: the host replies to session/start and exits in the
    // write callback, so the round trip can never lose a race against a timer
    // on a loaded runner (this was the suite's only timed death arm).
    const client = await MuseClient.spawn({
      museBin: process.execPath,
      args: ["-e", inlineHostSource("ephemeral", "exitAfterSessionStart")],
      clientInfo: { name: "sdk_test", version: "0.0.0" },
    });
    const session = await client.startSession({ workspaceRoot: "/w" });
    session.pending.submitted({ commandId: "cmd-a", input: "hi" });

    await client.exit;
    await settleMicrotasks();

    assert.equal(session.pending.discarded, true);
  },
);

test(
  "T030(b): a host KILLED during close() is still an abnormal death (SS2.13.3b)",
  // 60 s, NOT the shared 20 s: the 20 s failure-only cap below starts its
  // clock only after spawn()+startSession() have spent budget, so at the
  // shared value node:test's own generic timeout won the race and the labeled
  // assert never reported (PR #24422 round 2). The cap must decisively win.
  { timeout: 60_000 },
  async (t) => {
    // `#closing` marks the EOF as ours — but when the host ignores stdin EOF,
    // close() escalates to SIGTERM/SIGKILL and the exit classifies as a crash
    // row, an abnormal death NO MATTER who started the close. Without close()
    // forwarding that row, no session ever hears it: the pending set never
    // drains and the sessionId never enters the discarded registry.
    const { onStderr, pid: announcedPid } = announcedPidProbe();
    // The host is DELIBERATELY wedged: if #shutdown ever regresses to hang,
    // an uncapped close() plus its leaked pipes would pin the runner forever
    // — so the pid gets a last-resort reaper and the close a failure-only
    // cap. The reaper is registered BEFORE any assert can fail, and awaits
    // the probe itself, so no failure path leaks the child.
    t.after(async () => reap(await announcedPid.catch(() => undefined)));
    const client = await MuseClient.spawn({
      museBin: process.execPath,
      args: ["-e", inlineHostSource("ephemeral", "wedged")],
      clientInfo: { name: "sdk_test", version: "0.0.0" },
      shutdownTimeoutMs: 0,
      onStderr,
    });
    const session = await client.startSession({ workspaceRoot: "/w" });
    session.pending.submitted({ commandId: "cmd-a", input: "hi" });
    // Await the probe, never sync-match stderr: the pid line may lag the
    // stdout round trips, and the probe carries its own failure-only cap.
    await announcedPid;

    const closed = await settledWithin(client.close(), 20_000);
    assert.ok(closed.settled, "failure-only cap: close() must settle on the wedged host");

    const exit = await client.exit;
    assert.equal(exit.kind, "crash", "the wedged host must have been killed, not drained");
    assert.equal(session.pending.discarded, true, "the discharge must run despite #closing");
    // The reattach is withheld by the DISCARDED-REGISTRY clause alone: close()
    // claimed the EOF, so the client's own hostDied latch never set on this
    // path — which is exactly what splits the two #assertReattachAllowed
    // clauses under per-guard mutation (deleting the sessionIds.has check
    // downgrades this rejection to a request-after-close ProtocolError).
    await assert.rejects(client.resumeSession({ sessionId: "s-1" }), MuseSessionDiscardedError);
  },
);

test(
  "T030 P0: a spawn-built client ROUTES view notifications — a turn wait settles with no manual apply",
  { timeout: ARM_TIMEOUT },
  async () => {
    // `Session.apply` is the only event entry point and `#connection` is
    // private, so before the constructor claimed `onNotification` every view
    // frame on a spawn-built client was silently dropped: this exact arm hung
    // at `turn.completed` (verified RED before the routing landed). No manual
    // `session.apply` anywhere — the wire is the only feed.
    const client = await MuseClient.spawn({
      museBin: process.execPath,
      args: ["-e", inlineHostSource("durable", "streamsTurn")],
      clientInfo: { name: "sdk_test", version: "0.0.0" },
    });
    try {
      const session = await client.startSession({ workspaceRoot: "/w" });
      const turn = await session.sendUserTurn({ input: [{ type: "text", text: "hi" }] });
      const outcome = await turn.completed;
      assert.equal(outcome.kind, "completed");
      assert.ok(outcome.kind === "completed" && outcome.observedStart, "turn/started routed too");
    } finally {
      await client.close();
    }
  },
);

test(
  "T030/FR-018: a FAILED handshake does not leak the spawned host",
  { timeout: ARM_TIMEOUT },
  async (t) => {
    // spawn()'s catch closes the handshake it already spawned. Deleting that
    // cleanup line stays green on every other arm (their handshakes succeed),
    // so this one drives the failure: the host refuses `initialize`, spawn
    // rejects, and the child must be GONE — not a live orphan `muse serve`.
    const { onStderr, pid: announcedPid } = announcedPidProbe();
    // When the guarded cleanup regresses, the leaked child's live pipes pin
    // the runner past --test-timeout; reap so the guard fails red, not wedged.
    // Registered before any assert can fail, so no failure path leaks it.
    t.after(async () => reap(await announcedPid.catch(() => undefined)));
    await assert.rejects(
      MuseClient.spawn({
        museBin: process.execPath,
        args: ["-e", inlineHostSource("ephemeral", "initializeError")],
        clientInfo: { name: "sdk_test", version: "0.0.0" },
        onStderr,
      }),
      /initialize refused/,
    );
    // Await the probe: the pid line rides a different pipe than the stdout
    // frames the rejection came from, so a sync stderr match can flake.
    const pid = await announcedPid;
    assert.throws(
      () => process.kill(pid, 0),
      { code: "ESRCH" },
      `spawned host ${pid} is still alive after a failed handshake`,
    );
  },
);
