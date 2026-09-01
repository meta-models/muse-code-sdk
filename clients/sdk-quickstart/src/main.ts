/**
 * Run the journey and print the segment report.
 *
 *   node dist/src/main.js --bin <path-to-release-built-muse>
 *   node dist/src/main.js --bin <path-to-release-built-muse> --no-provider
 *
 * The default is the provider-configured (acceptance) mode: the harness starts
 * a loopback fake first-party endpoint and points the host's HOME at it, so
 * every one of the twelve segments runs for real. Nothing leaves `127.0.0.1`
 * and no API key is used.
 *
 * `--no-provider` selects the credential-free degradation path: no provider is
 * configured, so the host cannot run a model and the six model-dependent
 * segments fail. That run is useful for isolating the segments that need no
 * model; it is NOT the acceptance artifact.
 *
 * Exit 0 means every required segment passed and every expect-block is still
 * accurate. Exit 1 means a required segment failed, or a blocked segment
 * started passing and now needs promoting.
 */

import { runConfiguredJourney, runJourney } from "./journey.js";
import { formatReport } from "./segments.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const museBin = argument("--bin") ?? process.env["MUSE_BIN"];
if (museBin === undefined || museBin.length === 0) {
  process.stderr.write(
    "usage: node dist/src/main.js --bin <path-to-release-built-muse> [--no-provider]\n" +
      "       (or set MUSE_BIN). Build it with:\n" +
      "       install muse, then: MUSE_BIN=$(command -v muse)\n",
  );
  process.exit(2);
}

if (process.argv.includes("--no-provider")) {
  const report = await runJourney({ museBin });
  process.stdout.write(`${formatReport(report)}\n`);
  process.stdout.write(
    "\nmode=credential-free (no provider configured) — this is the degradation path, not the acceptance run\n",
  );
  process.exit(report.ok ? 0 : 1);
}

const configured = await runConfiguredJourney({ museBin });
process.stdout.write(`${formatReport(configured.report)}\n`);
process.stdout.write(
  `\nmode=provider-configured baseUrl=${configured.baseUrl}` +
    ` catalogGets=${String(configured.catalogGets)}` +
    ` scriptedToolCalls=${String(configured.scriptedToolCalls)}\n`,
);
process.exit(configured.report.ok ? 0 : 1);
