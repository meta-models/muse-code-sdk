/**
 * TEST-97527-6 (FR-97527-6) — per-release add-on tarball, re-vendor, provenance.
 *
 * `scripts/build-sdk-experimental-addon-tarball.sh` generates the add-on from
 * the schema bundles, compiles it against the SDK, and packs one tarball per
 * release; `scripts/revendor-sdk-experimental-addon.mjs` fetches the tarball
 * attached to the internal release; and
 * `scripts/check-sdk-experimental-addon-provenance.mjs` compares the vendored
 * copy's versions (package vs embedded vs pinned host) and reds on skew or
 * tamper. Release attach/fetch run over a fake `gh` against a fixture
 * release dir, so no test touches the network.
 *
 * Fixtures are SYNTHETIC (`x/…` and `s/…` names): no real experimental name
 * may appear in this suite (the public package this file ships beside must
 * never name one). Each test owns its temp dirs; child joins carry a
 * failure-only cap (the `timeout` below fires only on a wedge, never on the
 * green path).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `dist/test/` -> `dist/` -> `clients/sdk-ts/` -> `clients/` -> project root. */
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..", "..");
const buildScript = join(projectRoot, "scripts", "build-sdk-experimental-addon-tarball.sh");
const revendorScript = join(projectRoot, "scripts", "revendor-sdk-experimental-addon.mjs");
const provenanceScript = join(
  projectRoot,
  "scripts",
  "check-sdk-experimental-addon-provenance.mjs",
);
const tscBin = join(projectRoot, "node_modules", ".bin", "tsc");
const sdkDir = join(projectRoot, "clients", "sdk-ts");
const closureManifest = join(projectRoot, "scripts", "sdk-source-closure.json");

/** Failure-only cap for child joins: generous enough to diagnose a wedge. */
const CHILD_CAP_MS = 180000;

const HOST_VERSION = "1.2.3";
const PREVIOUS_VERSION = "1.2.2";

const STABLE_FIXTURE = {
  $defs: {
    ItemKind: { enum: ["stableA"] },
    SChangedParams: { properties: { sessionId: { type: "string" } }, type: "object" },
    SNewParams: { properties: { sessionId: { type: "string" } }, type: "object" },
    SNewResult: { properties: { ok: { type: "boolean" } }, type: "object" },
    SPingParams: { properties: { sessionId: { type: "string" } }, type: "object" },
    SPingResult: { properties: { pong: { type: "boolean" } }, type: "object" },
  },
  methods: {
    "s/new": {
      params: { $ref: "#/$defs/SNewParams" },
      result: { $ref: "#/$defs/SNewResult" },
      "x-msp-descriptor": "s/new",
    },
    "s/ping": {
      params: { $ref: "#/$defs/SPingParams" },
      result: { $ref: "#/$defs/SPingResult" },
      "x-msp-descriptor": "s/ping",
    },
  },
  notifications: {
    "s/changed": {
      params: { $ref: "#/$defs/SChangedParams" },
      "x-msp-descriptor": "s/changed",
    },
  },
  requests: {},
};

const PREVIOUS_STABLE_FIXTURE = {
  $defs: STABLE_FIXTURE.$defs,
  methods: {
    "s/ping": STABLE_FIXTURE.methods["s/ping"],
  },
  notifications: STABLE_FIXTURE.notifications,
  requests: {},
};

const EXPERIMENTAL_FIXTURE = {
  $defs: {
    ...STABLE_FIXTURE.$defs,
    ItemKind: {
      oneOf: [
        { enum: ["stableA"], type: "string" },
        { const: "xKind", type: "string", "x-msp-stability": "experimental" },
      ],
    },
    XAlphaResult: { properties: { alpha: { type: "string" } }, type: "object" },
    XEventParams: { properties: { sessionId: { type: "string" } }, type: "object" },
  },
  methods: {
    ...STABLE_FIXTURE.methods,
    "x/alpha": {
      result: { $ref: "#/$defs/XAlphaResult" },
      "x-msp-descriptor": "x/alpha",
      "x-msp-stability": "experimental",
    },
  },
  notifications: {
    ...STABLE_FIXTURE.notifications,
    "x/event": {
      params: { $ref: "#/$defs/XEventParams" },
      "x-msp-descriptor": "x/event",
      "x-msp-stability": "experimental",
    },
  },
  requests: {},
};

const MSP_TYPES_FIXTURE = `export interface SChangedParams {
  readonly sessionId: string;
}
export interface SNewParams {
  readonly sessionId: string;
}
export interface SNewResult {
  readonly ok: boolean;
}
export interface SPingParams {
  readonly sessionId: string;
}
export interface SPingResult {
  readonly pong: boolean;
}
export interface XAlphaResult {
  readonly alpha: string;
}
export interface XEventParams {
  readonly sessionId: string;
}
`;

/** A fixture release tree: bundles plus the experimental declarations. */
function writeTree(dir: string): void {
  mkdirSync(join(dir, "schema", "msp", "stable"), { recursive: true });
  mkdirSync(join(dir, "schema", "msp", "experimental"), { recursive: true });
  writeFileSync(join(dir, "schema", "msp", "stable", "msp.schema.json"), JSON.stringify(STABLE_FIXTURE));
  writeFileSync(
    join(dir, "schema", "msp", "experimental", "msp.schema.json"),
    JSON.stringify(EXPERIMENTAL_FIXTURE),
  );
  writeFileSync(join(dir, "schema", "msp", "experimental", "msp.d.ts"), MSP_TYPES_FIXTURE);
  writeFileSync(join(dir, "previous-stable.json"), JSON.stringify(PREVIOUS_STABLE_FIXTURE));
}

function freshRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function cleanup(root: string): void {
  rmSync(root, { force: true, recursive: true });
}

function git(args: readonly string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "user.email",
      // Split so no address literal appears in published source (the
      // source-audience gate fails closed on the mechanical shape).
      GIT_CONFIG_VALUE_0: ["addon-test", "example.invalid"].join("@"),
      GIT_CONFIG_KEY_1: "user.name",
      GIT_CONFIG_VALUE_1: "Addon Test",
      GIT_CONFIG_KEY_2: "commit.gpgsign",
      GIT_CONFIG_VALUE_2: "false",
    },
    stdio: "pipe",
    timeout: CHILD_CAP_MS,
  });
}

/**
 * A fake `gh` with `release download` over a fixture release dir: the
 * TEST-97527-6 hermetic seam. Every invocation appends to the log; the
 * release exists iff FAKE_RELEASE_DIR names a live dir holding
 * FAKE_RELEASE_TAG when that is set.
 */
function writeFakeGh(dir: string): { readonly bin: string; readonly log: string } {
  const bin = join(dir, "gh");
  const log = join(dir, "gh.log");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
set -euo pipefail
echo "gh $*" >> "${log}"
[[ "$1" == "release" && "$2" == "download" ]] || { echo "fake-gh: only release download is stubbed" >&2; exit 2; }
tag="$3"; shift 3
pattern=""; dest="."
while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--pattern) pattern="$2"; shift 2 ;;
    -D|--dir) dest="$2"; shift 2 ;;
    -R|--repo) shift 2 ;;
    --clobber) shift ;;
    *) echo "fake-gh: unexpected arg: $1" >&2; exit 2 ;;
  esac
done
if [[ -z "\${FAKE_RELEASE_DIR:-}" || ! -d "$FAKE_RELEASE_DIR" ]]; then
  echo "fake-gh: release $tag not found" >&2
  exit 1
fi
if [[ -n "\${FAKE_RELEASE_TAG:-}" && "$tag" != "$FAKE_RELEASE_TAG" ]]; then
  echo "fake-gh: release $tag not found" >&2
  exit 1
fi
mkdir -p "$dest"
matched=0
for f in "$FAKE_RELEASE_DIR"/$pattern; do
  [[ -f "$f" ]] || continue
  cp "$f" "$dest/"
  matched=1
done
[[ "$matched" == 1 ]] || { echo "fake-gh: no asset matches $pattern" >&2; exit 1; }
`,
  );
  execFileSync("chmod", ["+x", bin], { timeout: CHILD_CAP_MS });
  return { bin, log };
}

function runBuild(args: {
  readonly root: string;
  readonly tree: string;
  readonly version: string;
  readonly previousStable?: string;
}): { readonly keepDir: string; readonly tarball: string; readonly output: string } {
  const keepDir = join(args.root, "keep");
  mkdirSync(keepDir, { recursive: true });
  const argv = ["--tree", args.tree, "--version", args.version];
  if (args.previousStable !== undefined) {
    argv.push("--previous-stable", args.previousStable);
  }
  const child = spawnSync(buildScript, argv, {
    encoding: "utf8",
    env: {
      ...process.env,
      SDK_PACKAGE_DIR: sdkDir,
      TBH_SDK_KEEP_DIR: keepDir,
      TSC_BIN: tscBin,
    },
    stdio: "pipe",
    timeout: CHILD_CAP_MS,
  });
  const output = `${child.stdout}${child.stderr}`;
  assert.equal(child.status, 0, `build succeeds: ${output}`);
  const tarball = join(keepDir, `muse-code-sdk-experimental-${args.version}.tgz`);
  assert.ok(existsSync(tarball), `build stages ${tarball}`);
  return { keepDir, output, tarball };
}

function unpack(tarball: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  execFileSync("tar", ["-xzf", tarball, "-C", dest], { stdio: "pipe", timeout: CHILD_CAP_MS });
}

function runProvenance(args: readonly string[]): { readonly code: number; readonly output: string } {
  const child = spawnSync(process.execPath, [provenanceScript, ...args], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: CHILD_CAP_MS,
  });
  return { code: child.status ?? -1, output: `${child.stdout}${child.stderr}` };
}

test("the build script packs a version-locked tarball from fixture bundles", () => {
  const root = freshRoot("addon-build-");
  try {
    const tree = join(root, "tree");
    writeTree(tree);
    const { output, tarball } = runBuild({
      previousStable: join(tree, "previous-stable.json"),
      root,
      tree,
      version: HOST_VERSION,
    });
    assert.match(output, /muse-code-sdk-experimental-1\.2\.3\.tgz/);
    const unpacked = join(root, "unpacked");
    unpack(tarball, unpacked);
    const pkg = join(unpacked, "package");
    const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")) as Record<
      string,
      unknown
    >;
    assert.equal(manifest["name"], "@muse-code/sdk-experimental");
    assert.equal(manifest["version"], HOST_VERSION);
    const constants = readFileSync(join(pkg, "dist", "constants.js"), "utf8");
    assert.match(constants, new RegExp(`ADDON_HOST_VERSION = "${HOST_VERSION}"`));
    assert.ok(existsSync(join(pkg, "dist", "index.js")), "built entry point ships");
    assert.ok(existsSync(join(pkg, "dist", "msp.d.ts")), "vendored declarations ship");
    const client = readFileSync(join(pkg, "dist", "client.js"), "utf8");
    assert.match(client, /xAlpha/, "experimental-only wrapper ships");
    assert.match(client, /sNew/, "one-release re-export ships");
  } finally {
    cleanup(root);
  }
});

test("the build script resolves the previous bundle from the release history", () => {
  const root = freshRoot("addon-prev-");
  try {
    const tree = join(root, "tree");
    writeTree(tree);
    // The tagged previous release predates the s/new promotion.
    writeFileSync(
      join(tree, "schema", "msp", "stable", "msp.schema.json"),
      JSON.stringify(PREVIOUS_STABLE_FIXTURE),
    );
    writeFileSync(
      join(tree, "CHANGELOG.md"),
      `# Changelog\n\n## ${PREVIOUS_VERSION}\n\n### Fixes\n\n- Seeded\n`,
    );
    git(["init", "-b", "main", "-q"], tree);
    git(["add", "-A"], tree);
    git(["commit", "-qm", "seed"], tree);
    git(["tag", `releases/muse/${PREVIOUS_VERSION}`], tree);
    writeFileSync(
      join(tree, "schema", "msp", "stable", "msp.schema.json"),
      JSON.stringify(STABLE_FIXTURE),
    );
    writeFileSync(
      join(tree, "CHANGELOG.md"),
      `# Changelog\n\n## ${HOST_VERSION}\n\n### Fixes\n\n- Seeded\n\n## ${PREVIOUS_VERSION}\n\n### Fixes\n\n- Seeded\n`,
    );
    git(["add", "-A"], tree);
    git(["commit", "-qm", "cut"], tree);
    const { output, tarball } = runBuild({ root, tree, version: HOST_VERSION });
    assert.match(output, new RegExp(`previous stable bundle: ${PREVIOUS_VERSION}`));
    const unpacked = join(root, "unpacked");
    unpack(tarball, unpacked);
    const client = readFileSync(join(unpacked, "package", "dist", "client.js"), "utf8");
    assert.match(client, /sNew/, "the resolved window keeps the one-release re-export");
  } finally {
    cleanup(root);
  }
});

test("the build script builds without a window on the first release", () => {
  const root = freshRoot("addon-first-");
  try {
    const tree = join(root, "tree");
    writeTree(tree);
    writeFileSync(join(tree, "CHANGELOG.md"), `# Changelog\n\n## ${HOST_VERSION}\n\n### Fixes\n\n- Seeded\n`);
    git(["init", "-b", "main", "-q"], tree);
    git(["add", "-A"], tree);
    git(["commit", "-qm", "seed"], tree);
    const { output, tarball } = runBuild({ root, tree, version: HOST_VERSION });
    assert.match(output, /no earlier release; building without a promotion window/);
    const unpacked = join(root, "unpacked");
    unpack(tarball, unpacked);
    assert.ok(existsSync(join(unpacked, "package", "dist", "index.js")));
  } finally {
    cleanup(root);
  }
});

test("the build script refuses when the previous bundle is unfetchable", () => {
  const root = freshRoot("addon-unfetch-");
  try {
    const tree = join(root, "tree");
    writeTree(tree);
    writeFileSync(
      join(tree, "CHANGELOG.md"),
      `# Changelog\n\n## ${HOST_VERSION}\n\n- x\n\n## ${PREVIOUS_VERSION}\n\n- x\n`,
    );
    // No git history at all: the named previous release cannot resolve.
    const keepDir = join(root, "keep");
    mkdirSync(keepDir, { recursive: true });
    const child = spawnSync(
      buildScript,
      ["--tree", tree, "--version", HOST_VERSION],
      {
        encoding: "utf8",
        env: { ...process.env, SDK_PACKAGE_DIR: sdkDir, TBH_SDK_KEEP_DIR: keepDir, TSC_BIN: tscBin },
        stdio: "pipe",
        timeout: CHILD_CAP_MS,
      },
    );
    assert.notEqual(child.status, 0, "unfetchable previous bundle refuses");
    assert.match(`${child.stdout}${child.stderr}`, new RegExp(PREVIOUS_VERSION));
  } finally {
    cleanup(root);
  }
});

test("the build script refuses when the previous release tag is unfetchable from git history", () => {
  const root = freshRoot("addon-untagged-");
  try {
    const tree = join(root, "tree");
    writeTree(tree);
    // A real git checkout whose CHANGELOG names a previous release that was
    // never tagged: the production-shaped unfetchable trigger. A regression
    // that fell through to a windowless build would silently drop the
    // one-release re-export, so the refusal itself is the assertion.
    writeFileSync(
      join(tree, "CHANGELOG.md"),
      `# Changelog\n\n## ${HOST_VERSION}\n\n- x\n\n## ${PREVIOUS_VERSION}\n\n- x\n`,
    );
    git(["init", "-b", "main", "-q"], tree);
    git(["add", "-A"], tree);
    git(["commit", "-qm", "cut"], tree);
    const keepDir = join(root, "keep");
    mkdirSync(keepDir, { recursive: true });
    const child = spawnSync(
      buildScript,
      ["--tree", tree, "--version", HOST_VERSION],
      {
        encoding: "utf8",
        env: { ...process.env, SDK_PACKAGE_DIR: sdkDir, TBH_SDK_KEEP_DIR: keepDir, TSC_BIN: tscBin },
        stdio: "pipe",
        timeout: CHILD_CAP_MS,
      },
    );
    assert.notEqual(child.status, 0, "untagged previous release refuses");
    const output = `${child.stdout}${child.stderr}`;
    assert.match(output, new RegExp(PREVIOUS_VERSION));
    assert.match(
      output,
      /tag releases\/muse\/1\.2\.2 unfetchable/,
      "the git-history trigger, not the no-checkout refusal",
    );
  } finally {
    cleanup(root);
  }
});

test("re-vendor fetches the attached tarball from the internal release", () => {
  const root = freshRoot("addon-fetch-");
  try {
    const tree = join(root, "tree");
    writeTree(tree);
    const { tarball } = runBuild({
      previousStable: join(tree, "previous-stable.json"),
      root,
      tree,
      version: HOST_VERSION,
    });
    // The attached asset: the tarball as the release carries it.
    const releaseDir = join(root, "release");
    mkdirSync(releaseDir, { recursive: true });
    const attached = join(releaseDir, `muse-code-sdk-experimental-${HOST_VERSION}.tgz`);
    execFileSync("cp", [tarball, attached], { stdio: "pipe", timeout: CHILD_CAP_MS });
    mkdirSync(join(root, "bin"), { recursive: true });
    const fake = writeFakeGh(join(root, "bin"));
    const vendorDir = join(root, "vendor");
    const child = spawnSync(
      process.execPath,
      [revendorScript, "--release", HOST_VERSION, "--dir", vendorDir],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_RELEASE_DIR: releaseDir,
          FAKE_RELEASE_TAG: `releases/muse/${HOST_VERSION}`,
          GH_BIN: fake.bin,
        },
        stdio: "pipe",
        timeout: CHILD_CAP_MS,
      },
    );
    assert.equal(child.status, 0, `re-vendor succeeds: ${child.stdout}${child.stderr}`);
    const fetched = join(vendorDir, `muse-code-sdk-experimental-${HOST_VERSION}.tgz`);
    assert.ok(existsSync(fetched), "tarball lands in the vendor dir");
    assert.equal(
      readFileSync(fetched, "utf8"),
      readFileSync(attached, "utf8"),
      "fetched bytes equal the attached asset",
    );
    const calls = readFileSync(fake.log, "utf8");
    assert.match(calls, new RegExp(`release download releases/muse/${HOST_VERSION}`));
    assert.match(calls, /-R mslsrc\/tbh/, "the internal repo is the only fetch source");
  } finally {
    cleanup(root);
  }
});

test("provenance greens on a version match", () => {
  const root = freshRoot("addon-green-");
  try {
    const tree = join(root, "tree");
    writeTree(tree);
    const { tarball } = runBuild({
      previousStable: join(tree, "previous-stable.json"),
      root,
      tree,
      version: HOST_VERSION,
    });
    unpack(tarball, join(root, "work"));
    const { code, output } = runProvenance([
      "--addon-dir",
      join(root, "work", "package"),
      "--host-version",
      HOST_VERSION,
    ]);
    assert.equal(code, 0, `matching versions green: ${output}`);
    assert.match(output, new RegExp(HOST_VERSION));
  } finally {
    cleanup(root);
  }
});

test("provenance reds on skew naming the re-vendor command", () => {
  const root = freshRoot("addon-skew-");
  try {
    const tree = join(root, "tree");
    writeTree(tree);
    const { tarball } = runBuild({
      previousStable: join(tree, "previous-stable.json"),
      root,
      tree,
      version: HOST_VERSION,
    });
    unpack(tarball, join(root, "work"));
    const pinned = "9.9.9";
    const { code, output } = runProvenance([
      "--addon-dir",
      join(root, "work", "package"),
      "--host-version",
      pinned,
    ]);
    assert.notEqual(code, 0, "skewed versions red");
    assert.match(output, new RegExp(HOST_VERSION), "names the embedded version");
    assert.match(output, new RegExp(pinned), "names the pinned version");
    assert.match(
      output,
      /revendor-sdk-experimental-addon\.mjs --release 9\.9\.9/,
      "names the re-vendor command for the pinned release",
    );
  } finally {
    cleanup(root);
  }
});

test("provenance reds on a tampered tarball", () => {
  const root = freshRoot("addon-tamper-");
  try {
    const tree = join(root, "tree");
    writeTree(tree);
    const { tarball } = runBuild({
      previousStable: join(tree, "previous-stable.json"),
      root,
      tree,
      version: HOST_VERSION,
    });
    const pkg = join(root, "work", "package");
    unpack(tarball, join(root, "work"));
    // Tamper: rewrite the embedded host version after the build to match
    // the pinned version, so a skew-only check would pass.
    const constantsPath = join(pkg, "dist", "constants.js");
    const constants = readFileSync(constantsPath, "utf8");
    assert.match(constants, new RegExp(`ADDON_HOST_VERSION = "${HOST_VERSION}"`));
    writeFileSync(
      constantsPath,
      constants.replace(
        `ADDON_HOST_VERSION = "${HOST_VERSION}"`,
        `ADDON_HOST_VERSION = "9.9.9"`,
      ),
    );
    const { code, output } = runProvenance(["--addon-dir", pkg, "--host-version", "9.9.9"]);
    assert.notEqual(code, 0, "a tampered tarball reds even when embedded matches pinned");
    assert.match(output, new RegExp(HOST_VERSION), "names the package version");
    assert.match(output, /9\.9\.9/, "names the tampered embedded version");
  } finally {
    cleanup(root);
  }
});

test("the step-6 scripts fail closed on missing args or dirs", () => {
  const build = spawnSync(buildScript, [], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: CHILD_CAP_MS,
  });
  assert.notEqual(build.status, 0, "the build script needs its args");
  assert.match(`${build.stdout}${build.stderr}`, /usage:/);
  const badVersion = spawnSync(buildScript, ["--tree", tmpdir(), "--version", "abc"], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: CHILD_CAP_MS,
  });
  assert.notEqual(badVersion.status, 0, "the build script needs a plain X.Y.Z version");
  const revendor = spawnSync(process.execPath, [revendorScript], {
    encoding: "utf8",
    stdio: "pipe",
    timeout: CHILD_CAP_MS,
  });
  assert.notEqual(revendor.status, 0, "re-vendor needs its args");
  assert.match(`${revendor.stdout}${revendor.stderr}`, /usage:/);
  const revendorBad = spawnSync(
    process.execPath,
    [revendorScript, "--release", "abc", "--dir", tmpdir()],
    { encoding: "utf8", stdio: "pipe", timeout: CHILD_CAP_MS },
  );
  assert.notEqual(revendorBad.status, 0, "re-vendor needs a plain X.Y.Z release");
  const revendorOverride = spawnSync(
    process.execPath,
    [revendorScript, "--release", HOST_VERSION, "--dir", tmpdir(), "--repo", "custom/o", "--tag", "custom-tag"],
    { encoding: "utf8", stdio: "pipe", timeout: CHILD_CAP_MS },
  );
  assert.notEqual(revendorOverride.status, 0, "re-vendor refuses --repo/--tag overrides (#100281)");
  assert.match(`${revendorOverride.stdout}${revendorOverride.stderr}`, /usage:/);
  const missing = runProvenance(["--addon-dir", join(tmpdir(), "addon-no-such-dir"), "--host-version", HOST_VERSION]);
  assert.notEqual(missing.code, 0, "provenance refuses a missing add-on dir");
});

test("re-vendor refuses when the release has no attached tarball", () => {
  const root = freshRoot("addon-norelease-");
  try {
    mkdirSync(join(root, "bin"), { recursive: true });
    const fake = writeFakeGh(join(root, "bin"));
    const child = spawnSync(
      process.execPath,
      [revendorScript, "--release", HOST_VERSION, "--dir", join(root, "vendor")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_RELEASE_TAG: `releases/muse/${HOST_VERSION}`,
          GH_BIN: fake.bin,
        },
        stdio: "pipe",
        timeout: CHILD_CAP_MS,
      },
    );
    assert.notEqual(child.status, 0, "a missing release refuses");
    assert.match(
      `${child.stdout}${child.stderr}`,
      new RegExp(`releases/muse/${HOST_VERSION}`),
      "names the missing release",
    );
  } finally {
    cleanup(root);
  }
});

test("provenance refuses a malformed add-on dir", () => {
  const root = freshRoot("addon-malformed-");
  try {
    const tree = join(root, "tree");
    writeTree(tree);
    const { tarball } = runBuild({
      previousStable: join(tree, "previous-stable.json"),
      root,
      tree,
      version: HOST_VERSION,
    });
    unpack(tarball, join(root, "work"));
    const pkg = join(root, "work", "package");
    // Not JSON in package.json.
    const manifestPath = join(pkg, "package.json");
    const manifest = readFileSync(manifestPath, "utf8");
    writeFileSync(manifestPath, "not json{{{");
    assert.notEqual(
      runProvenance(["--addon-dir", pkg, "--host-version", HOST_VERSION]).code,
      0,
      "a broken manifest refuses",
    );
    writeFileSync(manifestPath, manifest);
    // No built constants.
    const constantsPath = join(pkg, "dist", "constants.js");
    const constants = readFileSync(constantsPath, "utf8");
    rmSync(constantsPath);
    assert.notEqual(
      runProvenance(["--addon-dir", pkg, "--host-version", HOST_VERSION]).code,
      0,
      "a missing embedded version refuses",
    );
    writeFileSync(constantsPath, constants);
    // Constants without the embedded marker.
    writeFileSync(constantsPath, "export const SOMETHING_ELSE = 1;\n");
    assert.notEqual(
      runProvenance(["--addon-dir", pkg, "--host-version", HOST_VERSION]).code,
      0,
      "constants without the embedded version refuse",
    );
    writeFileSync(constantsPath, constants);
    // The green control: restored, the same dir passes.
    assert.equal(
      runProvenance(["--addon-dir", pkg, "--host-version", HOST_VERSION]).code,
      0,
      "the restored dir greens",
    );
  } finally {
    cleanup(root);
  }
});

test("step-6 paths never enter the public source closure", () => {
  // The subjects exist (red before the implementation lands) and the
  // mirror can never carry them: the re-mirror copies closure paths only.
  for (const script of [buildScript, revendorScript, provenanceScript]) {
    assert.ok(existsSync(script), `${script} exists`);
  }
  const closure = JSON.parse(readFileSync(closureManifest, "utf8")) as {
    closure_paths: string[];
  };
  // Exact add-on-side script names only: a bare `sdk-experimental`
  // substring also bans the public-package leak gate
  // (`check-sdk-experimental-leak.mjs`), which the closure carries by design
  // so the mirror publish enforces it (INV-97527-5). That overbroad needle
  // red every ride carrying main in #99842.
  const banned = [
    "generate-sdk-experimental-addon.mjs",
    "build-sdk-experimental-addon-tarball.sh",
    "revendor-sdk-experimental-addon.mjs",
    "check-sdk-experimental-addon-provenance.mjs",
  ];
  for (const entry of closure.closure_paths) {
    for (const needle of banned) {
      assert.ok(!entry.includes(needle), `closure entry ${entry} carries no add-on path`);
    }
  }
});
