/**
 * Turns N cookbook recipes into one verdict.
 *
 * Each recipe is a small journey (the quickstart's `Segment` contract) plus a
 * declaration of which host binaries it needs. The runner runs them one at a
 * time, in manifest order, and fails the whole run when a recipe fails, when
 * a recipe's journey report is NOT OK, or when a declared host binary was not
 * provided — a verdict that quietly thinned is not a verdict.
 */

import type { JourneyReport } from "./kit/segments.js";
import { formatReport } from "./kit/segments.js";

/** The binaries a CI run provides once and every recipe shares. */
export interface RecipeHosts {
  /** Absolute path to the release-built `muse` binary, when provided. */
  readonly museBin?: string;
  /** Absolute path to the `muse-conformance` binary, when provided. */
  readonly conformanceBin?: string;
  /** Root of the committed golden-transcript corpus (`schema/msp/transcripts`). */
  readonly transcriptRoot: string;
}

/** The env-var spelling for each host, used verbatim in failure messages. */
export const HOST_ENV: Record<HostNeed, string> = {
  museBin: "MUSE_BIN",
  conformanceBin: "MUSE_CONFORMANCE_BIN",
};

export type HostNeed = "museBin" | "conformanceBin";

/** One runnable, documented cookbook entry. */
export interface Recipe {
  readonly id: string;
  /** Plain-words title, used verbatim in the printed report. */
  readonly title: string;
  /** Repository-relative path of the docs page this recipe backs. */
  readonly docsPage: string;
  /** Which of {@link RecipeHosts} this recipe cannot run without. */
  readonly needs: readonly HostNeed[];
  /** Runs the recipe's journey. Throwing marks the recipe failed. */
  run(hosts: RecipeHosts): Promise<JourneyReport>;
}

export interface RecipeResult {
  readonly id: string;
  readonly title: string;
  readonly docsPage: string;
  /** The journey report, when the recipe ran to a report at all. */
  readonly report: JourneyReport | undefined;
  /** Why the recipe failed outside its own journey (missing host, throw). */
  readonly failure: string | undefined;
}

export interface CookbookReport {
  readonly recipes: readonly RecipeResult[];
  /** True only when every recipe produced an OK journey report. */
  readonly ok: boolean;
}

/**
 * Pick one recipe by id for a focused local run (`--only <id>`), so a docs
 * page can say "run this recipe" without demanding every host binary. An
 * unknown id fails loud, naming the known ids — a filter that silently
 * matches nothing would print a green verdict over zero recipes.
 */
export function selectRecipes(
  recipes: readonly Recipe[],
  onlyId: string | undefined,
): readonly Recipe[] {
  if (onlyId === undefined) return recipes;
  const matched = recipes.filter((recipe) => recipe.id === onlyId);
  if (matched.length === 0) {
    throw new Error(
      `no recipe with id "${onlyId}"; known recipes: ${recipes.map((recipe) => recipe.id).join(", ")}`,
    );
  }
  return matched;
}

export async function runRecipes(
  recipes: readonly Recipe[],
  hosts: RecipeHosts,
): Promise<CookbookReport> {
  const results: RecipeResult[] = [];
  for (const recipe of recipes) {
    results.push(await runOne(recipe, hosts));
  }
  return {
    recipes: results,
    ok: results.every((result) => result.failure === undefined && result.report?.ok === true),
  };
}

async function runOne(recipe: Recipe, hosts: RecipeHosts): Promise<RecipeResult> {
  const missing = recipe.needs.filter((need) => {
    const provided = hosts[need];
    return provided === undefined || provided.length === 0;
  });
  if (missing.length > 0) {
    return {
      id: recipe.id,
      title: recipe.title,
      docsPage: recipe.docsPage,
      report: undefined,
      failure:
        `missing required host binar${missing.length === 1 ? "y" : "ies"}: ` +
        missing.map((need) => `${need} (set ${HOST_ENV[need]})`).join(", "),
    };
  }
  try {
    const report = await recipe.run(hosts);
    return {
      id: recipe.id,
      title: recipe.title,
      docsPage: recipe.docsPage,
      report,
      failure: undefined,
    };
  } catch (error) {
    return {
      id: recipe.id,
      title: recipe.title,
      docsPage: recipe.docsPage,
      report: undefined,
      failure: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The human-facing report: every recipe, its journey lines, one verdict. */
export function formatCookbookReport(report: CookbookReport): string {
  const lines: string[] = [];
  let failed = 0;
  for (const result of report.recipes) {
    const recipeFailed = result.failure !== undefined || result.report?.ok !== true;
    if (recipeFailed) failed += 1;
    lines.push(`=== ${recipeFailed ? "FAIL" : "OK  "} ${result.id}  ${result.title}`);
    if (result.failure !== undefined) {
      lines.push(`    ${result.failure}`);
    }
    if (result.report !== undefined) {
      lines.push(...formatReport(result.report).split("\n").map((line) => `    ${line}`));
    }
  }
  lines.push(
    `cookbook ${report.ok ? "OK" : "NOT OK"} (recipes=${String(report.recipes.length)} failed=${String(failed)})`,
  );
  return lines.join("\n");
}
