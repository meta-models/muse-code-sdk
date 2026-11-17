/**
 * TEST-22936-6 to TEST-22936-15, TEST-22936-17 and TEST-22936-18 (spec 14990 amendment #22936; ADR
 * 22936 D3): the compatibility-epoch tier on the TypeScript SDK's handshake.
 *
 * Equal fingerprints: no check. Different fingerprints with an equal or
 * absent served epoch: the additive tier, today's warning. Different
 * fingerprints with a different epoch: the declared-breaking tier, a warning
 * by default and a refusal at connect behind `refuseDeclaredBreakingSchema`,
 * which names both bundles and closes the host the SDK spawned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import {
  EXPECTED_SCHEMA_COMPATIBILITY_EPOCH,
  EXPECTED_SCHEMA_FINGERPRINT,
  MuseClient,
  ProtocolError,
  SchemaCompatibilityError,
  classifyServedSchema,
  spawnMspConnection,
} from "../src/index.js";

const OTHER_FINGERPRINT = `sha256:${"c".repeat(64)}`;
const MISSING_BIN = "/nonexistent/muse-schema-epoch-tier";
const PINNED_EPOCH = EXPECTED_SCHEMA_COMPATIBILITY_EPOCH;

interface HostLog {
  readonly notifications: string[];
  stdinEnded: boolean;
  killed: boolean;
}

/**
 * An in-memory host that answers `initialize` with the given `schema`
 * object and records every notification it receives, whether its stdin was
 * ended (the SDK's orderly close) and whether it was signalled.
 */
function hostSpawn(schema: Record<string, unknown>): {
  readonly spawnFn: typeof spawn;
  readonly log: HostLog;
} {
  const log: HostLog = { notifications: [], stdinEnded: false, killed: false };
  const spawnFn = (): ChildProcessWithoutNullStreams => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const send = (value: Record<string, unknown>): void => {
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
    };
    const respond = (frame: { id?: unknown; method?: string }): void => {
      if (frame.id === undefined && typeof frame.method === "string") {
        log.notifications.push(frame.method);
        return;
      }
      if (frame.method === "initialize") {
        send({
          id: frame.id,
          result: {
            experimentalApi: false,
            grantedCapabilities: [],
            museHome: "/nonexistent",
            platformFamily: "unix",
            platformOs: "linux",
            schema,
            serverInfo: { name: "in-memory", version: "0.0.0" },
            sessionDurability: "ephemeral",
            userAgent: "in-memory-host/0.0.0",
          },
        });
      }
    };
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        for (const line of chunk
          .toString("utf-8")
          .split("\n")
          .filter((candidate) => candidate.length > 0)) {
          respond(JSON.parse(line) as { id?: unknown; method?: string });
        }
        callback();
      },
      final(callback): void {
        log.stdinEnded = true;
        callback();
        stdout.end();
        queueMicrotask(() => {
          child.emit("exit", 0, null);
          child.emit("close", 0, null);
        });
      },
    });
    child["stdout"] = stdout;
    child["stderr"] = stderr;
    child["stdin"] = stdin;
    child["kill"] = () => {
      log.killed = true;
      stdout.end();
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      });
      return true;
    };
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnFn: spawnFn as unknown as typeof spawn, log };
}

const CLIENT = { clientInfo: { name: "sdk_test", version: "0.0.0" } };

test("TEST-22936-6: equal fingerprints run no epoch check", () => {
  assert.equal(
    classifyServedSchema({
      fingerprint: EXPECTED_SCHEMA_FINGERPRINT,
      compatibilityEpoch: PINNED_EPOCH + 5,
    }),
    undefined,
  );
});

test("TEST-22936-7: a different fingerprint with an equal epoch is the additive tier", () => {
  const warning = classifyServedSchema({
    fingerprint: OTHER_FINGERPRINT,
    compatibilityEpoch: PINNED_EPOCH,
  });
  assert.equal(warning?.kind, "schemaFingerprintMismatch");
  assert.equal(warning?.tier, "additive");
  assert.equal(warning?.servedEpoch, PINNED_EPOCH);
  assert.equal(warning?.pinnedEpoch, PINNED_EPOCH);
  assert.equal(warning?.served, OTHER_FINGERPRINT);
  assert.equal(warning?.pinned, EXPECTED_SCHEMA_FINGERPRINT);
});

test("TEST-22936-8: a host that omits the member reads as the additive tier", () => {
  const warning = classifyServedSchema({ fingerprint: OTHER_FINGERPRINT });
  assert.equal(warning?.tier, "additive");
  assert.equal(warning?.servedEpoch, undefined, "absence is unknown, never a substituted value");
});

test("TEST-22936-9: a different fingerprint with a different epoch is the declared-breaking tier", () => {
  const warning = classifyServedSchema({
    fingerprint: OTHER_FINGERPRINT,
    compatibilityEpoch: PINNED_EPOCH + 1,
  });
  assert.equal(warning?.tier, "declaredBreaking");
  assert.equal(warning?.servedEpoch, PINNED_EPOCH + 1);
  for (const named of [
    OTHER_FINGERPRINT,
    String(PINNED_EPOCH + 1),
    EXPECTED_SCHEMA_FINGERPRINT,
    String(PINNED_EPOCH),
  ]) {
    assert.ok(warning?.message.includes(named), `the message must name ${named}`);
  }
});

test("TEST-22936-17: the classifier reads a malformed served epoch as absent, as the handshake does", () => {
  for (const value of [-1, 1.5, "1"]) {
    const warning = classifyServedSchema({
      fingerprint: OTHER_FINGERPRINT,
      compatibilityEpoch: value as unknown as number,
    });
    assert.equal(
      warning?.tier,
      "additive",
      `${JSON.stringify(value)}: the tier the handshake reports for the same host (FR-22936-8)`,
    );
    assert.equal(
      warning?.servedEpoch,
      undefined,
      `${JSON.stringify(value)}: nothing is substituted for the value`,
    );
  }
});

test("TEST-22936-10: the declared-breaking tier stays a warning while the setting is off", async () => {
  const host = hostSpawn({
    compatibilityEpoch: PINNED_EPOCH + 1,
    fingerprint: OTHER_FINGERPRINT,
    version: 1,
  });
  const handshake = spawnMspConnection({ command: MISSING_BIN, spawnFn: host.spawnFn });
  const spawned = await handshake.initialize(CLIENT);
  try {
    assert.equal(spawned.fingerprintWarning?.tier, "declaredBreaking");
    assert.deepEqual(host.log.notifications, ["initialized"], "the connection proceeded");
  } finally {
    await spawned.close();
  }
});

test("TEST-22936-11: with the setting on, the declared-breaking tier refuses at connect and closes the host", async () => {
  const host = hostSpawn({
    compatibilityEpoch: PINNED_EPOCH + 1,
    fingerprint: OTHER_FINGERPRINT,
    version: 1,
  });
  const handshake = spawnMspConnection({
    command: MISSING_BIN,
    refuseDeclaredBreakingSchema: true,
    spawnFn: host.spawnFn,
  });
  await assert.rejects(handshake.initialize(CLIENT), (error: unknown) => {
    assert.ok(error instanceof SchemaCompatibilityError, String(error));
    // The error's fields are the warning's flat fields: one shape for both.
    assert.equal(error.tier, "declaredBreaking");
    assert.equal(error.served, OTHER_FINGERPRINT);
    assert.equal(error.servedEpoch, PINNED_EPOCH + 1);
    assert.equal(error.pinned, EXPECTED_SCHEMA_FINGERPRINT);
    assert.equal(error.pinnedEpoch, PINNED_EPOCH);
    assert.ok(error.message.includes(OTHER_FINGERPRINT) && error.message.includes(EXPECTED_SCHEMA_FINGERPRINT));
    // Checked inside the predicate: the host was already closed when the
    // refusal settled, not merely at some later point.
    assert.ok(host.log.stdinEnded || host.log.killed, "the host is closed before the refusal settles");
    return true;
  });
  assert.deepEqual(host.log.notifications, [], "a refused connection never sends `initialized`");
  await handshake.exited;
});

test("TEST-22936-12: the setting leaves the additive tier a warning", async () => {
  const host = hostSpawn({
    compatibilityEpoch: PINNED_EPOCH,
    fingerprint: OTHER_FINGERPRINT,
    version: 1,
  });
  const handshake = spawnMspConnection({
    command: MISSING_BIN,
    refuseDeclaredBreakingSchema: true,
    spawnFn: host.spawnFn,
  });
  const spawned = await handshake.initialize(CLIENT);
  try {
    assert.equal(spawned.fingerprintWarning?.tier, "additive");
  } finally {
    await spawned.close();
  }
});

test("TEST-22936-13: MuseClient.spawn forwards the setting", async () => {
  const host = hostSpawn({
    compatibilityEpoch: PINNED_EPOCH + 1,
    fingerprint: OTHER_FINGERPRINT,
    version: 1,
  });
  await assert.rejects(
    MuseClient.spawn({
      ...CLIENT,
      museBin: MISSING_BIN,
      refuseDeclaredBreakingSchema: true,
      spawnFn: host.spawnFn,
    }),
    (error: unknown) => error instanceof SchemaCompatibilityError,
  );
  assert.deepEqual(host.log.notifications, []);
});

test("TEST-22936-18: MuseClient.spawn leaves the declared-breaking tier a warning by default", async () => {
  // The default-off path of FR-22936-7 (ADR 22936 D3: the published behaviour
  // does not change until the owner enables the setting): no setting, a host
  // at a different fingerprint and epoch, and the connection goes ahead.
  const host = hostSpawn({
    compatibilityEpoch: PINNED_EPOCH + 1,
    fingerprint: OTHER_FINGERPRINT,
    version: 1,
  });
  const client = await MuseClient.spawn({
    ...CLIENT,
    museBin: MISSING_BIN,
    spawnFn: host.spawnFn,
  });
  try {
    assert.deepEqual(host.log.notifications, ["initialized"], "the connection proceeded with the setting off");
    assert.equal(
      classifyServedSchema(client.initializeResult.schema)?.tier,
      "declaredBreaking",
      "the tier is readable from the facade's initialize result",
    );
  } finally {
    await client.close();
  }
});

test("TEST-22936-14: the built epoch equals the stable bundle's declared value", () => {
  // The stamp-freshness proof for the second pin: the value the build stamped
  // is the one the committed stable bundle declares at its root (ADR 22936
  // D5), the same bytes the fingerprint pin derives from.
  const bundlePath = fileURLToPath(new URL("../../../../schema/msp/stable/msp.schema.json", import.meta.url));
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as { compatibilityEpoch?: unknown };
  assert.equal(typeof bundle.compatibilityEpoch, "number", "the stable bundle declares its epoch");
  assert.equal(EXPECTED_SCHEMA_COMPATIBILITY_EPOCH, bundle.compatibilityEpoch);
});

test("TEST-22936-15: a served epoch that is not a non-negative integer reads by the setting: absent when off, a protocol error when on", async () => {
  // FR-22936-8. With the setting off the published behaviour does not change
  // (ADR 22936 D3): the malformed member is read as absent, the additive
  // tier, and the connection proceeds and sends `initialized`. With the
  // setting on the tier it asks for cannot be read, so the arm fails closed
  // before classification: a `ProtocolError` carrying the frame, never a
  // `SchemaCompatibilityError`, and no `initialized`.
  for (const served of [-1, 1.5, "1"]) {
    const label = JSON.stringify(served);
    const offHost = hostSpawn({ compatibilityEpoch: served, fingerprint: OTHER_FINGERPRINT, version: 1 });
    const off = spawnMspConnection({
      command: MISSING_BIN,
      refuseDeclaredBreakingSchema: false,
      spawnFn: offHost.spawnFn,
    });
    const spawned = await off.initialize(CLIENT);
    try {
      assert.equal(spawned.fingerprintWarning?.tier, "additive", `${label} (setting off): read as absent, the additive tier`);
      assert.equal(spawned.fingerprintWarning?.servedEpoch, undefined, `${label} (setting off): nothing is substituted`);
      assert.deepEqual(offHost.log.notifications, ["initialized"], `${label} (setting off): the connection proceeds`);
    } finally {
      await spawned.close();
    }
    const onHost = hostSpawn({ compatibilityEpoch: served, fingerprint: OTHER_FINGERPRINT, version: 1 });
    const on = spawnMspConnection({
      command: MISSING_BIN,
      refuseDeclaredBreakingSchema: true,
      spawnFn: onHost.spawnFn,
    });
    await assert.rejects(on.initialize(CLIENT), (error: unknown) => {
      assert.ok(error instanceof ProtocolError, `${label} (setting on): ${String(error)}`);
      assert.ok(!(error instanceof SchemaCompatibilityError), `${label} (setting on): a malformed member is not a tier refusal`);
      assert.ok(
        error.message.includes("not a non-negative integer") && error.message.includes("muse"),
        `${label} (setting on): the message names the condition and a next step: ${error.message}`,
      );
      assert.ok(
        typeof error.line === "string" && error.line.includes(JSON.stringify(served)),
        `${label} (setting on): the refused frame rides on the error`,
      );
      return true;
    });
    assert.deepEqual(onHost.log.notifications, [], `${label} (setting on): never \`initialized\``);
    await on.close();
  }
});
