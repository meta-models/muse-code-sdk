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
  producer: { repository: string; root: string };
  mirror: { repository: string };
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
  assert.equal(manifest.producer.repository, "mslsrc/tbh");
  assert.equal(
    manifest.mirror.repository,
    "meta-models/muse-code-sdk",
    "the mirror is the public venue (ADR 21932 Amendment 1, owner launch " +
      "ruling 3); pointing a republish at this private repository would be a " +
      "loop, not a publication",
  );
});
