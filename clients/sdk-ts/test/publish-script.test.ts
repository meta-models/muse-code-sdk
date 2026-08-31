/**
 * `publish_sdk_npm_script` — the gates in `scripts/publish-sdk-npm.sh`
 * (seat extension, hub #24410 04:05Z).
 *
 * The script is the only sanctioned path to `npm publish` for this package, so
 * its safety properties are pinned here rather than left to review:
 *
 *  - **`--pack-only` is the default.** Running it with no arguments must not be
 *    able to publish. This is exercised, not asserted from the source text.
 *  - **Every gate fails BEFORE npm.** Each negative arm below points the script
 *    at a fixture that violates exactly one gate and asserts a non-zero exit
 *    whose message names that gate. A gate that "fails" by letting npm reject
 *    the publish later is not a gate.
 *  - **No credential is handled at all.** npm's OIDC exchange is the whole
 *    credential story, so there is nothing here to echo, write to the repo, or
 *    leave on a command line where `ps` could read it.
 *
 * The negative arms work because the script resolves the package directory from
 * `SDK_PACKAGE_DIR`. That indirection exists ONLY for these tests; the default
 * is the real `clients/sdk-ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  cpSync,
  statSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `dist/test/` -> `dist/` -> `clients/sdk-ts/` -> `clients/` -> project root. */
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..", "..");
const script = join(projectRoot, "scripts", "publish-sdk-npm.sh");
const realPackageDir = join(projectRoot, "clients", "sdk-ts");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
}

/**
 * A registry that cannot answer. Gate 4 runs `npm view` unconditionally, so
 * without this the default `npm test` would make a live network call — against
 * the repo rule that live-network smokes are opt-in. Offline it would silently
 * degrade to "not on the registry yet", i.e. green without testing what it
 * claims; behind a black-holing proxy npm's retry ladder can eat most of the
 * per-arm timeout. Port 9 (discard) refuses instantly, so the gate resolves
 * deterministically as "not published" with no network and no waiting.
 */
const OFFLINE_REGISTRY = "http://127.0.0.1:9";

/**
 * Retries off. Port 9 refuses instantly, but npm's default retry ladder still
 * turns each refusal into ~70s of backoff — five arms of that is six minutes of
 * suite time spent waiting for a connection that can never succeed.
 */
const NO_RETRY = { npm_config_fetch_retries: "0", npm_config_fetch_retry_maxtimeout: "1" };

function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(script, args, {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_registry: OFFLINE_REGISTRY,
        ...NO_RETRY,
        // Blanked, never merely absent. `process.env` is spread in, so on a
        // real Actions runner an inherited value would carry the OIDC arms
        // past the interlock and toward an actual publish.
        ACTIONS_ID_TOKEN_REQUEST_URL: "",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "", combined: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    const stdout = e.stdout ?? "";
    const stderr = e.stderr ?? "";
    return {
      status: e.status ?? -1,
      stdout,
      stderr,
      combined: `${stdout}\n${stderr}`,
    };
  }
}

/**
 * A copy of the real package — including its built `dist/` — whose manifest can
 * be corrupted one field at a time.
 *
 * The copy's `build` script is neutralised: the fixture has no `node_modules`,
 * so a real `tsc --build` would fail and every arm would then be testing the
 * build gate instead of the gate it names. `dist/` is copied precisely so the
 * pack and audit stages still have something real to work on.
 */
/** Every fixture dir made here, so none is stranded in $TMPDIR after the run. */
const fixtureDirs: string[] = [];
process.on("exit", () => {
  for (const d of fixtureDirs) rmSync(d, { recursive: true, force: true });
});

function fixtureWith(mutate: (m: Record<string, unknown>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "sdk-publish-fixture-"));
  fixtureDirs.push(dir);
  const pkg = join(dir, "sdk-ts");
  cpSync(realPackageDir, pkg, {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  const manifestPath = join(pkg, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  const scripts = (manifest.scripts ?? {}) as Record<string, string>;
  scripts.build = "true";
  scripts.prepack = "true";
  manifest.scripts = scripts;
  mutate(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return pkg;
}

test("the script exists and is executable", () => {
  const mode = statSync(script).mode;
  assert.ok(mode & 0o111, "scripts/publish-sdk-npm.sh must have the execute bit");
});

test("--help explains the two auth paths and the owner one-timers", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  // Case-insensitive on purpose: these assert that the CONCEPT is documented,
  // not how the header happens to capitalise a heading today.
  for (const expected of [
    "--pack-only",
    "--publish",
    "trusted publishing",
    "keychain",
    "provenance",
  ]) {
    assert.ok(
      result.combined.toLowerCase().includes(expected.toLowerCase()),
      `--help must document ${expected}`,
    );
  }
});

test("the default run is pack-only and cannot reach npm publish", () => {
  const result = run([]);
  assert.equal(
    result.status,
    0,
    `a default run over the real package must pass every gate:\n${result.combined}`,
  );
  assert.ok(
    /pack-only/i.test(result.combined),
    "the default run must say plainly that it published nothing",
  );
  assert.ok(
    !/^\s*\+?\s*npm publish/m.test(result.combined),
    "a default run must never invoke npm publish",
  );
});

test("the license gate fails before npm, and names the license", () => {
  const pkg = fixtureWith((m) => {
    m.license = "Apache-2.0";
  });
  const result = run([], { SDK_PACKAGE_DIR: pkg });
  assert.notEqual(result.status, 0, "a non-MIT license must fail the run");
  assert.match(result.combined, /license/i);
  assert.match(result.combined, /MIT/);
});

test("the name gate rejects a package that is not the ruled scope", () => {
  const pkg = fixtureWith((m) => {
    // The pre-rename name. Written by concatenation so a future scope-rename
    // sweep cannot silently turn this negative arm into a positive one — which
    // is exactly what happened to it once already.
    m.name = ["@muse", "/sdk"].join("");
  });
  const result = run([], { SDK_PACKAGE_DIR: pkg });
  assert.notEqual(result.status, 0, "the pre-rename name must fail the run");
  assert.match(result.combined, /@muse-code\/sdk/);
});

test("the private gate rejects a manifest that npm would refuse anyway", () => {
  const pkg = fixtureWith((m) => {
    m.private = true;
  });
  const result = run([], { SDK_PACKAGE_DIR: pkg });
  assert.notEqual(result.status, 0);
  assert.match(result.combined, /private/i);
});

test("the tarball audit fails when the files whitelist widens", () => {
  // "dist" instead of "dist/src" is the exact drift the whitelist exists to
  // stop: it ships the QA harness, the conformance oracle and the wire taps.
  const pkg = fixtureWith((m) => {
    m.files = ["dist"];
  });
  const result = run([], { SDK_PACKAGE_DIR: pkg });
  assert.notEqual(result.status, 0, "a widened whitelist must fail the audit");
  assert.match(result.combined, /whitelist|unexpected|dist\/(qa|test)/i);
});

// ---- the executable safety arms ------------------------------------------
//
// The source-grep arms below prove the SHAPE of the script. These prove the
// BEHAVIOUR: renaming a variable, or moving auth to after `npm publish`, keeps
// a grep green while breaking the real guarantee.

test("--publish refuses a 0.x version: D-013 blocks the first publish", () => {
  // The package is deliberately pinned inside 0.x, so without this interlock
  // the first real publish would be exactly the one D-013 forbids.
  const pkg = fixtureWith(() => {});
  const result = run(["--publish"], { SDK_PACKAGE_DIR: pkg });
  assert.notEqual(result.status, 0, "a 0.x --publish must not proceed");
  assert.match(result.combined, /D-013/);
  assert.match(result.combined, /Nothing was published/);
});

test("--publish in Actions without an OIDC token dies before the registry", () => {
  const pkg = fixtureWith((m) => {
    m.version = "1.0.0"; // past the D-013 interlock, so auth is what is tested
  });
  const result = run(["--publish"], {
    SDK_PACKAGE_DIR: pkg,
    GITHUB_ACTIONS: "1",
    ACTIONS_ID_TOKEN_REQUEST_URL: "",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.combined, /OIDC token is available/);
  assert.match(
    result.combined,
    /id-token: write/,
    "the message must name the workflow permission that fixes it",
  );
});

test("--publish outside Actions refuses: provenance is impossible there", () => {
  // npm generates provenance only inside a supported CI provider, so a manual
  // run cannot satisfy the ruling's --provenance requirement at all.
  const pkg = fixtureWith((m) => {
    m.version = "1.0.0";
  });
  const result = run(["--publish"], { SDK_PACKAGE_DIR: pkg, GITHUB_ACTIONS: "" });
  assert.notEqual(result.status, 0);
  assert.match(result.combined, /provenance/i);
  assert.match(
    result.combined,
    /publish-npm\.yml/,
    "the message must point at the path that does work",
  );
});

test("the INV-009 gate rejects a runtime dependency", () => {
  const pkg = fixtureWith((m) => {
    m.dependencies = { "left-pad": "1.3.0" };
  });
  const result = run([], { SDK_PACKAGE_DIR: pkg });
  assert.notEqual(result.status, 0, "a runtime dependency must fail the run");
  assert.match(result.combined, /INV-009/);
  assert.match(result.combined, /left-pad/, "the message must name the offender");
});

test("a MIT-labelled tarball that ships no licence text fails the audit", () => {
  // The whitelist is allow-only: it proves nothing is EXTRA, never that
  // something required is present. A licence-less publish would otherwise pass
  // every gate while the manifest claims MIT.
  const pkg = fixtureWith(() => {});
  rmSync(join(pkg, "LICENSE"));
  const result = run([], { SDK_PACKAGE_DIR: pkg });
  assert.notEqual(result.status, 0, "a missing LICENSE must fail the run");
  assert.match(result.combined, /LICENSE/);
});

test("the script handles no credential at all, so none can leak", () => {
  const source = readFileSync(script, "utf8");
  const code = source.replace(/^\s*#.*$/gm, ""); // comments describe, they do not run

  // Since the manual token path was removed (provenance is impossible outside
  // CI, so it could never have worked), the strongest available property is
  // that the script never touches a secret: OIDC is handled inside npm, and
  // there is nothing here to echo, write, or put on a command line.
  assert.ok(
    !/security find-generic-password/.test(code),
    "no Keychain read may remain in executable code — the manual path cannot " +
      "produce provenance and was removed rather than left to dead-end",
  );
  assert.ok(
    !/_authToken/.test(code),
    "the script must not construct registry auth itself; npm's OIDC exchange is " +
      "the whole credential story",
  );
  assert.ok(
    !/echo\s+"?\$\{?(NODE_AUTH_TOKEN|NPM_TOKEN|TOKEN|npm_token)/i.test(code),
    "no token variable may be echoed",
  );
  assert.ok(
    !/(npm_[A-Za-z0-9]{30,})/.test(source),
    "no npm token literal may appear in the script, comments included",
  );
});

test("the header still names the staged Keychain item and why it is unusable", () => {
  const source = readFileSync(script, "utf8");
  // The coordinator staged this item on the publishing Mac (hub #24410,
  // 04:22Z): service `npm-muse-code-publish`, account `npm`. The script cannot
  // use it — an interim token publish is unprovenanced, which ruling 4 forbids
  // — but the header must keep naming it, because "why isn't the staged
  // credential wired up?" is the question the next operator will ask.
  assert.match(source, /npm-muse-code-publish/);
  assert.match(
    source,
    /provenance/i,
    "the header must state the reason the staged token is not wired up",
  );
  assert.match(
    source,
    /25304/,
    "the header must point at where that conflict gets resolved",
  );
});

test("publishing uses OIDC in Actions and always asks for provenance", () => {
  const source = readFileSync(script, "utf8");
  assert.ok(
    /GITHUB_ACTIONS/.test(source),
    "the auth path is chosen by whether the run is inside Actions",
  );
  assert.ok(
    /--provenance/.test(source),
    "--provenance is not optional; a publish without it is not the publish " +
      "that was asked for",
  );
  assert.ok(
    /--access\s+public/.test(source),
    "a scoped package defaults to restricted",
  );
});

test("the script is idempotent: an already-published version is a clean no-op", () => {
  const source = readFileSync(script, "utf8");
  assert.ok(
    /npm view/.test(source),
    "the already-published check is `npm view`, run before any publish attempt",
  );
});
