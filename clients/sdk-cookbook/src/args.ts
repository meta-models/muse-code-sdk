/**
 * Argv parsing for the cookbook runner, split out of `main.ts` so its
 * fail-loud arms are testable: `main.ts` runs the recipes at import time, so
 * a test can never import it (PR #24319 review).
 */

/**
 * Read `--flag value` or `--flag=value` from `argv`.
 *
 * A present flag with a forgotten value throws instead of reading as "no
 * filter": silently widening `--only` to the whole manifest would run every
 * recipe a dev never asked for, and the equals spelling handled here was the
 * same hole — `--only=cancel-mid-turn` used to match nothing and run
 * everything (PR #24319 review, both verified live). An empty `--only=`
 * returns the empty string, which `selectRecipes` rejects naming the known
 * ids.
 */
export function argument(argv: readonly string[], name: string): string | undefined {
  // Any other token spelled onto the flag (`--only:id`, `--onlyid`) is an
  // unparsed spelling: reading it as "no flag at all" would silently widen
  // the run to the full manifest (FR-24225-3), so it fails loud instead.
  const unparsed = argv.find(
    (entry) => entry.startsWith(name) && entry !== name && !entry.startsWith(`${name}=`),
  );
  if (unparsed !== undefined) {
    throw new Error(
      `${name}: unparsed spelling ${JSON.stringify(unparsed)}; use ${name} <value> or ${name}=<value>`,
    );
  }
  const withEquals = argv.find((entry) => entry.startsWith(`${name}=`));
  if (withEquals !== undefined) return withEquals.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}
