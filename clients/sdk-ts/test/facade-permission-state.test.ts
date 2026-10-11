/**
 * TEST-42624-10 (A — the client arms): the stable TypeScript SDK's arms
 * (amendment 42624 § Test enrollment, § Compatibility; INV-42624-1).
 *
 * The stable SDK negotiates no `experimentalApi`, so on its own connection
 * the `permissionState` member is STRIPPED (the stable bundle has no such
 * member) and the facade renders no Auto-review state at all. Its arms are
 * therefore the Compatibility arms, not a renders-active predicate:
 *
 * - the stripped member is unknown evidence (schema pin: stable lacks it,
 *   experimental carries it);
 * - the experimental member arriving anyway — an embedder that opted in via
 *   `MuseClientOptions.capabilities` — rides `session/statusChanged` and
 *   `session/permissionProfileChanged`, both tolerated losslessly: no fold
 *   state, no I/O, no throw (SS1.5.4);
 * - a mode-only `session/approvalModeChanged` folds the MODE and creates no
 *   Auto-review claim: the facade exposes no accessor that could report one,
 *   so "a profile label alone is insufficient" cannot be violated here. That
 *   last pin is the tripwire a future predicate must consciously replace,
 *   and when it does it must satisfy the full triple.
 *
 * First-run receipts: every arm here passes on the pre-change facade — these
 * are pins, recorded as such in the sub-issue (#51292).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Session } from "../src/index.js";
import { FakeDuplex } from "./helpers/fake-duplex.js";
import type { SessionApprovalModeChangedParams, SourceRange } from "@muse-code/msp";

const SESSION = "s-1";
const SOURCE: SourceRange = {
  first: { recordIndex: 0, streamOffset: 0 },
  last: { recordIndex: 0, streamOffset: 0 },
  stream: { kind: "run", runId: "r-1" },
} as unknown as SourceRange;

/** The renders-active triple as the experimental wire spells it. */
const TRIPLE = {
  profileId: ":auto-review",
  reviewerAttached: true,
  reviewerAuthority: "autoReview",
} as const;

// dist/test/<file>.js → clients/sdk-ts/dist/test → projects/tbh
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..", "..");

type WireFrame = Parameters<Session<string>["apply"]>[0];

/**
 * Every public member name of `value` that reads like an Auto-review /
 * permission-state claim.
 */
function claimSurface(value: object): string[] {
  // Own instance fields AND the prototype chain up to Object.prototype:
  // the facade keeps public state on the instance, so a scan of the
  // prototype alone misses a field (review 5438019145 P1 4203396788).
  const names = new Set<string>();
  let cursor: object | null = value;
  while (cursor !== null && cursor !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(cursor)) names.add(name);
    cursor = Object.getPrototypeOf(cursor) as object | null;
  }
  return [...names].filter((name) => /permission|reviewer|autoreview/i.test(name)).sort();
}

function wired(): { readonly transport: FakeDuplex; readonly session: Session<string> } {
  const transport = new FakeDuplex();
  const connection = new Connection(transport, { mintCommandId: () => "mint-0" });
  const session = new Session<string>({
    sessionId: SESSION,
    durability: { kind: "durable" },
    connection,
  });
  return { session, transport };
}

function approvalModeChanged(
  mode: SessionApprovalModeChangedParams["mode"],
  viewCursor: string,
): {
  readonly method: "session/approvalModeChanged";
  readonly params: SessionApprovalModeChangedParams;
} {
  return {
    method: "session/approvalModeChanged",
    params: {
      clientName: "test",
      commandId: "cmd-1",
      mode,
      sessionId: SESSION,
      source: "approvalReconfigure",
      sourceRange: SOURCE,
      viewCursor,
    },
  };
}

function schema(bundle: "stable" | "experimental"): {
  readonly defs: Record<string, { properties?: Record<string, unknown>; required?: string[] }>;
  readonly notifications: Record<string, unknown>;
} {
  const raw = JSON.parse(
    readFileSync(join(projectRoot, "schema", "msp", bundle, "msp.schema.json"), "utf8"),
  ) as { $defs: Record<string, { properties?: Record<string, unknown>; required?: string[] }>; notifications: Record<string, unknown> };
  return { defs: raw.$defs, notifications: raw.notifications };
}

test("TEST-42624-10 (stable SDK): a stable connection sees permissionState stripped — the stable bundle has no member, the experimental bundle does", () => {
  const stable = schema("stable");
  const experimental = schema("experimental");
  const stableSession = stable.defs["Session"]?.properties ?? {};
  const experimentalSession = experimental.defs["Session"]?.properties ?? {};
  assert.equal("permissionState" in stableSession, false, "stable Session carries no permissionState");
  assert.equal("permissionState" in experimentalSession, true, "experimental Session carries it");
  assert.equal(
    "permissionState" in (stable.defs["SessionStatusChangedParams"]?.properties ?? {}),
    false,
    "stable session/statusChanged carries no permissionState",
  );
  assert.equal(
    "permissionState" in (experimental.defs["SessionStatusChangedParams"]?.properties ?? {}),
    true,
    "experimental session/statusChanged carries it (additive-optional)",
  );
  assert.equal("session/permissionProfileChanged" in stable.notifications, false);
  assert.equal("session/permissionProfileChanged" in experimental.notifications, true);
  // The triple's three members are REQUIRED on the experimental type: a
  // snapshot cannot answer the renders-active predicate with a member missing.
  // Membership, not a freeze: the arm needs these three to be REQUIRED; a
  // later required member on this experimental type must not red it.
  const required = experimental.defs["EffectivePermissionState"]?.required ?? [];
  for (const member of ["profileId", "reviewerAttached", "reviewerAuthority"]) {
    assert.ok(required.includes(member), `${member} is required on EffectivePermissionState`);
  }
  assert.equal("EffectivePermissionState" in stable.defs, false);
});

test("TEST-42624-10 (stable SDK): session/statusChanged carrying the triple is tolerated — no fold state, no I/O, no throw", async () => {
  const { session, transport } = wired();
  const frame: WireFrame = {
    method: "session/statusChanged",
    params: { sessionId: SESSION, status: "idle", viewCursor: null, permissionState: TRIPLE },
  };
  const outcome = session.apply(frame);
  assert.deepEqual(outcome.fold, {
    kind: "ignoredUnrecognizedMethod",
    method: "session/statusChanged",
  });
  assert.deepEqual(await outcome.io, []);
  assert.deepEqual(outcome.retirements, []);
  assert.equal(transport.writes.length, 0, "a live host-state projection authors no command");
  assert.deepEqual(session.fold.sessionState.families(), [], "no state family folds from it");
});

test("TEST-42624-10 (stable SDK): session/permissionProfileChanged is tolerated as a newer host's method", async () => {
  const { session, transport } = wired();
  const frame: WireFrame = {
    method: "session/permissionProfileChanged",
    params: {
      clientName: "test",
      commandId: "cmd-9",
      profileId: ":auto-review",
      sessionId: SESSION,
      source: "client",
      sourceRange: SOURCE,
      viewCursor: "v:2",
      permissionState: TRIPLE,
    },
  };
  const outcome = session.apply(frame);
  assert.deepEqual(outcome.fold, {
    kind: "ignoredUnrecognizedMethod",
    method: "session/permissionProfileChanged",
  });
  assert.deepEqual(await outcome.io, []);
  assert.equal(transport.writes.length, 0);
  assert.deepEqual(session.fold.sessionState.families(), []);
});

test("TEST-42624-10 (stable SDK): a mode-only change folds the mode and the facade claims no Auto-review", async () => {
  const { session, transport } = wired();
  const modes = ["onRequest", "promptUnmatched", "allowAll", "denyUnmatched"] as const;
  for (const [index, mode] of modes.entries()) {
    // A distinct cursor per event: an equal cursor is a replay the store refuses.
    const event = approvalModeChanged(mode, `v:${index + 1}`);
    const outcome = session.apply(event);
    assert.equal(outcome.fold.kind, "sessionState", `${mode} folds as session state`);
    assert.deepEqual(session.fold.sessionState.get("session/approvalModeChanged"), event.params);
  }
  assert.deepEqual(session.fold.sessionState.families(), ["session/approvalModeChanged"]);
  // A later triple on the live projection changes nothing the fold holds.
  session.apply({
    method: "session/statusChanged",
    params: { sessionId: SESSION, status: "idle", viewCursor: null, permissionState: TRIPLE },
  } as WireFrame);
  assert.deepEqual(session.fold.sessionState.families(), ["session/approvalModeChanged"]);
  assert.equal(transport.writes.length, 0);
  // INV-42624-1 tripwire: the stable facade exposes NO Auto-review / permission
  // state accessor, so nothing here can report "active" off the mode or a
  // label alone. A future accessor must flip this pin AND satisfy the triple.
  assert.deepEqual(claimSurface(session), [], "no Auto-review claim surface on the stable facade");
});

test("TEST-42624-10 (stable SDK): the claim-surface tripwire sees a public INSTANCE field, not just the prototype", () => {
  // Review 5438019145 P1 4203396788: the facade keeps public state on the
  // instance (`sessionId`, `opening`), so a future `permissionState` field
  // lands there; a prototype-only scan would stay green. `#private` fields
  // never enumerate, so scanning the instance adds no false positive.
  const { session } = wired();
  (session as unknown as Record<string, unknown>)["permissionState"] = {};
  assert.deepEqual(claimSurface(session), ["permissionState"], "a planted instance field trips the pin");
});
