/**
 * TEST-95605-1/2 (the client arms): the stable TypeScript SDK's arms for
 * the `needsInput` status (ADR 95605 D1/D2/D4).
 *
 * The stable SDK negotiates no `experimentalApi`, so on its own connection
 * the `needsInput` word is GATE-FALLBACK-REWRITTEN to `idle` and the
 * `needsInputReasons` member is STRIPPED (the stable bundle carries
 * neither). Its arms are therefore the Compatibility arms, not a
 * renders-needs-input predicate:
 *
 * - the stripped member is unknown evidence (schema pin: stable lacks it,
 *   experimental carries it; stable lists only the three old status
 *   words, experimental carries the `needsInput` arm);
 * - the experimental frame arriving anyway — an embedder that opted in —
 *   rides `session/statusChanged` tolerated losslessly: no fold state,
 *   no I/O, no throw (SS1.5.4). The SDK's session-table surface for the
 *   push is follow-up work (the fold already excludes it as a live
 *   host-state projection); this test pins only that the frame cannot
 *   break the fold.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Connection, Session } from "../src/index.js";
import { FakeDuplex } from "./helpers/fake-duplex.js";

const SESSION = "s-1";

// dist/test/<file>.js → clients/sdk-ts/dist/test → the workspace root
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..", "..");

type WireFrame = Parameters<Session<string>["apply"]>[0];

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

function schema(bundle: "stable" | "experimental"): {
  readonly defs: Record<string, { properties?: Record<string, unknown>; enum?: string[]; oneOf?: Array<{ enum?: string[]; const?: string }> }>;
} {
  const raw = JSON.parse(
    readFileSync(join(projectRoot, "schema", "msp", bundle, "msp.schema.json"), "utf8"),
  ) as { $defs: Record<string, { properties?: Record<string, unknown>; enum?: string[]; oneOf?: Array<{ enum?: string[]; const?: string }> }> };
  return { defs: raw.$defs };
}

/** Every string word a SessionStatus def declares, flat or oneOf-split. */
function statusWords(def: { enum?: string[]; oneOf?: Array<{ enum?: string[]; const?: string }> }): string[] {
  const words = [...(def.enum ?? [])];
  for (const arm of def.oneOf ?? []) {
    words.push(...(arm.enum ?? []));
    if (arm.const !== undefined) words.push(arm.const);
  }
  return words;
}

test("TEST-95605 (stable SDK): needsInputReasons rides the experimental bundle only, and needsInput is its arm", () => {
  const stable = schema("stable");
  const experimental = schema("experimental");
  assert.equal("needsInputReasons" in (stable.defs["Session"]?.properties ?? {}), false, "stable Session carries no needsInputReasons");
  assert.equal("needsInputReasons" in (experimental.defs["Session"]?.properties ?? {}), true, "experimental Session carries it");
  assert.equal(
    "needsInputReasons" in (stable.defs["SessionStatusChangedParams"]?.properties ?? {}),
    false,
    "stable session/statusChanged carries no needsInputReasons",
  );
  assert.equal(
    "needsInputReasons" in (experimental.defs["SessionStatusChangedParams"]?.properties ?? {}),
    true,
    "experimental session/statusChanged carries it (additive-optional)",
  );
  assert.deepEqual(statusWords(stable.defs["SessionStatus"] ?? {}), ["notLoaded", "idle", "running"]);
  assert.ok(
    statusWords(experimental.defs["SessionStatus"] ?? {}).includes("needsInput"),
    "experimental SessionStatus carries the needsInput arm",
  );
  assert.deepEqual(
    (experimental.defs["NeedsInputReason"] as { enum?: string[] } | undefined)?.enum,
    ["approvalPending", "inputPending"],
  );
  assert.equal("NeedsInputReason" in stable.defs, false, "stable bundle carries no NeedsInputReason def");
});

test("TEST-95605 (stable SDK): session/statusChanged carrying needsInput is tolerated — no fold state, no I/O, no throw", async () => {
  const { session, transport } = wired();
  const frame: WireFrame = {
    method: "session/statusChanged",
    params: {
      sessionId: SESSION,
      status: "needsInput",
      viewCursor: null,
      attention: ["approvalPending"],
      needsInputReasons: ["approvalPending"],
    },
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
