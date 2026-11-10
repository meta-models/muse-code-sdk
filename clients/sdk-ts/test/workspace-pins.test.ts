/**
 * TEST-008 `workspace_pins_and_zero_deps` — spec 14990 FR-003/FR-004/FR-006,
 * INV-008/INV-009.
 *
 * Three pins that must not drift:
 *  - the schema fingerprint: well-formed AND equal to the port's derivation
 *    over the live stable schema bytes (ADR 77546 D4: the value derives at
 *    build; the receipt-pins gate proves the committed source carries the
 *    hook and no literal);
 *  - the TypeScript version against `scripts/check-msp-ts-typecheck.sh`;
 *  - zero runtime dependencies in both workspace packages.
 * Plus the no-copy rule: no vendored `msp.d.ts` under `clients/`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
/** `dist/test/` -> `dist/` -> `clients/sdk-ts/`. */
const packageRoot = join(here, "..", "..");

function read(relative: string): string {
  return readFileSync(join(projectRoot, relative), "utf8");
}

/** Run the derivation port's CLI once; the file-arg path (the vector suite covers stdin). */
function deriveStableOverSchema(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(packageRoot, "scripts", "msp-fingerprint.mjs"),
        "stable",
        join(projectRoot, "schema", "msp", "stable", "msp.schema.json"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`the derivation port refused the live stable schema: ${stderr.trim()}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

test("the pinned fingerprint is a well-formed fingerprint", () => {
  // #77546: no committed copy of the fingerprint remains — the value
  // derives at build from the schema bytes. This arm keeps the cheap local
  // half: the derived value is a well-formed fingerprint, and the
  // mismatch message names the remedy.
  assert.match(
    EXPECTED_SCHEMA_FINGERPRINT,
    /^sha256:[0-9a-f]{64}$/,
    "EXPECTED_SCHEMA_FINGERPRINT is malformed; rebuild via `npm run build`",
  );
  const message = fingerprintMismatchMessage(
    EXPECTED_SCHEMA_FINGERPRINT,
    "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  assert.ok(
    message.includes(EXPECTED_SCHEMA_FINGERPRINT),
    "the mismatch message must name the pin",
  );
});

test("the built fingerprint equals the derivation over the live stable schema", async () => {
  // The stamp-freshness proof: the value the build stamped is exactly what
  // the port derives from the schema bytes in this tree. A stale `dist/`
  // (built, then the schema advanced without rebuilding) fails here — the
  // same staleness-is-never-silent promise the old manifest test kept.
  assert.equal(
    EXPECTED_SCHEMA_FINGERPRINT,
    await deriveStableOverSchema(),
    "the stamped value drifted from the live stable schema bytes; rebuild",
  );
});

test("a fingerprint mismatch says rebuild, not 'the SDK is broken'", () => {
  const message = fingerprintMismatchMessage("sha256:aaa", "sha256:bbb");
  assert.ok(
    message.includes("rebuild after a schema advance"),
    "the message must name the remedy",
  );
  assert.ok(
    message.includes("npm run build"),
    "the remedy is the one build command, never a hand edit",
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

test("the stamped module is gitignored, never committed", () => {
  // The stamp output carries the derived value: committing it would
  // reintroduce exactly the content pin the stamp exists to remove (one
  // shared line every schema advance rewrites). The ignore entry is the
  // guard; this arm fails if it is ever dropped.
  const gitignore = read(".gitignore");
  assert.ok(
    gitignore.split("\n").some((line) => line.trim() === "/clients/sdk-ts/src/fingerprint.stamped.ts"),
    "the stamped module must stay gitignored",
  );
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
