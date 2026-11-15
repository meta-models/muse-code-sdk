/**
 * The applied-tools verification arm: a caller that spells
 * `config.allowedBuiltInTools` can prove the host echoed the
 * post-intersection set, and the check fails loudly — never silently —
 * when the echo is absent or still names an excluded tool.
 *
 * The spelling rides the stable-typed `config` field verbatim:
 * `#forwardConfig` returns a config naming no MCP server unchanged, so
 * an experimental `allowedBuiltInTools` member reaches `session/start`
 * and `session/resume` exactly as spelled, and the host — not the
 * client — owns the shape check. The echo is read structurally from
 * the opening result, like the permission-profile proof reads
 * `session.permissionState`: the stable result types strip the
 * experimental member. The cast below is that seam, made explicit: the
 * experimental type is not graduated into the stable package, and the
 * leak gate proves the built package names no experimental-only
 * surface.
 *
 * Causal, never time-based: every wait is `waitForWrites`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AppliedBuiltInToolsNotApplied,
  Connection,
  MuseClient,
  verifyAppliedBuiltInTools,
} from "../src/index.js";
import type { MuseClientOptions, StartSessionOptions } from "../src/index.js";
import { answer, FakeDuplex, sentParams, waitForWrites } from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
const ALLOWED = ["read", "search", "edit"] as const;

// The experimental spelling, kept out of the stable type: the dict is
// typed with the experimental member and cast at the stable-typed
// facade boundary. Graduation would remove the cast.
type ExperimentalConfig = NonNullable<StartSessionOptions["config"]> & {
  allowedBuiltInTools?: readonly string[];
};
const CONFIG: ExperimentalConfig = { allowedBuiltInTools: [...ALLOWED] };

function clientAndTransport(): { client: MuseClient; transport: FakeDuplex } {
  const transport = new FakeDuplex();
  return { client: new MuseClient(new Connection(transport), DURABLE), transport };
}

function startResult(sessionId: string, applied?: unknown): Record<string, unknown> {
  return {
    session: { sessionId, status: "idle" },
    viewCursor: "cursor-0",
    ...(applied === undefined ? {} : { appliedBuiltInTools: applied }),
  };
}

function resumeResult(sessionId: string, applied?: unknown): Record<string, unknown> {
  return {
    session: { sessionId, status: "idle" },
    history: { mode: "none", items: [] },
    pendingRequests: [],
    viewCursor: "cursor-9",
    ...(applied === undefined ? {} : { appliedBuiltInTools: applied }),
  };
}

async function startWith(
  client: MuseClient,
  transport: FakeDuplex,
  result: Record<string, unknown>,
  index = 0,
) {
  const pending = client.startSession({
    workspaceRoot: "/w",
    config: CONFIG as NonNullable<StartSessionOptions["config"]>,
  });
  await waitForWrites(transport, index + 1);
  answer(transport, index, result);
  const session = await pending;
  return session;
}

test("a config spelling allowed tools reaches session/start verbatim and the echo verifies", async () => {
  const { client, transport } = clientAndTransport();
  const session = await startWith(client, transport, startResult("s-1", ["read"]));
  assert.deepEqual(sentParams(transport, 0)["config"], { allowedBuiltInTools: [...ALLOWED] });
  assert.deepEqual(verifyAppliedBuiltInTools(session.opening, [...ALLOWED]), ["read"]);
});

test("a config spelling allowed tools reaches session/resume verbatim and the echo verifies", async () => {
  const { client, transport } = clientAndTransport();
  const pending = client.resumeSession({
    sessionId: "s-2",
    config: CONFIG as NonNullable<StartSessionOptions["config"]>,
  });
  await waitForWrites(transport, 1);
  assert.deepEqual(sentParams(transport, 0)["config"], { allowedBuiltInTools: [...ALLOWED] });
  answer(transport, 0, resumeResult("s-2", ["read", "search"]));
  const session = await pending;
  assert.deepEqual(verifyAppliedBuiltInTools(session.opening, [...ALLOWED]), ["read", "search"]);
});

test("an echo that is a strict subset of the request passes", async () => {
  const { client, transport } = clientAndTransport();
  const session = await startWith(client, transport, startResult("s-1", ["read"]));
  assert.deepEqual(verifyAppliedBuiltInTools(session.opening, [...ALLOWED]), ["read"]);
});

test("an absent echo fails as unapplied and the session still opens", async () => {
  const { client, transport } = clientAndTransport();
  // No echo: the pre-P8 answer. The open itself succeeds — verification
  // is opt-in, so the failure lands in the helper, never silently.
  const session = await startWith(client, transport, startResult("s-1"));
  assert.throws(
    () => verifyAppliedBuiltInTools(session.opening, [...ALLOWED]),
    (error: unknown) => {
      assert.ok(error instanceof AppliedBuiltInToolsNotApplied);
      assert.deepEqual(error.requested, [...ALLOWED]);
      assert.equal(error.applied, null);
      assert.equal(error.sessionId, "s-1");
      return true;
    },
  );
});

test("an echo still naming workflow fails", async () => {
  const { client, transport } = clientAndTransport();
  const session = await startWith(client, transport, startResult("s-1", ["read", "workflow"]));
  assert.throws(
    () => verifyAppliedBuiltInTools(session.opening, [...ALLOWED]),
    (error: unknown) => {
      assert.ok(error instanceof AppliedBuiltInToolsNotApplied);
      assert.deepEqual(error.applied, ["read", "workflow"]);
      assert.equal(error.sessionId, "s-1");
      return true;
    },
  );
});

test("a malformed echo fails as unapplied", async () => {
  const { client, transport } = clientAndTransport();
  const stringEcho = await startWith(client, transport, startResult("s-1", "read"));
  assert.throws(
    () => verifyAppliedBuiltInTools(stringEcho.opening, [...ALLOWED]),
    (error: unknown) => {
      assert.ok(error instanceof AppliedBuiltInToolsNotApplied);
      assert.equal(error.applied, null);
      return true;
    },
  );
  const blankEcho = await startWith(client, transport, startResult("s-1", ["read", ""]), 1);
  assert.throws(
    () => verifyAppliedBuiltInTools(blankEcho.opening, [...ALLOWED]),
    (error: unknown) => {
      assert.ok(error instanceof AppliedBuiltInToolsNotApplied);
      assert.equal(error.applied, null);
      return true;
    },
  );
});

test("no config spelled is a no-op", async () => {
  const { client, transport } = clientAndTransport();
  const pending = client.startSession({ workspaceRoot: "/w" });
  await waitForWrites(transport, 1);
  assert.equal("config" in sentParams(transport, 0), false);
  answer(transport, 0, startResult("s-1"));
  const session = await pending;
  assert.equal(session.sessionId, "s-1");
});

test("an empty request passes only on an empty echo", async () => {
  const { client, transport } = clientAndTransport();
  const empty = await startWith(client, transport, startResult("s-1", []));
  assert.deepEqual(verifyAppliedBuiltInTools(empty.opening, []), []);
  const workflow = await startWith(client, transport, startResult("s-1", ["workflow"]), 1);
  assert.throws(
    () => verifyAppliedBuiltInTools(workflow.opening, []),
    AppliedBuiltInToolsNotApplied,
  );
});

test("a blank requested name is a usage error, and no opening proves nothing", () => {
  assert.throws(
    () => verifyAppliedBuiltInTools(undefined, [""]),
    /non-empty strings/,
  );
  assert.throws(
    () => verifyAppliedBuiltInTools(undefined, ["read"]),
    (error: unknown) => {
      assert.ok(error instanceof AppliedBuiltInToolsNotApplied);
      assert.equal(error.applied, null);
      assert.equal(error.sessionId, null);
      return true;
    },
  );
});
