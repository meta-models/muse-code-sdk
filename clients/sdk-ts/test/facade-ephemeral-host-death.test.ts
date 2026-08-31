/**
 * T030b — FM-002 / Scenario 4.3, the CLIENT-SIDE COMPOSITION of the ephemeral
 * host-death discard obligation (spec 14990 slice 3).
 *
 * Slice 2b (T023) landed the two store-level primitives with ZERO production
 * callers on purpose: `PendingCommandSet.discardEphemeral()` and
 * `ItemStore.markEphemeralHostDeath(isInProgress)`. This is the tick that
 * calls them, and the three facts it composes are the three the facade owns:
 *
 *  1. WHICH PROFILE — read from the handshake's `sessionDurability`
 *     (tdd SS2.13.1). Absent is `"durable"`. An UNRECOGNIZED value is
 *     emphatically NOT: "a client that does not know the value MUST NOT infer
 *     any durability guarantee from it, and MUST NOT fall through to the
 *     absent-means-durable rule — that rule keys on the member being MISSING,
 *     not on its value being unfamiliar."
 *  2. WHETHER THIS DEATH WAS ABNORMAL — exit 0 (`cleanShutdown`) is the ONLY
 *     row where the drain completed and `SessionEnd` records were written
 *     (tdd SS2.11); every other row means no `SessionEnd`.
 *  3. THE DISCHARGE — SS2.13.3b's MUST is a five-clause conjunction, quoted
 *     verbatim: "stop waiting for a terminal, do not attempt to reattach
 *     (`session/resume` is withheld, SS2.13.2), do not replay the session's
 *     `commandId`s (SS3.1.3), do not present the transcript as complete, and
 *     mark the affected items as unknown rather than failed or cancelled".
 *     Each has an arm below. The follow-on note — "No `item/completed` is
 *     synthesized on the wire, by the server or by the SDK" — is a separate
 *     sentence and has its own arm rather than being counted as a clause.
 *
 * TWO CLAUSES ARE ONLY PARTLY REACHABLE TODAY, and the arms say so in their
 * titles rather than overclaiming: "do not reattach" has no `resumeSession` to
 * withhold yet, and the replay refusal is one `Session`'s private set — a
 * FRESH `Session` cannot know a previous one's discarded ids. Both become real
 * when the submit verbs land, and T030's OPEN note carries the obligation.
 *
 * INV-001 holds throughout: the store stays wire-shape-blind and the facade
 * supplies the `(item) => item.status === "inProgress"` probe against the
 * GENERATED `Item`, where `tsc` checks the field and the value.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { InitializeResult, Item, ItemStartedParams, SourceRange } from "@muse/msp";

import type { FoldedItem } from "../src/index.js";
import {
  MuseForeignSessionError,
  MuseHostDiedError,
  MuseSessionDiscardedError,
  readSessionDurability,
  Session,
} from "../src/index.js";
import type { ExitClassification, HostDeathDischarge, ViewEvent } from "../src/index.js";

const SOURCE: SourceRange = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: "str-1", kind: "session" },
};
const SESSION = "s-1";

/** A handshake result carrying (or omitting) the durability member. */
function handshake(sessionDurability?: string): InitializeResult {
  return {
    experimentalApi: false,
    grantedCapabilities: [],
    museHome: "/home/agent/.muse",
    platformFamily: "unix",
    platformOs: "linux",
    schema: { fingerprint: "sha256:0", version: 1 },
    serverInfo: { name: "muse-session-server", version: "0.9.4" },
    userAgent: "muse-session-server/0.9.4",
    ...(sessionDurability === undefined ? {} : { sessionDurability }),
  };
}

const CRASH: ExitClassification = {
  exitCode: 77,
  exitSignal: null,
  kind: "crash",
  stderrTail: ["thread 'main' panicked"],
};
const CLEAN: ExitClassification = { kind: "cleanShutdown" };

function item(itemId: string, extra: Partial<Item> = {}): Item {
  return { itemId, kind: "toolCall", revision: 1, status: "inProgress", ...extra };
}

function itemStarted(payload: Item, viewCursor: string): ViewEvent {
  const params: ItemStartedParams = { item: payload, sessionId: SESSION, viewCursor };
  return { method: "item/started", params };
}

function sessionOn(sessionDurability?: string): Session<string> {
  return new Session<string>({
    sessionId: SESSION,
    durability: readSessionDurability(handshake(sessionDurability)),
  });
}

const ephemeralSession = (): Session<string> => sessionOn("ephemeral");

/** Narrow to the discharged arm, failing the test if another arm came back. */
function discharged(result: HostDeathDischarge<string>) {
  assert.equal(result.kind, "discharged");
  if (result.kind !== "discharged") throw new Error("unreachable");
  return result;
}

async function pumpMacrotasks(turns: number): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// ---- 1. reading the profile off the handshake (SS2.13.1) -------------------

test("T030b: an absent sessionDurability reads as durable — absent is decidable, not fabricated", { timeout: 5_000 }, () => {
  assert.deepEqual(readSessionDurability(handshake()), { kind: "durable" });
});

test("T030b: a declared \"durable\" reads the same as absent — nothing downstream separates them", { timeout: 5_000 }, () => {
  assert.deepEqual(readSessionDurability(handshake("durable")), { kind: "durable" });
});

test("T030b: \"ephemeral\" selects the profile that carries the discard obligation", { timeout: 5_000 }, () => {
  assert.deepEqual(readSessionDurability(handshake("ephemeral")), { kind: "ephemeral" });
});

test("T030b: an UNRECOGNIZED sessionDurability is NOT durable — it never falls through to the absent rule", { timeout: 5_000 }, () => {
  // SS2.13.1's sharpest clause, and the one an implementation gets wrong by
  // writing `value === "ephemeral" ? ephemeral : durable`: that silently grants
  // a durability guarantee to a value it has never heard of. The enum is open
  // precisely so a third value can land (#14401's degraded state is a
  // candidate), and the conservative read is "assume nothing survives".
  assert.deepEqual(readSessionDurability(handshake("degraded")), {
    kind: "unrecognized",
    value: "degraded",
  });
});

test("T030b: an unrecognized profile discharges the obligation, exactly as ephemeral does", { timeout: 5_000 }, () => {
  const s = sessionOn("degraded");
  s.apply(itemStarted(item("i-1"), "v:1"));
  assert.equal(s.hostExited(CRASH).kind, "discharged");
});

// ---- 2. which deaths are abnormal (SS2.11 / SS2.13.3b) ---------------------

test("T030b: a clean shutdown is not a death — nothing discharges and no live wait is disturbed", { timeout: 5_000 }, async () => {
  const s = ephemeralSession();
  s.apply(itemStarted(item("i-1"), "v:1"));
  const turn = s.turn("t-1");

  assert.equal(s.hostExited(CLEAN).kind, "notADeath");

  // The wait must still be PENDING. Without this assert, dropping the
  // abnormal-exit guard in `Session.hostExited` — so an orderly exit 0
  // rejects every live turn wait with MuseHostDiedError — merges green.
  let settled = false;
  void turn.completed.then(
    () => (settled = true),
    () => (settled = true),
  );
  await pumpMacrotasks(3);
  assert.equal(settled, false, "an orderly close is not a death (SS2.11 row 0)");

  // And the session stays usable.
  assert.equal(s.fold.items.ephemeralSessionDiscarded, false);
  s.apply(itemStarted(item("i-2"), "v:2"));
});

test("T030b: every non-cleanShutdown row is abnormal — no SessionEnd was written", { timeout: 5_000 }, () => {
  const rows: ExitClassification[] = [
    { exitCode: 1, kind: "unhandledError", stderrTail: [] },
    { exitCode: 2, kind: "usageError", retry: "never", stderrTail: [] },
    { exitCode: 3, kind: "configError", retry: "fix-config", stderrTail: [] },
    { exitCode: 4, kind: "leaseUnavailable", retry: "after-lease-release", stderrTail: [] },
    { exitCode: 5, kind: "sdkSurfaceUnavailable", retry: "never", stderrTail: [] },
    CRASH,
    { exitCode: null, exitSignal: "SIGKILL", kind: "crash", stderrTail: [] },
  ];
  for (const exit of rows) {
    const s = ephemeralSession();
    s.apply(itemStarted(item("i-1"), "v:1"));
    assert.equal(s.hostExited(exit).kind, "discharged", `${exit.kind} must discharge`);
  }
});

test("T030b: a DURABLE host's abnormal death leaves BOTH stores exactly as observed (FM-001)", { timeout: 5_000 }, () => {
  const s = sessionOn("durable");
  s.apply(itemStarted(item("i-1"), "v:1"));
  s.pending.submitted({ commandId: "c-1", input: "x" });

  assert.equal(s.hostExited(CRASH).kind, "durableDeath");

  // The item half AND the pending half. Discharging the pending set here would
  // wipe a durable session's commands and permanently blacklist their ids —
  // the opposite of the resume reconciliation FM-001 promises.
  assert.equal(s.fold.items.get("i-1")?.status, "inProgress");
  assert.equal(s.fold.items.isTerminalUnknown("i-1"), false);
  assert.equal(s.pending.size, 1);
  assert.equal(s.pending.discarded, false);
});

test("T030b: the three outcomes are distinguishable — not-a-death and durable-death are not the same state", { timeout: 5_000 }, () => {
  // A bare `discharged: false` collapsed these two, yet one session is still
  // usable and the other is dead until resume with every wait already rejected.
  assert.equal(sessionOn("ephemeral").hostExited(CLEAN).kind, "notADeath");
  assert.equal(sessionOn("durable").hostExited(CRASH).kind, "durableDeath");
  assert.equal(sessionOn("ephemeral").hostExited(CRASH).kind, "discharged");
});

// ---- 3. the discharge itself (SS2.13.3b's five clauses) --------------------

test("T030b: clause 5 — in-progress items are marked UNKNOWN, terminal ones are left alone", { timeout: 5_000 }, () => {
  const s = ephemeralSession();
  s.apply(itemStarted(item("i-running"), "v:1"));
  s.apply(itemStarted(item("i-done", { status: "completed" }), "v:2"));
  s.apply(itemStarted(item("i-failed", { status: "failed" }), "v:3"));

  const result = discharged(s.hostExited(CRASH));
  assert.deepEqual(result.terminalUnknownItems, [{ itemId: "i-running", kind: "terminalUnknown" }]);
  assert.equal(s.fold.items.isTerminalUnknown("i-running"), true);
  assert.equal(s.fold.items.isTerminalUnknown("i-done"), false);
});

test("T030b: the annotation never touches the wire item, and synthesizes no item/completed", { timeout: 5_000 }, () => {
  const s = ephemeralSession();
  const wire = item("i-running");
  s.apply(itemStarted(wire, "v:1"));
  const before = s.fold.items.size;
  // Snapshot by VALUE. `ItemStore.apply` stores the caller's object by
  // reference, so comparing the stored item against `wire` would be
  // `deepEqual(x, x)` — an assertion that cannot fail, and which an
  // implementation writing the annotation onto the item in place would pass.
  const beforeDeath = structuredClone(wire);

  s.hostExited(CRASH);

  assert.deepEqual(s.fold.items.get("i-running"), beforeDeath);
  assert.equal(s.fold.items.get("i-running")?.status, "inProgress");
  // The annotation still had to LAND — without this the arm passes under an
  // inverted in-progress probe, which the mutation ledger claims it catches.
  assert.equal(s.fold.items.isTerminalUnknown("i-running"), true);
  assert.equal(s.fold.items.size, before, "no synthesized item joined the fold");
});

test("T030b: clause 4 — the transcript is not presentable as complete", { timeout: 5_000 }, () => {
  const s = ephemeralSession();
  s.apply(itemStarted(item("i-running", { turnId: "t-1" }), "v:1"));
  s.hostExited(CRASH);

  // Nothing anywhere claims completion: the turn holds no terminal, the item
  // is annotated unknown, and the store reports the session discarded. A
  // renderer that draws a finished transcript from this state is choosing to.
  assert.equal(s.fold.turn("t-1")?.terminal, undefined);
  assert.equal(s.fold.items.isTerminalUnknown("i-running"), true);
  assert.equal(s.fold.items.ephemeralSessionDiscarded, true);
});

test("T030b: pending commands retire terminal-unknown, with the input kept and NO composer restore", { timeout: 5_000 }, () => {
  const s = ephemeralSession();
  s.pending.submitted({ commandId: "c-1", input: "fix the test" });
  s.pending.submitted({ commandId: "c-2", input: "and the lint" });

  const result = discharged(s.hostExited(CRASH));
  assert.deepEqual(result.retiredCommands, [
    { commandId: "c-1", input: "fix the test", kind: "terminalUnknown" },
    { commandId: "c-2", input: "and the lint", kind: "terminalUnknown" },
  ]);
  assert.equal(s.pending.size, 0);
  // Unlike every rejected/reclaimed/abandoned retirement, this one carries no
  // `restoreToComposer`: the client does not know whether the work ran, and
  // offering it back would invite the double execution SS3.1.3 forbids.
  for (const retirement of result.retiredCommands) {
    assert.equal(Object.hasOwn(retirement, "restoreToComposer"), false);
  }
});

test("T030b: clause 3 (partial) — this session refuses to replay a discarded commandId (SS3.1.3)", { timeout: 5_000 }, () => {
  // PARTIAL by construction: the blacklist is this set's own. A brand-new
  // Session cannot know these ids, so the cross-host half of "do not replay at
  // a new host" is not enforceable until the submit verbs land (T030's NOTE).
  const s = ephemeralSession();
  s.pending.submitted({ commandId: "c-1", input: "fix the test" });
  s.hostExited(CRASH);

  assert.throws(
    () => s.pending.submitted({ commandId: "c-1", input: "fix the test" }),
    MuseSessionDiscardedError,
  );
});

test("T030b: a discarded set refuses BRAND-NEW submits too, not just the ids it retired", { timeout: 5_000 }, () => {
  const s = ephemeralSession();
  s.pending.submitted({ commandId: "c-1", input: "x" });
  s.hostExited(CRASH);

  // Otherwise a post-discharge submit is accepted and the next discharge
  // retires it `terminalUnknown` — "we don't know if this ran" about input
  // provably never sent to any host, the fabrication SS2.13.3b forbids.
  assert.throws(
    () => s.pending.submitted({ commandId: "c-new", input: "y" }),
    MuseSessionDiscardedError,
  );
  assert.equal(s.pending.discarded, true);
});

test("T030b: clause 2 (partial) — the discarded session refuses further inbound events", { timeout: 5_000 }, () => {
  // PARTIAL: "do not attempt to reattach" is really about withholding
  // `session/resume`, which does not exist yet. What IS enforceable today is
  // that the discarded fold accepts no more events.
  const s = ephemeralSession();
  s.apply(itemStarted(item("i-1"), "v:1"));
  s.hostExited(CRASH);

  assert.equal(s.apply(itemStarted(item("i-2"), "v:2")).fold.kind, "refusedSessionDiscarded");
  assert.equal(s.fold.items.has("i-2"), false, "and nothing folded");
});

test("T030b: the discharge is latched — a second notification replays the FIRST report verbatim", { timeout: 5_000 }, () => {
  const s = ephemeralSession();
  s.apply(itemStarted(item("i-1"), "v:1"));
  s.pending.submitted({ commandId: "c-1", input: "x" });

  // A client can learn of one death twice (the exit promise AND transport
  // EOF). The primitives are only side-effect-idempotent — `discardEphemeral`
  // drains the set, so its RETURN is a one-shot delta — and an unlatched
  // second call reported `commands: 0`, silently losing the retired input.
  const first = discharged(s.hostExited(CRASH));
  const second = discharged(s.hostExited(CRASH));
  assert.deepEqual(second.terminalUnknownItems, first.terminalUnknownItems);
  assert.deepEqual(second.retiredCommands, first.retiredCommands);
  assert.equal(second.retiredCommands.length, 1);
});

test("T030b: the discharge carries the exit classification and its stderr evidence (INV-010)", { timeout: 5_000 }, () => {
  const result = discharged(ephemeralSession().hostExited(CRASH));
  assert.deepEqual(result.exit, CRASH);
  assert.deepEqual(result.profile, { kind: "ephemeral" });
});

// ---- clause 1: "stop waiting for a terminal" ------------------------------

test("T030b: clause 1 — a live turn wait settles terminal-unknown rather than hanging", { timeout: 5_000 }, async () => {
  const s = ephemeralSession();
  const turn = s.turn("t-1");
  s.apply(itemStarted(item("i-1", { turnId: "t-1" }), "v:1"));

  s.hostExited(CRASH);

  // No terminal will EVER arrive: not on this connection, not on a later one,
  // not ever (SS2.13.3b). Terminal-unknown is an annotation, not a synthesized
  // terminal, so settling this way honours INV-006 rather than breaking it.
  assert.deepEqual(await turn.completed, { kind: "terminalUnknown" });
});

test("T030b: the turn's iterators close on the discharge instead of hanging open forever", { timeout: 5_000 }, async () => {
  const s = ephemeralSession();
  const turn = s.turn("t-1");
  const items = turn.items();
  s.apply(itemStarted(item("i-1", { turnId: "t-1" }), "v:1"));
  s.hostExited(CRASH);

  const seen: FoldedItem[] = [];
  for await (const entry of items) seen.push(entry);
  assert.deepEqual(seen.map((entry) => entry.itemId), ["i-1"]);
});

// ---- the durable arm's waiters --------------------------------------------

test("T030b: a DURABLE host's death rejects the wait with the classification — it never fakes a terminal", { timeout: 5_000 }, async () => {
  const s = sessionOn();
  const turn = s.turn("t-1");
  s.hostExited(CRASH);

  // FM-001: the terminals arrive on resume, so this waiter has no answer here.
  // Rejecting reports that honestly; resolving would be the invented terminal
  // INV-006 forbids, and hanging would be the trap SS3.1.4 exists to close.
  await assert.rejects(turn.completed, (error: Error) => {
    assert.ok(error instanceof MuseHostDiedError);
    assert.equal(error.exit.kind, "crash");
    assert.match(error.message, /exit code 77/);
    return true;
  });
});

test("T030b: an iterator opened AFTER a durable death replays, then reports the death", { timeout: 5_000 }, async () => {
  const s = sessionOn();
  s.apply(itemStarted(item("i-1", { turnId: "t-1" }), "v:1"));
  s.turn("t-1");
  s.hostExited(CRASH);

  // Ending cleanly here would hand the consumer a partial replay plus a tidy
  // `done` — an unfinished turn rendered as finished, the invented completion
  // INV-006 forbids. It still gets the items it was owed, THEN the error.
  const seen: FoldedItem[] = [];
  await assert.rejects(
    (async () => {
      for await (const entry of s.turn("t-1").items()) seen.push(entry);
    })(),
    MuseHostDiedError,
  );
  assert.deepEqual(seen.map((entry) => entry.itemId), ["i-1"]);
});

test("T030b: an un-awaited turn handle does not kill the embedder when a durable host dies", { timeout: 5_000 }, async () => {
  // `TurnHandle`'s constructor attaches a no-op `.catch` to `#completed`.
  // Without it this rejection is unhandled and Node tears the process down —
  // load-bearing, and previously deletable with the whole suite still green.
  const rejections: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    const s = sessionOn();
    s.turn("t-never-awaited"); // deliberately never awaited
    s.hostExited(CRASH);
    await pumpMacrotasks(20);
    assert.deepEqual(rejections, [], "the un-awaited wait must not escape as unhandled");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

// ---- session identity ------------------------------------------------------

test("T030b: an event for another session is refused, never folded", { timeout: 5_000 }, () => {
  const s = sessionOn();
  const foreign: ViewEvent = {
    method: "item/started",
    params: { item: item("i-x"), sessionId: "some-other-session", viewCursor: "v:1" },
  };
  assert.throws(() => s.apply(foreign), MuseForeignSessionError);
  assert.equal(s.fold.items.size, 0);
});

// ---- the death latches on the SESSION, not just on live handles ------------

test("T030b: a turn handle minted AFTER an ephemeral death settles instead of hanging", { timeout: 5_000 }, async () => {
  const s = ephemeralSession();
  s.hostExited(CRASH);

  // The discharge settled the handles that already existed. One minted
  // afterwards must inherit the death: otherwise its `completed` hangs forever,
  // the exact SS3.1.4 hang "stop waiting for a terminal" forbids.
  assert.deepEqual(await s.turn("t-late").completed, { kind: "terminalUnknown" });
});

test("T030b: a turn handle minted AFTER a durable death rejects instead of hanging", { timeout: 5_000 }, async () => {
  const s = sessionOn();
  s.hostExited(CRASH);
  await assert.rejects(s.turn("t-late").completed, MuseHostDiedError);
});

test("T030b: a discarded session refuses NON-item events too, not only item events", { timeout: 5_000 }, () => {
  const s = ephemeralSession();
  s.hostExited(CRASH);

  // ItemStore's guard covers only item events, so without a Session-level
  // latch a post-discharge `turn/completed` settled a fresh turn "completed"
  // on a session the client was told to discard.
  const turnDone: ViewEvent = {
    method: "turn/completed",
    params: {
      sessionId: SESSION,
      sourceRange: SOURCE,
      terminal: "completed",
      turnId: "t-zombie",
      viewCursor: "v:9",
    },
  };
  // REFUSED as an outcome, not thrown: a trailing drain frame must not kill
  // the consumer's pump. The load-bearing assertion is the second one.
  assert.equal(s.apply(turnDone).fold.kind, "refusedSessionDiscarded");
  assert.equal(s.fold.turn("t-zombie"), undefined, "no zombie turn folded");
});

test("T030b: a durable death into an OPEN iterator drains the backlog, then reports the death", { timeout: 5_000 }, async () => {
  const s = sessionOn();
  const turn = s.turn("t-1");
  const items = turn.items();
  s.apply(itemStarted(item("i-1", { turnId: "t-1" }), "v:1"));

  s.hostExited(CRASH);

  // The consumer was already owed i-1; swallowing it in favour of the error
  // would be the silent hole PushStream's own contract rules out.
  const first = await items.next();
  assert.equal((first.value as Item | undefined)?.itemId, "i-1");
  await assert.rejects(items.next(), MuseHostDiedError);
});

test("T030b: a signal kill names the SIGNAL — exit code null is not the diagnostic", { timeout: 5_000 }, async () => {
  const s = sessionOn();
  const turn = s.turn("t-1");
  // The only branch where `exitCode` is null. Rendering "exit code null" here
  // throws away the signal, which is that exit's ONLY diagnostic — and every
  // other durable-death arm feeds the exit-77 fixture, so nothing reached it.
  s.hostExited({ exitCode: null, exitSignal: "SIGKILL", kind: "crash", stderrTail: [] });

  await assert.rejects(turn.completed, (error: Error) => {
    assert.match(error.message, /signal SIGKILL/);
    return true;
  });
});

test("T030b: a waiter already parked on next() is settled by a durable death", { timeout: 5_000 }, async () => {
  const s = sessionOn();
  const turn = s.turn("t-1");
  const items = turn.items();

  // Park the consumer BEFORE the death, so the drain goes through `fail()`'s
  // queued-waiter loop rather than the buffered/#failure path the existing arm
  // takes. Without that loop this promise never settles — the silent hang
  // SS3.1.4 exists to close, and deleting the loop kept the whole suite green.
  const parked = items.next();
  s.hostExited(CRASH);

  await assert.rejects(parked, MuseHostDiedError);
});

test("T030b: the second hostExited fails handles the drain left unsettled", { timeout: 5_000 }, async () => {
  const s = sessionOn();
  s.hostExited(CRASH);

  // A durable death does not stop the fold, so the drain can still deliver
  // `turn/started` for a turn whose terminal never arrives. r6 stopped
  // pre-failing server-minted handles (so a delivered terminal wins), which
  // left this one pending FOREVER — the SS3.1.4 hang INV-014 forbids, in this
  // spec's own amended words: "a wait is never left pending by a fact the
  // client has already observed".
  s.apply({
    method: "turn/started",
    params: {
      commandId: "t-3",
      sessionId: SESSION,
      sourceRange: SOURCE,
      turnId: "t-3",
      viewCursor: "v:1",
    },
  });

  // The SECOND notification is what marks end-of-drain: nothing more is coming.
  s.hostExited(CRASH);

  await assert.rejects(s.turn("t-3").completed, MuseHostDiedError);
});

test("T030b: a turn already settled before the death keeps its terminal, everywhere", { timeout: 5_000 }, async () => {
  const s = sessionOn();
  s.apply({
    method: "turn/started",
    params: { commandId: "t-1", sessionId: SESSION, sourceRange: SOURCE, turnId: "t-1", viewCursor: "v:1" },
  });
  s.apply(itemStarted(item("i-1", { turnId: "t-1" }), "v:2"));
  s.apply({
    method: "turn/completed",
    params: { sessionId: SESSION, sourceRange: SOURCE, terminal: "completed", turnId: "t-1", viewCursor: "v:3" },
  });

  s.hostExited(CRASH);

  // `fail()` no-ops on a settled handle, and that guard is what stops one turn
  // giving two answers. Without it the wait still says "completed" while a
  // fresh iterator rejects `MuseHostDiedError` — the split FM-001's
  // settle-on-the-server-fact rule forbids. The existing arms only cover turns
  // unsettled AT the death or settled after it.
  assert.equal((await s.turn("t-1").completed).kind, "completed");
  const seen: FoldedItem[] = [];
  for await (const entry of s.turn("t-1").items()) seen.push(entry);
  assert.deepEqual(seen.map((e) => e.itemId), ["i-1"]);
});

test("T030b: CHARACTERIZATION of #23674 — a pre-death start keeps its rejection", { timeout: 5_000 }, async () => {
  const s = sessionOn();
  s.apply({
    method: "turn/started",
    params: { commandId: "t-1", sessionId: SESSION, sourceRange: SOURCE, turnId: "t-1", viewCursor: "v:1" },
  });
  const wait = s.turn("t-1").completed;

  s.hostExited(CRASH);

  // The drain delivers the real terminal AFTER the death.
  s.apply({
    method: "turn/completed",
    params: { sessionId: SESSION, sourceRange: SOURCE, terminal: "completed", turnId: "t-1", viewCursor: "v:2" },
  });

  // PINS TODAY'S ANSWER, WHICH IS THE KNOWN DEFECT, NOT THE DESIRED ONE
  // (issue #23674): the fold records the terminal while the wait stays
  // rejected, because the wait was live at the death and FM-001 rejects those.
  // The identical frames with the start arriving AFTER the death settle
  // instead — that split is the defect. This arm exists so the repair has an
  // executable baseline and so an accidental half-fix cannot flip the answer
  // silently; REWRITE IT when #23674 lands, do not delete it.
  assert.equal(s.fold.turn("t-1")?.terminal, "completed");
  await assert.rejects(wait, MuseHostDiedError);
});

test("T030b: a foreign frame still THROWS after a discard, never a drain refusal", { timeout: 5_000 }, async () => {
  // EPHEMERAL: only a discharged session has the latch that could swallow the
  // throw. A durable session never reaches it, so this arm would pass either
  // way on `sessionOn()` — which is exactly how the first draft of it missed.
  const s = ephemeralSession();
  s.hostExited(CRASH);
  assert.equal(s.fold.items.ephemeralSessionDiscarded, true, "the latch must be armed");
  // A frame naming a different session is an embedder routing bug, not this
  // session's trailing drain frame, so the discard latch must not relabel it.
  assert.throws(
    () =>
      s.apply({
        method: "item/started",
        params: { item: item("i-x"), sessionId: "some-other-session", viewCursor: "v:9" },
      }),
    MuseForeignSessionError,
  );
});
