/**
 * TEST-42624-10 (A — the client arms; #52255): the required-selection arm of
 * the stable TypeScript SDK facade (amendment 42624 § Compatibility).
 *
 * A caller that sets `requirePermissionProfile` alongside `permissionProfile`
 * requires its selection: the client proves the committed selection equals
 * the requested id — from the start result's own `session.permissionState`,
 * else a `session/read` read-back — and throws `PermissionProfileNotApplied`
 * instead of proceeding on the host default. The refused session is dropped
 * (no orphan); the caller resumes via the error's `sessionId` or starts
 * again: no auto-close, no auto-set, never a silent default.
 *
 * Causal, never time-based: every wait is `waitForWrites` / `settleMicrotasks`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Connection, MuseClient, PermissionProfileNotApplied } from "../src/index.js";
import type { MuseClientOptions } from "../src/index.js";
import {
  answer,
  FakeDuplex,
  sentFrame,
  sentParams,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };
const REQUIRED = ":unrestricted";
const OTHER = ":ask-me";

function startResult(
  sessionId: string,
  permissionState?: Record<string, unknown> | null,
): Record<string, unknown> {
  const session: Record<string, unknown> = { sessionId, status: "idle" };
  if (permissionState !== undefined) session["permissionState"] = permissionState;
  return { session, viewCursor: "cursor-0" };
}

function readResult(
  sessionId: string,
  permissionState?: Record<string, unknown> | null,
): Record<string, unknown> {
  const session: Record<string, unknown> = { sessionId, status: "idle" };
  if (permissionState !== undefined) session["permissionState"] = permissionState;
  return {
    history: { mode: "none", items: [] },
    pendingRequests: [],
    session,
    viewCursor: "cursor-1",
  };
}

function triple(profileId: string | null): Record<string, unknown> {
  return { profileId, reviewerAuthority: "autoReview", reviewerAttached: true };
}

function notApplied(
  requested: string,
  served: string | null,
  sessionId: string,
): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof PermissionProfileNotApplied, `expected PermissionProfileNotApplied, got ${error}`);
    assert.equal(error.requested, requested);
    assert.equal(error.served, served);
    assert.equal(error.sessionId, sessionId);
    return true;
  };
}

test("TEST-42624-10 (ts): a required start whose read-back serves a different profile throws and sends no turn", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const opening = client.startSession({
    permissionProfile: REQUIRED,
    requirePermissionProfile: true,
  });
  await waitForWrites(transport, 1);
  assert.equal(sentFrame(transport, 0)["method"], "session/start");
  assert.equal(sentParams(transport, 0)["permissionProfile"], REQUIRED);
  assert.ok(
    !("requirePermissionProfile" in sentParams(transport, 0)),
    "the require flag is client-local, never on the wire",
  );
  answer(transport, 0, startResult("s-1"));

  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "session/read");
  assert.equal(sentParams(transport, 1)["sessionId"], "s-1");
  answer(transport, 1, readResult("s-1", triple(OTHER)));

  await assert.rejects(opening, notApplied(REQUIRED, OTHER, "s-1"));
  await settleMicrotasks();
  assert.equal(transport.writes.length, 2);

  // The session stays open and the client stays usable: a plain retry works.
  const retry = client.startSession({});
  await waitForWrites(transport, 3);
  answer(transport, 2, startResult("s-2"));
  const session = await retry;
  assert.equal(session.sessionId, "s-2");
});

test("TEST-42624-10 (ts): a required start whose read-back omits permissionState throws with served null", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const opening = client.startSession({
    permissionProfile: REQUIRED,
    requirePermissionProfile: true,
  });
  await waitForWrites(transport, 1);
  answer(transport, 0, startResult("s-1"));
  await waitForWrites(transport, 2);
  answer(transport, 1, readResult("s-1"));

  await assert.rejects(opening, notApplied(REQUIRED, null, "s-1"));
  await settleMicrotasks();
  assert.equal(transport.writes.length, 2);
});

test("TEST-42624-10 (ts): a required start whose read-back serves profileId null throws with served null", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const opening = client.startSession({
    permissionProfile: REQUIRED,
    requirePermissionProfile: true,
  });
  await waitForWrites(transport, 1);
  answer(transport, 0, startResult("s-1"));
  await waitForWrites(transport, 2);
  answer(transport, 1, readResult("s-1", triple(null)));

  await assert.rejects(opening, notApplied(REQUIRED, null, "s-1"));
  await settleMicrotasks();
  assert.equal(transport.writes.length, 2);
});

test("TEST-42624-10 (ts): requirePermissionProfile without permissionProfile is a usage error before anything is sent", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const opening = client.startSession({ requirePermissionProfile: true });
  await settleMicrotasks();
  if (transport.writes.length > 0) {
    // Pre-fix behavior: it sent — answer so nothing dangles, then fail loudly.
    answer(transport, 0, startResult("s-1"));
    await opening;
    assert.fail("usage error must fire before anything is sent");
  }
  await assert.rejects(opening);
});

test("TEST-42624-10 (ts): without the flag the start is byte-identical — one frame, no read", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const opening = client.startSession({ permissionProfile: REQUIRED });
  await waitForWrites(transport, 1);
  answer(transport, 0, startResult("s-1"));
  const session = await opening;
  assert.equal(session.sessionId, "s-1");
  await settleMicrotasks();
  assert.equal(transport.writes.length, 1);
});

test("TEST-42624-10 (ts): a start result already carrying the required profile proceeds with no read", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const opening = client.startSession({
    permissionProfile: REQUIRED,
    requirePermissionProfile: true,
  });
  await waitForWrites(transport, 1);
  answer(transport, 0, startResult("s-1", triple(REQUIRED)));
  const session = await opening;
  assert.equal(session.sessionId, "s-1");
  await settleMicrotasks();
  assert.equal(transport.writes.length, 1);
});

test("TEST-42624-10 (ts): a start result carrying a different profile throws with no read", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const opening = client.startSession({
    permissionProfile: REQUIRED,
    requirePermissionProfile: true,
  });
  await waitForWrites(transport, 1);
  answer(transport, 0, startResult("s-1", triple(OTHER)));

  await assert.rejects(opening, notApplied(REQUIRED, OTHER, "s-1"));
  await settleMicrotasks();
  assert.equal(transport.writes.length, 1);
});

test("TEST-42624-10 (ts): after the refusal the id stays resumable — resume via sessionId works", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), DURABLE);

  const opening = client.startSession({
    permissionProfile: REQUIRED,
    requirePermissionProfile: true,
  });
  await waitForWrites(transport, 1);
  answer(transport, 0, startResult("s-1", triple(OTHER)));
  await assert.rejects(opening, notApplied(REQUIRED, OTHER, "s-1"));
  await settleMicrotasks();

  // The refused session was dropped (no orphan); the error's sessionId is the
  // caller's handle to resume (the drop itself is pinned on the Py twin,
  // where `_sessions` is reachable — TS `#sessions` is truly private).
  const pending = client.resumeSession({ sessionId: "s-1" });
  await waitForWrites(transport, 2);
  assert.equal(sentFrame(transport, 1)["method"], "session/resume");
  assert.equal(sentParams(transport, 1)["sessionId"], "s-1");
  answer(transport, 1, {
    session: { sessionId: "s-1", status: "idle" },
    history: { mode: "none", items: [] },
    pendingRequests: [],
    viewCursor: "cursor-9",
  });
  const session = await pending;
  assert.equal(session.sessionId, "s-1");
  assert.equal(session.opening?.verb, "session/resume");
});
