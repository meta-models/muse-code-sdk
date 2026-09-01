/**
 * `npm_publication_readiness` — the packaging metadata `@muse-code/sdk` needs before
 * an `npm publish` is even runnable (owner launch ruling 4, hub #24410; the
 * long-pole item 1 of #25304).
 *
 * This file pins the PACKAGE SHAPE, not the decision to publish. D-013's
 * "no published SDK before 1.0" was amended on 2026-08-31 by D-053
 * (`specs/13929-msp-activation/decision.md`): publishing at 0.x is permitted,
 * the stability promise is still withheld, and the published README must say so
 * — a condition `scripts/publish-sdk-npm.sh` gates on rather than one this file
 * asserts. What remains behind owner steps on #25304 is the registry side: the
 * `@muse-code` scope and the trusted publisher. The pins here exist so the
 * shape cannot silently regress, and so the tarball's contents are a checked
 * contract rather than whatever `dist/` happened to hold on the publishing
 * machine.
 *
 * The `files` whitelist is the load-bearing one. `tsc --build` emits `dist/qa`
 * and `dist/test` beside `dist/src`, and the QA harness carries the conformance
 * oracle, the wire taps, and the fixture-host driver — none of which belong in a
 * package an external consumer installs (the external-audience source profile,
 * #25857). A whitelist that drifted to `dist` would ship all three.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `dist/test/` -> `dist/` -> `clients/sdk-ts/`. */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");

interface SdkManifest {
  name: string;
  version: string;
  private?: boolean;
  license?: string;
  homepage?: string;
  repository?: { type?: string; url?: string; directory?: string };
  bugs?: { url?: string };
  files?: string[];
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  publishConfig?: { access?: string };
}

const manifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf8"),
) as SdkManifest;

/** The one public venue, per ADR 21932 Amendment 1 and owner launch ruling 3. */
const TARGET_REPO = "meta-models/muse-code-sdk";

test("the package name is the ruled npm scope, @muse-code", () => {
  assert.equal(
    manifest.name,
    "@muse-code/sdk",
    'owner ruling, verbatim: "Let\'s do @muse-code/sdk." (hub #24410, 04:15Z). ' +
      `The pre-rename name ${["@muse", "/sdk"].join("")} is not ours on the ` +
      "registry and must not reappear",
  );
});

test("the manifest is not marked private", () => {
  assert.ok(
    !("private" in manifest),
    "`private: true` makes `npm publish` refuse outright; the field is removed " +
      "rather than set to false so nothing reads as a deliberate opt-out",
  );
});

test("the version stays inside 0.x", () => {
  // Deliberately a ratchet, not an equality. `assert.equal(version, "0.1.0")`
  // would be a hand-copy of the value in package.json — the content-pin rule —
  // and the first legitimate 0.1.1 would red this file for no behavioural
  // reason. The durable contract is the 0.x posture, which is what D-013
  // actually withholds; the specific 0.1.0 the owner ruled is enforced where it
  // is load-bearing, by scripts/publish-sdk-npm.sh's already-published gate.
  assert.match(
    manifest.version,
    /^0\./,
    "D-013 withholds the stability promise until 1.0, and D-053 did not give it " +
      "back — it permitted PUBLISHING at 0.x, so the version itself is what " +
      "keeps a released package from implying a compatibility claim. Leaving " +
      "0.x is D-022's single leave-0.x/declare-v1 event, not a version bump",
  );
});

test("the licence is MIT (owner ruling 3, provisional)", () => {
  assert.equal(
    manifest.license,
    "MIT",
    "npm reads this field for the package page; the LICENSE text itself lands " +
      "on " + TARGET_REPO + " under the hygiene lane",
  );
});

test("every outbound link points at the public venue, not at this repo", () => {
  assert.equal(manifest.homepage, `https://github.com/${TARGET_REPO}`);
  assert.equal(manifest.repository?.type, "git");
  assert.equal(
    manifest.repository?.url,
    `git+https://github.com/${TARGET_REPO}.git`,
  );
  assert.equal(
    manifest.repository?.directory,
    "clients/sdk-ts",
    "the mirror keeps the closure's layout, so the subdirectory pointer is the " +
      "same path on both sides",
  );
  assert.equal(
    manifest.bugs?.url,
    `https://github.com/${TARGET_REPO}/issues`,
    "npm renders this as the package page's Issues link; pointed at the private " +
      "repo it 404s for every reader",
  );

  // Sweep the WHOLE manifest, not a list of fields someone has to remember to
  // extend. A hand-picked list is what let `bugs.url` through in the first
  // place, and it would have let a planted `contributors[].url` through too.
  // Nothing legitimate in this manifest contains the private slug, so any
  // occurrence anywhere is the defect.
  assert.ok(
    !JSON.stringify(manifest).includes("mslsrc/tbh"),
    "an installed package must not advertise this private repository anywhere " +
      `in its manifest: ${JSON.stringify(manifest)}`,
  );
});

test("the files whitelist ships the library and nothing else", () => {
  assert.deepEqual(
    manifest.files,
    ["dist/src"],
    "an explicit whitelist, not an ignore list: a new top-level directory then " +
      "defaults to NOT shipping. Widening this to `dist` — or adding `qa`, " +
      "`test` or `src` — ships the QA harness, the conformance oracle and the " +
      "wire taps to every external consumer; scripts/publish-sdk-npm.sh proves " +
      "that consequence by auditing the packed tarball, where the same drift " +
      "surfaces as unexpected dist/qa and dist/test paths",
  );
});

test("the tarball's entry points resolve inside the whitelisted directory", () => {
  const main = (manifest as unknown as { main?: string }).main;
  const types = (manifest as unknown as { types?: string }).types;
  for (const [field, value] of [
    ["main", main],
    ["types", types],
  ] as const) {
    assert.ok(value, `${field} must be declared`);
    assert.ok(
      value.startsWith("dist/src/"),
      `${field} (${value}) points outside the files whitelist, so the published ` +
        "tarball would be missing its own entry point",
    );
  }
});

test("packing builds first, so a clean checkout cannot publish a stale dist", () => {
  const prepack = manifest.scripts?.prepack ?? "";
  assert.match(
    prepack,
    /\bnpm run build\b/,
    "`dist/` is gitignored; without prepack, `npm pack` on a fresh clone " +
      "produces a tarball with no code in it and npm reports no error",
  );
  // The tarball also has to carry the MSP declarations it names, and that step
  // runs on the build output — so it belongs after the build, in prepack, not
  // in `build` where an ordinary `npm run build` would rewrite `dist/`.
  assert.match(
    prepack,
    /bundle-msp-types\.mjs$/,
    "`@muse-code/msp` is private and unpublished, so the pack step must bundle " +
      "its declarations; without this the tarball ships unresolvable imports",
  );
});

test("a scoped package must opt in to public access explicitly", () => {
  assert.equal(
    manifest.publishConfig?.access,
    "public",
    "npm defaults a scoped package to restricted; the default would publish a " +
      "paid-org-private package, which is not what the ruling asked for",
  );
});

test("preparing for npm did not smuggle in a runtime dependency (INV-009)", () => {
  assert.deepEqual(
    Object.keys(manifest.dependencies ?? {}),
    [],
    "spec 14990 INV-009 is unchanged by packaging: a runtime dependency is an " +
      "owner escalation under the O-3 precedent",
  );
  assert.ok(
    manifest.devDependencies?.["@muse-code/msp"],
    "@muse-code/msp stays a devDependency for now — it is a types-only " +
      "workspace package whose sole file re-exports schema/msp/msp.d.ts from " +
      "OUTSIDE its own package root, so it is not yet publishable. Promoting it " +
      "to `dependencies` before it exists on the registry would turn a dangling " +
      "type reference into a hard `npm install` failure, which is strictly " +
      "worse. The decision and its sequencing are stated in the PR body and on " +
      "#25304.",
  );
  assert.ok(
    !JSON.stringify(manifest).includes('"@muse/'),
    "no @muse/* specifier may survive the scope rename anywhere in the manifest",
  );
});
