/**
 * `sdk_source_closure_manifest` — `scripts/sdk-source-closure.json`, the
 * authoritative list of what gets mirrored into `meta-models/muse-code-sdk`
 * for the `@muse-code/sdk` publication (owner charter, hub #24410 06:51Z).
 *
 * The manifest is consumed off this repository: the mirror's `publish-npm.yml`
 * is a thin caller that invokes `scripts/publish-sdk-npm.sh` by path, and when
 * that file is missing it fails with an error naming this manifest as the place
 * the path must be listed. So the failure mode this file guards is a silent one
 * — a closure path renamed or deleted here, the manifest left behind, and the
 * next republish producing a mirror that cannot publish.
 *
 * Every assertion below is derived from the tree, not copied from it: no digest,
 * no count, no second copy of a path list.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `dist/test/` -> `dist/` -> `clients/sdk-ts/` -> `clients/` -> project root. */
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..", "..");
const manifestPath = join(projectRoot, "scripts", "sdk-source-closure.json");

/** The path the mirror's publish workflow invokes, and fails loudly without. */
const PUBLISH_SCRIPT = "scripts/publish-sdk-npm.sh";

interface ClosureManifest {
  artifact: string;
  producer: { repository: string };
  mirror: { repository: string; python_tree?: string[]; rust_tree?: string[] };
  closure_paths: string[];
  path_notes: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ClosureManifest;

test("every closure path still exists in the tree", () => {
  const missing = manifest.closure_paths.filter((p) => !existsSync(join(projectRoot, p)));
  assert.deepEqual(
    missing,
    [],
    "a closure path that no longer exists is a republish that silently ships " +
      "less than it claims; rename it here in the same change that renames it " +
      "in the tree",
  );
});

test("the publish script is in the closure and is executable", () => {
  // Both halves matter. The mirror workflow's guard is `[ -x ... ]`, so a
  // mirrored-but-non-executable script fails there exactly as a missing one
  // does, and the error text points back at this manifest either way.
  assert.ok(
    manifest.closure_paths.includes(PUBLISH_SCRIPT),
    `${PUBLISH_SCRIPT} must be a closure path: the mirror's publish-npm.yml ` +
      "holds no publishing logic and calls it by path, so a republish without " +
      "it produces a mirror whose publish workflow dead-ends",
  );
  assert.ok(
    statSync(join(projectRoot, PUBLISH_SCRIPT)).mode & 0o111,
    "the mirror checks the execute bit, so it has to survive the mirror",
  );
});

/** The Python publish path (#638 S6): the gate script the mirror's
 * publish-pypi.yml calls by path, and the row generator it calls in turn.
 * Same silent failure mode as PUBLISH_SCRIPT: dropped from the closure, the
 * next republish produces a mirror whose Python publish dead-ends. The
 * tree->list direction (which Python paths must be here at all) lives with
 * the Python suite, clients/sdk-py/tests/test_source_closure.py. */
const PYPI_PUBLISH_SCRIPTS = ["scripts/publish-sdk-pypi.sh", "scripts/sdk-py-wheel-rows.py"];

test("the Python publish scripts are in the closure and executable", () => {
  for (const script of PYPI_PUBLISH_SCRIPTS) {
    assert.ok(
      manifest.closure_paths.includes(script),
      `${script} must be a closure path: the mirror's publish-pypi.yml holds ` +
        "no publishing logic and calls the gate script by path, and the gate " +
        "script calls the row generator by path",
    );
    assert.ok(
      statSync(join(projectRoot, script)).mode & 0o111,
      `${script}: the mirror checks the execute bit, so it has to survive the mirror`,
    );
  }
});

test("the mirror section states the python/ destination for the Python closure", () => {
  // The Python closure lands under the mirror's python/ tree, unlike the TS
  // paths' verbatim layout. The bridge operator reads this manifest, so the
  // divergence has to be stated here, not remembered.
  assert.match(
    (manifest.mirror.python_tree ?? []).join(" "),
    /python\//,
    "the manifest no longer explains where the Python closure lands in the mirror",
  );
});

/** The Rust publish path: the crates.io gate script the mirror's
 * publish-crates.yml calls by path, with the PUBLISH_SCRIPT failure mode. */
const CRATES_PUBLISH_SCRIPT = "scripts/publish-sdk-crates.sh";
/** The Rust crate, carried by its shipped set rather than as one directory. */
const RUST_CRATE = "clients/sdk-rs";
/** A path_notes note opening with this lands its entry under the mirror's
 * rust/ tree: the re-mirror copy and the anchor digest route by it. */
const RUST_NOTE = "Rust closure";

test("the crates.io publish script is in the closure and executable", () => {
  assert.ok(
    manifest.closure_paths.includes(CRATES_PUBLISH_SCRIPT),
    `${CRATES_PUBLISH_SCRIPT} must be a closure path: the mirror's publish-crates.yml ` +
      "holds no publishing logic and calls it by path",
  );
  assert.ok(
    statSync(join(projectRoot, CRATES_PUBLISH_SCRIPT)).mode & 0o111,
    `${CRATES_PUBLISH_SCRIPT}: the mirror checks the execute bit, so it has to survive the mirror`,
  );
});

test("the mirror section states the rust/ destination for the Rust closure", () => {
  assert.match(
    (manifest.mirror.rust_tree ?? []).join(" "),
    /rust\//,
    "the manifest no longer explains where the Rust closure lands in the mirror",
  );
});

test("the Rust closure is exactly the crate's packaged set", () => {
  // The mirror carries what crates.io ships and nothing more: the crate's
  // tests and process notes stay internal, so listing the crate directory
  // whole would publish them. Derived from the manifest's `include` list,
  // never a second hand-kept copy of it.
  const cargo = readFileSync(join(projectRoot, RUST_CRATE, "Cargo.toml"), "utf8");
  const include = /^include\s*=\s*\[([^\]]*)\]/m.exec(cargo)?.[1];
  assert.ok(include !== undefined, `${RUST_CRATE}/Cargo.toml must declare the packaged set in an \`include\` list`);
  const packaged = [...include.matchAll(/"([^"]+)"/g)]
    .map((match) => `${RUST_CRATE}/${(match[1] ?? "").replace(/\/\*\*$/, "")}`)
    .sort();
  const listed = manifest.closure_paths.filter((p) => p === RUST_CRATE || p.startsWith(`${RUST_CRATE}/`));
  assert.deepEqual(
    listed,
    packaged,
    "the Rust closure entries must equal the crate's `include` list, entry for entry",
  );
});

test("exactly the Rust closure entries carry the note that routes them under rust/", () => {
  const rustEntries = manifest.closure_paths.filter(
    (p) => p === CRATES_PUBLISH_SCRIPT || p.startsWith(`${RUST_CRATE}/`),
  );
  const marked = Object.entries(manifest.path_notes)
    .filter(([, note]) => note.startsWith(RUST_NOTE))
    .map(([path]) => path)
    .sort();
  assert.deepEqual(
    marked,
    rustEntries,
    `exactly the Rust entries carry the "${RUST_NOTE}" note opening; any other entry lands at its verbatim layout`,
  );
});

test("every closure path is explained, and every explanation names a real path", () => {
  const paths = new Set(manifest.closure_paths);
  const noted = new Set(Object.keys(manifest.path_notes));
  assert.deepEqual(
    manifest.closure_paths.filter((p) => !noted.has(p)),
    [],
    "the closure is published source: a path nobody can explain is a path " +
      "nobody decided to publish",
  );
  assert.deepEqual(
    [...noted].filter((p) => !paths.has(p)),
    [],
    "a note for a path that left the closure is stale prose",
  );
});

test("the closure list is sorted, deduplicated, and non-overlapping", () => {
  const sorted = [...manifest.closure_paths].sort();
  assert.deepEqual(
    manifest.closure_paths,
    sorted,
    "sorted so an added path lands in one obvious place rather than wherever " +
      "the adding PR happened to append it",
  );
  assert.equal(
    new Set(manifest.closure_paths).size,
    manifest.closure_paths.length,
    "a duplicated path mirrors twice",
  );
  for (const a of manifest.closure_paths) {
    for (const b of manifest.closure_paths) {
      if (a === b) continue;
      assert.ok(
        !b.startsWith(`${a}/`),
        `${b} is inside ${a}; a nested entry makes what the republish copies ` +
          "depend on the order it walks the list",
      );
    }
  }
});

test("the manifest names the public venue as the mirror, never this repository", () => {
  // The producer side carries no internal name: the public-mirror scrub
  // removed the private repository and monorepo path from this mirrored
  // file. The pin stays —
  // now on the public-safe wording — so a republish still cannot silently
  // point at this private repository (a loop, not a publication).
  assert.deepEqual(
    manifest.producer,
    { repository: "the internal source tree" },
    "the producer block carries exactly the public-safe wording and nothing else",
  );
  assert.equal(
    manifest.mirror.repository,
    "meta-models/muse-code-sdk",
    "the mirror is the public venue (ADR 21932 Amendment 1, owner launch " +
      "ruling 3); pointing a republish at this private repository would be a " +
      "loop, not a publication",
  );
});
