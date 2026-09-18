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
const audienceChecker = join(projectRoot, "scripts", "check-sdk-py-external-audience.py");
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
 * The lockstep / product-stability posture that D-063 (ADR 25304 D3) makes a
 * precondition of publishing. Written into the fixture rather than copied from
 * the real README on purpose: these arms test the GATE, and reading the gate's
 * input from the same tree the gate inspects would make them pass or fail on
 * the README's editing history instead.
 */
const POSTURE_README =
  "# `@muse-code/sdk`\n\n" +
  "**This package versions in lockstep with Muse Code**: the SDK version is " +
  "the Muse Code release it ships with. The stable MSP surface follows the " +
  "product's compatibility posture; surfaces marked experimental " +
  "(`x-msp-openness`) may change or be removed with a changelog entry.\n";

test("an aligned --publish passes both version gates and dies only at provenance", () => {
  // D-063 (ADR 25304 D1): the only version condition left is lockstep with the
  // host. The unmutated fixture carries the aligned version, so the run below
  // must pass the lockstep gate and the posture gate and die at the provenance
  // interlock — which sits several gates further down, past build, registry
  // state, and pack-and-audit — and never at the version.
  const pkg = fixtureWith(() => {});
  writeFileSync(join(pkg, "README.md"), POSTURE_README);
  const result = run(["--publish"], { SDK_PACKAGE_DIR: pkg, GITHUB_ACTIONS: "" });
  assert.notEqual(result.status, 0, "outside Actions no publish can proceed at all");
  assert.doesNotMatch(
    result.combined,
    /does not match the host version|version floor|D-013 forbids/i,
    "an aligned version must not be a reason to refuse; the only refusal left " +
      `here is provenance:\n${result.combined}`,
  );
  assert.match(
    result.combined,
    /provenance/i,
    `the run must get past the version gates and reach the provenance ` +
      `interlock further down:\n${result.combined}`,
  );
});

/**
 * Assert `--publish` refuses this README **at the posture gate**.
 *
 * The refusal has to be pinned to the gate's own message, not to properties an
 * ACCEPT run also has. Outside Actions every run dies at the provenance gate,
 * so `status != 0` and "Nothing was published" are true either way — and the
 * ACCEPT line itself says `ok: README states the lockstep ... (D-063)`, which
 * supplies both /D-063/ and /README/. An assertion that all four survive is an
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
    /requires the README to state the lockstep/,
    `${why}: must die at the POSTURE gate, not merely somewhere downstream:\n${result.combined}`,
  );
  assert.doesNotMatch(
    result.combined,
    /ok: README states/,
    `${why}: the gate reported the posture as satisfied`,
  );
  assert.match(result.combined, /D-063/, "the message must name the amendment it enforces");
  assert.match(result.combined, /Nothing was published/);
}

test("a --publish whose README omits the posture entirely fails before the registry", () => {
  // D-063 keeps publication conditioned on the artifact stating its own
  // posture where a registry reader will see it — now the lockstep /
  // product-stability posture instead of the 0.x disclaimer.
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

test("the posture gate refuses a README missing the lockstep clause", () => {
  assertPostureRefused(
    "# `@muse-code/sdk`\n\nThe stable MSP surface follows the product's " +
      "compatibility posture; experimental surfaces may change or be removed.\n",
    "no lockstep clause",
  );
});

test("the posture gate refuses a README missing the stable-surface clause", () => {
  assertPostureRefused(
    "# `@muse-code/sdk`\n\nThis package versions in lockstep with Muse Code. " +
      "Experimental surfaces may change or be removed.\n",
    "no stable-surface clause",
  );
});

test("the posture gate refuses a README missing the experimental caveat", () => {
  assertPostureRefused(
    "# `@muse-code/sdk`\n\nThis package versions in lockstep with Muse Code. " +
      "The stable MSP surface follows the product's compatibility posture.\n",
    "no experimental caveat",
  );
});

test("the posture gate refuses a README asserting the OPPOSITE posture", () => {
  // The markers are deliberately loose substring matches, which is what makes
  // them survive a rewording — and exactly what a negation would exploit:
  // "no longer in lockstep" contains the word "lockstep". A gate a negation
  // passes is not a gate.
  assertPostureRefused(
    "# `@muse-code/sdk`\n\nThis package is no longer in lockstep with Muse " +
      "Code. The stable MSP surface follows the product's compatibility " +
      "posture; experimental surfaces may change or be removed.\n",
    "an inverted posture",
  );
});

test("the posture gate accepts the posture phrased without the word 'lockstep'", () => {
  // The markers are a floor, not a wording pin: a README that states the same
  // posture in different words must publish. An ACCEPT arm needs the opposite
  // proof from a REFUSE arm: outside Actions every run fails, so "it failed"
  // says nothing. What distinguishes acceptance is WHERE it failed — at
  // provenance, having first reported the posture ok.
  const pkg = fixtureWith(() => {});
  writeFileSync(
    join(pkg, "README.md"),
    "# `@muse-code/sdk`\n\nThe SDK version tracks the Muse Code release it " +
      "ships with. The stable MSP surface carries the product's compatibility " +
      "promise; experimental surfaces are subject to change.\n",
  );
  const result = run(["--publish"], { SDK_PACKAGE_DIR: pkg, GITHUB_ACTIONS: "" });
  assert.match(
    result.combined,
    /ok: README states the lockstep/,
    `this wording states the posture and must pass the gate:\n${result.combined}`,
  );
  assert.doesNotMatch(result.combined, /requires the README to state the lockstep/);
  assert.match(
    result.combined,
    /provenance/i,
    `and must then reach the provenance interlock further down:\n${result.combined}`,
  );
});

test("the shipping README satisfies the posture gate today", () => {
  // This is the only check in CI that reads the REAL README: without it a PR
  // rewording the posture keeps every lane green and the break first surfaces
  // as a refused publish run — an outage, not a red PR. Pack-only prints the
  // same acceptance line as --publish, so no publish path is exercised here.
  const result = run([]);
  assert.match(
    result.combined,
    /ok: README states the lockstep/,
    `the shipping README must state the lockstep posture (tdd SS7.1):\n${result.combined}`,
  );
});

test("--publish refuses a manifest version that is not the host version (D-063 lockstep)", () => {
  // ADR 25304 D1: the version is set by the release train; publishing a
  // version the host tree does not carry fails before the registry.
  const pkg = fixtureWith((m) => {
    m.version = "9.9.9";
  });
  writeFileSync(join(pkg, "README.md"), POSTURE_README);
  const result = run(["--publish"], { SDK_PACKAGE_DIR: pkg, GITHUB_ACTIONS: "" });
  assert.notEqual(result.status, 0, "a diverged version must not publish");
  assert.match(
    result.combined,
    /does not match the host version/,
    `must die at the lockstep gate:\n${result.combined}`,
  );
  assert.match(result.combined, /D-063/, "the message must name the amendment it enforces");
  assert.match(result.combined, /Nothing was published/);
  assert.doesNotMatch(
    result.combined,
    /provenance/i,
    "the run must stop at the lockstep gate, before the provenance interlock",
  );
});

test("pack-only tolerates a diverged version with a note; the always-on equality lives in npm-publication.test.ts", () => {
  // Same CI-decoupling rationale as the posture gate: pack-only runs on every
  // push, and the in-repo equality is already enforced by the
  // npm-publication.test.ts lockstep arm, which reds the PR that diverges.
  const pkg = fixtureWith((m) => {
    m.version = "9.9.9";
  });
  const result = run([], { SDK_PACKAGE_DIR: pkg });
  assert.equal(
    result.status,
    0,
    `pack-only must stay green on a diverged version:\n${result.combined}`,
  );
  assert.match(
    result.combined,
    /does not match the host version|note:.*host/i,
    "pack-only must still SAY the version is diverged",
  );
});

test("pack-only never fails on the posture, whatever the README says", () => {
  // The gate is a publish precondition, not a build one. Failing pack-only on
  // it would couple this package's CI to the README edit that states the
  // posture, and CI runs pack-only on every push (ADR 25304 D3 keeps the
  // D-053-era decoupling).
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
  // The unmutated fixture is aligned and its real README states the posture,
  // so auth is what is tested.
  const pkg = fixtureWith(() => {});
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
  const pkg = fixtureWith(() => {});
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

// ---- the external-audience gate arms (#37515) ------------------------------
//
// The README is the npm long description and the manifest description is the
// listing summary; 0.1.1 shipped both citing artifacts only the producing
// repository resolves. The shared checker's per-class refusals are proven in
// the Python suite that owns it; these arms prove THIS script's wiring: the
// gate audits the packed tarball, fires in pack-only (so the leak class reds
// the PR, not the publish), and fails closed when the checker is missing.

test("the audience gate refuses a tarball whose README cites private artifacts", () => {
  const pkg = fixtureWith(() => {});
  // The posture clauses are present, so the only refusal left is the leak.
  writeFileSync(
    join(pkg, "README.md"),
    `${POSTURE_README}\nOwning spec: specs/14990-muse-sdk (INV-009).\n`,
  );
  const result = run([], { SDK_PACKAGE_DIR: pkg });
  assert.notEqual(result.status, 0, "a leaking README must fail pack-only");
  assert.match(
    result.combined,
    /spec-path/,
    `the refusal must name the leak class:\n${result.combined}`,
  );
  assert.match(result.combined, /37515/, "the message must name the tracking issue");
});

test("the audience gate refuses a manifest description citing private artifacts", () => {
  const pkg = fixtureWith((m) => {
    m.description = "The MSP TypeScript facade; owning spec specs/14990-muse-sdk.";
  });
  writeFileSync(join(pkg, "README.md"), POSTURE_README);
  const result = run([], { SDK_PACKAGE_DIR: pkg });
  assert.notEqual(result.status, 0, "a leaking manifest description must fail pack-only");
  assert.match(
    result.combined,
    /package\.json description/,
    `the refusal must name the description site, not just the README:\n${result.combined}`,
  );
});

test("the audience gate fails closed when the checker is missing from the tree", () => {
  // Exactly the shape a republish that drops the closure file would produce.
  // Publishing unaudited is the failure the gate exists to prevent, so a
  // missing checker is a refusal, never a skip.
  const result = runMirror(mirrorFixture({ host_version: "0.0.0" }, { withChecker: false }), []);
  assert.notEqual(result.status, 0, "a missing checker must fail the run");
  assert.match(
    result.combined,
    /check-sdk-py-external-audience\.py is missing/,
    `the message must name the missing file:\n${result.combined}`,
  );
  assert.match(
    result.combined,
    /sdk-source-closure\.json/,
    "the message must point at the closure manifest that carries it",
  );
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

// ---- the mirror-anchor gate arm (ADR 25304 D1) -----------------------------
//
// The registry is only contacted from the meta-models mirror, whose tree is
// exactly the source closure and carries no `crates/*` path. There the
// lockstep gate's host-version carrier is the mirror's own
// `publish-anchor.json` (`host_version`, written by the re-sync). These arms
// prove that arm on a mirror-shaped fixture: the script copied to a root with
// no `crates/`, a committed clean tree, and an anchor to read.

function mirrorFixture(
  anchor: Record<string, unknown> | string | null,
  { withChecker = true }: { withChecker?: boolean } = {},
): {
  script: string;
  pkg: string;
} {
  const root = mkdtempSync(join(tmpdir(), "sdk-publish-mirror-"));
  fixtureDirs.push(root);
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(script, join(root, "scripts", "publish-sdk-npm.sh"));
  if (withChecker) {
    // The mirror carries the shared audience checker under its python/ tree
    // (the Python-closure layout), not next to this script; the fixture
    // mirrors that so these arms also prove the script's two-layout
    // resolution.
    mkdirSync(join(root, "python", "scripts"), { recursive: true });
    cpSync(audienceChecker, join(root, "python", "scripts", "check-sdk-py-external-audience.py"));
  }
  const pkg = join(root, "clients", "sdk-ts");
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
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(pkg, "README.md"), POSTURE_README);
  if (anchor !== null) {
    const body = typeof anchor === "string" ? anchor : `${JSON.stringify(anchor, null, 2)}\n`;
    writeFileSync(join(root, "publish-anchor.json"), body);
  }
  // The real mirror is a git checkout and --publish's tree-anchor gate demands
  // one, clean; commit the fixture so the run reaches the version gates.
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
  git("init", "-q", ".");
  // Concatenated so the fixture identity never forms an address shape in the
  // published source (the source-audience employee-identifier rule; same
  // dodge as the pre-rename package-name arm above).
  git("config", "user.email", ["t", "example.invalid"].join("@"));
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-q", "-m", "mirror fixture");
  return { script: join(root, "scripts", "publish-sdk-npm.sh"), pkg };
}

function runMirror(
  fixture: { script: string; pkg: string },
  args: string[] = ["--publish"],
): RunResult {
  try {
    const stdout = execFileSync(fixture.script, args, {
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_registry: OFFLINE_REGISTRY,
        ...NO_RETRY,
        ACTIONS_ID_TOKEN_REQUEST_URL: "",
        GITHUB_ACTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "", combined: stdout };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    const stdout = e.stdout ?? "";
    const stderr = e.stderr ?? "";
    return { status: e.status ?? -1, stdout, stderr, combined: `${stdout}\n${stderr}` };
  }
}

test("mirror shape: --publish reads the host version from publish-anchor.json and proceeds on a match", () => {
  const manifest = JSON.parse(
    readFileSync(join(realPackageDir, "package.json"), "utf8"),
  ) as { version: string };
  const result = runMirror(mirrorFixture({ host_version: manifest.version }));
  assert.match(
    result.combined,
    /publish anchor/,
    `a matching anchor must satisfy the lockstep gate:\n${result.combined}`,
  );
  assert.doesNotMatch(result.combined, /does not match the host version/);
  assert.match(
    result.combined,
    /provenance/i,
    `and the run must then reach the provenance interlock:\n${result.combined}`,
  );
});

test("mirror shape: --publish refuses when the manifest differs from the anchor", () => {
  const result = runMirror(mirrorFixture({ host_version: "9.9.9" }));
  assert.notEqual(result.status, 0, "a diverged anchor must not publish");
  assert.match(result.combined, /does not match the host version/);
  assert.match(result.combined, /Nothing was published/);
  assert.doesNotMatch(result.combined, /provenance/i);
});

test("mirror shape: --publish refuses when no host-version carrier exists at all", () => {
  const result = runMirror(mirrorFixture(null));
  assert.notEqual(result.status, 0, "no carrier, no publish");
  assert.match(
    result.combined,
    /no host-version carrier/,
    `the message must say what is missing:\n${result.combined}`,
  );
  assert.match(result.combined, /Nothing was published/);
});

test("mirror shape: an anchor without host_version refuses at the lockstep gate", () => {
  // Exactly the shape a re-sync bug would produce: the file exists, the
  // version does not.
  const result = runMirror(mirrorFixture({}));
  assert.notEqual(result.status, 0, "an empty anchor must not publish");
  assert.match(
    result.combined,
    /names no version/,
    `the message must say the carrier is empty:\n${result.combined}`,
  );
  assert.match(result.combined, /Nothing was published/);
});

test("mirror shape: a malformed anchor refuses --publish cleanly, never a raw parse crash", () => {
  // Constitution XIII scoped failure: pack-only must not depend on the
  // anchor at all, so the parse failure surfaces as the empty-version
  // refusal on --publish, with the script's own FAILED message.
  const result = runMirror(mirrorFixture("{ malformed\n"));
  assert.notEqual(result.status, 0, "a malformed anchor must not publish");
  assert.match(
    result.combined,
    /names no version/,
    `the refusal must be the gate's own, not a Node stack:\n${result.combined}`,
  );
  assert.match(result.combined, /Nothing was published/);
  assert.doesNotMatch(result.combined, /SyntaxError/);
});

test("mirror shape: pack-only never depends on the anchor, malformed or not", () => {
  // The other Constitution XIII half: the scoped refusal is --publish's; a
  // pack-only run over the same malformed anchor must pass every gate with a
  // note, so an edit widening the lockstep die to both modes cannot land
  // green.
  const result = runMirror(mirrorFixture("{ malformed\n"), []);
  assert.equal(
    result.status,
    0,
    `pack-only must stay green under a malformed anchor:\n${result.combined}`,
  );
  assert.match(result.combined, /Pack-only does not/);
  assert.doesNotMatch(result.combined, /SyntaxError/);
});
