/**
 * T019's INV-001 discharge — the pending set's ack/disposition vocabulary is
 * IMPORTED from the generated layer, not restated locally.
 *
 * INV-001 carried ONE recorded interim exception: `PendingDisposition`,
 * `PendingCommandAck`, the `-32030` code, and the `"commandRejected"` kind
 * check were hand-written in `pending-command-set.ts` because the generated
 * layer did not describe them. Spec 206 Phase 11 (#22772) enrolled all four,
 * so the exception is discharged by re-binding — and by these arms, which
 * fail while any of the four is still hand-carried.
 *
 * WHY A SOURCE GUARD. "Never restate a wire shape" is a statement about the
 * SOURCE, not about runtime values: a hand-written union and the generated one
 * are structurally identical, so a type-level assertion alone passes either
 * way — which is exactly why the drift was invisible. The no-vendored-copy
 * guard for INV-008 in `workspace-pins.test.ts` reads source text for the same
 * reason.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { MspErrorDataKind, TurnStartDisposition, TurnStartResult } from "@muse/msp";

import {
  COMMAND_REJECTED_CODE,
  COMMAND_REJECTED_KIND,
  PendingCommandSet,
} from "../src/index.js";
import type { PendingCommandAck, PendingDisposition } from "../src/index.js";

/** `dist/test/` -> `dist/` -> `clients/sdk-ts/` -> `clients/` -> project root. */
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..", "..");

const PENDING_SOURCE_PATH = "clients/sdk-ts/src/pending/pending-command-set.ts";

function read(relative: string): string {
  return readFileSync(join(projectRoot, relative), "utf8");
}

interface ErrorRegistryRow {
  readonly code: number;
  readonly kind: string;
}

function registryRow(kind: string): ErrorRegistryRow {
  const bundle = JSON.parse(read("schema/msp/stable/msp.schema.json")) as {
    errors: ErrorRegistryRow[];
  };
  const row = bundle.errors.find((e) => e.kind === kind);
  if (row === undefined) {
    throw new Error(`the stable bundle must register an error row for \`${kind}\``);
  }
  return row;
}

// ---- the source arms: nothing is restated locally -------------------------

test("the pending set imports its ack/disposition vocabulary from @muse/msp (INV-001)", () => {
  const source = read(PENDING_SOURCE_PATH);
  const imports = /import type \{([^}]*)\} from "@muse\/msp";/s.exec(source);
  const names = imports?.[1];
  if (names === undefined) {
    throw new Error(`${PENDING_SOURCE_PATH} must type-import from @muse/msp`);
  }
  const imported = new Set(names.split(",").map((s) => s.trim()).filter(Boolean));

  for (const name of ["TurnStartDisposition", "TurnStartResult", "MspErrorDataKind"]) {
    assert.ok(
      imported.has(name),
      `the re-bind must import \`${name}\` from the generated layer; imported: ` +
        `${[...imported].join(", ")}`,
    );
  }
});

test("the disposition union is no longer restated in the SDK (INV-001)", () => {
  const source = read(PENDING_SOURCE_PATH);
  assert.ok(
    !/"started"\s*\|\s*"queued"\s*\|\s*"steered"/.test(source),
    "the SS3.2 disposition union belongs to the generated layer; a local copy " +
      "drifts silently because the two are structurally identical",
  );
});

test("the disposition and ack types ARE the generated ones, asserted positively (INV-001)", () => {
  // The negative regex above only bans one exact member order; a re-hand-copied
  // union in any other order slips through it and stays structurally identical,
  // so no type round-trip can see it either. Pinning the binding LINE means any
  // restatement — reordered or not — fails here.
  const source = read(PENDING_SOURCE_PATH);
  assert.match(
    source,
    /export type PendingDisposition = TurnStartDisposition;/,
    "PendingDisposition must be the generated TurnStartDisposition by alias, not a copy",
  );
  assert.match(
    source,
    /export type PendingCommandAck = Readonly<Pick<TurnStartResult, "turnId" \| "disposition">>;/,
    "PendingCommandAck must derive from the generated TurnStartResult, not a copy",
  );
});

test("the settlement code is one named export, not an unchecked private literal", () => {
  // The types-only `@muse/msp` package carries no VALUES, so the registry code
  // cannot be imported the way the types can. The discharge is that the SDK
  // names it exactly once, exports it, and a test pins that export to the
  // enrolled row below — the same shape as `EXPECTED_SCHEMA_FINGERPRINT`.
  const source = read(PENDING_SOURCE_PATH);
  // Comments may cite the code freely; what must not exist twice is a second
  // executable copy, because only the exported one is pinned below.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(
    (code.match(/-32030/g) ?? []).length,
    1,
    "a second executable copy of the code is one no pin compares against",
  );
  assert.match(
    source,
    /export const COMMAND_REJECTED_CODE[^\n]*=\s*-32030;/,
    "the code must be exported so the registry pin can reach it; a private " +
      "literal is the hand-carry INV-001's exception recorded",
  );
});

test("the interim-exception notice is retired from the module (T019)", () => {
  const source = read(PENDING_SOURCE_PATH);
  assert.ok(
    !/until the #206 ack\/disposition enrollment lands/.test(source),
    "the exception is discharged; prose that still claims it is live is drift",
  );
});

// ---- the registry arms: the settlement vocabulary is pinned ---------------

test("the settlement code equals the committed commandRejected registry row", () => {
  const row = registryRow("commandRejected");
  assert.equal(
    COMMAND_REJECTED_CODE,
    row.code,
    "a schema advance that moves the code must red this lane, not silently " +
      "leave the SDK settling on a code the host no longer sends",
  );
});

test("the settlement kind is the generated closed error vocabulary's member", () => {
  const row = registryRow("commandRejected");
  assert.equal(COMMAND_REJECTED_KIND, row.kind);

  // The annotation is what makes a typo a compile error: `MspErrorDataKind` is
  // the CLOSED registry vocabulary, so `"commandRejcted"` no longer typechecks
  // the way it did against the open `ErrorKind`.
  const bound: Extract<MspErrorDataKind, "commandRejected"> = COMMAND_REJECTED_KIND;
  assert.equal(bound, "commandRejected");
});

test("only the registered code/kind settles; every other registry row holds", () => {
  const bundle = JSON.parse(read("schema/msp/stable/msp.schema.json")) as {
    errors: ErrorRegistryRow[];
  };
  for (const row of bundle.errors) {
    const settles = PendingCommandSet.isSettlement({ code: row.code, kind: row.kind });
    assert.equal(
      settles,
      row.kind === "commandRejected",
      `\`${row.kind}\` (${row.code}) must ${row.kind === "commandRejected" ? "" : "NOT "}` +
        "settle a pending command (SS4.13 nothing-admitted errors are not settlements)",
    );
  }
});

// ---- the type arms: the pair the generated ack carries --------------------

test("a generated TurnStartResult IS the ack the pending set accepts", () => {
  // The connection layer gets a `TurnStartResult` back from `turn/start`; the
  // discharge means it hands that value straight to `acked()` with no local
  // re-shaping (T019: the `turnId`/`disposition` pair IS `PendingCommandAck`).
  const result: TurnStartResult = {
    commandId: "cmd-1",
    disposition: "queued",
    startedNewTurn: false,
    status: "accepted",
    turnId: "cmd-1",
  };
  const ack: PendingCommandAck = result;

  const set = new PendingCommandSet<string>();
  set.submitted({ commandId: "cmd-1", input: "hi" });
  set.acked("cmd-1", ack);

  assert.equal(set.get("cmd-1")?.ack?.disposition, "queued");
  assert.equal(set.get("cmd-1")?.ack?.turnId, "cmd-1");
});

test("PendingDisposition is the generated TurnStartDisposition", () => {
  const generated: TurnStartDisposition = "steered";
  const pending: PendingDisposition = generated;
  const backAgain: TurnStartDisposition = pending;
  assert.equal(backAgain, "steered");
});
