/**
 * The cookbook runner's contract, proven without a binary.
 *
 * The runner is what turns N recipes into one CI verdict, so its failure
 * arms are the ones that must be unreachable by accident:
 *
 *  - a recipe whose required host binary was not provided FAILS the run
 *    (never a silent skip — a verdict that quietly thinned is not a verdict);
 *  - a recipe that throws is captured as that recipe's failure, not a crash
 *    that hides every recipe after it;
 *  - the run is serial and in manifest order, because two release hosts
 *    racing each other is exactly the flake class the quickstart avoids.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

import { argument } from "../src/args.js";
import { runJourney, summarize } from "../src/kit/segments.js";
import { formatCookbookReport, runRecipes, selectRecipes } from "../src/runner.js";
import type { Recipe, RecipeHosts } from "../src/runner.js";
import { RECIPES } from "../src/manifest.js";
import { RECORDED_REQUEST_IDS, recordedRequestIds } from "../src/recipes/approve-or-deny.js";

const HOSTS: RecipeHosts = {
  museBin: "/fake/tbh",
  conformanceBin: "/fake/muse-conformance",
  transcriptRoot: "/fake/transcripts",
};

function passingReport() {
  return summarize([
    {
      id: "step",
      title: "a step",
      outcome: "passed" as const,
      durationMs: 1,
      expectBlock: undefined,
      failure: undefined,
    },
  ]);
}

function fakeRecipe(id: string, overrides?: Partial<Recipe>): Recipe {
  return {
    id,
    title: `recipe ${id}`,
    docsPage: `developer-docs/src/content/docs/cookbook/${id}.mdx`,
    needs: [],
    run: async () => passingReport(),
    ...overrides,
  };
}

test("recipes run serially in manifest order", async () => {
  const events: string[] = [];
  const recipes = [
    fakeRecipe("first", {
      run: async () => {
        events.push("first:start");
        // Yield so an accidentally-parallel runner would interleave.
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push("first:end");
        return passingReport();
      },
    }),
    fakeRecipe("second", {
      run: async () => {
        events.push("second:start");
        events.push("second:end");
        return passingReport();
      },
    }),
  ];
  const report = await runRecipes(recipes, HOSTS);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  assert.deepEqual(report.recipes.map((recipe) => recipe.id), ["first", "second"]);
  assert.equal(report.ok, true);
});

test("a recipe whose required host is missing fails the run, never skips", async () => {
  const untouched: string[] = [];
  const recipes = [
    fakeRecipe("needs-muse", {
      needs: ["museBin"],
      run: async () => {
        untouched.push("ran");
        return passingReport();
      },
    }),
  ];
  const report = await runRecipes(recipes, { transcriptRoot: "/fake/transcripts" });
  assert.deepEqual(untouched, [], "a recipe must not run without its declared host");
  assert.equal(report.ok, false);
  const result = report.recipes[0];
  assert.ok(result !== undefined);
  assert.ok(result.failure !== undefined && /museBin|MUSE_BIN/.test(result.failure),
    `the failure must name the missing host: ${String(result.failure)}`);
});

test("a throwing recipe is captured as its own failure and later recipes still run", async () => {
  const recipes = [
    fakeRecipe("explodes", {
      run: async () => {
        throw new Error("the host went sideways");
      },
    }),
    fakeRecipe("after"),
  ];
  const report = await runRecipes(recipes, HOSTS);
  assert.equal(report.ok, false);
  const [exploded, after] = report.recipes;
  assert.ok(exploded !== undefined && after !== undefined);
  assert.match(String(exploded.failure), /the host went sideways/);
  assert.equal(after.failure, undefined);
  assert.equal(after.report?.ok, true);
});

test("a recipe whose journey report is NOT OK fails the run", async () => {
  const recipes = [
    fakeRecipe("red-journey", {
      run: async () =>
        summarize([
          {
            id: "step",
            title: "a step",
            outcome: "failed" as const,
            durationMs: 1,
            expectBlock: undefined,
            failure: "assertion failed",
          },
        ]),
    }),
  ];
  const report = await runRecipes(recipes, HOSTS);
  assert.equal(report.ok, false);
});

test("the formatted report names every recipe and ends with one verdict line", async () => {
  const report = await runRecipes([fakeRecipe("alpha"), fakeRecipe("beta")], HOSTS);
  const text = formatCookbookReport(report);
  assert.match(text, /alpha/);
  assert.match(text, /beta/);
  assert.match(text, /cookbook OK \(recipes=2 failed=0\)$/);
  const red = await runRecipes(
    [fakeRecipe("alpha", { run: async () => { throw new Error("boom"); } })],
    HOSTS,
  );
  assert.match(formatCookbookReport(red), /cookbook NOT OK \(recipes=1 failed=1\)$/);
});

test("--only selects exactly one known recipe and fails loud on an unknown id", () => {
  const recipes = [fakeRecipe("alpha"), fakeRecipe("beta")];
  assert.deepEqual(selectRecipes(recipes, undefined), recipes);
  assert.deepEqual(
    selectRecipes(recipes, "beta").map((recipe) => recipe.id),
    ["beta"],
  );
  assert.throws(
    () => selectRecipes(recipes, "gamma"),
    /no recipe with id "gamma".*alpha.*beta/,
    "an unknown id must fail naming the known ids, never run zero recipes green",
  );
});

/**
 * FR-24225-3's fail-loud flag arms. Both holes were live once: a bare
 * trailing `--only` and the equals spelling `--only=<id>` each read as "no
 * filter" and silently ran the whole manifest (PR #24319 review).
 */
test("a present flag without a usable value fails loud; both spellings parse", () => {
  assert.equal(argument([], "--only"), undefined);
  assert.equal(argument(["--only", "beta"], "--only"), "beta");
  assert.equal(argument(["--only=beta"], "--only"), "beta");
  assert.throws(
    () => argument(["--only"], "--only"),
    /--only requires a value/,
    "a bare trailing flag must not widen to the full manifest",
  );
  assert.throws(
    () => argument(["--only", "--bin"], "--only"),
    /--only requires a value/,
    "a flag followed by another flag has no value",
  );
  // An empty `--only=` parses to "", which selectRecipes rejects by name —
  // still loud, never a silent widen.
  assert.equal(argument(["--only="], "--only"), "");
  // An unparsed spelling fails loud instead of reading as "no flag at all"
  // and widening to the full manifest (FR-24225-3).
  assert.throws(() => argument(["--only:beta"], "--only"), /unparsed spelling/);
  assert.throws(
    () => selectRecipes([fakeRecipe("alpha")], argument(["--only="], "--only")),
    /no recipe with id ""/,
  );
});

test("runJourney runs teardown exactly once even when a segment fails", async () => {
  // The #15943 host-child leak guard: teardown must run even when a segment
  // fails — skipping teardown on a red journey reds this test. (runSegment
  // swallows segment errors, so the `finally` equals a post-loop call today.)
  const teardowns: string[] = [];
  const report = await runJourney(
    [{
      id: "boom",
      title: "Throws",
      run: async () => {
        throw new Error("boom");
      },
    }],
    {},
    async () => {
      teardowns.push("ran");
    },
  );
  assert.equal(teardowns.length, 1, "teardown must run exactly once on a failing journey");
  assert.equal(report.ok, false);
});

test("the manifest's recipe ids are unique and every docs page exists", async () => {
  const ids = RECIPES.map((recipe) => recipe.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate recipe id in the manifest");
  assert.ok(RECIPES.length >= 2, "the launch manifest carries at least two recipes");
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const projectRoot = join(packageRoot, "..", "..");
  for (const recipe of RECIPES) {
    assert.match(
      recipe.docsPage,
      /^developer-docs\/src\/content\/docs\/cookbook\//,
      `${recipe.id} must document itself under the Cookbook sidebar group`,
    );
    await access(join(projectRoot, recipe.docsPage));
  }
});

/**
 * The OTHER direction of the page↔recipe binding: a cookbook page nobody
 * registered a recipe for would still be autogenerated into the sidebar and
 * ship green — the exact unvalidated-docs rot the cookbook exists to stop
 * (PR #24319 review). The group's index page is the one prose exception.
 */
test("every cookbook page except the index is backed by exactly one recipe", async () => {
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  const projectRoot = join(packageRoot, "..", "..");
  const pagesDir = join(projectRoot, "developer-docs", "src", "content", "docs", "cookbook");
  const backing = RECIPES.map((recipe) => recipe.docsPage);
  assert.equal(
    new Set(backing).size,
    backing.length,
    "two recipes claim the same docs page; a page is backed by exactly one recipe",
  );
  // Recursive: Starlight autogenerates NESTED pages into the sidebar too, so
  // a page tucked into a subfolder must not dodge the scan (PR #24319
  // review). Only the group's top-level index.mdx is exempt.
  const pages = (await readdir(pagesDir, { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile() && /\.(md|mdx)$/.test(entry.name))
    .map((entry) => relative(pagesDir, join(entry.parentPath, entry.name)))
    .filter((name) => name !== "index.mdx");
  for (const page of pages) {
    const repoRelative = `developer-docs/src/content/docs/cookbook/${page}`;
    assert.ok(
      backing.includes(repoRelative),
      `orphan cookbook page with no backing recipe: ${repoRelative} — register a recipe in src/manifest.ts or remove the page`,
    );
  }
});

/**
 * FR-24225-6's fail-loud clause, which nothing else reaches: the journey uses
 * exactly the recorded ids, so the exhaustion throw never fires in a passing
 * run. Softening it into a fallback would keep every check green and bring
 * back the uncorrelatable-ack hang the seam exists to prevent, with no red
 * naming the cause (PR #25153 review). The seam retires with #25143.
 */
test("the recorded-request-id minter walks its ids once, then fails loud", () => {
  const mint = recordedRequestIds();
  const drained = RECORDED_REQUEST_IDS.map(() => mint());
  assert.deepEqual(drained, [1, 2, 3, "b9"], "the minter yields the recorded ids in order");
  assert.throws(
    () => mint(),
    /transcript recorded only/,
    "a request past the recorded set must fail loud, never fall back to a minted id",
  );
});
