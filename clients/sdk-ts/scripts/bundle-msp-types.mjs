#!/usr/bin/env node
/**
 * Make the packed tarball self-contained.
 *
 * `@muse-code/msp` is a private, types-only workspace package: it re-exports
 * `schema/msp/msp.d.ts` in place so there is exactly one copy of the generated
 * wire declarations (spec 14990 INV-008). That works everywhere inside this
 * repo and nowhere outside it — the package is not on the registry and is not a
 * dependency of `@muse-code/sdk`, so every shipped declaration that names it is
 * unresolvable for a customer (TS2307 under `skipLibCheck: false`).
 *
 * This step runs on `prepack`, between `tsc` and `npm pack`, and touches only
 * the build output:
 *
 *   1. copy the generated declarations to `dist/src/msp.d.ts`;
 *   2. repoint `from "@muse-code/msp"` in the emitted `.d.ts` files at it.
 *
 * Nothing is written into the source tree, so INV-008's single copy still
 * holds: `dist/` is build output. The copy cannot go stale where it matters,
 * because the pack that produces the tarball is the same step that re-copies
 * it verbatim. It is NOT short-lived — see the tail comment on why the build
 * stamp is left alone — so do not reason about it as if the next build undoes
 * it; only a rebuild that a real source change invalidates does that. The step
 * is idempotent.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = join(packageDir, "..", "..");
const generated = join(workspaceRoot, "schema", "msp", "msp.d.ts");
const distSrc = join(packageDir, "dist", "src");
const bundled = join(distSrc, "msp.d.ts");

const SPECIFIER = "@muse-code/msp";
/**
 * The package named as a MODULE, not merely mentioned. Several doc comments
 * survive into the emitted files and say `@muse-code/msp` in prose — those are
 * still true after bundling and resolve to nothing, so rewriting them would
 * corrupt the documentation to fix a problem it does not have.
 */
const AS_MODULE = new RegExp(String.raw`(from|import|require)\s*\(?\s*"${SPECIFIER}"`, "g");

function fail(message) {
  console.error(`bundle-msp-types: ${message}`);
  process.exit(1);
}

if (!statSync(generated, { throwIfNoEntry: false })?.isFile()) {
  fail(`no generated declarations at ${generated}; run the protocol generator first`);
}
if (!statSync(distSrc, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`no build output at ${distSrc}; run \`npm run build\` first`);
}

writeFileSync(
  bundled,
  [
    "// Generated MSP wire declarations, bundled into the published package.",
    "//",
    "// Copied verbatim from `schema/msp/msp.d.ts` at pack time by",
    "// `scripts/bundle-msp-types.mjs`. Do not edit, and do not commit: this file",
    "// exists only in build output, so the repo keeps one copy of the generated",
    "// artifact (spec 14990 INV-008) while the tarball stays self-contained.",
    "",
    readFileSync(generated, "utf8"),
  ].join("\n"),
);

/** Every emitted file under `dist/src`, deepest first is irrelevant — order-free. */
function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

let rewritten = 0;
for (const file of walk(distSrc)) {
  if (file === bundled) continue;
  const source = readFileSync(file, "utf8");
  AS_MODULE.lastIndex = 0;
  if (!AS_MODULE.test(source)) continue;

  if (!file.endsWith(".d.ts")) {
    // Every import of this package is `import type`, so it erases and no
    // emitted `.js` can name it as a module. If one ever does, the module has
    // runtime meaning and repointing a declaration would not be the fix.
    fail(`${relative(packageDir, file)} imports ${SPECIFIER} in emitted JavaScript, not just types`);
  }

  // `./msp.js` from `dist/src`, `../msp.js` from `dist/src/facade`, and so on.
  const hops = relative(dirname(file), bundled).split(sep).join("/").replace(/\.d\.ts$/, ".js");
  const target = hops.startsWith(".") ? hops : `./${hops}`;
  // Rewrite through the same regex that decided this file needs rewriting, so
  // mutation and guard cannot disagree. A blanket replace of the quoted
  // specifier would also hit a doc comment that happens to quote it — in a
  // file that imports the package, which is exactly where the leftover scan
  // is blind, because that scan only looks for module position too.
  AS_MODULE.lastIndex = 0;
  writeFileSync(
    file,
    source.replace(AS_MODULE, (match) => match.replace(`"${SPECIFIER}"`, `"${target}"`)),
  );
  rewritten += 1;
}

const leftover = [...walk(distSrc)].filter((f) => {
  if (f === bundled) return false;
  AS_MODULE.lastIndex = 0;
  return AS_MODULE.test(readFileSync(f, "utf8"));
});
if (leftover.length > 0) {
  fail(`${leftover.length} file(s) still name ${SPECIFIER} after the rewrite`);
}

// The build stamp is deliberately LEFT ALONE, and only `.d.ts` files are
// rewritten above.
//
// Dropping the stamp would be tidier — `dist/` would go back to a byte-faithful
// compile of `src/` on the next build. It is not worth what it costs. This
// script runs inside `prepack`, and the suite packs the real package directory
// while other `node --test` children are importing `dist/**/*.js`; without the
// stamp, prepack's `tsc --build` is a full rebuild that rewrites every one of
// those files underneath them, and a half-written module read mid-rewrite is a
// SyntaxError with nothing to blame it on. With the stamp intact the build is a
// no-op, no `.js` is touched, and nothing a running test imports ever moves.
//
// Leaving `dist/` repointed is harmless: the specifier it now carries resolves
// to a file that is really there, it is what we publish anyway, and any real
// source edit rebuilds it back to the bare specifier that the next prepack
// rewrites again.

console.log(`bundle-msp-types: bundled ${relative(packageDir, bundled)}, repointed ${rewritten} file(s)`);
