/**
 * Run every cookbook recipe and print the report.
 *
 *   node dist/src/main.js --bin <release-built-muse> --conformance <muse-conformance>
 *
 * (or set MUSE_BIN / MUSE_CONFORMANCE_BIN). Exit 0 means every recipe's
 * journey passed. Exit 1 means a recipe failed — including a recipe whose
 * declared host binary was not provided; the cookbook never skips a recipe.
 *
 * `--only <recipe-id>` runs one recipe, for a focused local run with only
 * that recipe's binaries built. CI runs the whole manifest.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { argument } from "./args.js";
import { RECIPES } from "./manifest.js";
import { formatCookbookReport, runRecipes, selectRecipes } from "./runner.js";

/** `argument` with the CLI's exit contract: a malformed flag is exit 2. */
function cliArgument(name: string): string | undefined {
  try {
    return argument(process.argv, name);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

function provided(flag: string, env: string): string | undefined {
  const value = cliArgument(flag) ?? process.env[env];
  return value === undefined || value.length === 0 ? undefined : value;
}

const museBin = provided("--bin", "MUSE_BIN");
const conformanceBin = provided("--conformance", "MUSE_CONFORMANCE_BIN");

// dist/src -> package root -> clients -> the repository root.
const projectRoot = join(fileURLToPath(new URL("../..", import.meta.url)), "..", "..");

const report = await runRecipes(selectRecipes(RECIPES, cliArgument("--only")), {
  ...(museBin === undefined ? {} : { museBin }),
  ...(conformanceBin === undefined ? {} : { conformanceBin }),
  transcriptRoot: join(projectRoot, "schema", "msp", "transcripts"),
});
process.stdout.write(`${formatCookbookReport(report)}\n`);
process.exit(report.ok ? 0 : 1);
