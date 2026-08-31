/**
 * QA-TEST-001/002/003 — the wire tap and the oracle, proven over the REAL
 * `@muse/sdk` spawn path against a real child process.
 *
 * The host here is a scripted MSP host rather than `tbh serve` for one
 * reason only: the deviations under test are things a CORRECT host never
 * does, so the real binary cannot produce them on demand. The real-binary
 * arm is `qa-real-binary.test.ts`; this file proves the oracle DISCRIMINATES,
 * which is the property a QA harness is worthless without.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { spawnMspConnection } from "../src/index.js";
import type { InitializeParams } from "@muse/msp";

import { readWireLog, runOracle, tappedSpawnOptions } from "../qa/index.js";
import type { ApiObservation, ObservedRun } from "../qa/index.js";

const SCRIPTED_HOST = fileURLToPath(new URL("./helpers/qa-scripted-host.js", import.meta.url));

const CLIENT_INFO: InitializeParams = {
  clientInfo: { name: "auto_qa_sdk", version: "0.0.0" },
};

interface DriveResult {
  readonly observations: readonly ApiObservation[];
  readonly tapFile: string;
  readonly workDir: string;
}

/**
 * Drive the scripted host through the SDK's PUBLIC surface only, recording
 * what a README-level integrator can see. No SDK internals are touched.
 */
async function driveScriptedHost(arm: string): Promise<DriveResult> {
  const workDir = await mkdtemp(join(tmpdir(), "muse-qa-tap-"));
  const tapFile = join(workDir, "wire.tap.jsonl");
  const observations: ApiObservation[] = [];

  const handshake = spawnMspConnection(
    tappedSpawnOptions({
      tapFile,
      command: process.execPath,
      args: [SCRIPTED_HOST, arm],
    }),
  );
  handshake.onNotification((notification) => {
    observations.push({
      kind: "notification",
      method: notification.method,
      params: notification.params ?? null,
    });
  });
  handshake.onProtocolError((error) => {
    observations.push({ kind: "protocolError", message: error.message });
  });

  const initialized = await handshake.initialize(CLIENT_INFO);
  observations.push({
    kind: "initializeResult",
    result: initialized.initializeResult as unknown as Record<string, unknown>,
    fingerprintWarning: initialized.fingerprintWarning ?? null,
  });

  try {
    const result = await initialized.connection.request("session/list", {});
    observations.push({ kind: "requestOk", step: "list", method: "session/list", result });
  } catch (error) {
    observations.push({
      kind: "requestError",
      step: "list",
      method: "session/list",
      error: {
        name: (error as Error).name,
        message: (error as Error).message,
        ...("code" in (error as object) ? { code: (error as { code: number }).code } : {}),
        ...("kind" in (error as object) ? { kind: (error as { kind: string }).kind } : {}),
      },
    });
  }

  await initialized.close();
  return { observations, tapFile, workDir };
}

async function observe(arm: string): Promise<{ run: ObservedRun; workDir: string }> {
  const driven = await driveScriptedHost(arm);
  const wire = await readWireLog(driven.tapFile);
  return {
    run: { api: driven.observations, wire, requestedMethods: ["session/list"] },
    workDir: driven.workDir,
  };
}

test("QA-TEST-001: the tap records BOTH directions of real child traffic", async () => {
  const { run, workDir } = await observe("faithful");
  try {
    assert.ok(run.wire.outbound.length >= 2, "the SDK's initialize + initialized reached the tap");
    assert.ok(run.wire.inbound.length >= 2, "the host's responses reached the tap");
    assert.equal(run.wire.outbound[0]?.json?.["method"], "initialize");
    assert.equal(run.wire.outbound[1]?.json?.["method"], "initialized");
    // The interleave is preserved: the host cannot answer before it is asked.
    const firstInbound = run.wire.inbound[0];
    assert.ok(firstInbound !== undefined);
    assert.ok(
      firstInbound.order > (run.wire.outbound[0]?.order ?? Number.MAX_SAFE_INTEGER),
      "the tap preserves the real request-before-response order",
    );
    assert.equal(run.wire.trailing.clientToHost, "", "no half-frame is left unaccounted for");
    assert.equal(run.wire.trailing.hostToClient, "");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("QA-TEST-002: the oracle is SILENT on faithful real traffic (control)", async () => {
  const { run, workDir } = await observe("faithful");
  try {
    const findings = runOracle(run);
    assert.deepEqual(
      findings.map((f) => f.checkId),
      [],
      `faithful traffic must produce no finding, got: ${JSON.stringify(findings, null, 2)}`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("QA-TEST-003a: a host that answers one id TWICE is caught", async () => {
  const { run, workDir } = await observe("duplicateResponse");
  try {
    const findings = runOracle(run);
    const correlation = findings.filter((f) => f.checkId === "O3");
    assert.equal(correlation.length, 1, `expected one O3 finding, got ${JSON.stringify(findings)}`);
    const only = correlation[0];
    assert.ok(only !== undefined);
    assert.match(only.wireSaid, /twice|two responses|duplicate/i);
    assert.ok(only.apiSaid.length > 0, "the finding states what the public API said");
    assert.equal(only.track, "bug", "a duplicate response violates the correlation contract");
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("QA-TEST-003b: an error with no `data.kind` is caught on the SPEC-GAP track", async () => {
  const { run, workDir } = await observe("errorWithoutKind");
  try {
    const findings = runOracle(run);
    const typed = findings.filter((f) => f.checkId === "O5");
    assert.equal(typed.length, 1, `expected one O5 finding, got ${JSON.stringify(findings)}`);
    const only = typed[0];
    assert.ok(only !== undefined);
    // The integrator sees a TRANSPORT fault; the host served a deliberate
    // SERVER error. That mismatch is the finding.
    assert.match(only.apiSaid, /ProtocolError/);
    assert.match(only.wireSaid, /no `?data\.kind`?/i);
    assert.match(only.wireSaid, /-32603/, "the served code is quoted, and the caller never saw it");
    assert.equal(
      only.track,
      "spec-gap",
      "ErrorObject.data is optional in the schema, so this is a constrain-vs-document decision",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
