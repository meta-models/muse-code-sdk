/**
 * Find the REAL `tbh` binary. The harness never falls back to a stand-in
 * host: a black-box QA harness that quietly tests a fixture proves nothing,
 * so "not found" is an explicit unavailability the caller must handle, never
 * a substitution.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** `clients/sdk-ts/dist/qa/` → the repo's `projects/tbh` root. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

/** The env var the auto-qa procedure sets; it wins over any discovered build. */
export const MUSE_QA_SDK_BIN = "MUSE_QA_SDK_BIN";

export type BinaryResolution =
  | { readonly available: true; readonly path: string; readonly source: string }
  | { readonly available: false; readonly reason: string };

export function resolveMuseBinary(env: NodeJS.ProcessEnv = process.env): BinaryResolution {
  const explicit = env[MUSE_QA_SDK_BIN];
  if (explicit !== undefined && explicit !== "") {
    return existsSync(explicit)
      ? { available: true, path: explicit, source: MUSE_QA_SDK_BIN }
      : { available: false, reason: `${MUSE_QA_SDK_BIN}=${explicit} does not exist` };
  }
  const candidates = [
    ...(env["CARGO_TARGET_DIR"] === undefined
      ? []
      : [[join(env["CARGO_TARGET_DIR"], "debug", "tbh"), "CARGO_TARGET_DIR/debug"] as const]),
    [join(REPO_ROOT, "target", "debug", "tbh"), "target/debug"] as const,
    [join(REPO_ROOT, "target", "release", "tbh"), "target/release"] as const,
  ];
  for (const [path, source] of candidates) {
    if (existsSync(path)) return { available: true, path, source };
  }
  return {
    available: false,
    reason: [
      `no \`tbh\` binary found. Build one and point ${MUSE_QA_SDK_BIN} at it:`,
      "  CARGO_TARGET_DIR=$(scripts/probe-env.sh --print) cargo build -p tbh-cli --bin tbh",
      `  export ${MUSE_QA_SDK_BIN}=$CARGO_TARGET_DIR/debug/tbh`,
      `searched: ${candidates.map(([path]) => path).join(", ")}`,
    ].join("\n"),
  };
}
