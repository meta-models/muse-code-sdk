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

import {
  D19764_COMMAND_TEXT,
  D19764_EXPECTED,
  MUSE_QA_SDK_BIN,
  blockedRunEvidence,
  blockedVerdictOf,
  blockerStillBites,
  errorKindOfRun,
  foldBlockedEvidence,
  observeD19764,
  renderReportMarkdown,
  runSdkQa,
  subjectStepsOf,
} from "../qa/index.js";
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
