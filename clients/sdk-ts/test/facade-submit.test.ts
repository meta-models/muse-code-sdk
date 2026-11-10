/**
 * T030 / TEST-012 — the submit half of FR-018: `Session.sendUserTurn` over
 * `turn/start`, and the SS4.13 retirement drivers that need client→server I/O.
 *
 * These are T030's obligations (a), (c) and (d), each RED-first before the
 * implementation existed:
 *
 *  - (a) `sendUserTurn` authors `turn/start` through the connection's SINGLE
 *    minter (INV-013) and returns THE SESSION'S handle for the ack's `turnId`
 *    rather than a second handle minted beside it;
 *  - (c) the two submit-side SS2.13.3b clauses — `commandId` replay refused
 *    ACROSS sessions, not only within one (the `resumeSession` withholding
 *    twin lives in `facade-client.test.ts`, where `MuseClient` is the subject);
 *  - (d) the SS4.13 retirements that were driverless without a submit verb:
 *    `observedQueueMovement` → replay → `replayAnswered`, the snapshot join's
 *    `mustReplay` → `resolveReplayAtJoin`, and the no-snapshot reconnect plan's
 *    same-`commandId` resubmit.
 *
 * Every arm drives a real frame out of the fake duplex, or asserts that none
 * was written. A submit verb that never reaches the wire is the half-contract
 * T031's NOTE warns about, and it applies here identically.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Connection,
  COMMAND_REJECTED_CODE,
  COMMAND_REJECTED_KIND,
  DiscardedSessions,
  MuseSessionDiscardedError,
  Session,
} from "../src/index.js";
import type { SnapshotJoinFacts } from "../src/index.js";
import {
  answer,
  answerError,
  FakeDuplex,
  sentFrame,
  sentParams,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";
import type { Item, TurnStartResult } from "@muse-code/msp";

const ARM_TIMEOUT = 10_000;

/** A connection whose mint is observable, so a SECOND minter shows up as a gap. */
function wired(options?: { readonly discarded?: DiscardedSessions }): {
  readonly transport: FakeDuplex;
  readonly connection: Connection;
  readonly session: Session<string>;
  readonly minted: string[];
} {
  const transport = new FakeDuplex();
  const minted: string[] = [];
  const connection = new Connection(transport, {
    mintCommandId: () => {
      const id = `mint-${minted.length}`;
      minted.push(id);
      return id;
    },
  });
  const session = new Session<string>({
    sessionId: "s-1",
    durability: { kind: "durable" },
    connection,
    ...(options?.discarded === undefined ? {} : { discarded: options.discarded }),
  });
  return { connection, minted, session, transport };
}

function turnAck(overrides: Partial<TurnStartResult> = {}): Record<string, unknown> {
  return {
    commandId: "mint-0",
    disposition: "started",
    startedNewTurn: true,
    status: "accepted",
    turnId: "t-1",
    ...overrides,
  } as unknown as Record<string, unknown>;
}

function userMessage(overrides: Partial<Item> = {}): Item {
  return {
    itemId: "i-1",
    kind: "userMessage",
    revision: 1,
    sessionId: "s-1",
    status: "completed",
    turnId: "t-1",
    ...overrides,
  } as unknown as Item;
}

/**
 * An error that ADMITS NOTHING (SS4.13), so the entry HOLDS for the caller's
 * same-`commandId` retry. Unlike ending the transport it leaves the connection
 * LIVE, which is what {@link assertReplayMemoryPruned} needs.
 */
function nothingAdmitted(): Record<string, unknown> {
  return { code: -32602, message: "invalid params", data: { kind: "invalidParams" } };
}

/**
 * The observability probe for the two consumer-driven retirement verbs (#24306).
 *
 * A retirement that skips `TurnSubmitter.forgetRetired` leaves the retired
 * command's `turn/start` params in the submitter's replay memory forever — the
 * unbounded submit-then-abandon leak the `Session` wrappers exist to close.
 * Nothing else in the suite can see it: the pending set is already correct
 * either way, so deleting both `forgetRetired` calls left the whole `@muse-code/sdk`
 * suite green.
 *
 * So make the memory speak. Re-seed the SAME `commandId` — an entry the
 * submitter never authored, and therefore has no params for — beside one live
 * submit, then drive the no-snapshot reconnect plan. Both entries are unacked,
 * so both are demanded as same-`commandId` resubmits, retired id first. A
 * PRUNED memory has nothing to replay for it and authors exactly one frame: the
 * live entry's. A LEAKED memory also re-sends the retired `turn/start`, and it
 * goes out first.
 */
async function assertReplayMemoryPruned(
  session: Session<string>,
  transport: FakeDuplex,
  retiredCommandId: string,
  liveCommandId: string,
): Promise<void> {
  session.pending.submitted({ commandId: retiredCommandId, input: "hi" });
  const live = session.sendUserTurn({
    input: [{ type: "text", text: "again" }],
    composerInput: "again",
  });
  const liveWrite = transport.writes.length;
  await waitForWrites(transport, liveWrite + 1);
  answerError(transport, liveWrite, nothingAdmitted());
  await live.catch(() => undefined);

  const reconnected = session.resolveReconnect();
  const replayWrite = transport.writes.length;
  await waitForWrites(transport, replayWrite + 1);
  assert.equal(
    sentParams(transport, replayWrite)["commandId"],
    liveCommandId,
    `the reconnect re-sent retired ${retiredCommandId}: its replay memory was not pruned`,
  );
  answer(transport, replayWrite, turnAck({ commandId: liveCommandId, turnId: "t-live" }));
  assert.deepEqual(await reconnected, []);
  await settleMicrotasks();
  assert.equal(
    transport.writes.length,
    replayWrite + 1,
    "a pruned replay memory authors exactly one resubmit: the live entry's",
  );
}

// ---- (a) sendUserTurn -----------------------------------------------------

test(
  "T030(a)/TEST-012: sendUserTurn sends turn/start and never mints its own commandId (INV-013)",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { minted, session, transport } = wired();

    const pending = session.sendUserTurn({ input: [{ type: "text", text: "hi" }] });
    await waitForWrites(transport, 1);
    answer(transport, 0, turnAck());
    await pending;

    assert.equal(sentFrame(transport, 0)["method"], "turn/start");
    const params = sentParams(transport, 0);
    // The connection's mint is the ONLY minter. A facade-side second minter
    // would show as a commandId this list never produced.
    assert.deepEqual(minted, ["mint-0"]);
    assert.equal(params["commandId"], "mint-0");
    assert.equal(params["sessionId"], "s-1");
    assert.deepEqual(params["input"], [{ type: "text", text: "hi" }]);
  },
);

test(
  "T030(a)/TEST-012: sendUserTurn returns THIS session's handle for the ack's turnId, not a second one",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();

    const pending = session.sendUserTurn({ input: [{ type: "text", text: "hi" }] });
    await waitForWrites(transport, 1);
    answer(transport, 0, turnAck({ turnId: "t-7" }));
    const turn = await pending;

    assert.equal(turn.turnId, "t-7");
    // Identity, not shape: a handle minted BESIDE the session's would compare
    // equal on every field and still route no events, because `Session.apply`
    // only ever feeds the one in its own map.
    assert.equal(turn, session.turn("t-7"));
    assert.equal(session.knownTurnCount, 1);

    // And it is live: the turn/completed the session folds must settle THIS
    // handle's wait.
    session.apply({
      method: "turn/completed",
      params: { sessionId: "s-1", turnId: "t-7", terminal: "completed", viewCursor: "c-1" },
    });
    const outcome = await turn.completed;
    assert.equal(outcome.kind, "completed");
  },
);

test(
  "T030(a)/TEST-012: sendUserTurn ADOPTS a handle the wire already minted, never replaces it",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The race that makes "this session's handle" load-bearing rather than
    // tautological: `turn/started` can fold BEFORE the ack resolves, so a
    // handle for that turnId already exists and already has waiters. Minting a
    // fresh one at the ack would evict it from the map and strand every one of
    // them on a promise nothing will ever settle.
    const { session, transport } = wired();

    const submit = session.sendUserTurn({ input: [{ type: "text", text: "hi" }] });
    await waitForWrites(transport, 1);
    session.apply({
      method: "turn/started",
      params: { sessionId: "s-1", turnId: "t-7", viewCursor: "c-1" },
    });
    const early = session.turn("t-7");
    const waited = early.completed;

    answer(transport, 0, turnAck({ turnId: "t-7" }));
    const turn = await submit;

    assert.equal(turn, early, "the ack must adopt the handle the wire minted");
    assert.equal(session.knownTurnCount, 1);
    assert.equal(turn.observedStart, true, "the adopted handle keeps what it observed");

    // And the wait registered on the pre-existing handle still settles.
    session.apply({
      method: "turn/completed",
      params: { sessionId: "s-1", turnId: "t-7", terminal: "completed", viewCursor: "c-2" },
    });
    assert.equal((await waited).kind, "completed");
  },
);

test(
  "T030(a)/TEST-012: sendUserTurn OMITS unset optional members and never sends null (SS1.2)",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();

    const pending = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      displayText: null,
      ifBusy: null,
      reasoningEffort: null,
    } as unknown as Parameters<Session<string>["sendUserTurn"]>[0]);
    await waitForWrites(transport, 1);
    answer(transport, 0, turnAck());
    await pending;

    const { commandId, ...params } = sentParams(transport, 0);
    assert.ok(typeof commandId === "string" && commandId.length > 0);
    // Deep-equal: a dropped forward fails even when no assertion names it.
    assert.deepEqual(params, { sessionId: "s-1", input: [{ type: "text", text: "hi" }] });
  },
);

test(
  "T030(a)/TEST-012: sendUserTurn forwards every caller-supplied member to the wire",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();

    const pending = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      displayText: "hi",
      ifBusy: "steer",
      reasoningEffort: "high",
    });
    await waitForWrites(transport, 1);
    answer(transport, 0, turnAck());
    await pending;

    const { commandId, ...params } = sentParams(transport, 0);
    assert.ok(typeof commandId === "string" && commandId.length > 0);
    assert.deepEqual(params, {
      sessionId: "s-1",
      input: [{ type: "text", text: "hi" }],
      displayText: "hi",
      ifBusy: "steer",
      reasoningEffort: "high",
    });
  },
);

test(
  "T030(a)/TEST-012: sendUserTurn records the optimistic SS4.13 entry and its ack",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    // An item already folded, so the entry's insertion point is checkable.
    session.apply({
      method: "item/completed",
      params: { sessionId: "s-1", item: userMessage({ itemId: "i-0" }), viewCursor: "c-0" },
    });

    const pending = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    // BEFORE the ack: the entry must already be renderable, or the optimistic
    // echo SS4.13 describes does not exist.
    await waitForWrites(transport, 1);
    const entry = session.pending.get("mint-0");
    assert.ok(entry !== undefined, "the submit must be pending before its ack");
    assert.equal(entry.input, "hi");
    assert.equal(entry.anchorAfterItemId, "i-0");
    assert.equal(entry.ack, undefined);

    answer(transport, 0, turnAck({ turnId: "t-1", disposition: "queued" }));
    await pending;
    assert.deepEqual(session.pending.get("mint-0")?.ack, {
      turnId: "t-1",
      disposition: "queued",
    });
  },
);

test(
  "T030(a)/TEST-012: a durable -32030 rejection retires the entry to the composer and rethrows",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();

    const pending = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    await waitForWrites(transport, 1);
    answerError(transport, 0, {
      code: COMMAND_REJECTED_CODE,
      message: "rejected",
      data: { kind: "commandRejected", reason: "policy_denied" },
    });

    // The error reaches the caller — who already holds the input, which is why
    // this path needs no second retirement channel — and the SS4.13 entry does
    // not linger as the durable-looking echo the clause forbids.
    await assert.rejects(pending, /rejected/);
    assert.equal(session.pending.has("mint-0"), false);
    assert.equal(session.pending.size, 0);
  },
);

test(
  "T030(a)/TEST-012: a nothing-admitted error HOLDS the entry rather than retiring it",
  { timeout: ARM_TIMEOUT },
  async () => {
    // SS4.13 "Nothing-admitted errors are not settlements": only a durable
    // -32030 settles. `invalidParams` admits nothing, so the entry must stay
    // pending for the caller's same-commandId retry.
    const { session, transport } = wired();

    const pending = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    await waitForWrites(transport, 1);
    answerError(transport, 0, {
      code: -32602,
      message: "invalid params",
      data: { kind: "invalidParams" },
    });

    await assert.rejects(pending, /invalid params/);
    assert.equal(session.pending.has("mint-0"), true);
  },
);

test(
  "T030(a)/TEST-012: a fold-only Session refuses sendUserTurn loudly instead of silently dropping it",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The connection seam is OPTIONAL because fold-only construction is a real
    // current use (every arm in facade-turn.test.ts). A submit against one must
    // therefore fail where the caller can see it.
    const session = new Session({ sessionId: "s-1", durability: { kind: "durable" } });
    await assert.rejects(
      session.sendUserTurn({ input: [{ type: "text", text: "hi" }] }),
      /connection/i,
    );
  },
);

// ---- (c) the cross-session replay refusal ---------------------------------

test(
  "T030(c): an ephemeral host death refuses that commandId's replay ACROSS sessions, not only within one",
  { timeout: ARM_TIMEOUT },
  async () => {
    // SS2.13.3b: "do not replay the session's commandIds". Before this the
    // refusal lived in ONE PendingCommandSet, so a FRESH Session could not know
    // a previous one's discarded ids and would happily replay them at the new
    // host — the exactly-once violation the clause exists to prevent.
    const discarded = new DiscardedSessions();
    const first = new Session<string>({
      sessionId: "s-1",
      durability: { kind: "ephemeral" },
      discarded,
    });
    first.pending.submitted({ commandId: "cmd-a", input: "hi" });
    const discharge = first.hostExited({
      kind: "crash",
      exitCode: 9,
      exitSignal: null,
      stderrTail: [],
    });
    assert.equal(discharge.kind, "discharged");

    const second = new Session<string>({
      sessionId: "s-2",
      durability: { kind: "durable" },
      discarded,
    });
    assert.throws(
      () => second.pending.submitted({ commandId: "cmd-a", input: "hi" }),
      MuseSessionDiscardedError,
    );
    // A DIFFERENT id is untouched: the refusal is per-commandId, not a latch
    // that closes every later session.
    second.pending.submitted({ commandId: "cmd-b", input: "hi" });
    assert.equal(second.pending.has("cmd-b"), true);
  },
);

test(
  "T030(c): the discharged sessionId is recorded so a reattach can be withheld",
  { timeout: ARM_TIMEOUT },
  () => {
    const discarded = new DiscardedSessions();
    const session = new Session<string>({
      sessionId: "s-1",
      durability: { kind: "ephemeral" },
      discarded,
    });
    assert.equal(discarded.sessionIds.has("s-1"), false);
    session.hostExited({ kind: "crash", exitCode: null, exitSignal: "SIGKILL", stderrTail: [] });
    assert.equal(discarded.sessionIds.has("s-1"), true);
  },
);

// ---- (d) the SS4.13 drivers that need client→server I/O -------------------

test(
  "T030(d): queue movement replays the acked-queued commandId — same id, no second mint",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { minted, session, transport } = wired();

    const submit = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    await waitForWrites(transport, 1);
    answer(transport, 0, turnAck({ turnId: "t-mine", disposition: "queued" }));
    await submit;

    // A turn that is NOT this entry's own starts: SS4.3 carries no view event
    // for a command-intake settlement, so the client MUST re-verify by replay.
    const outcome = session.apply({
      method: "turn/started",
      params: { sessionId: "s-1", turnId: "t-other", viewCursor: "c-1" },
    });
    await waitForWrites(transport, 2);
    assert.equal(sentFrame(transport, 1)["method"], "turn/start");
    const replayParams = sentParams(transport, 1);
    // SS3.1.1: the replay is the SAME logical command. A fresh id would be the
    // double execution the whole idempotency handle exists to prevent.
    assert.equal(replayParams["commandId"], "mint-0");
    assert.deepEqual(minted, ["mint-0"]);
    assert.deepEqual(replayParams["input"], [{ type: "text", text: "hi" }]);

    // The replay answers with a durable abandonment: the entry retires and the
    // input goes back to the composer.
    answerError(transport, 1, {
      code: COMMAND_REJECTED_CODE,
      message: "abandoned",
      data: { kind: "commandRejected", reason: "abandoned" },
    });
    const retirements = await outcome.io;
    assert.deepEqual(retirements, [
      { kind: "abandoned", commandId: "mint-0", input: "hi", restoreToComposer: true },
    ]);
    assert.equal(session.pending.has("mint-0"), false);
  },
);

test(
  "T030(d): a replay that still answers the original ack keeps the entry pending",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    const submit = session.sendUserTurn({ input: [{ type: "text", text: "hi" }] });
    await waitForWrites(transport, 1);
    answer(transport, 0, turnAck({ turnId: "t-mine", disposition: "queued" }));
    await submit;

    const outcome = session.apply({
      method: "turn/completed",
      params: { sessionId: "s-1", turnId: "t-other", terminal: "completed", viewCursor: "c-1" },
    });
    await waitForWrites(transport, 2);
    answer(transport, 1, turnAck({ commandId: "mint-0", turnId: "t-mine", disposition: "queued" }));

    assert.deepEqual(await outcome.io, []);
    // Held, never promoted locally: only a snapshot can prove a queued ack stale.
    assert.equal(session.pending.has("mint-0"), true);
  },
);

test(
  "T030(d): an apply that triggers no I/O settles its io promise empty rather than leaving it pending",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session } = wired();
    const outcome = session.apply({
      method: "turn/started",
      params: { sessionId: "s-1", turnId: "t-1", viewCursor: "c-1" },
    });
    assert.deepEqual(await outcome.io, []);
  },
);

test(
  "T030(d): resolveSnapshotJoin replays the join's mustReplay entries and retires the reclaimed one",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    const submit = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    await waitForWrites(transport, 1);
    answer(transport, 0, turnAck({ turnId: "t-mine", disposition: "queued" }));
    await submit;

    // The snapshot names neither this commandId nor its turn: the join demands
    // a replay, and the replay's stale "queued" ack is the reclaimed signature.
    const facts: SnapshotJoinFacts = {
      activeTurn: null,
      queuedTurns: [],
      userMessageCommandIds: [],
      lastItemId: null,
    };
    const joined = session.resolveSnapshotJoin(facts);
    await waitForWrites(transport, 2);
    assert.equal(sentParams(transport, 1)["commandId"], "mint-0");
    answer(transport, 1, turnAck({ commandId: "mint-0", turnId: "t-mine", disposition: "queued" }));

    assert.deepEqual(await joined, [
      { kind: "reclaimed", commandId: "mint-0", input: "hi", restoreToComposer: true },
    ]);
    assert.equal(session.pending.has("mint-0"), false);
  },
);

test(
  "T030(d): resolveReconnect resubmits an UNACKED entry with the same commandId before any retire",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { minted, session, transport } = wired();
    // Submitted but never acked — the intake is durable BEFORE the ack
    // (SS3.1.3), so a fresh-id re-send would be a double execution.
    const submit = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    await waitForWrites(transport, 1);
    // The connection dies mid-flight; the caller's own promise never settles
    // successfully, which is not this arm's subject.
    void submit.catch(() => {});

    const reconnected = session.resolveReconnect();
    await waitForWrites(transport, 2);
    assert.equal(sentFrame(transport, 1)["method"], "turn/start");
    assert.equal(sentParams(transport, 1)["commandId"], "mint-0");
    assert.deepEqual(minted, ["mint-0"]);

    answer(transport, 1, turnAck({ commandId: "mint-0", turnId: "t-1" }));
    assert.deepEqual(await reconnected, []);
    // Still pending, now acked: a resubmit is not a retirement.
    assert.deepEqual(session.pending.get("mint-0")?.ack, {
      turnId: "t-1",
      disposition: "started",
    });
  },
);

test(
  "T030(d): the drivers refuse to fabricate I/O for a fold-only session",
  { timeout: ARM_TIMEOUT },
  async () => {
    const session = new Session<string>({ sessionId: "s-1", durability: { kind: "durable" } });
    session.pending.submitted({ commandId: "cmd-a", input: "hi" });
    await assert.rejects(session.resolveReconnect(), /connection/i);
  },
);

test(
  "T030(d): a materialized userMessage retires the entry the submit verb created",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The wired-in-slice-3 retirement, now driven end-to-end from a real
    // submit rather than a hand-seeded entry.
    const { session, transport } = wired();
    const submit = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    await waitForWrites(transport, 1);
    answer(transport, 0, turnAck({ turnId: "t-1" }));
    await submit;

    const outcome = session.apply({
      method: "item/completed",
      params: {
        sessionId: "s-1",
        item: userMessage({ itemId: "i-9", commandId: "mint-0" } as Partial<Item>),
        viewCursor: "c-1",
      },
    });
    assert.deepEqual(outcome.retirements, [
      { kind: "materialized", commandId: "mint-0", matchedBy: "userMessage", itemId: "i-9" },
    ]);
    await settleMicrotasks();
    // No replay was authored for a command that materialized.
    assert.equal(transport.writes.length, 1);
  },
);

// ---- view/gap must not disturb the SS4.13 and FR-019 arms ------------------
//
// FLIPPED with T032 (FR-020). Both arms below were written while `view/gap`
// was the sanctioned `ignoredUnrecognizedMethod` drop (D-24021-1), and their
// subject was "the marker disturbs nothing". That subject SURVIVES the flip
// and is what they still assert; what changed is that the marker now authors
// exactly one thing — the `view/page` walk — and their frames now carry the
// generated `after`/`next` rather than the invented `fromCursor`/`toCursor`
// that a dropped frame never had to get right.

test(
  "T030/T031: a view/gap retires no pending command and mints no turn — it authors only the fill",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    const submit = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    await waitForWrites(transport, 1);
    answer(transport, 0, turnAck({ turnId: "t-1", disposition: "queued" }));
    await submit;

    const outcome = session.apply({
      method: "view/gap",
      params: { after: "c-1", next: "c-9", sessionId: "s-1" },
    });

    assert.deepEqual(outcome.fold, { after: "c-1", kind: "deliveryGap", next: "c-9" });
    assert.deepEqual(outcome.retirements, []);
    // The ONE frame the marker authors is the fill's first page — never a
    // `turn/start` replay: the gap is not queue movement.
    await waitForWrites(transport, 2);
    assert.equal(sentFrame(transport, 1)["method"], "view/page");
    answer(transport, 1, { events: [], nextCursor: null });
    assert.deepEqual(await outcome.io, []);
    await settleMicrotasks();

    assert.equal(transport.writes.length, 2);
    assert.equal(session.knownTurnCount, 1, "no phantom handle was minted for the marker");
    assert.equal(session.pending.has("mint-0"), true, "the pending entry is untouched");
  },
);

test(
  "T031: a view/gap notification never drives the approval handler",
  { timeout: ARM_TIMEOUT },
  async () => {
    const { session, transport } = wired();
    let calls = 0;
    session.onApproval(() => {
      calls += 1;
      return { choiceId: "allow_once" };
    });

    const outcome = session.apply({
      method: "view/gap",
      params: { after: "c-1", next: "c-9", sessionId: "s-1" },
    });
    await waitForWrites(transport, 1);
    answer(transport, 0, { events: [], nextCursor: null });
    await outcome.io;
    await settleMicrotasks();

    assert.equal(calls, 0);
    // Exactly one frame, and it is the fill's page — no `approval/decide`.
    assert.equal(transport.writes.length, 1);
    assert.equal(sentFrame(transport, 0)["method"], "view/page");
  },
);

test(
  "T030(a): a dead transport HOLDS the entry — it admits nothing and settles nothing",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The other half of "nothing-admitted errors are not settlements": a
    // transport death is not even a server-authored MSP error, so it proves
    // nothing about the intake and the entry must survive for the caller's
    // same-commandId retry. Held here rather than inside the abandon-flow arm
    // below, which needs a LIVE connection for its replay-memory probe.
    const { session, transport } = wired();
    const pending = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    await waitForWrites(transport, 1);
    transport.chunks.end(); // dead transport: the ack never comes
    await pending.catch(() => undefined);
    assert.equal(session.pending.has("mint-0"), true, "a transport failure HOLDS the entry");
  },
);

test(
  "T030(a): Session.stopRetrying retires the abandoned submit through the facade and prunes its replay memory",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The sanctioned SS3.1.1 abandon flow: submit → an error that admits
    // nothing (entry HELD for the same-commandId retry) → the consumer gives
    // up. The verb lives on `Session`, not the `pending` view, so the
    // retirement also prunes the submitter's replay memory (see
    // PendingCommandView's doc) — and that prune is what the tail pins (#24306).
    const { session, transport } = wired();
    const pending = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    await waitForWrites(transport, 1);
    answerError(transport, 0, nothingAdmitted());
    await pending.catch(() => undefined);
    assert.equal(session.pending.has("mint-0"), true, "a nothing-admitted error HOLDS the entry");

    const retired = session.stopRetrying("mint-0");
    assert.deepEqual(retired, {
      kind: "retryAbandonedByClient",
      commandId: "mint-0",
      input: "hi",
      restoreToComposer: true,
    });
    assert.equal(session.pending.has("mint-0"), false);
    // Idempotent from the caller's view: a second stop has nothing to retire.
    assert.equal(session.stopRetrying("mint-0"), undefined);

    await assertReplayMemoryPruned(session, transport, "mint-0", "mint-1");
  },
);

test(
  "T030(a): Session.replayAnswered settles a consumer-driven replay and prunes the same replay memory",
  { timeout: ARM_TIMEOUT },
  async () => {
    // `replayAnswered`'s first arm as a PUBLIC verb (#24306). A consumer that
    // performs its own replay I/O — the fold-only composition `joinSnapshot`
    // stays on `pending` for — feeds the answer back through here, and a
    // durable `commandRejected`/`abandoned` is a settlement (SS4.13).
    const { session, transport } = wired();
    const pending = session.sendUserTurn({
      input: [{ type: "text", text: "hi" }],
      composerInput: "hi",
    });
    await waitForWrites(transport, 1);
    answerError(transport, 0, nothingAdmitted());
    await pending.catch(() => undefined);
    assert.equal(session.pending.has("mint-0"), true);

    const settled = session.replayAnswered("mint-0", {
      kind: "error",
      error: { code: COMMAND_REJECTED_CODE, kind: COMMAND_REJECTED_KIND, reason: "abandoned" },
    });
    assert.deepEqual(settled, {
      kind: "abandoned",
      commandId: "mint-0",
      input: "hi",
      restoreToComposer: true,
    });
    assert.equal(session.pending.has("mint-0"), false);
    // An answer for an entry that is already gone settles nothing and, in
    // particular, retires nothing a second time.
    assert.equal(
      session.replayAnswered("mint-0", {
        kind: "ack",
        ack: { turnId: "t-1", disposition: "started" },
      }),
      "held",
    );

    await assertReplayMemoryPruned(session, transport, "mint-0", "mint-1");
  },
);

test(
  "T030(d): resolveSnapshotJoin RESUBMITS the unacked entry first and does not retire it on the join miss",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The mustResubmit half's own splitting arm: deleting the resubmit loop
    // leaves only replays, and an unacked submit at a snapshot join would
    // silently never reach the host again — the durable-intake case SS4.13's
    // resubmit-before-any-retire order exists for.
    const { session, transport } = wired();
    const acked = session.sendUserTurn({
      input: [{ type: "text", text: "first" }],
      composerInput: "first",
    });
    await waitForWrites(transport, 1);
    answer(transport, 0, turnAck({ commandId: "mint-0", turnId: "t-a", disposition: "queued" }));
    await acked;
    const unacked = session.sendUserTurn({
      input: [{ type: "text", text: "second" }],
      composerInput: "second",
    });
    await waitForWrites(transport, 2);
    void unacked.catch(() => {}); // never answered; not this arm's subject

    const facts: SnapshotJoinFacts = {
      activeTurn: null,
      queuedTurns: [],
      userMessageCommandIds: [],
      lastItemId: null,
    };
    const joined = session.resolveSnapshotJoin(facts);

    // SS4.13 order: the UNACKED entry's same-commandId resubmit goes out
    // BEFORE the acked entry's replay.
    await waitForWrites(transport, 3);
    assert.equal(sentFrame(transport, 2)["method"], "turn/start");
    assert.equal(sentParams(transport, 2)["commandId"], "mint-1");
    answer(transport, 2, turnAck({ commandId: "mint-1", turnId: "t-b", disposition: "started" }));

    await waitForWrites(transport, 4);
    assert.equal(sentParams(transport, 3)["commandId"], "mint-0");
    // The stale "queued" ack is the reclaimed signature against this snapshot.
    answer(transport, 3, turnAck({ commandId: "mint-0", turnId: "t-a", disposition: "queued" }));

    assert.deepEqual(await joined, [
      { kind: "reclaimed", commandId: "mint-0", input: "first", restoreToComposer: true },
    ]);
    // The join miss retired NOTHING for the unacked entry: it is pending and
    // now acked under its original commandId.
    assert.equal(session.pending.has("mint-1"), true);
    assert.deepEqual(session.pending.get("mint-1")?.ack, {
      turnId: "t-b",
      disposition: "started",
    });
  },
);
