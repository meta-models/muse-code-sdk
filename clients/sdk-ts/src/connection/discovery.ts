/**
 * Host discovery for `MuseClient.spawn` (FR-79107-1), mirroring the Rust SDK's
 * `discover_muse_bin` and the Python SDK's: an explicit `museBin` wins and is
 * returned verbatim (existence is the spawn's to prove), else the first
 * executable `muse` on the process `PATH` — `muse.exe` on Windows, as in Rust.
 * The package does not bundle a host, so no host is a typed error raised
 * before any process is started.
 */

import { stat } from "node:fs/promises";
import { join } from "node:path";

import { MuseHostDiscoveryError } from "../errors.js";

/**
 * Resolve the host binary. `path` and `platform` are parameters, not reads, so
 * tests drive them; `MuseClient.spawn` passes the process's own. An empty
 * `PATH` entry is skipped rather than read as the working directory.
 */
export async function discoverMuseBin(
  museBin: string | undefined,
  path: string | undefined,
  platform: NodeJS.Platform,
): Promise<string> {
  if (museBin !== undefined) return museBin;
  const windows = platform === "win32";
  const name = windows ? "muse.exe" : "muse";
  for (const directory of (path ?? "").split(windows ? ";" : ":")) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    if (await isExecutable(candidate, windows)) return candidate;
  }
  throw new MuseHostDiscoveryError();
}

async function isExecutable(candidate: string, windows: boolean): Promise<boolean> {
  try {
    const found = await stat(candidate);
    return found.isFile() && (windows || (found.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}
