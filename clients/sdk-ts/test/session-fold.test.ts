/**
 * T035 (slice 1b) — FR-007's turn-lifecycle and approval/user-input fold-input
 * arms, as a transport-less contract test over synthetic event sequences.
 *
 * This is a subset of TEST-001's checkpoints: 1b and 1c may land in either
 * order, so 1b carries its own RED for the surface T019 delivers rather than
 * waiting on the #14951 corpus (Constitution IV; spec 14990 drift round 3).
 *
 * Every event object below is typed as the GENERATED params type it names, so
 * a member the fold reads that the wire does not carry fails `tsc` here rather
 * than at runtime against a real host (INV-001). That protection lives in the
 * `const params: <Generated>Params` annotations: `apply` also accepts the
 * wire's wide `{ method, params }` shape (SS1.5.4 tolerance), so an
 * UNANNOTATED inline literal would fall through to the wide overload — keep
 * new events typed the way the helpers here are.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type {
  ApprovalRequestParams,
  ApprovalResolvedParams,
  ApprovalUpdatedParams,
  Item,
  ItemCompletedParams,
  ItemDeltaParams,
  ItemStartedParams,
  ItemUpdatedParams,
  Notification,
  SessionApprovalModeChangedParams,
  SessionBranchChangedParams,
  SessionContextUsageParams,
  SessionGoalChangedParams,
  SessionModelChangedParams,
  SessionTodoListChangedParams,
  SessionTokenUsageParams,
  SourceRange,
  TurnCompletedParams,
  TurnError,
  TurnRetractedParams,
  TurnRetryScheduledParams,
  TurnStartedParams,
  TurnUnqueuedParams,
  UserInputRequestParams,
  UserInputSettledParams,
} from "@muse/msp";

import { SessionFold } from "../src/index.js";
import type { FoldItems, SessionStateMethod, ViewEvent } from "../src/index.js";

const SOURCE: SourceRange = {
  first: { id: "e-1", sequence: 1 },
  last: { id: "e-1", sequence: 1 },
  stream: { id: "str-1", kind: "session" },
};
const SESSION = "s-1";

function turnStarted(turnId: string, commandId: string, viewCursor: string): ViewEvent {
  const params: TurnStartedParams = { commandId, sessionId: SESSION, sourceRange: SOURCE, turnId, viewCursor };
  return { method: "turn/started", params };
}

function turnCompleted(
  turnId: string,
  terminal: string,
  viewCursor: string,
  error?: TurnError,
): ViewEvent {
  const params: TurnCompletedParams = {
    sessionId: SESSION,
    sourceRange: SOURCE,
    terminal,
    turnId,
    viewCursor,
    ...(error !== undefined ? { error } : {}),
  };
  return { method: "turn/completed", params };
}

function turnRetracted(turnId: string, commandId: string, viewCursor: string): ViewEvent {
  const params: TurnRetractedParams = { commandId, sessionId: SESSION, sourceRange: SOURCE, turnId, viewCursor };
  return { method: "turn/retracted", params };
}

function turnUnqueued(turnId: string, commandId: string, viewCursor: string): ViewEvent {
  const params: TurnUnqueuedParams = { commandId, sessionId: SESSION, sourceRange: SOURCE, turnId, viewCursor };
  return { method: "turn/unqueued", params };
}

function item(itemId: string, revision: number, extra: Partial<Item> = {}): Item {
  return { itemId, kind: "agentMessage", revision, status: "inProgress", ...extra };
}

function approvalRequested(approvalId: string, viewCursor: string, command = "ls"): ViewEvent {
  const params: ApprovalRequestParams = {
    approvalId,
    availableChoices: [],
    currentRequirementId: { approvalId, sourceIndex: 0 },
    itemId: "i-1",
    judgeEscalated: false,
    protectedWrite: false,
    rawArgs: "{}",
    sessionId: SESSION,
    sourceRange: SOURCE,
    subject: { kind: "shell", command },
    taskId: "t-1",
    toolCallId: "call-1",
    toolName: "shell",
    turnId: "turn-1",
    viewCursor,
  };
  return { method: "approval/requested", params };
}

function approvalResolved(approvalId: string, decision: string, viewCursor: string): ViewEvent {
  const params: ApprovalResolvedParams = {
    approvalId,
    decision,
    itemId: "i-1",
    policyResult: "allow",
    resolvedBy: "user",
    sessionId: SESSION,
    sourceRange: SOURCE,
    stageEvidence: [],
    turnId: "turn-1",
    viewCursor,
  };
  return { method: "approval/resolved", params };
}

function userInputRequested(userInputId: string, viewCursor: string): ViewEvent {
  const params: UserInputRequestParams = {
    itemId: "i-2",
    questions: [],
    sessionId: SESSION,
    toolCallId: "call-2",
    toolName: "ask",
    turnId: "turn-1",
    userInputId,
    viewCursor,
  };
  return { method: "userInput/requested", params };
}

function userInputSettled(userInputId: string, outcome: string, viewCursor: string): ViewEvent {
  const params: UserInputSettledParams = {
    answers: [],
    clarification: null,
    decidedByCommandId: null,
    outcome,
    reason: null,
    sessionId: SESSION,
    sourceRange: SOURCE,
    userInputId,
    viewCursor,
  };
  return { method: "userInput/settled", params };
}

// ---- turn lifecycle -------------------------------------------------------

test("turn/started opens a running turn and names the active turn", () => {
  const fold = new SessionFold();
  assert.equal(fold.activeTurnId, undefined, "no turn is running before any event");

  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));

  assert.equal(fold.activeTurnId, "turn-1");
  assert.deepEqual(
    fold.turns().map((t) => [t.turnId, t.state]),
    [["turn-1", "running"]],
  );
  assert.equal(fold.turn("turn-1")?.commandId, "cmd-1");
});

test("turn/completed settles the turn and carries the wire terminal verbatim", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  fold.apply(turnCompleted("turn-1", "failed", "v:s:2"));

  assert.equal(fold.activeTurnId, undefined, "a settled turn is no longer running");
  const settled = fold.turn("turn-1");
  assert.equal(settled?.state, "settled");
  assert.equal(settled?.terminal, "failed");
  // `turn/completed` carries no `commandId` on the wire, so the held entry is
  // the ONLY reason a settled turn still knows its command (tdd SS3.6). A fold
  // that minted a fresh turn per event would drop the settled-turn-to-command
  // join with every other assertion here still green.
  assert.equal(settled?.commandId, "cmd-1", "settling must not forget the started event's command");
});

test("an unknown TurnTerminal value is recorded verbatim, never normalized (INV-006)", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  // `TurnTerminal` is wire-open: a value this SDK does not know is still the
  // server's terminal, and the fold must not rewrite it to a known one.
  fold.apply(turnCompleted("turn-1", "supersededByFork", "v:s:2"));

  assert.equal(fold.turn("turn-1")?.terminal, "supersededByFork");
  assert.equal(fold.turn("turn-1")?.state, "settled");
});

test("a failed turn's wire error folds verbatim; a non-failed terminal carries none", () => {
  const fold = new SessionFold();
  const wireError: TurnError = {
    kind: "modelError",
    message: "the provider returned a 500",
    retryable: true,
  };
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  fold.apply(turnCompleted("turn-1", "failed", "v:s:2", wireError));

  // The SS4.5.1 failure payload must survive the fold untouched: a renderer
  // reads WHY the turn failed from here.
  assert.deepEqual(fold.turn("turn-1")?.error, wireError);

  fold.apply(turnStarted("turn-2", "cmd-2", "v:s:3"));
  fold.apply(turnCompleted("turn-2", "completed", "v:s:4"));
  assert.equal(fold.turn("turn-2")?.error, undefined, "error is present iff the turn failed");
});

test("an accepted retract after turn/completed(cancelled) still marks the turn retracted", () => {
  const fold = new SessionFold();
  // The wire's REAL ordering for a ran-then-retracted turn (tdd SS3.4): the
  // turn first settles with terminal "cancelled", THEN the accepted retract
  // arrives. A fold that ignores retracts on settled turns would silently
  // never tell the client its submission was retracted.
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  fold.apply(turnCompleted("turn-1", "cancelled", "v:s:2"));
  fold.apply(turnRetracted("turn-1", "cmd-1", "v:s:3"));

  const retracted = fold.turn("turn-1");
  assert.equal(retracted?.state, "retracted");
  assert.equal(retracted?.terminal, "cancelled", "the wire terminal is kept verbatim (INV-006)");
});

test("turn/completed for a turn never started still settles it (gap fill)", () => {
  const fold = new SessionFold();
  fold.apply(turnCompleted("turn-9", "completed", "v:s:1"));

  assert.equal(fold.turn("turn-9")?.state, "settled");
  assert.equal(fold.turn("turn-9")?.terminal, "completed");
  assert.equal(fold.activeTurnId, undefined);
});

test("turn/retracted retires the submission's turn without inventing a terminal", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  fold.apply(turnRetracted("turn-1", "cmd-1", "v:s:2"));

  const retracted = fold.turn("turn-1");
  assert.equal(retracted?.state, "retracted");
  assert.equal(retracted?.terminal, undefined, "a retract is not a TurnTerminal (INV-006)");
  assert.equal(fold.activeTurnId, undefined);
});

test("turn/unqueued records a reclaimed turn that never ran and never becomes active", () => {
  const fold = new SessionFold();
  // A queued submit's pre-minted turn: no `turn/started` is ever emitted for
  // it, and no `turn/completed` ever will be (tdd SS3.6, SS4.5.1).
  fold.apply(turnUnqueued("turn-2", "cmd-2", "v:s:1"));

  const unqueued = fold.turn("turn-2");
  assert.equal(unqueued?.state, "unqueued");
  assert.equal(unqueued?.commandId, "cmd-2");
  assert.equal(unqueued?.terminal, undefined, "a reclaim is not a terminal (INV-006)");
  assert.equal(fold.activeTurnId, undefined, "a reclaimed turn never runs");
});

test("turn/unqueued for a queued turn does not disturb the running turn", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  fold.apply(turnUnqueued("turn-2", "cmd-2", "v:s:2"));

  assert.equal(fold.activeTurnId, "turn-1", "the reclaim was another turn's");
  assert.equal(fold.turn("turn-2")?.state, "unqueued");
});

test("a redelivered turn/started for a STILL-RUNNING turn folds, and is not dropped", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  // The legal half of the redelivery guard, which the guard's own comment and
  // D-6 both promise: only a turn that LEFT `running` is dropped. Without this
  // pin, tightening the guard to held-based (`#turns.has(id)` → drop) keeps
  // every other test green while silently refusing a replay of a turn that is
  // genuinely still running.
  const outcome = fold.apply(turnStarted("turn-1", "cmd-1", "v:s:2"));

  assert.deepEqual(outcome, { kind: "turn", turnId: "turn-1", state: "running" });
  assert.equal(fold.activeTurnId, "turn-1");
  assert.equal(fold.turns().length, 1, "a re-start never duplicates the turn");
});

test("a redelivered turn/started never resurrects a turn that left running", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  fold.apply(turnCompleted("turn-1", "completed", "v:s:2"));
  // Cursor-ordered delivery does not make a replay impossible: a reconnect
  // can re-deliver a page the client already folded. Re-opening the turn would
  // mint `{state: "running", terminal: "completed"}` — a shape TurnEntry's own
  // docs forbid — and pin `activeTurnId` to a turn nothing will complete.
  const outcome = fold.apply(turnStarted("turn-1", "cmd-1", "v:s:3"));

  assert.deepEqual(outcome, {
    kind: "ignoredStaleFrame",
    method: "turn/started",
    id: "turn-1",
  });
  assert.equal(fold.turn("turn-1")?.state, "settled");
  assert.equal(fold.turn("turn-1")?.terminal, "completed");
  assert.equal(fold.activeTurnId, undefined, "a replayed start never re-arms the active turn");
});

test("a redelivered turn/completed never un-retracts a retracted turn", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  fold.apply(turnCompleted("turn-1", "cancelled", "v:s:2"));
  fold.apply(turnRetracted("turn-1", "cmd-1", "v:s:3"));
  // The retract is the LAST fact and the load-bearing one (the ran-then-
  // retracted ordering above). Replaying the completion frame that preceded it
  // must not flip the turn back to settled and erase that fact.
  const outcome = fold.apply(turnCompleted("turn-1", "cancelled", "v:s:2"));

  assert.deepEqual(outcome, {
    kind: "ignoredStaleFrame",
    method: "turn/completed",
    id: "turn-1",
  });
  assert.equal(fold.turn("turn-1")?.state, "retracted");
  assert.equal(fold.turn("turn-1")?.terminal, "cancelled", "the wire terminal is still verbatim");
});

test("a redelivered turn/completed on a SETTLED turn folds, and is not dropped", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  fold.apply(turnCompleted("turn-1", "completed", "v:s:2"));
  // The other deliberately-unguarded case D-6 records: `#turnCompleted` drops
  // only `retracted`/`unqueued`, because re-applying a completion to a settled
  // turn rewrites identical facts and is harmless. Widening that guard to
  // `state !== "running"` — the tempting symmetry with `#turnStarted` — turns
  // this legal redelivery into a drop, and every other test stays green.
  const outcome = fold.apply(turnCompleted("turn-1", "completed", "v:s:3"));

  assert.deepEqual(outcome, { kind: "turn", turnId: "turn-1", state: "settled" });
  assert.equal(fold.turn("turn-1")?.terminal, "completed");
  assert.equal(fold.turns().length, 1, "a redelivered completion never duplicates the turn");
});

test("a reclaimed turn stays unqueued: no turn/completed ever settles it", () => {
  const fold = new SessionFold();
  fold.apply(turnUnqueued("turn-2", "cmd-2", "v:s:1"));
  // tdd SS3.6/SS4.5.1: a pre-minted queued turn never launched, so no
  // completion is coming — one that arrives is a frame for a turn this fold
  // has already retired, not a terminal it must invent.
  const outcome = fold.apply(turnCompleted("turn-2", "completed", "v:s:2"));

  assert.deepEqual(outcome, {
    kind: "ignoredStaleFrame",
    method: "turn/completed",
    id: "turn-2",
  });
  assert.equal(fold.turn("turn-2")?.state, "unqueued");
  assert.equal(fold.turn("turn-2")?.terminal, undefined, "a reclaim is not a terminal (INV-006)");
});

test("turn/retracted carries the commandId when the retract is the FIRST frame", () => {
  const fold = new SessionFold();
  // The gap-fill case this module documents: a client joining mid-session can
  // see `turn/retracted` as its first frame for a turn. Without the retract
  // arm's own commandId capture that entry has no command, so a renderer
  // cannot join the retracted turn to its submission — and the
  // started-then-retracted tests cannot catch it, because `turn/started`
  // already set the same commandId there.
  fold.apply(turnRetracted("turn-9", "cmd-9", "v:s:1"));

  const retracted = fold.turn("turn-9");
  assert.equal(retracted?.state, "retracted");
  assert.equal(retracted?.commandId, "cmd-9");
  assert.equal(retracted?.terminal, undefined, "a retract is not a TurnTerminal (INV-006)");
});

test("turn/completed clears the retry countdown (tdd SS4.5.1)", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  const params: TurnRetryScheduledParams = {
    attempt: 1,
    maxAttempts: 3,
    nextAttempt: 2,
    reason: "overloaded",
    retryDelayMs: 500,
    sessionId: SESSION,
    sourceRange: SOURCE,
    turnId: "turn-1",
    viewCursor: "v:s:2",
  };
  fold.apply({ method: "turn/retryScheduled", params });
  assert.ok(fold.turn("turn-1")?.retryScheduled, "the hint is set while the turn runs");

  fold.apply(turnCompleted("turn-1", "completed", "v:s:3"));

  // The hint is a "retrying in Ns" countdown and clears on the turn's next
  // event; a renderer keyed on it would otherwise show a countdown on a turn
  // that is already done.
  assert.equal(fold.turn("turn-1")?.retryScheduled, undefined);
});

test("a redelivered turn/unqueued on a reclaimed turn folds, and is not dropped", () => {
  const fold = new SessionFold();
  fold.apply(turnUnqueued("turn-2", "cmd-2", "v:s:1"));
  // The third item on D-6's deliberately-unguarded list. It is the one arm
  // whose legal redelivery no test covered: every other test feeds this arm a
  // fresh turn, which `#turnFor` mints as `running`, so a `state !== "running"`
  // guard bolted on here never fires and the whole suite stays green.
  const outcome = fold.apply(turnUnqueued("turn-2", "cmd-2", "v:s:2"));

  assert.deepEqual(outcome, { kind: "turn", turnId: "turn-2", state: "unqueued" });
  assert.equal(fold.turns().length, 1, "a redelivered reclaim never duplicates the turn");
  assert.equal(fold.turn("turn-2")?.terminal, undefined, "a reclaim is not a terminal (INV-006)");
  assert.equal(fold.activeTurnId, undefined, "a reclaimed turn never runs");
});

test("turn/retryScheduled is non-terminal: the turn keeps running", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  const params: TurnRetryScheduledParams = {
    attempt: 1,
    maxAttempts: 3,
    nextAttempt: 2,
    reason: "overloaded",
    retryDelayMs: 500,
    sessionId: SESSION,
    sourceRange: SOURCE,
    turnId: "turn-1",
    viewCursor: "v:s:2",
  };
  fold.apply({ method: "turn/retryScheduled", params });

  assert.equal(fold.activeTurnId, "turn-1", "a scheduled retry never settles a turn");
  assert.equal(fold.turn("turn-1")?.state, "running");
  assert.equal(fold.turn("turn-1")?.retryScheduled?.nextAttempt, 2);
});

test("a replayed page never re-plants the retry hint on a turn that left running", () => {
  const fold = new SessionFold();
  const retry: ViewEvent = {
    method: "turn/retryScheduled",
    params: {
      attempt: 1,
      maxAttempts: 3,
      nextAttempt: 2,
      reason: "overloaded",
      retryDelayMs: 500,
      sessionId: SESSION,
      sourceRange: SOURCE,
      turnId: "turn-1",
      viewCursor: "v:s:2",
    },
  };
  const page: readonly ViewEvent[] = [
    turnStarted("turn-1", "cmd-1", "v:s:1"),
    retry,
    turnCompleted("turn-1", "cancelled", "v:s:3"),
    turnRetracted("turn-1", "cmd-1", "v:s:4"),
  ];
  for (const event of page) fold.apply(event);
  assert.equal(fold.turn("turn-1")?.retryScheduled, undefined, "in-order delivery is clean");

  // `turn/retryScheduled` is a turn frame too, so it takes the same redelivery
  // guard as the others. Without it, a reconnect replay re-plants the hint on
  // the retracted turn — and `#turnCompleted`'s clear can no longer undo that,
  // because the replayed completion is itself dropped. The turn would show
  // "retrying in Ns" forever.
  for (const event of page) fold.apply(event);

  assert.equal(fold.turn("turn-1")?.state, "retracted");
  assert.equal(fold.turn("turn-1")?.retryScheduled, undefined, "the replayed hint is dropped");
  assert.deepEqual(fold.apply(retry), {
    kind: "ignoredStaleFrame",
    method: "turn/retryScheduled",
    id: "turn-1",
  });
});

test("turns are listed in first-observed order", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  fold.apply(turnCompleted("turn-1", "completed", "v:s:2"));
  fold.apply(turnUnqueued("turn-3", "cmd-3", "v:s:3"));
  fold.apply(turnStarted("turn-2", "cmd-2", "v:s:4"));

  assert.deepEqual(
    fold.turns().map((t) => t.turnId),
    ["turn-1", "turn-3", "turn-2"],
  );
});

// ---- approvals as fold inputs --------------------------------------------

test("approval/requested adds a pending approval", () => {
  const fold = new SessionFold();
  fold.apply(approvalRequested("a-1", "v:s:1"));

  assert.deepEqual(
    fold.pendingApprovals().map((a) => a.approvalId),
    ["a-1"],
  );
  assert.equal(fold.pendingApprovals()[0]?.requested.toolName, "shell");
});

test("a re-requested approval refreshes to the SECOND payload without duplicating", () => {
  const fold = new SessionFold();
  fold.apply(approvalRequested("a-1", "v:s:1", "ls"));
  // An `approval/updated` between the two requests is the case that separates
  // "replace the entry" from "replace only `requested`": a re-issued request
  // already embodies the latest refresh (tdd SS5.6.3), so keeping the OLD
  // update would pair a new subject with stale stage/choices — and a decide
  // against those bounces -32053.
  const update: ApprovalUpdatedParams = {
    approvalId: "a-1",
    availableChoices: [],
    change: { kind: "stageAdvanced" },
    currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
    sessionId: SESSION,
    sourceRange: SOURCE,
    subject: { kind: "shell", command: "ls" },
    viewCursor: "v:s:1b",
  };
  fold.apply({ method: "approval/updated", params: update });
  assert.ok(fold.pendingApprovals()[0]?.latestUpdate, "the update landed on the first request");

  // A redelivered request for a STILL-PENDING approval must refresh the held
  // payload: a renderer keeps showing the old subject/choices otherwise.
  const second = approvalRequested("a-1", "v:s:2", "rm -rf /tmp/x");
  fold.apply(second);

  const pending = fold.pendingApprovals();
  assert.equal(pending.length, 1, "a re-request never duplicates the entry");
  assert.deepEqual(pending[0]?.requested, second.params, "the WHOLE second payload is held");
  assert.equal(
    pending[0]?.latestUpdate,
    undefined,
    "the re-request replaces the entry: no stale refresh survives it",
  );
});

test("a re-requested prompt refreshes to the SECOND payload without duplicating", () => {
  const fold = new SessionFold();
  const first = userInputRequested("u-1", "v:s:1");
  fold.apply(first);
  // The user-input mirror of the approval refresh rule. It matters on resume,
  // where the host re-issues a still-pending prompt: a first-request-wins fold
  // would keep showing the stale first payload, and every same-id double
  // request elsewhere in this file settles in between, so nothing else here
  // exercises the refresh.
  const second = userInputRequested("u-1", "v:s:2");
  const outcome = fold.apply(second);

  assert.deepEqual(outcome, { kind: "userInputPending", userInputId: "u-1" });
  const pending = fold.pendingUserInputs();
  assert.equal(pending.length, 1, "a re-request never duplicates the entry");
  assert.deepEqual(pending[0], second.params, "the SECOND payload is the one held");
  assert.notDeepEqual(pending[0], first.params, "the first payload was replaced, not kept");
});

test("approval/updated refreshes the pending view in place and keeps it pending", () => {
  const fold = new SessionFold();
  fold.apply(approvalRequested("a-1", "v:s:1"));
  const params: ApprovalUpdatedParams = {
    approvalId: "a-1",
    availableChoices: [],
    change: { kind: "stageAdvanced" },
    currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
    sessionId: SESSION,
    sourceRange: SOURCE,
    subject: { kind: "shell", command: "ls -la" },
    viewCursor: "v:s:2",
  };
  fold.apply({ method: "approval/updated", params });

  const pending = fold.pendingApprovals();
  assert.equal(pending.length, 1, "an update never duplicates the entry");
  assert.equal(pending[0]?.latestUpdate?.currentRequirementId.sourceIndex, 1);
  assert.equal(fold.resolvedApprovals().length, 0, "an update is not a resolution");
});

test("approval/updated for an approval never requested is tolerated", () => {
  const fold = new SessionFold();
  const params: ApprovalUpdatedParams = {
    approvalId: "a-ghost",
    availableChoices: [],
    change: { kind: "stageAdvanced" },
    currentRequirementId: { approvalId: "a-ghost", sourceIndex: 0 },
    sessionId: SESSION,
    sourceRange: SOURCE,
    subject: { kind: "shell" },
    viewCursor: "v:s:1",
  };
  const outcome = fold.apply({ method: "approval/updated", params });

  assert.equal(fold.pendingApprovals().length, 0, "the fold never invents a request it did not see");
  // The outcome must be truthful: nothing is pending, so `approvalPending`
  // would make a renderer keyed on FoldOutcome show an approval the fold
  // does not hold (PR #23087 review round).
  assert.deepEqual(outcome, {
    kind: "ignoredStaleFrame",
    method: "approval/updated",
    id: "a-ghost",
  });
});

test("approval/updated after approval/resolved never resurrects the decision either", () => {
  const fold = new SessionFold();
  fold.apply(approvalRequested("a-1", "v:s:1"));
  fold.apply(approvalResolved("a-1", "approved", "v:s:2"));
  // The `approval/updated` mirror of the requested-after-resolved guard below.
  // This arm has no `#resolvedApprovals` check of its own — it relies on the
  // resolve having deleted the pending entry — so the first-terminal-wins
  // property is EMERGENT here, not stated, and nothing pinned it.
  //
  // It is also the exact frame issue #23379 is about: a post-terminal update
  // carrying a FAILED `policyPersistence` report. Whoever implements that
  // surfacing will be editing this branch, and the obvious careless shape —
  // look the approval up in `#resolvedApprovals` and re-open it to hang the
  // fact on — silently re-pends a decided approval. This test is what stops
  // that landing green.
  const update: ApprovalUpdatedParams = {
    approvalId: "a-1",
    availableChoices: [],
    change: { kind: "stageAdvanced" },
    currentRequirementId: { approvalId: "a-1", sourceIndex: 1 },
    sessionId: SESSION,
    sourceRange: SOURCE,
    subject: { kind: "shell", command: "rm -rf /tmp/x" },
    viewCursor: "v:s:3",
  };
  const outcome = fold.apply({ method: "approval/updated", params: update });

  assert.deepEqual(outcome, {
    kind: "ignoredStaleFrame",
    method: "approval/updated",
    id: "a-1",
  });
  assert.equal(fold.pendingApprovals().length, 0, "a decided approval is never re-opened");
  assert.deepEqual(
    fold.resolvedApprovals().map((r) => r.decision),
    ["approved"],
    "the durable terminal is untouched (tdd SS5)",
  );
});

test("approval/requested after approval/resolved never resurrects the decision", () => {
  const fold = new SessionFold();
  fold.apply(approvalRequested("a-1", "v:s:1"));
  fold.apply(approvalResolved("a-1", "approved", "v:s:2"));
  // A redelivered or pre-join `approval/requested` frame for an approval that
  // already has its durable terminal: re-opening it would show a decision
  // prompt for something already decided, and it would pend forever.
  const outcome = fold.apply(approvalRequested("a-1", "v:s:3"));

  assert.deepEqual(outcome, {
    kind: "ignoredStaleFrame",
    method: "approval/requested",
    id: "a-1",
  });
  assert.equal(fold.pendingApprovals().length, 0, "the decided approval stays decided");
  assert.deepEqual(
    fold.resolvedApprovals().map((r) => r.decision),
    ["approved"],
  );
});

test("userInput/requested after userInput/settled never resurrects the prompt", () => {
  const fold = new SessionFold();
  fold.apply(userInputRequested("u-1", "v:s:1"));
  fold.apply(userInputSettled("u-1", "answered", "v:s:2"));
  const outcome = fold.apply(userInputRequested("u-1", "v:s:3"));

  assert.deepEqual(outcome, {
    kind: "ignoredStaleFrame",
    method: "userInput/requested",
    id: "u-1",
  });
  assert.equal(fold.pendingUserInputs().length, 0, "the settled prompt stays settled");
  assert.deepEqual(
    fold.settledUserInputs().map((s) => s.outcome),
    ["answered"],
  );
});

test("approval/resolved retires the pending approval and records the terminal", () => {
  const fold = new SessionFold();
  fold.apply(approvalRequested("a-1", "v:s:1"));
  fold.apply(approvalResolved("a-1", "approved", "v:s:2"));

  assert.equal(fold.pendingApprovals().length, 0);
  assert.deepEqual(
    fold.resolvedApprovals().map((r) => [r.approvalId, r.decision]),
    [["a-1", "approved"]],
  );
});

test("the FIRST durable approval terminal wins; a second never overwrites it", () => {
  const fold = new SessionFold();
  fold.apply(approvalRequested("a-1", "v:s:1"));
  fold.apply(approvalResolved("a-1", "approved", "v:s:2"));
  const second = fold.apply(approvalResolved("a-1", "denied", "v:s:3"));

  assert.deepEqual(second, { kind: "approvalResolved", approvalId: "a-1", firstTerminal: false });
  assert.deepEqual(
    fold.resolvedApprovals().map((r) => r.decision),
    ["approved"],
    "the first durable terminal decision is the one that stands (tdd SS5)",
  );
});

test("approval/resolved with no prior request still records the terminal", () => {
  const fold = new SessionFold();
  const outcome = fold.apply(approvalResolved("a-7", "denied", "v:s:1"));

  assert.deepEqual(outcome, { kind: "approvalResolved", approvalId: "a-7", firstTerminal: true });
  assert.equal(fold.resolvedApprovals().length, 1);
});

// ---- user input as fold inputs -------------------------------------------

test("userInput/requested adds a pending prompt and settled retires it", () => {
  const fold = new SessionFold();
  const requested = userInputRequested("u-1", "v:s:1");
  fold.apply(requested);
  assert.deepEqual(
    fold.pendingUserInputs().map((u) => u.userInputId),
    ["u-1"],
  );
  // The pending entry IS the generated request params — the wire shape already
  // carries `userInputId`, so no wrapper duplicates it (PR #23087 review round).
  assert.deepEqual(fold.pendingUserInputs()[0], requested.params);

  fold.apply(userInputSettled("u-1", "answered", "v:s:2"));
  assert.equal(fold.pendingUserInputs().length, 0);
  assert.deepEqual(
    fold.settledUserInputs().map((s) => [s.userInputId, s.outcome]),
    [["u-1", "answered"]],
  );
});

test("the FIRST user-input settlement wins; a second never overwrites it", () => {
  const fold = new SessionFold();
  fold.apply(userInputRequested("u-1", "v:s:1"));
  fold.apply(userInputSettled("u-1", "answered", "v:s:2"));
  const second = fold.apply(userInputSettled("u-1", "cancelled", "v:s:3"));

  assert.deepEqual(second, { kind: "userInputSettled", userInputId: "u-1", firstSettlement: false });
  assert.deepEqual(
    fold.settledUserInputs().map((s) => s.outcome),
    ["answered"],
  );
});

test("userInput/settled with no prior request still records the settlement", () => {
  const fold = new SessionFold();
  // The user-input mirror of the cold `approval/resolved` test. A fold that
  // dropped a pre-join settlement would lose it from `settledUserInputs()` AND
  // disarm the requested-after-settled guard, so a redelivered request would
  // re-open a prompt that already settled — pending forever.
  const outcome = fold.apply(userInputSettled("u-7", "cancelled", "v:s:1"));

  assert.deepEqual(outcome, { kind: "userInputSettled", userInputId: "u-7", firstSettlement: true });
  assert.deepEqual(
    fold.settledUserInputs().map((s) => [s.userInputId, s.outcome]),
    [["u-7", "cancelled"]],
  );

  const resurrect = fold.apply(userInputRequested("u-7", "v:s:2"));
  assert.deepEqual(resurrect, {
    kind: "ignoredStaleFrame",
    method: "userInput/requested",
    id: "u-7",
  });
  assert.equal(fold.pendingUserInputs().length, 0, "the settled prompt stays settled");
});

test("pending approvals and prompts list in first-observed order", () => {
  const fold = new SessionFold();
  fold.apply(approvalRequested("a-2", "v:s:1"));
  fold.apply(approvalRequested("a-1", "v:s:2"));
  fold.apply(userInputRequested("u-9", "v:s:3"));
  fold.apply(userInputRequested("u-4", "v:s:4"));

  assert.deepEqual(fold.pendingApprovals().map((a) => a.approvalId), ["a-2", "a-1"]);
  assert.deepEqual(fold.pendingUserInputs().map((u) => u.userInputId), ["u-9", "u-4"]);
});

// ---- the two-store composition, bound to the generated types --------------

test("item events fold into the ItemStore bound to the generated Item", () => {
  const fold = new SessionFold();
  const started: ItemStartedParams = {
    item: item("i-1", 1),
    sessionId: SESSION,
    viewCursor: "v:s:1",
  };
  fold.apply({ method: "item/started", params: started });

  const delta: ItemDeltaParams = {
    delta: "hello ",
    itemId: "i-1",
    sessionId: SESSION,
    viewCursor: "v:s:2",
  };
  fold.apply({ method: "item/delta", params: delta });
  // ANNOTATED, like every other event here: an unannotated inline literal
  // resolves to the wide `{ method, params: unknown }` overload and loses the
  // compile-time pin this file's header mandates (INV-001).
  const second: ItemDeltaParams = {
    delta: "world",
    itemId: "i-1",
    sessionId: SESSION,
    viewCursor: "v:s:3",
  };
  fold.apply({ method: "item/delta", params: second });

  assert.equal(fold.items.accumulated("i-1", "text"), "hello world");

  // The wire really sends deltas for non-default fields ("output",
  // "summary.0" — tdd SS4.3.1); the fold must route `params.field` through,
  // not pile every delta into `text`. This is the ONLY `field`-routing
  // coverage, so it must bind to the typed overload: unannotated, a typo like
  // `itemIdd` would keep `tsc --build` at exit 0 and only fail at runtime.
  const outputDelta: ItemDeltaParams = {
    delta: "tool bytes",
    field: "output",
    itemId: "i-1",
    sessionId: SESSION,
    viewCursor: "v:s:3b",
  };
  fold.apply({ method: "item/delta", params: outputDelta });
  assert.equal(fold.items.accumulated("i-1", "output"), "tool bytes");
  assert.equal(fold.items.accumulated("i-1", "text"), "hello world", "text is untouched");

  const completed: ItemCompletedParams = {
    item: item("i-1", 2, { status: "completed", text: "hello world" }),
    sessionId: SESSION,
    sourceRange: SOURCE,
    viewCursor: "v:s:4",
  };
  fold.apply({ method: "item/completed", params: completed });

  assert.equal(fold.items.get("i-1")?.status, "completed");
  assert.equal(fold.items.get("i-1")?.revision, 2);
});

test("session-state events fold into the store keyed by their method name", () => {
  const fold = new SessionFold();
  const model: SessionModelChangedParams = {
    modelId: "muse-large",
    sessionId: SESSION,
    source: "user",
    sourceRange: SOURCE,
    viewCursor: "v:s:1",
  };
  fold.apply({ method: "session/modelChanged", params: model });

  const goal: SessionGoalChangedParams = {
    sessionId: SESSION,
    sourceRange: SOURCE,
    viewCursor: "v:s:2",
  };
  fold.apply({ method: "session/goalChanged", params: goal });

  // NO CAST. `get` is generic in the family, so this is already typed as the
  // model family's params — the cast that used to be here was the tell that
  // the return was still the 7-way union (PR #23087 review round).
  assert.equal(fold.sessionState.get("session/modelChanged")?.modelId, "muse-large");
  assert.ok(
    fold.sessionState.has("session/goalChanged"),
    "an absent `goal` member is an explicit clear, and the family holds that fact (INV-005)",
  );
});

test("the fold passes viewCursor through, so a redelivered state frame is refused", () => {
  const fold = new SessionFold();
  const model: SessionModelChangedParams = {
    modelId: "muse-large",
    sessionId: SESSION,
    source: "user",
    sourceRange: SOURCE,
    viewCursor: "v:s:1",
  };
  const first = fold.apply({ method: "session/modelChanged", params: model });
  assert.deepEqual(first.kind, "sessionState");
  assert.equal(first.kind === "sessionState" && first.outcome.applied, true);

  // The SAME frame again: the store's exact-cursor replay refusal (INV-005) is
  // the whole reason `apply` hands `params.viewCursor` down. Dropping that
  // argument leaves every other assertion in this file green while a
  // redelivered session-state page silently re-applies and reports `applied`.
  const replay = fold.apply({ method: "session/modelChanged", params: model });
  assert.equal(replay.kind, "sessionState");
  assert.equal(
    replay.kind === "sessionState" && replay.outcome.applied,
    false,
    "an exact-cursor redelivery is refused, not re-applied",
  );
});

test("an unrecognized notification method folds without throwing (SS1.5.4)", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  // Additive evolution: a host newer than this SDK emits a method it has never
  // heard of. The wire is an external boundary, so this frame IS reachable —
  // and the wire's actual shape ({ method: string, params }) must typecheck
  // against `apply` WITHOUT a cast (PR #23087 review round): the tolerance
  // seam lives inside `apply`, not at every call site.
  const wireFrame: { readonly method: string; readonly params: unknown } = {
    method: "session/somethingNew",
    params: { sessionId: SESSION, viewCursor: "v:s:2" },
  };
  const outcome = fold.apply(wireFrame);

  assert.deepEqual(outcome, { kind: "ignoredUnrecognizedMethod", method: "session/somethingNew" });
  assert.equal(fold.activeTurnId, "turn-1", "the rest of the fold is untouched");
});

test("a real view/gap frame moves the fold's CURRENCY and no store (T032 flips D-24021-1's drop)", () => {
  // THE FLIP. D-24021-1 recorded the sanctioned drop —
  // `ignoredUnrecognizedMethod` — and named spec 14990 T032 as the lane that
  // must consciously reverse it when splice-fill recovery lands. This is that
  // reversal, and it is a re-aim rather than a deletion: the assertion still
  // pins exactly what a `view/gap` does to the fold, and it still reds if a
  // refactor makes the marker seed a store.
  //
  // What D-24021-1 said structurally is UNCHANGED and still asserted below:
  // the marker is not a view event, so it folds no item and no state family.
  // What changed is the SDK's answer: a frame this package fully recognizes
  // may not be reported as an unrecognized method, because that report is
  // SS1.5.4's tolerance verdict for a newer host's unknown method and a
  // consumer cannot tell the two apart.
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:0"));

  assert.deepEqual(
    fold.apply({
      method: "view/gap",
      params: { sessionId: SESSION, after: "v:s:1", next: "v:s:5" },
    }),
    { after: "v:s:1", kind: "deliveryGap", next: "v:s:5" },
  );
  assert.equal(fold.current, false, "FM-003: not current until the hole is filled");
  assert.deepEqual(fold.pendingGap, { after: "v:s:1", next: "v:s:5", sessionId: SESSION });
  assert.equal(fold.items.size, 0, "the marker seeds no item");
  assert.deepEqual(fold.sessionState.families(), [], "and no state family");
  assert.equal(fold.activeTurnId, "turn-1", "the rest of the fold is untouched");
});

test("consecutive gaps coalesce on the FIRST after; gapFilled clears only the target reached", () => {
  // The client mirror of the server's own D-16487-1 bracket rule. Replacing
  // `after` with the newer gap's would move the lower bound past events that
  // were never delivered, so a walk from there would skip them permanently.
  const fold = new SessionFold();
  fold.apply({ method: "view/gap", params: { after: "v:s:1", next: "v:s:5", sessionId: SESSION } });
  fold.apply({ method: "view/gap", params: { after: "v:s:6", next: "v:s:9", sessionId: SESSION } });
  assert.deepEqual(fold.pendingGap, { after: "v:s:1", next: "v:s:9", sessionId: SESSION });

  // EQUALITY, never a relational compare (tdd SS4.1): filling the ORIGINAL
  // target clears nothing, because the second hole is still open.
  assert.equal(fold.gapFilled("v:s:5"), false);
  assert.equal(fold.current, false);
  assert.equal(fold.gapFilled("v:s:9"), true);
  assert.equal(fold.current, true);
  assert.equal(fold.pendingGap, undefined);
  // A repeat report of a hole already filled clears nothing and invents no gap.
  assert.equal(fold.gapFilled("v:s:9"), false);
  assert.equal(fold.current, true);
});

test("the generated Notification frame folds with no re-wrapping (the real wiring shape)", () => {
  const fold = new SessionFold();
  // This is EXACTLY the type `NotificationHandler` hands a consumer, and its
  // `params` is optional on the wire. If `apply`'s wide overload required
  // `params`, `fold.apply(notification)` would be a TS2769 and every wiring
  // site would have to re-wrap `{ method, params }` — the per-call-site
  // ceremony the overload exists to remove (PR #23087 review round).
  const notification: Notification = {
    jsonrpc: "2.0",
    method: "session/somethingNew",
    params: { sessionId: SESSION, viewCursor: "v:s:1" },
  };
  assert.deepEqual(fold.apply(notification), {
    kind: "ignoredUnrecognizedMethod",
    method: "session/somethingNew",
  });

  // The same frame with `params` genuinely absent — the wire omits it when
  // empty — must also fold rather than fail to typecheck.
  const bare: Notification = { jsonrpc: "2.0", method: "session/alsoNew" };
  assert.deepEqual(fold.apply(bare), {
    kind: "ignoredMissingParams",
    method: "session/alsoNew",
  });
});

test("a params-less frame for a KNOWN method is dropped, never thrown (SS1.5.4)", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));

  // Making `params` optional to admit the generated `Notification` also
  // admits this: a legal `Notification` for a method the fold DOES recognize,
  // with no params. Every recognized arm dereferences `params`, so an
  // unguarded `apply` throws `TypeError: Cannot read properties of undefined`
  // and takes out the consumer's notification pump — the opposite of the
  // drop-don't-throw posture the default arm exists to hold.
  const headless: Notification = { jsonrpc: "2.0", method: "turn/started" };
  const outcome = fold.apply(headless);

  assert.deepEqual(outcome, { kind: "ignoredMissingParams", method: "turn/started" });
  assert.equal(fold.activeTurnId, "turn-1", "the rest of the fold is untouched");
  assert.equal(fold.turns().length, 1, "no turn was minted from the params-less frame");
});

test("fold.items and fold.sessionState expose no mutators (snapshot-only, like the rest)", () => {
  const fold = new SessionFold();
  // Every mutation goes through `apply()`. A consumer reaching a store mutator
  // directly (e.g. `items.seed([])`) would desync the composite view: items
  // would clear while the turn/pending maps kept their entries, breaking
  // INV-002 replay equality. The narrowed surface makes that a compile error.
  // @ts-expect-error — `seed` is not on the fold's read-only items surface
  fold.items.seed;
  // @ts-expect-error — `apply` is not on the fold's read-only items surface
  fold.items.apply;
  // @ts-expect-error — `applyDelta` is not on the fold's read-only items surface
  fold.items.applyDelta;
  // @ts-expect-error — `markEphemeralHostDeath` is not on the fold's read-only items surface
  fold.items.markEphemeralHostDeath;
  // @ts-expect-error — `apply` is not on the fold's read-only session-state surface
  fold.sessionState.apply;
  // @ts-expect-error — `seed` is not on the fold's read-only session-state surface
  fold.sessionState.seed;

  // The read half stays fully usable.
  assert.equal(fold.items.size, 0);
  assert.equal(fold.sessionState.families().length, 0);
});

test("a wrong-family read is a compile error, not a silent wrong shape", () => {
  const fold = new SessionFold();
  const model: SessionModelChangedParams = {
    modelId: "muse-large",
    sessionId: SESSION,
    source: "user",
    sourceRange: SOURCE,
    viewCursor: "v:s:1",
  };
  fold.apply({ method: "session/modelChanged", params: model });

  // The family key narrowing closed the ARGUMENT side; this closes the return
  // side. While `get` returned the 7-way union, reading one family as another
  // was a legal narrowing cast and silently produced the wrong shape.
  // @ts-expect-error — `totalTokens` is the tokenUsage family, not modelChanged
  fold.sessionState.get("session/modelChanged")?.totalTokens;
  // @ts-expect-error — `modelId` is not on the goal family
  fold.sessionState.get("session/goalChanged")?.modelId;

  assert.equal(fold.sessionState.get("session/modelChanged")?.modelId, "muse-large");
});

test("snapshot getters are deep-readonly: a field write is a compile error", () => {
  const fold = new SessionFold();
  fold.apply(turnStarted("turn-1", "cmd-1", "v:s:1"));
  fold.apply(userInputRequested("u-1", "v:s:2"));
  fold.apply(approvalRequested("a-1", "v:s:3"));
  const started: ItemStartedParams = {
    item: item("i-1", 5),
    sessionId: SESSION,
    viewCursor: "v:s:4",
  };
  fold.apply({ method: "item/started", params: started });

  // Read the true values FIRST. The probes below really do write — see the
  // note under them — so asserting after them would assert the corruption.
  assert.equal(fold.pendingUserInputs()[0]?.userInputId, "u-1");
  assert.equal(fold.turn("turn-1")?.state, "running");
  assert.equal(fold.items.get("i-1")?.revision, 5);

  // Hiding the store MUTATORS was only half the seal. These accessors hand
  // back the fold's own stored objects and the generated wire types carry no
  // `readonly`, so each of these writes used to typecheck AND STICK — the
  // item one defeats the INV-003 revision guard outright, and all of them
  // break INV-002 replay equality through the read surface.
  // @ts-expect-error — pendingUserInputs() elements are deep-readonly
  fold.pendingUserInputs()[0]!.userInputId = "hijacked";
  // @ts-expect-error — pendingApprovals() entries are deep-readonly, nested included
  fold.pendingApprovals()[0]!.requested.toolName = "hijacked";
  // @ts-expect-error — turn entries are deep-readonly
  fold.turn("turn-1")!.state = "settled";
  // @ts-expect-error — items are deep-readonly: this one defeated the revision guard
  fold.items.get("i-1")!.revision = 0;
  // @ts-expect-error — list() elements too, not just get()
  fold.items.list()[0]!.status = "completed";

  // AND THE HONEST PART: `readonly` is erased at runtime, so every write above
  // DID land. This test's first draft asserted the values were untouched and
  // failed on exactly that. The seal is a compile-time one — it stops a
  // consumer writing this by accident, which is the whole realistic hazard;
  // it is not a runtime freeze, and the doc comment on `DeepReadonly` says so
  // rather than implying a guarantee the type cannot make.
  assert.equal(fold.pendingUserInputs()[0]?.userInputId, "hijacked");
  assert.equal(fold.items.get("i-1")?.revision, 0);
});

test("the items surface is an ALLOWLIST: it cannot fail open as the store grows", () => {
  // `Omit` never checks its keys against the type, so a renamed mutator
  // (`seed` -> `reseed`) re-appears under the new name and any mutator added
  // to `ItemStore` later lands on this exported surface silently. `Pick`
  // constrains its keys to `keyof ItemStore`, so a rename is a compile error
  // at the definition and a new member simply never enters. This pins the
  // resulting key set so widening it is a deliberate edit, not a side effect.
  type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
  const itemKeysArePinned: Exactly<
    keyof FoldItems,
    | "accumulated"
    | "accumulatedFields"
    | "ephemeralSessionDiscarded"
    | "get"
    | "has"
    | "isTerminalUnknown"
    | "lastOpenedItemId"
    | "list"
    | "size"
  > = true;
  assert.equal(itemKeysArePinned, true);
});

test("the session-state surface names its family keys, so a typo is a compile error", () => {
  const fold = new SessionFold();
  // The store's own `get`/`has` take a bare `string`, so
  // `get("session/modelchanged")` would typecheck and silently read
  // `undefined`. The family key IS protocol vocabulary — narrow it while this
  // surface is new, because narrowing after #210/#211 consume it is a break.
  // @ts-expect-error — lowercase `c`: not a `session/*` notification method
  fold.sessionState.get("session/modelchanged");
  // @ts-expect-error — a real method, but not a session-state family
  fold.sessionState.has("turn/started");

  const family: SessionStateMethod = "session/tokenUsage";
  assert.equal(fold.sessionState.has(family), false);

  // The interface must round-trip with ITSELF: the obvious consumer loop over
  // `families()` has to feed `get`/`has` without a cast, or the parameter
  // narrowing just relocates the bare-string cast it exists to forbid.
  const model: SessionModelChangedParams = {
    modelId: "muse-large",
    sessionId: SESSION,
    source: "user",
    sourceRange: SOURCE,
    viewCursor: "v:s:1",
  };
  fold.apply({ method: "session/modelChanged", params: model });

  const seen: SessionStateMethod[] = [];
  for (const f of fold.sessionState.families()) {
    assert.ok(fold.sessionState.has(f));
    assert.ok(fold.sessionState.get(f) !== undefined);
    seen.push(f);
  }
  assert.deepEqual(seen, ["session/modelChanged"]);
});

test("every ViewEvent method routes to its own arm, never the default (mutation guard)", () => {
  // One event per generated method, tsc-forced complete: a dropped switch arm
  // is invisible to the compile-time Exclude pin (the default arm swallows the
  // event), so this table is the runtime guard that kills that mutant class.
  const itemUpdated: ItemUpdatedParams = {
    item: item("i-t", 2),
    sessionId: SESSION,
    sourceRange: SOURCE,
    viewCursor: "v:t:2",
  };
  const itemCompleted: ItemCompletedParams = {
    item: item("i-t", 3, { status: "completed" }),
    sessionId: SESSION,
    sourceRange: SOURCE,
    viewCursor: "v:t:3",
  };
  const retrySched: TurnRetryScheduledParams = {
    attempt: 1,
    maxAttempts: 3,
    nextAttempt: 2,
    reason: "overloaded",
    retryDelayMs: 500,
    sessionId: SESSION,
    sourceRange: SOURCE,
    turnId: "turn-t3",
    viewCursor: "v:t:8",
  };
  const approvalUpdated: ApprovalUpdatedParams = {
    approvalId: "a-t",
    availableChoices: [],
    change: { kind: "stageAdvanced" },
    currentRequirementId: { approvalId: "a-t", sourceIndex: 1 },
    sessionId: SESSION,
    sourceRange: SOURCE,
    subject: { kind: "shell" },
    viewCursor: "v:t:10",
  };
  const model: SessionModelChangedParams = {
    modelId: "muse-large",
    sessionId: SESSION,
    source: "user",
    sourceRange: SOURCE,
    viewCursor: "v:t:14",
  };
  const goal: SessionGoalChangedParams = {
    sessionId: SESSION,
    sourceRange: SOURCE,
    viewCursor: "v:t:15",
  };
  const todo: SessionTodoListChangedParams = {
    items: [{ status: "pending", text: "one" }],
    revision: 1,
    sessionId: SESSION,
    sourceRange: SOURCE,
    sourceTool: "todo",
    viewCursor: "v:t:16",
  };
  const branch: SessionBranchChangedParams = {
    branch: "main",
    sessionId: SESSION,
    sourceRange: SOURCE,
    viewCursor: "v:t:17",
    workspaceRoot: "/w",
  };
  const tokens: SessionTokenUsageParams = {
    cumulative: { outputTokens: 1, promptTokens: 1, totalTokens: 2 },
    promptTokens: 1,
    sessionId: SESSION,
    sourceRange: SOURCE,
    totalTokens: 2,
    turnId: "turn-t",
    usage: { cachedTokens: 0, inputTokens: 1, outputTokens: 1, reasoningTokens: 0 },
    viewCursor: "v:t:18",
  };
  const context: SessionContextUsageParams = {
    pressure: "normal",
    sessionId: SESSION,
    sourceRange: SOURCE,
    usedTokens: 10,
    viewCursor: "v:t:19",
  };
  const approvalMode: SessionApprovalModeChangedParams = {
    clientName: "sdk-test",
    commandId: "cmd-t",
    mode: "onRequest",
    sessionId: SESSION,
    source: "startup",
    sourceRange: SOURCE,
    viewCursor: "v:t:20",
  };
  const started: ItemStartedParams = {
    item: item("i-t", 1),
    sessionId: SESSION,
    viewCursor: "v:t:1",
  };
  const byMethod: Record<ViewEvent["method"], ViewEvent> = {
    "item/started": { method: "item/started", params: started },
    "item/updated": { method: "item/updated", params: itemUpdated },
    "item/completed": { method: "item/completed", params: itemCompleted },
    "item/delta": {
      method: "item/delta",
      params: { delta: "d", itemId: "i-t", sessionId: SESSION, viewCursor: "v:t:4" },
    },
    "turn/started": turnStarted("turn-t", "cmd-t", "v:t:5"),
    "turn/completed": turnCompleted("turn-t", "completed", "v:t:6"),
    "turn/retracted": turnRetracted("turn-t2", "cmd-t2", "v:t:7"),
    "turn/retryScheduled": { method: "turn/retryScheduled", params: retrySched },
    "turn/unqueued": turnUnqueued("turn-t4", "cmd-t4", "v:t:9"),
    "approval/requested": approvalRequested("a-t", "v:t:10"),
    "approval/updated": { method: "approval/updated", params: approvalUpdated },
    "approval/resolved": approvalResolved("a-t", "approved", "v:t:11"),
    "userInput/requested": userInputRequested("u-t", "v:t:12"),
    "userInput/settled": userInputSettled("u-t", "answered", "v:t:13"),
    "session/modelChanged": { method: "session/modelChanged", params: model },
    "session/goalChanged": { method: "session/goalChanged", params: goal },
    "session/todoListChanged": { method: "session/todoListChanged", params: todo },
    "session/branchChanged": { method: "session/branchChanged", params: branch },
    "session/tokenUsage": { method: "session/tokenUsage", params: tokens },
    "session/contextUsage": { method: "session/contextUsage", params: context },
    "session/approvalModeChanged": { method: "session/approvalModeChanged", params: approvalMode },
    // The delivery marker is a routed arm since T032 (FR-020): it changes no
    // store, but it MUST NOT reach the `ignoredUnrecognizedMethod` default —
    // that report is reserved for a newer host's genuinely unknown method.
    "view/gap": {
      method: "view/gap",
      params: { after: "v:t:20", next: "v:t:22", sessionId: SESSION },
    },
  };

  const fold = new SessionFold();
  for (const [method, event] of Object.entries(byMethod)) {
    const outcome = fold.apply(event);
    assert.notEqual(
      outcome.kind,
      "ignoredUnrecognizedMethod",
      `\`${method}\` must route to its own arm, not fall through to the default`,
    );
    assert.notEqual(
      outcome.kind,
      "ignoredStaleFrame",
      `\`${method}\` with a fresh id must be consumed, not dropped as stale`,
    );
  }
});

test("the whole fold is deterministic over the same sequence (INV-002)", () => {
  const sequence: ViewEvent[] = [
    turnStarted("turn-1", "cmd-1", "v:s:1"),
    approvalRequested("a-1", "v:s:2"),
    userInputRequested("u-1", "v:s:3"),
    approvalResolved("a-1", "approved", "v:s:4"),
    userInputSettled("u-1", "answered", "v:s:5"),
    turnCompleted("turn-1", "completed", "v:s:6"),
    turnUnqueued("turn-2", "cmd-2", "v:s:7"),
  ];

  const run = (): string => {
    const fold = new SessionFold();
    for (const event of sequence) fold.apply(event);
    return JSON.stringify({
      turns: fold.turns(),
      pendingApprovals: fold.pendingApprovals(),
      resolvedApprovals: fold.resolvedApprovals(),
      pendingUserInputs: fold.pendingUserInputs(),
      settledUserInputs: fold.settledUserInputs(),
    });
  };

  assert.equal(run(), run());
});
