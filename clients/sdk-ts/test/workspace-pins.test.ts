/**
 * TEST-008 `workspace_pins_and_zero_deps` — spec 14990 FR-003/FR-004/FR-006,
 * INV-008/INV-009.
 *
 * Three pins that must not drift:
 *  - the schema fingerprint against `schema/msp/stable/manifest.json`;
 *  - the TypeScript version against `scripts/check-msp-ts-typecheck.sh`;
 *  - zero runtime dependencies in both workspace packages.
 * Plus the no-copy rule: no vendored `msp.d.ts` under `clients/`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EXPECTED_SCHEMA_FINGERPRINT,
  checkServedFingerprint,
  fingerprintMismatchMessage,
} from "../src/index.js";

/** `dist/test/` -> `dist/` -> `clients/sdk-ts/` -> `clients/` -> project root. */
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..", "..");

function read(relative: string): string {
  return readFileSync(join(projectRoot, relative), "utf8");
}

test("the pinned fingerprint equals the stable schema manifest", () => {
  const manifest = JSON.parse(read("schema/msp/stable/manifest.json")) as {
    fingerprint: string;
  };
  assert.equal(
    EXPECTED_SCHEMA_FINGERPRINT,
    manifest.fingerprint,
    fingerprintMismatchMessage(EXPECTED_SCHEMA_FINGERPRINT, manifest.fingerprint),
  );
});

test("a fingerprint mismatch says re-pin, not 'the SDK is broken'", () => {
  const message = fingerprintMismatchMessage("sha256:aaa", "sha256:bbb");
  assert.ok(
    message.includes("re-pin after a schema advance"),
    "the message must name the remedy",
  );
  assert.ok(
    message.includes("scripts/regen-msp-pins.sh"),
    "the remedy is the one regeneration command (#20521 FR-008), never a hand edit",
  );
  assert.ok(
    !message.includes("by updating"),
    "the old hand-edit instruction is gone (#20521 FR-008)",
  );
  assert.ok(
    message.includes("does NOT mean the SDK is broken"),
    "the message must rule out the wrong reading that has cost lanes time",
  );
  assert.ok(message.includes("sha256:aaa") && message.includes("sha256:bbb"));
});

test("a served fingerprint mismatch warns and never throws (SS1.4.1)", () => {
  assert.equal(checkServedFingerprint(EXPECTED_SCHEMA_FINGERPRINT), undefined);
  const warning = checkServedFingerprint("sha256:something-else");
  assert.ok(warning, "a mismatch must be surfaced");
  assert.equal(warning.kind, "schemaFingerprintMismatch");
  assert.equal(warning.served, "sha256:something-else");
  assert.equal(warning.pinned, EXPECTED_SCHEMA_FINGERPRINT);
});

test("the TypeScript pin matches the one CI already enforces", () => {
  const script = read("scripts/check-msp-ts-typecheck.sh");
  const match = /TYPESCRIPT_VERSION="([^"]+)"/.exec(script);
  assert.ok(match, "check-msp-ts-typecheck.sh must pin a TypeScript version");
  const scriptPin = match[1];

  const rootManifest = JSON.parse(read("package.json")) as {
    devDependencies?: Record<string, string>;
  };
  assert.equal(
    rootManifest.devDependencies?.typescript,
    scriptPin,
    "the workspace and the CI typecheck script must pin the same compiler",
  );
});

test("both packages declare zero runtime dependencies (INV-009)", () => {
  for (const manifestPath of ["clients/sdk-ts/package.json", "clients/msp-ts/package.json"]) {
    const manifest = JSON.parse(read(manifestPath)) as {
      dependencies?: Record<string, string>;
    };
    const runtimeDeps = Object.keys(manifest.dependencies ?? {});
    assert.deepEqual(
      runtimeDeps,
      [],
      `${manifestPath} must declare no runtime dependencies; a proposed one is ` +
        "an owner escalation under the O-3 precedent, not a local decision",
    );
  }
});

test("the generated declarations are consumed in place, never copied (INV-008)", () => {
  assert.ok(
    !existsSync(join(projectRoot, "clients/msp-ts/msp.d.ts")),
    "a vendored copy of msp.d.ts would fork from the artifact #206 owns",
  );
  const reexport = read("clients/msp-ts/index.d.ts");
  // The specifier is written `msp.js` because TypeScript resolves a `.js`
  // module specifier to the `.d.ts` beside it; what matters here is that it
  // points INTO schema/msp/ rather than at anything under clients/.
  assert.ok(
    /from\s+"\.\.\/\.\.\/schema\/msp\/msp(\.js)?"/.test(reexport),
    "@muse-code/msp must re-export the committed artifact at its own path",
  );
});
