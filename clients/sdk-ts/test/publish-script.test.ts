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
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
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

/**
 * The 0.x README posture that D-053 makes a precondition of publishing. Written
 * into the fixture rather than copied from the real README on purpose: these
 * arms test the GATE, and reading the gate's input from the same tree the gate
 * inspects would make them pass or fail on the README's editing history instead.
 * The real README's wording is owned by #26157.
 */
const POSTURE_README =
  "# `@muse-code/sdk`\n\n" +
  "**This is a 0.x release and it is experimental.** There is no stability " +
  "promise before 1.0: any release may change or remove API you are using.\n";

test("a 0.x --publish is no longer blocked by a version floor (D-013 as amended by D-053)", () => {
  // D-053 (2026-08-31) permits publishing at 0.x, and the interlock that
  // refused every 0.x publish was deleted with it — its own comment bound the
  // two together. What must NOT come back is a version floor: the run below is
  // expected to die at the provenance interlock — which sits several gates
  // further down, past build, registry state, and pack-and-audit — and never at
  // the version.
  const pkg = fixtureWith(() => {});
  writeFileSync(join(pkg, "README.md"), POSTURE_README);
  const result = run(["--publish"], { SDK_PACKAGE_DIR: pkg, GITHUB_ACTIONS: "" });
  assert.notEqual(result.status, 0, "outside Actions no publish can proceed at all");
  assert.doesNotMatch(
    result.combined,
    /before 1\.0|version floor|D-013 forbids/i,
    "a 0.x version must no longer be a reason to refuse; the only refusal left " +
      `here is provenance:\n${result.combined}`,
  );
  assert.match(
    result.combined,
    /provenance/i,
    `the run must get past the version check and reach the provenance ` +
      `interlock further down:\n${result.combined}`,
  );
});

/**
 * Assert `--publish` at 0.x refuses this README **at the posture gate**.
 *
 * The refusal has to be pinned to the gate's own message, not to properties an
 * ACCEPT run also has. Outside Actions every run dies at the provenance gate,
 * so `status != 0` and "Nothing was published" are true either way — and the
 * ACCEPT line itself says `ok: README states the 0.x ... (D-053)`, which
 * supplies both /D-053/ and /README/. An assertion that all four survive is an
 * assertion about nothing: with the predicate forced to accept, every arm below
 * stayed green.
 *
 * So: match the refusal text, and require the acceptance line to be ABSENT.
 */
function assertPostureRefused(readme: string, why: string): void {
  const pkg = fixtureWith(() => {});
  writeFileSync(join(pkg, "README.md"), readme);
  const result = run(["--publish"], { SDK_PACKAGE_DIR: pkg, GITHUB_ACTIONS: "" });
  assert.notEqual(result.status, 0, `${why}: the publish must not proceed`);
  assert.match(
    result.combined,
    /publishing at 0\.x requires the README/,
    `${why}: must die at the POSTURE gate, not merely somewhere downstream:\n${result.combined}`,
  );
  assert.doesNotMatch(
    result.combined,
    /ok: README states/,
    `${why}: the gate reported the posture as satisfied`,
  );
  assert.match(result.combined, /D-053/, "the message must name the amendment it enforces");
  assert.match(result.combined, /Nothing was published/);
}

test("a 0.x --publish whose README omits the no-stability posture fails before the registry", () => {
  // D-053 permits publishing at 0.x *because* the posture is stated where a
  // registry reader will see it. Without that, publishing 0.x silently drops
  // the principle the amendment kept — so the script refuses.
  assertPostureRefused(
    "# `@muse-code/sdk`\n\nA TypeScript SDK.\n",
    "a README stating no posture at all",
  );
});

// One arm per clause tdd SS7.1 makes normative, each holding the other two.
//
// Without these, the gate's clauses are not individually covered: a fixture
// with none and a fixture with all of them leaves every single-clause mutant
// alive, so a later edit could silently weaken the gate to one grep and every
// arm would still pass.

test("the posture gate refuses a README missing the experimental clause", () => {
  assertPostureRefused(
    "# `@muse-code/sdk`\n\nThere is no stability promise before 1.0: any " +
      "release may change or remove API you are using.\n",
    "no experimental clause",
  );
});

test("the posture gate refuses a README missing the no-stability clause", () => {
  assertPostureRefused(
    "# `@muse-code/sdk`\n\nThis is a 0.x release and it is experimental. Any " +
      "release may change or remove API you are using.\n",
    "no no-stability clause",
  );
});

test("the posture gate refuses a README missing the may-change clause", () => {
  assertPostureRefused(
    "# `@muse-code/sdk`\n\nThis is a 0.x release and it is experimental. " +
      "There is no stability promise before 1.0.\n",
    "no may-change clause",
  );
});

test("the posture gate refuses a README asserting the OPPOSITE posture", () => {
  // The markers are deliberately loose substring matches, which is what makes
  // them survive a rewording — and exactly what a negation would exploit:
  // "no longer experimental" contains the word "experimental". A gate a
  // negation passes is not a gate.
  assertPostureRefused(
    "# `@muse-code/sdk`\n\nThis SDK is no longer experimental. There is no " +
      "stability promise before 1.0 — but that may change, and nothing will " +
      "change or remove API you are using.\n",
    "an inverted posture",
  );
});

test("the posture gate accepts the posture phrased as 'no stability promise applies'", () => {
  // The counterexample that removed the second negation guard. This wording
  // states the required posture and must publish; a guard keying on the
  // substring "stability promise applies" killed it, which is the
  // wording-sensitive outage loose markers exist to avoid.
  //
  // An ACCEPT arm needs the opposite proof from a REFUSE arm: outside Actions
  // every run fails, so "it failed" says nothing. What distinguishes acceptance
  // is WHERE it failed — at provenance, having first reported the posture ok.
  const pkg = fixtureWith(() => {});
  writeFileSync(
    join(pkg, "README.md"),
    "# `@muse-code/sdk`\n\nThis is an experimental 0.x release. No stability " +
      "promise applies before 1.0: any release may change or remove API you " +
      "are using.\n",
  );
  const result = run(["--publish"], { SDK_PACKAGE_DIR: pkg, GITHUB_ACTIONS: "" });
  assert.match(
    result.combined,
    /ok: README states the 0\.x/,
    `this wording states the posture and must pass the gate:\n${result.combined}`,
  );
  assert.doesNotMatch(result.combined, /publishing at 0\.x requires the README/);
  assert.match(
    result.combined,
    /provenance/i,
    `and must then reach the provenance interlock further down:\n${result.combined}`,
  );
});

test("the shipping README satisfies the posture gate today", () => {
  // #26157's posture section is merged, so this is a green, stable arm rather
  // than the merge-race hazard it would have been beforehand. It is the only
  // check in CI that reads the REAL README: without it a PR rewording the
  // posture (say "experimental" -> "early-stage") keeps every lane green and
  // the break first surfaces as a refused publish run — an outage, not a red
  // PR. Pack-only prints the same acceptance line as --publish, so no publish
  // path is exercised here.
  const result = run([]);
  assert.match(
    result.combined,
    /ok: README states the 0\.x/,
    `the shipping README must state the 0.x posture (tdd SS7.1):\n${result.combined}`,
  );
});

test("the posture requirement applies to 0.x only, not to a 1.0 release", () => {
  // The condition D-053 attaches is a 0.x condition. At 1.0 the promise is made
  // rather than withheld, so requiring the withholding text there would be
  // requiring the package to contradict itself.
  const pkg = fixtureWith((m) => {
    m.version = "1.0.0";
  });
  writeFileSync(join(pkg, "README.md"), "# `@muse-code/sdk`\n\nA TypeScript SDK.\n");
  const result = run(["--publish"], { SDK_PACKAGE_DIR: pkg, GITHUB_ACTIONS: "" });
  assert.notEqual(result.status, 0, "outside Actions no publish can proceed at all");
  assert.doesNotMatch(
    result.combined,
    /D-053/,
    `the 0.x posture gate must not fire at 1.0:\n${result.combined}`,
  );
});

test("pack-only never fails on the posture, whatever the README says", () => {
  // The gate is a publish precondition, not a build one. Failing pack-only on it
  // would couple this package's CI to the README edit that states the posture,
  // and CI runs pack-only on every push.
  const pkg = fixtureWith(() => {});
  writeFileSync(join(pkg, "README.md"), "# `@muse-code/sdk`\n\nA TypeScript SDK.\n");
  const result = run([], { SDK_PACKAGE_DIR: pkg });
  assert.equal(
    result.status,
    0,
    `pack-only must stay green without the posture text:\n${result.combined}`,
  );
});

test("--publish in Actions without an OIDC token dies before the registry", () => {
  const pkg = fixtureWith((m) => {
    m.version = "1.0.0"; // 1.0 carries no 0.x posture condition, so auth is what is tested
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

// ---- the external-consumer arm -------------------------------------------
//
// Every arm above looks at the tarball from inside this repo, where
// `@muse-code/msp` is a workspace devDependency and therefore always resolves.
// A customer has no such package: it is private and not on the registry. So a
// declaration that still names it is unresolvable the moment the tarball leaves
// this workspace, and the only way to see that is to typecheck the packed
// artifact from a directory that shares nothing with this repo.
//
// `skipLibCheck: false` is the whole point. The default `true` hides exactly
// this class of defect — it was `true` in the consumer test that first shipped
// 0.1.0, which is why eleven unresolvable imports reached npm.

/**
 * Pack a COPY of the package and unpack the tarball. Returns the package dir.
 *
 * Never the real package directory. `npm pack` fires the real `prepack`, which
 * repoints every emitted declaration in the live `dist/` while the rest of the
 * suite's `node --test` children are reading out of it.
 *
 * Today that is survivable rather than safe: `prepack` leaves the incremental
 * build stamp alone (see `bundle-msp-types.mjs`), so its build is a no-op, only
 * `.d.ts` files move, and nothing imported at runtime is touched. Make the
 * stamp stale — by deleting it, as an earlier draft of this change did — and
 * the same `prepack` becomes a full rebuild of every emitted `.js` underneath
 * those children, which reads as a SyntaxError with nothing to blame.
 *
 * So this arm does not rely on that being true. It packs a copy, like the other
 * arms, and the live tree is not in the blast radius either way.
 *
 * The copy keeps the real `clients/sdk-ts` layout because the bundling step
 * resolves the generated declarations at `../../schema/msp/msp.d.ts`.
 * `schema/msp` is COPIED — it is small, and the pack step reads one file out
 * of it — while `node_modules` is symlinked, because copying it is not.
 *
 * That asymmetry is the point. The cleanup that removes these fixtures must
 * not follow the symlink, and it does not: recursive `rmSync` lstats and
 * unlinks a symlink rather than descending through it, verified before this
 * was written. But defence in depth is cheap here — with `schema` copied, the
 * worst a future cleanup regression could reach is a regenerable
 * `node_modules`, never a committed file.
 */
function packAndExtract(): string {
  const dir = mkdtempSync(join(tmpdir(), "sdk-consumer-"));
  fixtureDirs.push(dir);
  const root = join(dir, "workspace");
  const pkg = join(root, "clients", "sdk-ts");
  mkdirSync(join(root, "clients"), { recursive: true });
  cpSync(realPackageDir, pkg, {
    recursive: true,
    filter: (src) => !src.includes("node_modules"),
  });
  symlinkSync(join(projectRoot, "node_modules"), join(root, "node_modules"), "dir");
  cpSync(join(projectRoot, "schema", "msp"), join(root, "schema", "msp"), { recursive: true });

  const packDir = join(dir, "pack");
  mkdirSync(packDir);
  execFileSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: pkg,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tarball = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
  assert.ok(tarball, "npm pack produced no tarball");
  execFileSync("tar", ["-xzf", join(packDir, tarball), "-C", dir], { stdio: "inherit" });
  return join(dir, "package");
}

test("a consumer outside this workspace typechecks the tarball with skipLibCheck off", () => {
  const packageDir = packAndExtract();
  const consumer = dirname(packageDir);

  // The consumer's own node_modules. `@types/node` is linked rather than
  // vendored because the README now tells customers to install it themselves —
  // this fixture is that instruction, executed.
  const modules = join(consumer, "node_modules");
  mkdirSync(join(modules, "@muse-code"), { recursive: true });
  cpSync(packageDir, join(modules, "@muse-code", "sdk"), { recursive: true });
  cpSync(join(projectRoot, "node_modules", "@types", "node"), join(modules, "@types", "node"), {
    recursive: true,
  });
  // `@types/node` declares against `undici-types`, which npm installs alongside
  // it. Omitting it would fail this arm on the fixture's own incompleteness
  // rather than on anything the tarball did.
  cpSync(join(projectRoot, "node_modules", "undici-types"), join(modules, "undici-types"), {
    recursive: true,
  });

  writeFileSync(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "sdk-consumer-probe", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    join(consumer, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "es2023",
          lib: ["es2023"],
          types: ["node"],
          module: "nodenext",
          moduleResolution: "nodenext",
          strict: true,
          // Not a detail: with this on (the default) the whole defect is invisible.
          skipLibCheck: false,
          noEmit: true,
        },
        include: ["index.ts"],
      },
      null,
      2,
    )}\n`,
  );
  // Importing the barrel pulls every shipped declaration into the program, so
  // an unresolvable specifier anywhere under `dist/src` fails this arm.
  writeFileSync(
    join(consumer, "index.ts"),
    [
      'import { MuseClient, Session, readSessionDurability } from "@muse-code/sdk";',
      "",
      "export type Probe = [typeof MuseClient, typeof Session, typeof readSessionDurability];",
      "",
    ].join("\n"),
  );

  const tsc = join(projectRoot, "node_modules", "typescript", "bin", "tsc");
  let status = 0;
  let output = "";
  try {
    output = execFileSync(process.execPath, [tsc, "--noEmit", "-p", "tsconfig.json"], {
      cwd: consumer,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    status = e.status ?? -1;
    output = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
  }

  assert.ok(
    !/TS2307/.test(output),
    `no shipped declaration may import a module the customer cannot install:\n${output}`,
  );
  assert.equal(status, 0, `the packed tarball must typecheck in a strict consumer:\n${output}`);
});

test("no shipped declaration imports a package that is not on the registry", () => {
  // The arm above is the behavioural proof. This one names the offender, so a
  // regression reports which file came back rather than a wall of TS2307.
  //
  // The pattern matches the package as a MODULE, not as prose: several doc
  // comments survive into the emitted declarations and say `@muse-code/msp`
  // while explaining where the generated types come from, which stays true.
  const asModule = /(from|import|require)\s*\(?\s*"@muse-code\/msp"/;
  const packageDir = packAndExtract();
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".d.ts") && asModule.test(readFileSync(full, "utf8")))
        offenders.push(full.slice(packageDir.length + 1));
    }
  };
  walk(join(packageDir, "dist"));
  assert.deepEqual(
    offenders,
    [],
    "`@muse-code/msp` is private and unpublished; its declarations must be bundled " +
      "into this tarball, not imported from it",
  );
});
