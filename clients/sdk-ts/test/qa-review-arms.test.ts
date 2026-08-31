/**
 * QA-TEST-004..007 and QA-TEST-011c — the arms the review round found
 * unreached.
 *
 * Every test here was RED before its fix: each one pins a path where the
 * harness could previously report a lie with an authoritative face — a
 * corrupted transcript, a mis-paired error, a crashed host read as clean, a
 * check that had been vacated, or a refusal nothing exercised. The oracle's own
 * rule applies to the harness itself: a check that passes whether or not the
 * code is right has checked nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MUSE_QA_SDK_BIN,
  TAP_SHIM_PATH,
  attributeByReplay,
  readWireLog,
  resolveMuseBinary,
  runOracle,
  runSdkQa,
} from "../qa/index.js";
import type {
  ApiObservation,
  ObservedRun,
  QaScenario,
  WireDirection,
  WireFrame,
  WireLog,
} from "../qa/index.js";

const CRASHING_HOST = fileURLToPath(new URL("./helpers/qa-crashing-host.js", import.meta.url));

// --------------------------------------------------------------------------
// Synthesized runs: the QA-TEST-011b technique, one level down.
// --------------------------------------------------------------------------

/** Build a wire log from frames given in true arrival order. */
function wireOf(entries: readonly (readonly [WireDirection, Record<string, unknown>])[]): WireLog {
  const counts: Record<WireDirection, number> = { clientToHost: 0, hostToClient: 0 };
  const frames: WireFrame[] = entries.map(([direction, json], order) => {
    const frame: WireFrame = {
      direction,
      index: counts[direction],
      order,
      raw: JSON.stringify(json),
      json,
    };
    counts[direction] += 1;
    return frame;
  });
  return {
    frames,
    outbound: frames.filter((frame) => frame.direction === "clientToHost"),
    inbound: frames.filter((frame) => frame.direction === "hostToClient"),
    trailing: { clientToHost: "", hostToClient: "" },
  };
}

const INITIALIZE_RESULT: Record<string, unknown> = { serverInfo: { name: "s", version: "0" } };

const initializeExchange = (): (readonly [WireDirection, Record<string, unknown>])[] => [
  ["clientToHost", { jsonrpc: "2.0", id: 1, method: "initialize", params: {} }],
  ["hostToClient", { jsonrpc: "2.0", id: 1, result: INITIALIZE_RESULT }],
  ["clientToHost", { jsonrpc: "2.0", method: "initialized" }],
];

const initializeObservation: ApiObservation = {
  kind: "initializeResult",
  result: INITIALIZE_RESULT,
  fingerprintWarning: null,
};

// --------------------------------------------------------------------------
// QA-TEST-004 — the tap reassembles a frame split mid-code-point (thread 1).
// --------------------------------------------------------------------------

test("QA-TEST-004: a frame split mid-code-point reassembles byte-identically", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "muse-qa-split-"));
  const tapFile = join(workDir, "wire.tap.jsonl");
  try {
    // A faithful frame carrying multibyte text. The host wrote it once; the
    // pipe delivered it in two reads that fall INSIDE the `é`.
    const frame = `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { userAgent: "Musé 😀" } })}\n`;
    const bytes = Buffer.from(frame, "utf8");
    const cut = bytes.indexOf(Buffer.from("é", "utf8")[0] as number) + 1;
    assert.ok(cut > 0 && cut < bytes.length, "the split lands mid-code-point");

    const records = [bytes.subarray(0, cut), bytes.subarray(cut)].map((chunk, seq) =>
      JSON.stringify({ d: "<", seq, b: chunk.toString("base64") }),
    );
    await writeFile(tapFile, `${records.join("\n")}\n`, "utf8");

    const wire = await readWireLog(tapFile);
    assert.equal(wire.inbound.length, 1, "the two halves are ONE frame, not two");
    // Byte-identity is the whole property: a per-chunk decode yields U+FFFD
    // here, the reassembled wire stops matching what the host sent, and the
    // oracle manufactures an `O2:facade` out of faithful traffic (FM-QA-001).
    assert.equal(wire.inbound[0]?.raw, frame.trimEnd());
    assert.ok(!(wire.inbound[0]?.raw ?? "").includes("�"), "no replacement character survives");
    assert.deepEqual(wire.inbound[0]?.json?.["result"], { userAgent: "Musé 😀" });
    assert.equal(wire.trailing.hostToClient, "");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("QA-TEST-004b: the shim's pid header is metadata, never wire traffic", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "muse-qa-hdr-"));
  const tapFile = join(workDir, "wire.tap.jsonl");
  try {
    const frame = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
    await writeFile(
      tapFile,
      [
        JSON.stringify({ d: "#", seq: 0, shim: 4242, child: 4243 }),
        JSON.stringify({ d: "<", seq: 1, b: Buffer.from(`${frame}\n`, "utf8").toString("base64") }),
        "",
      ].join("\n"),
      "utf8",
    );
    const wire = await readWireLog(tapFile);
    assert.equal(wire.inbound.length, 1, "the header did not become an inbound frame");
    assert.equal(wire.inbound[0]?.raw, frame);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// QA-TEST-005 — a crashed host never reads as clean (thread 3).
// --------------------------------------------------------------------------

test("QA-TEST-005: the shim propagates a crashed child's status, tail and all", async () => {
  const workDir = await mkdtemp(join(tmpdir(), "muse-qa-exit-"));
  const tapFile = join(workDir, "wire.tap.jsonl");
  try {
    const shim = spawn(process.execPath, [TAP_SHIM_PATH, tapFile, process.execPath, CRASHING_HOST, "7"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    const stdout: Buffer[] = [];
    shim.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    shim.stdin.end();

    const status = await new Promise<number | null>((resolve) => {
      shim.on("close", (code) => resolve(code));
    });

    // Exiting 0 here is the defect: `classifyExit` maps 0 to `cleanShutdown`,
    // so a host that crashed with a tail write in flight would pass as clean.
    assert.equal(status, 7, "the child's exit status survives the shim");
    // ...and the flush guarantee it was traded against still holds.
    assert.match(Buffer.concat(stdout).toString("utf8"), /last words/);
    assert.match(await readFile(tapFile, "utf8"), /"d":"<"/);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// QA-TEST-006 — repeated methods pair positionally (thread 2).
// --------------------------------------------------------------------------

test("QA-TEST-006a: two faithful same-method errors of different kinds produce NO finding", () => {
  const run: ObservedRun = {
    api: [
      initializeObservation,
      {
        kind: "requestError",
        step: "first",
        method: "session/resume",
        error: { name: "MspError", message: "gone", kind: "notFound" },
      },
      {
        kind: "requestError",
        step: "second",
        method: "session/resume",
        error: { name: "MspError", message: "busy", kind: "conflict" },
      },
    ],
    wire: wireOf([
      ...initializeExchange(),
      ["clientToHost", { jsonrpc: "2.0", id: 2, method: "session/resume", params: {} }],
      ["hostToClient", { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "gone", data: { kind: "notFound" } } }],
      ["clientToHost", { jsonrpc: "2.0", id: 3, method: "session/resume", params: {} }],
      ["hostToClient", { jsonrpc: "2.0", id: 3, error: { code: -32001, message: "busy", data: { kind: "conflict" } } }],
    ]),
    requestedMethods: ["session/resume"],
  };
  // First-match pairing reads the SECOND error against the FIRST response and
  // reports a retype the SDK never made — a false SDK bug with wire evidence.
  assert.deepEqual(runOracle(run), [], "faithful repeated-method traffic is clean");
});

test("QA-TEST-006b: a retype on the SECOND call is still caught when the first settled OK", () => {
  const run: ObservedRun = {
    api: [
      initializeObservation,
      { kind: "requestOk", step: "first", method: "setApprovalMode", result: { ok: true } },
      {
        kind: "requestError",
        step: "second",
        method: "setApprovalMode",
        // The host served `denied`; the facade surfaced `internal`.
        error: { name: "MspError", message: "nope", kind: "internal" },
      },
    ],
    wire: wireOf([
      ...initializeExchange(),
      ["clientToHost", { jsonrpc: "2.0", id: 2, method: "setApprovalMode", params: {} }],
      ["hostToClient", { jsonrpc: "2.0", id: 2, result: { ok: true } }],
      ["clientToHost", { jsonrpc: "2.0", id: 3, method: "setApprovalMode", params: {} }],
      ["hostToClient", { jsonrpc: "2.0", id: 3, error: { code: -32000, message: "nope", data: { kind: "denied" } } }],
    ]),
    requestedMethods: ["setApprovalMode"],
  };
  const findings = runOracle(run);
  assert.deepEqual(
    findings.map((found) => `${found.checkId}:${found.indicts}`),
    ["O4:facade"],
    "first-match pairing looks at the OK response and misses this entirely",
  );
  assert.match(findings[0]?.wireSaid ?? "", /denied/);
});

// --------------------------------------------------------------------------
// QA-TEST-007 — O1, O4 and O7 can actually fail (thread 7).
// --------------------------------------------------------------------------

test("QA-TEST-007a: O1 catches a duplicated `initialize`", () => {
  // The duplicate sits AFTER `initialized` so the handshake-count arm is the
  // only one under test; the traffic-before-initialized arm has its own shape.
  const run: ObservedRun = {
    api: [initializeObservation],
    wire: wireOf([
      ...initializeExchange(),
      ["clientToHost", { jsonrpc: "2.0", id: 2, method: "initialize", params: {} }],
    ]),
    requestedMethods: [],
  };
  const findings = runOracle(run).filter((found) => found.checkId === "O1");
  assert.equal(findings.length, 1, "a second handshake on the wire is an O1 finding");
  assert.match(findings[0]?.wireSaid ?? "", /2 `initialize` frame\(s\)/);
});

test("QA-TEST-007b: O4 catches a retyped error kind", () => {
  const run: ObservedRun = {
    api: [
      initializeObservation,
      {
        kind: "requestError",
        step: "list",
        method: "session/list",
        error: { name: "MspError", message: "no", kind: "internal" },
      },
    ],
    wire: wireOf([
      ...initializeExchange(),
      ["clientToHost", { jsonrpc: "2.0", id: 2, method: "session/list", params: {} }],
      ["hostToClient", { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "no", data: { kind: "notFound" } } }],
    ]),
    requestedMethods: ["session/list"],
  };
  const findings = runOracle(run).filter((found) => found.checkId === "O4");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.indicts, "facade", "retyping is the facade's doing");
  assert.match(findings[0]?.apiSaid ?? "", /internal/);
  assert.match(findings[0]?.wireSaid ?? "", /notFound/);
});

test("QA-TEST-007c: O7 catches a frame the caller never asked for", () => {
  const run: ObservedRun = {
    api: [initializeObservation],
    wire: wireOf([
      ...initializeExchange(),
      ["clientToHost", { jsonrpc: "2.0", id: 2, method: "telemetry/report", params: {} }],
    ]),
    requestedMethods: [],
  };
  const findings = runOracle(run).filter((found) => found.checkId === "O7");
  assert.equal(findings.length, 1, "an unrequested outbound method is an O7 finding");
  assert.equal(findings[0]?.track, "spec-gap", "nothing constrains this yet — constrain or document");
  assert.match(findings[0]?.wireSaid ?? "", /telemetry\/report/);
});

// --------------------------------------------------------------------------
// QA-TEST-011c and the refusal arms (thread 8).
// --------------------------------------------------------------------------

test("QA-TEST-011c: an observation that cannot reproduce from frames is INDETERMINATE", async () => {
  // No facade indictment, and an observable that deliberately disagrees between
  // the live run and any replay of it. Rounding this to `binary` — the exact
  // move FR-22764-3 forbids — is what this arm exists to catch.
  const run: ObservedRun = {
    api: [initializeObservation],
    wire: wireOf(initializeExchange()),
    requestedMethods: [],
  };
  let call = 0;
  const attribution = await attributeByReplay({
    run,
    observe: () => `observation-${(call += 1)}`,
    drive: async () => {},
  });
  assert.equal(attribution.component, "indeterminate");
  assert.notEqual(attribution.observedReplay, attribution.observedLive);
  assert.match(attribution.rationale, /did not reproduce/);
});

test("the missing-binary refusal is explicit, never a fixture substitution", () => {
  const refused = resolveMuseBinary({ [MUSE_QA_SDK_BIN]: "/nonexistent/tbh" });
  assert.equal(refused.available, false);
  assert.ok(refused.available === false && refused.reason.includes("/nonexistent/tbh"));
  assert.ok(
    refused.available === false && refused.reason.includes(MUSE_QA_SDK_BIN),
    "the refusal names the env var the operator set",
  );
});

test("the verdict mapping is pinned: expected-block, block-lifted, and blocked", async () => {
  const outcome = (blockerStillBites: boolean): QaScenario["run"] =>
    async (): Promise<Awaited<ReturnType<QaScenario["run"]>>> => ({
      runs: [],
      blockedVerdict: { bites: blockerStillBites },
      observed: "o",
      expected: "e",
    });

  const scenarios: QaScenario[] = [
    {
      id: "F01",
      title: "still blocked",
      vein: "fake",
      expectBlocked: { blocker: "#1", because: "x".repeat(70) },
      run: outcome(true),
    },
    {
      id: "F02",
      title: "blocker lifted",
      vein: "fake",
      expectBlocked: { blocker: "#2", because: "y".repeat(70) },
      run: outcome(false),
    },
    {
      id: "F03",
      title: "threw",
      vein: "fake",
      async run(): Promise<never> {
        throw new Error("the harness learned nothing");
      },
    },
    {
      // An explicit `refused: undefined` still compiles as the bites member;
      // the verdict read discriminates on VALUE, so this hand-written shape
      // must stay expected-block, never a misrouted `blocked` (#23324 review).
      id: "F04",
      title: "explicit refused: undefined still means bites",
      vein: "fake",
      expectBlocked: { blocker: "#3", because: "z".repeat(70) },
      async run(): Promise<Awaited<ReturnType<QaScenario["run"]>>> {
        return {
          runs: [],
          blockedVerdict: { bites: true, refused: undefined },
          observed: "o",
          expected: "e",
        };
      },
    },
  ];

  const report = await runSdkQa({ museBin: "/unused", scenarios });
  const verdicts = Object.fromEntries(
    report.scenarios.map((scenario) => [scenario.id, scenario.verdict]),
  );
  assert.deepEqual(verdicts, {
    F01: "expected-block",
    F02: "block-lifted",
    // An exception is BLOCKED, never a pass: a scenario that could not complete
    // taught the harness nothing about the host.
    F03: "blocked",
    F04: "expected-block",
  });
  assert.match(
    report.scenarios.find((scenario) => scenario.id === "F03")?.blockedBecause ?? "",
    /the harness learned nothing/,
  );
});
