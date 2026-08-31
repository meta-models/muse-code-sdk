/**
 * `node dist/qa/bin.js [--json <path>] [--markdown <path>]`
 *
 * One QA pass over the real binary, printing the report. Exit codes are for
 * the OPERATOR, not for CI: findings are the harness working, not failing.
 *   0  the pass ran (with or without findings)
 *   2  the pass could not run (no real binary)
 */

import { writeFile } from "node:fs/promises";

import { resolveMuseBinary } from "./binary.js";
import { renderReportMarkdown } from "./report.js";
import { runSdkQa } from "./run.js";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const resolved = resolveMuseBinary();
if (!resolved.available) {
  process.stderr.write(`auto-qa --area sdk cannot run: ${resolved.reason}\n`);
  process.exit(2);
}

const report = await runSdkQa({ museBin: resolved.path, museVersion: resolved.source });
const markdown = renderReportMarkdown(report);

const jsonOut = flag("--json");
if (jsonOut !== undefined) await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`, "utf8");
const markdownOut = flag("--markdown");
if (markdownOut !== undefined) await writeFile(markdownOut, markdown, "utf8");

process.stdout.write(`${markdown}\n`);
