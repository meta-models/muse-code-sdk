/**
 * QA-TEST-015 — verdicts are EARNED (#23111).
 *
 * Three arms where the harness previously reported a verdict it did not earn:
 * D19764's regression guard passed without checking the `session/read` it
 * issued; B04/B07 reported `expected-block` while their subject calls died at
 * `invalidParams` before reaching any turn-dependent behaviour; and the run
 * report could not identify the binary it tested (it printed the RESOLUTION
 * SOURCE — the env var name — as the "host version").
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  D19764_COMMAND_TEXT,
  D19764_EXPECTED,
  D19778_EXPECTED,
  MUSE_QA_SDK_BIN,
  RecordedHost,
  blockedRunEvidence,
  blockedVerdictOf,
  blockerStillBites,
  errorKindOfRun,
  foldBlockedEvidence,
  observeD19764,
  observeD19778,
  rejectionReasonOfRun,
  renderReportMarkdown,
  runSdkQa,
  scenarioWorkDir,
  subjectStepsOf,
} from "../qa/index.js";

const SCRIPTED_HOST = fileURLToPath(new URL("./helpers/qa-scripted-host.js", import.meta.url));
import type { ApiObservation, ObservedRun, QaScenario, WireLog } from "../qa/index.js";

/** Observable-level arms never read the wire; an empty log keeps them honest. */
const EMPTY_WIRE: WireLog = {
  frames: [],
  outbound: [],
  inbound: [],
  trailing: { clientToHost: "", hostToClient: "" },
};

const grantedInitialize: ApiObservation = {
  kind: "initializeResult",
  result: { grantedCapabilities: ["userShell"] },
  fingerprintWarning: null,
};

/** The reporter's exact empty-read shape from the #23111 tap capture. */
const emptyRead = (items: readonly Record<string, unknown>[]): ApiObservation => ({
  kind: "requestOk",
  step: "read",
  method: "session/read",
  result: {
    history: { items: [...items], mode: "inline", snapshot: null },
    pendingRequests: [],
    session: {},
    viewCursor: "v:01a03b98-f4e7-7af0-9d07-aac980dc0ba5:1",
  },
});

const shellOk: ApiObservation = {
  kind: "requestOk",
  step: "shell",
  method: "session/userShell",
  result: { commandId: "018f7294-0000-7000-8000-000000000001", status: "accepted" },
};

const shellItem: Record<string, unknown> = {
  kind: "userShell",
  commandText: D19764_COMMAND_TEXT,
  exitCode: 0,
  status: "completed",
  visibleOutput: "R371_CLEAN_MSP_USER_SHELL",
  itemId: "018f7294-0000-7000-8000-000000000002",
  turnId: null,
};

test("QA-TEST-015a: D19764's guard is not satisfied by an EMPTY session/read", () => {
  const run: ObservedRun = {
    api: [grantedInitialize, shellOk, emptyRead([])],
    wire: EMPTY_WIRE,
    requestedMethods: ["session/userShell", "session/read"],
  };
  // Setup: the grant and the ack are exactly the pre-#23111 observable — the
  // two facts the guard used to rest its whole verdict on.
  assert.match(observeD19764(run), /^granted:userShell\|shell:accepted/);
  // Target: an empty read must NOT satisfy the guard whose title is "its item
  // survives `session/read`" — this is the unearned pass from the #23111 tap.
  assert.notEqual(
    observeD19764(run),
    D19764_EXPECTED,
    "the guard passed while history.items was [] — the read it issued was never consulted",
  );
});

test("QA-TEST-015a (control): a read carrying the userShell item DOES satisfy the guard", () => {
  const run: ObservedRun = {
    api: [grantedInitialize, shellOk, emptyRead([shellItem])],
    wire: EMPTY_WIRE,
    requestedMethods: ["session/userShell", "session/read"],
  };
  assert.equal(observeD19764(run), D19764_EXPECTED);
});

test("QA-TEST-015a: a read carrying SOMEONE ELSE'S item does not satisfy the guard", () => {
  // Between the two extremes above sits the partial read this guard exists to
  // catch: history came back non-empty, but D19764's own item is not in it.
  // Without this case an `items.length > 0` predicate passes the whole suite.
  const run: ObservedRun = {
    api: [
      grantedInitialize,
      shellOk,
      emptyRead([{ ...shellItem, commandText: "printf SOMETHING_ELSE" }]),
    ],
    wire: EMPTY_WIRE,
    requestedMethods: ["session/userShell", "session/read"],
  };
  assert.notEqual(
    observeD19764(run),
    D19764_EXPECTED,
    "a read that dropped D19764's own item is the partial staleness the guard is for",
  );
});

const credentialDeath: ApiObservation = {
  kind: "notification",
  method: "turn/completed",
  params: { terminal: "failed", reason: "not logged in" },
};

/** The exact #23111 B04 shape: subject dead at params, turn dead on credentials. */
const rejectedSubjectRun: ObservedRun = {
  api: [
    grantedInitialize,
    { kind: "requestOk", step: "start", method: "session/start", result: {} },
    { kind: "requestOk", step: "turn", method: "turn/start", result: {} },
    {
      kind: "requestError",
      step: "steer",
      method: "turn/steer",
      error: {
        name: "MspError",
        message: "invalid turn/steer params: missing field `expectedTurnId`",
        code: -32602,
        kind: "invalidParams",
      },
    },
    credentialDeath,
  ],
  wire: EMPTY_WIRE,
  requestedMethods: ["session/start", "turn/start", "turn/steer"],
};

/** The same drive, well-formed: only the pinned credential failure killed it. */
const credentialDeathOnlyRun: ObservedRun = {
  api: [
    grantedInitialize,
    { kind: "requestOk", step: "start", method: "session/start", result: {} },
    { kind: "requestOk", step: "turn", method: "turn/start", result: {} },
    { kind: "requestOk", step: "steer", method: "turn/steer", result: {} },
    credentialDeath,
  ],
  wire: EMPTY_WIRE,
  requestedMethods: ["session/start", "turn/start", "turn/steer"],
};

/** The same drive once #19535 lifts: the turn actually ran to a clean terminal. */
const liftedRun: ObservedRun = {
  ...credentialDeathOnlyRun,
  api: [
    ...credentialDeathOnlyRun.api.slice(0, -1),
    {
      kind: "notification",
      method: "turn/completed",
      params: { terminal: "completed", reason: "completed" },
    },
  ],
};

test("QA-TEST-015b: a subject rejected as invalidParams has NOT proven its blocker bites", () => {
  const run = rejectedSubjectRun;
  // Setup: the turn independently died on the pinned credential failure, and
  // the subject settled invalidParams — the exact #23111 B04 shape.
  assert.equal(blockerStillBites(run), true, "the credential death alone still reads as biting");
  assert.equal(errorKindOfRun(run, "steer"), "invalidParams");
  // Target: traffic that never reached turn-dependent behaviour must not be
  // read as the blocker biting.
  const evidence = blockedRunEvidence(run);
  assert.ok(
    typeof evidence === "object" && "rejected" in evidence,
    `a subject call the host rejected as malformed proves nothing about the blocker (got ${JSON.stringify(evidence)})`,
  );
});

test("QA-TEST-015b: a `methodNotFound` subject has not proven its blocker bites either", () => {
  // `methodNotFound` dies EARLIER than `invalidParams` — at dispatch, before
  // any handler runs — and it is reachable on these very subjects: the
  // registry answers it for any method the active profile withholds (FR-024).
  const run: ObservedRun = {
    api: [
      grantedInitialize,
      { kind: "requestOk", step: "start", method: "session/start", result: {} },
      { kind: "requestOk", step: "turn", method: "turn/start", result: {} },
      {
        kind: "requestError",
        step: "readDuringTurn",
        method: "session/read",
        error: {
          name: "MspError",
          message: "method `session/read` is not available in this profile",
          code: -32601,
          kind: "methodNotFound",
        },
      },
      credentialDeath,
    ],
    wire: EMPTY_WIRE,
    requestedMethods: ["session/start", "turn/start", "session/read"],
  };
  assert.equal(blockerStillBites(run), true, "the credential death alone still reads as biting");
  const evidence = blockedRunEvidence(run);
  assert.ok(
    typeof evidence === "object" && "rejected" in evidence,
    `a subject the host never dispatched proves nothing about the blocker (got ${JSON.stringify(evidence)})`,
  );
  assert.match((evidence as { rejected: string }).rejected, /subject `readDuringTurn`/);
});

test("QA-TEST-015b: a rejected SETUP call refuses the verdict too", () => {
  // The rejection is one call earlier than the subject: `turn/start` itself
  // dies at param validation, so no turn ever starts, zero `turn/completed`
  // frames read as "bites", and the pre-review scan — which looked only at
  // subject steps — earned `expected-block` on a run with no turn at all.
  const run: ObservedRun = {
    api: [
      grantedInitialize,
      { kind: "requestOk", step: "start", method: "session/start", result: {} },
      {
        kind: "requestError",
        step: "turn",
        method: "turn/start",
        error: {
          name: "MspError",
          message: "invalid turn/start params: missing field `input`",
          code: -32602,
          kind: "invalidParams",
        },
      },
    ],
    wire: EMPTY_WIRE,
    requestedMethods: ["session/start", "turn/start"],
  };
  assert.deepEqual(subjectStepsOf(run), [], "the run issued no subject call at all");
  assert.equal(blockerStillBites(run), true, "zero turn/completed frames read as biting");
  const evidence = blockedRunEvidence(run);
  assert.ok(
    typeof evidence === "object" && "rejected" in evidence,
    `a run whose turn never started proves nothing about the blocker (got ${JSON.stringify(evidence)})`,
  );
  assert.match((evidence as { rejected: string }).rejected, /setup call `turn`/);
});

test("QA-TEST-015b: the `lifted` arm reports lifted, not bites", () => {
  // The flip is the whole point of the expect-block set: the moment #19535
  // lifts, every B01-B07 run must stop reporting `expected-block`. Without
  // this control, `blockedRunEvidence` can return "bites" unconditionally and
  // the block-lifted flip (spec 14990 Scenario 6 acceptance 5) dies silently.
  assert.equal(blockerStillBites(liftedRun), false, "a turn that actually ran is the flip signal");
  assert.equal(blockedRunEvidence(liftedRun), "lifted");
});

test("QA-TEST-015b (subject derivation): the run itself names the subject steps", () => {
  // Derived from the captured run, so a hand-kept list cannot drift and hide a
  // rejection: the fixed setup steps are excluded, the subject remains.
  assert.deepEqual(subjectStepsOf(rejectedSubjectRun), ["steer"]);
  const noSubject: ObservedRun = {
    api: [
      grantedInitialize,
      { kind: "requestOk", step: "start", method: "session/start", result: {} },
      { kind: "requestOk", step: "turn", method: "turn/start", result: {} },
      credentialDeath,
    ],
    wire: EMPTY_WIRE,
    requestedMethods: ["session/start", "turn/start"],
  };
  assert.deepEqual(subjectStepsOf(noSubject), []);
});

test("QA-TEST-015b (scenario fold): rejected evidence refuses the verdict outright", () => {
  // The fold is what the blocked scenarios consult: a rejected subject yields
  // a REFUSAL, which runSdkQa maps to `blocked`, so the expected-block /
  // block-lifted pair is unreachable for a run that never reached the host.
  const refused = foldBlockedEvidence("B04", [
    "bites",
    { rejected: "subject `steer` settled `err:invalidParams` — never reached the host" },
  ]);
  assert.ok(refused.refused !== undefined, `a rejected run must refuse the verdict (got ${JSON.stringify(refused)})`);
  assert.match(refused.refused, /B04 was rejected before reaching #19535.*steer/);
  assert.deepEqual(foldBlockedEvidence("B04", ["bites", "bites"]), { bites: true }, "all-bites control");
  assert.deepEqual(foldBlockedEvidence("B04", ["bites", "lifted"]), { bites: false }, "any-lifted control");
});

test("QA-TEST-015b (composition): blockedVerdictOf runs derivation → evidence → fold", () => {
  // The one call the shipped scenario makes. Pinning the composition — not
  // just its three parts — is what fails when the call site is reverted to
  // the pre-#23111 `runs.every(blockerStillBites)`.
  const refused = blockedVerdictOf("B04", [rejectedSubjectRun]);
  assert.ok(
    refused.refused !== undefined,
    `the B04 capture from #23111 must refuse the verdict (got ${JSON.stringify(refused)})`,
  );
  assert.match(refused.refused, /subject `steer`/);
  // Controls: the same composition still yields both real verdicts.
  assert.deepEqual(blockedVerdictOf("B01", [credentialDeathOnlyRun]), { bites: true });
  assert.deepEqual(blockedVerdictOf("B01", [liftedRun]), { bites: false });
});

test("QA-TEST-015b (control): a well-formed subject with the credential death still bites", () => {
  const run: ObservedRun = {
    api: [
      grantedInitialize,
      { kind: "requestOk", step: "turn", method: "turn/start", result: {} },
      {
        kind: "requestError",
        step: "steer",
        method: "turn/steer",
        error: { name: "MspError", message: "no turn is running", kind: "conflict" },
      },
      credentialDeath,
    ],
    wire: EMPTY_WIRE,
    requestedMethods: ["turn/start", "turn/steer"],
  };
  assert.equal(blockedRunEvidence(run), "bites");
});

test("QA-TEST-015b (evidence): a refused expect-block still files its capture's findings", async () => {
  // The refusal is a VALUE, not a throw. A throw unwound past `runSdkQa`'s
  // oracle and returned `runs: []`, so every deviation the SAME capture
  // recorded vanished from both filing tracks — pre-PR it was filed (spec
  // 14990 Scenario 6 acceptance 1: the oracle runs over every driven run).
  const scenario: QaScenario = {
    id: "B04",
    title: "refused",
    vein: "turn lifecycle over stdio",
    expectBlocked: { blocker: "#19535", because: "no turn ever runs" },
    async run(): Promise<Awaited<ReturnType<QaScenario["run"]>>> {
      return {
        runs: [rejectedSubjectRun],
        observed: "o",
        expected: "e",
        blockedVerdict: { refused: "B04 was rejected before reaching #19535: subject `steer` …" },
      };
    },
  };
  const report = await runSdkQa({ museBin: "/unused", scenarios: [scenario] });
  const result = report.scenarios[0];
  assert.equal(result?.verdict, "blocked", "the #23111 verdict is unchanged by carrying the refusal");
  assert.match(result?.blockedBecause ?? "", /rejected before reaching #19535/);
  // Target: the capture's oracle findings survived the refusal and reached
  // the filing tracks the procedure consumes.
  assert.ok(
    (result?.findings.length ?? 0) > 0,
    "the oracle must still see the run the drive captured",
  );
  assert.equal(
    report.filing.bug.length + report.filing.specGap.length,
    result?.findings.length,
    "every surviving finding is routed to a filing track",
  );
});

test("QA-TEST-015c: the report identifies the tested binary from the handshake", async () => {
  const handshake: ApiObservation = {
    kind: "initializeResult",
    result: {
      serverInfo: { name: "muse", version: "0.3.0" },
      userAgent: "muse-build/0.3.0 (non-interactive; linux-x86_64; build cc9ad71fd28)",
    },
    fingerprintWarning: null,
  };
  const scenario: QaScenario = {
    id: "F01",
    title: "fake",
    vein: "fake",
    async run(): Promise<Awaited<ReturnType<QaScenario["run"]>>> {
      return {
        runs: [{ api: [handshake], wire: EMPTY_WIRE, requestedMethods: [] }],
        observed: "o",
        expected: "o",
      };
    },
  };
  const report = await runSdkQa({
    museBin: "/unused",
    resolvedVia: MUSE_QA_SDK_BIN,
    scenarios: [scenario],
  });
  // Target: the one field a reader checks to answer "which build was this?"
  // carries the host's own identity, not the name of the env var that was set.
  assert.match(report.binaryVersion, /0\.3\.0/, "the host version comes from the handshake");
  assert.match(report.binaryVersion, /cc9ad71fd28/, "the build id the wire already carries");
  const markdown = renderReportMarkdown(report);
  // And the two facts stay SEPARATE and both real: the rendered `resolved via`
  // line names the source it was given, not the `unknown` fallback. Asserting
  // only the words "resolved via" left the forwarding free to print anything.
  assert.match(
    markdown,
    /resolved via: `MUSE_QA_SDK_BIN`/,
    "the resolution source is reported AS a source, with the value the caller supplied",
  );
  assert.match(markdown, /host version: `muse 0\.3\.0 \(build cc9ad71fd28\)` — from the initialize handshake/);
});

// ---------------------------------------------------------------------------
// QA-TEST-016 — D19778 reads SS3.7 CLASSIFICATION, not "any error" (#19778
// 2026-09-02 reopen). The guard reported `defect-reproduced` against a binary
// whose `session/compact` classification is conformant, because its only
// probe landed on a no-run session — where tdd SS3.7's params note MANDATES
// the typed `commandRejected`/`missing_run` refusal — and its observable
// folded every `err:*` into the defect. Fixtures mirror the raw frames a
// current-main binary served on the reopen rig (echo provider, hermetic XDG).
// ---------------------------------------------------------------------------

const compactStartOk: ApiObservation = {
  kind: "requestOk",
  step: "start",
  method: "session/start",
  result: { session: { sessionId: "01a0609d-13ec-7cb3-b9c3-cafd54f4b57d" } },
};

/** tdd SS3.7 no-resolvable-run arm, verbatim from the reopen-rig capture. */
const compactMissingRun: ApiObservation = {
  kind: "requestError",
  step: "compact",
  method: "session/compact",
  error: {
    name: "MspError",
    message: "session/compact command 01a0609d-1461-7d98-9f38-40868d0a6440 rejected: missing_run",
    code: -32030,
    kind: "commandRejected",
    reason: "missing_run",
  },
};

/** The seeded #19778 defect signature — the OP's exact admission death. */
const compactInternal: ApiObservation = {
  kind: "requestError",
  step: "compact",
  method: "session/compact",
  error: {
    name: "MspError",
    message:
      "session/compact runtime admission failed: background task failed: retained Session runtime cannot persist manual compaction command facts",
    code: -32603,
    kind: "internal",
  },
};

/**
 * The post-turn settlement the reopen rig actually serves: echo composes no
 * context budget, so admission classifies `compaction_unavailable` — a typed
 * SS3.7 outcome the pre-#21244 binary could not reach (its durable rejection
 * append died `-32603 internal`, the OP's report).
 */
const afterTurnTyped: ApiObservation = {
  kind: "requestError",
  step: "compactAfterTurn",
  method: "session/compact",
  error: {
    name: "MspError",
    message:
      "session/compact command 01a0609d-1692-7aae-b6ca-8b62cc5a115d rejected: compaction_unavailable",
    code: -32030,
    kind: "commandRejected",
    reason: "compaction_unavailable",
  },
};

const afterTurnInternal: ApiObservation = {
  ...compactInternal,
  step: "compactAfterTurn",
};

/** The completed echo turn that arms the defect class's actual surface. */
const compactTurnOk: ApiObservation = {
  kind: "requestOk",
  step: "turn",
  method: "turn/start",
  result: {
    commandId: "01a0609d-1462-7eb2-b724-031d711ba755",
    status: "accepted",
    turnId: "01a0609d-1462-7eb2-b724-031d711ba755",
  },
};
const compactTurnCompleted: ApiObservation = {
  kind: "notification",
  method: "turn/completed",
  params: {
    sessionId: "01a0609d-13ec-7cb3-b9c3-cafd54f4b57d",
    terminal: "completed",
    turnId: "01a0609d-1462-7eb2-b724-031d711ba755",
  },
};

const compactRequested = ["session/start", "session/compact", "turn/start"];

test("QA-TEST-016a: SS3.7's mandated missing_run refusal on a no-run session is classification, not the defect", () => {
  const run: ObservedRun = {
    api: [compactStartOk, compactMissingRun, compactTurnOk, compactTurnCompleted, afterTurnTyped],
    wire: EMPTY_WIRE,
    requestedMethods: compactRequested,
  };
  // Target: this run is a spec-conformant binary answering both arms with
  // typed SS3.7 outcomes. Reading it as anything but the guard's expected
  // value is the 2026-09-02 false reopen.
  assert.equal(
    observeD19778(run),
    D19778_EXPECTED,
    "the guard read tdd SS3.7's mandated missing_run classification as the reopened defect",
  );
});

test("QA-TEST-016b (control): the seeded internal admission death still reproduces on the no-run arm", () => {
  const run: ObservedRun = {
    api: [compactStartOk, compactInternal, compactTurnOk, compactTurnCompleted, afterTurnTyped],
    wire: EMPTY_WIRE,
    requestedMethods: compactRequested,
  };
  assert.equal(observeD19778(run), "compact:internal-admission-failure|afterTurn:classified");
});

test("QA-TEST-016c: the completed-run arm — the defect class's actual trigger — is read, and its internal death reproduces", () => {
  const run: ObservedRun = {
    api: [compactStartOk, compactMissingRun, compactTurnOk, compactTurnCompleted, afterTurnInternal],
    wire: EMPTY_WIRE,
    requestedMethods: compactRequested,
  };
  // Target: pre-rework the guard never issued a turn and never read this
  // step, so a fact-retention death AFTER a completed run — the OP's exact
  // surface (#21244's fix) — was invisible to it.
  assert.equal(
    observeD19778(run),
    "compact:missing_run|afterTurn:internal-admission-failure",
    "the guard must read the post-turn compact settlement — the arm the defect class actually bites on",
  );
});

// The arms below kill the one-line mutants that survived 016a/b/c: reading
// the KIND instead of the reason on the no-run arm, dropping the
// turn-never-completed guard, and letting the drain loop's own timeout pass
// (#27227 review).

/** A no-run refusal that is typed but NOT the reason SS3.7 mandates here. */
const compactInvalidTarget: ApiObservation = {
  ...compactMissingRun,
  error: { ...compactMissingRun.error, reason: "invalid_target" },
} as ApiObservation;

test("QA-TEST-016d: the no-run arm pins the REASON, not just the kind — a typed `invalid_target` there is a deviation", () => {
  const run: ObservedRun = {
    api: [compactStartOk, compactInvalidTarget, compactTurnOk, compactTurnCompleted, afterTurnTyped],
    wire: EMPTY_WIRE,
    requestedMethods: compactRequested,
  };
  // Kills `settlement === "err:commandRejected"` → `missing_run`: SS3.7's
  // params note mandates `missing_run` on a no-run session, so #17389's
  // `invalid_target` face leaking onto MSP must report, not pass.
  assert.equal(
    observeD19778(run),
    "compact:err:commandRejected/invalid_target|afterTurn:classified",
  );
});

test("QA-TEST-016e: a no-run session answered OK is a deviation — SS3.7 mandates the refusal", () => {
  const run: ObservedRun = {
    api: [
      compactStartOk,
      { kind: "requestOk", step: "compact", method: "session/compact", result: { status: "accepted" } },
      compactTurnOk,
      compactTurnCompleted,
      afterTurnTyped,
    ],
    wire: EMPTY_WIRE,
    requestedMethods: compactRequested,
  };
  assert.equal(
    observeD19778(run),
    "compact:ok-but-SS3.7-mandates-missing_run|afterTurn:classified",
  );
});

test("QA-TEST-016f: a turn that never completed reads `turn-never-completed`, never a pass", () => {
  // Kills deleting `if (!turnRan) return "turn-never-completed"`: with the
  // notification absent the post-turn probe proves nothing about the arm the
  // defect class bites on (QA-TEST-015's earned-verdict rule).
  const run: ObservedRun = {
    api: [compactStartOk, compactMissingRun, compactTurnOk, afterTurnTyped],
    wire: EMPTY_WIRE,
    requestedMethods: compactRequested,
  };
  assert.equal(observeD19778(run), "compact:missing_run|afterTurn:turn-never-completed");
  assert.notEqual(observeD19778(run), D19778_EXPECTED);
});

test("QA-TEST-016g: any typed post-turn reason is classification — the guard must not enumerate `wire_word`", () => {
  // `summarizer_failed` and `runtime_closed` are real
  // `ManualCompactionReason::wire_word` values that an enumerated subset
  // omitted, so a conformant typed answer read as the defect — the very
  // misread this guard exists to prevent. The third value is in NO current
  // vocabulary on purpose: it kills the enumerate-everything mutant (a Set
  // of all ten present-day words), which would re-create the false reopen
  // the next time `ManualCompactionReason` gains a variant — tdd SS3.1.2
  // says an unknown reason is still a terminal rejection.
  for (const reason of ["summarizer_failed", "runtime_closed", "reason_minted_after_this_test"]) {
    const run: ObservedRun = {
      api: [
        compactStartOk,
        compactMissingRun,
        compactTurnOk,
        compactTurnCompleted,
        { ...afterTurnTyped, error: { ...afterTurnTyped.error, reason } } as ApiObservation,
      ],
      wire: EMPTY_WIRE,
      requestedMethods: compactRequested,
    };
    assert.equal(observeD19778(run), D19778_EXPECTED, `${reason} is typed classification`);
  }
});

test("QA-TEST-016h: a drain loop that expires still holding `run_active` is not a pass", () => {
  // The drive re-probes until the runtime frees the active-run slot. If it
  // never does, the loop exits at its deadline with `run_active` as the last
  // settlement — the state `serve_assembly.rs` treats as a hard failure, so
  // it must not read as classification.
  const run: ObservedRun = {
    api: [
      compactStartOk,
      compactMissingRun,
      compactTurnOk,
      compactTurnCompleted,
      { ...afterTurnTyped, error: { ...afterTurnTyped.error, reason: "run_active" } } as ApiObservation,
    ],
    wire: EMPTY_WIRE,
    requestedMethods: compactRequested,
  };
  assert.equal(observeD19778(run), "compact:missing_run|afterTurn:run-slot-never-released");
  assert.notEqual(observeD19778(run), D19778_EXPECTED);
});

/** One drained probe: the slot is still held, so the drive re-asks. */
const afterTurnRunActive: ApiObservation = {
  ...afterTurnTyped,
  error: { ...afterTurnTyped.error, reason: "run_active" },
} as ApiObservation;

test("QA-TEST-016j: drained `run_active` probes before the typed answer are not the verdict — only the LAST post-turn settlement is read", () => {
  // The complement of 016h. The drive re-probes `compactAfterTurn` while the
  // runtime still answers `run_active` (the #21244 drain race), so a real
  // run records several post-turn settlements; the observable must read the
  // newest. Flipping `rejectionReasonOfRun`/`settlementOfRun` to first-wins
  // would read the first drained probe and report `run-slot-never-released`
  // against a conformant host — the false reopen this guard exists to stop.
  const run: ObservedRun = {
    api: [
      compactStartOk,
      compactMissingRun,
      compactTurnOk,
      compactTurnCompleted,
      afterTurnRunActive,
      afterTurnRunActive,
      afterTurnTyped,
    ],
    wire: EMPTY_WIRE,
    requestedMethods: compactRequested,
  };
  assert.equal(observeD19778(run), D19778_EXPECTED);
});

test("QA-TEST-016k: a post-turn `missing_run` is the runtime losing the run it just completed, never a pass", () => {
  // The probe omits `turnId`, so tdd SS3.7 resolves the latest run, and
  // `serve_assembly.rs` pins that same compact `accepted` after one completed
  // turn. A typed `missing_run` there is therefore a deviation with its own
  // face (like `run_active`), not "any reason is classification".
  const run: ObservedRun = {
    api: [
      compactStartOk,
      compactMissingRun,
      compactTurnOk,
      compactTurnCompleted,
      { ...afterTurnTyped, error: { ...afterTurnTyped.error, reason: "missing_run" } } as ApiObservation,
    ],
    wire: EMPTY_WIRE,
    requestedMethods: compactRequested,
  };
  assert.equal(observeD19778(run), "compact:missing_run|afterTurn:completed-run-not-resolvable");
  assert.notEqual(observeD19778(run), D19778_EXPECTED);
});

test("QA-TEST-016i: a real `MspError`'s `data.reason` reaches the observation", async () => {
  // 016a-h hand-write `error.reason` into fixtures, so the recorder spread
  // that actually captures it is unbacked: delete it and they all stay green
  // while the shipped guard silently returns to `compact:err:commandRejected`.
  // This drives a real child host and a real `MspError` through
  // `RecordedHost`, which is the only thing that pins the capture.
  const workDir = await scenarioWorkDir("d19778-reason");
  try {
    const host = await RecordedHost.open({
      museBin: process.execPath,
      argv: [SCRIPTED_HOST, "typedRejection"],
      workDir,
      label: "typedRejection",
    });
    await host.initialize();
    await host.command("compact", "session/compact", { sessionId: "s" });
    const run = await host.finish();
    assert.equal(rejectionReasonOfRun(run, "compact"), "missing_run");
    // …and the shipped observable reads that captured reason, not the kind.
    assert.equal(observeD19778(run), "compact:missing_run|afterTurn:turn-never-completed");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
