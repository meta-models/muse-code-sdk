/**
 * QA-TEST-001/002/003 — the wire tap and the oracle, proven over the REAL
 * `@muse-code/sdk` spawn path against a real child process.
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
import type { ConnectionOptions } from "../src/index.js";
import type { InitializeParams } from "@muse-code/msp";

import { readTapPids, readWireLog, runOracle, tappedSpawnOptions } from "../qa/index.js";
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
async function driveScriptedHost(
  arm: string,
  connection?: ConnectionOptions,
): Promise<DriveResult> {
  const workDir = await mkdtemp(join(tmpdir(), "muse-qa-tap-"));
  const tapFile = join(workDir, "wire.tap.jsonl");
  const observations: ApiObservation[] = [];

  const handshake = spawnMspConnection(
    tappedSpawnOptions({
      tapFile,
      command: process.execPath,
      args: [SCRIPTED_HOST, arm],
      ...(connection === undefined ? {} : { connection }),
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

test("TEST-26363-1: spawn forwards ConnectionOptions to the real connection", async () => {
  const driven = await driveScriptedHost("faithful", { mintRequestId: () => "x1" });
  try {
    const wire = await readWireLog(driven.tapFile);
    assert.equal(wire.outbound[0]?.json?.["method"], "initialize");
    assert.equal(wire.outbound[0]?.json?.["id"], "x1");
  } finally {
    await rm(driven.workDir, { recursive: true, force: true });
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

/** Settle a promise or give up: the RED shape here is "never settles" (#23615). */
async function settleOrTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ settled: "ok"; value: T } | { settled: "err"; error: Error } | { settled: "timeout" }> {
  const timedOut = Symbol("timedOut");
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), ms);
    timer.unref();
  });
  const outcome = await Promise.race([
    promise.then(
      (value) => ({ settled: "ok", value }) as const,
      (error: Error) => ({ settled: "err", error }) as const,
    ),
    bound.then(() => ({ settled: "timeout" }) as const),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

test("QA-TEST-014: a host that dies pre-finish propagates EOF through the shim (#23615)", async () => {
  // The loud start-failure shape: the host writes its complaint and dies
  // before ever answering. Shim-free, the SDK's pending `initialize`
  // rejects `ProtocolError: connection reached EOF`; the tap must not change
  // that — a shim that outlives the dead child holds the SDK's read end open
  // and wedges the whole QA pass on a response that can never come.
  // Exit 87, not 1: a shim that crashes on its own fault (an uncaught throw)
  // exits 1, which `classifyExit` reads as `unhandledError` — the same answer
  // a relayed exit 1 gives. Only a code the shim cannot self-produce proves
  // the child's real status travelled THROUGH the shim.
  const workDir = await mkdtemp(join(tmpdir(), "muse-qa-tap-"));
  const tapFile = join(workDir, "wire.tap.jsonl");
  const handshake = spawnMspConnection(
    tappedSpawnOptions({
      tapFile,
      command: process.execPath,
      args: ["-e", 'console.error("boom: unsupported provider"); process.exit(87);'],
    }),
  );
  try {
    const initialized = await settleOrTimeout(handshake.initialize(CLIENT_INFO), 10_000);
    assert.notEqual(
      initialized.settled,
      "timeout",
      "initialize never settled: the shim outlived the dead host and the SDK never saw EOF (#23615)",
    );
    assert.equal(initialized.settled, "err", "a dead host cannot have answered initialize");
    const error = (initialized as { error: Error }).error;
    assert.equal(error.name, "ProtocolError", "the tapped spawn matches the shim-free contract");
    assert.match(error.message, /EOF/);

    // The exit classification still comes from the child's real status: 87 is
    // outside classifyExit's documented 0..5 codes, so it classifies `crash`
    // with the code intact. A shim dying of its own fault cannot produce this
    // pair (its uncaught throw exits 1 -> `unhandledError`), so these two
    // assertions go RED against a self-crashing mutant shim.
    const exited = await settleOrTimeout(handshake.child.exit, 10_000);
    assert.equal(exited.settled, "ok", "the shim itself must exit once the child is gone");
    const classification = (exited as { value: { kind: string; exitCode?: number } }).value;
    assert.equal(classification.kind, "crash");
    assert.equal(classification.exitCode, 87);

    // And the shim process really is gone — the wedge FM-QA-004 exists to
    // prevent held stdio handles, not just an unsettled promise.
    const { shim } = await readTapPids(tapFile);
    assert.ok(shim !== undefined, "the tap header names the shim pid");
    const gone = async (): Promise<boolean> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          process.kill(shim, 0);
        } catch {
          return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return false;
    };
    assert.ok(await gone(), `the shim (pid ${shim}) is still alive with its child dead`);
  } finally {
    // A RED run leaves a wedged shim holding this test process's pipe ends;
    // reap it so the failure reports instead of hanging the whole suite.
    const { shim } = await readTapPids(tapFile).catch(() => ({ shim: undefined }));
    if (shim !== undefined) {
      try {
        process.kill(shim, "SIGKILL");
      } catch {
        // Already gone — the GREEN state.
      }
    }
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
