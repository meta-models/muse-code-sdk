/**
 * The `configureProvider` opt-in (#23537): the one mechanism by which a
 * scenario's host starts CONFIGURED instead of logged-out.
 *
 * Both arms exist because each failure mode silently recreates the D19535
 * false-positive class: a drifted settings shape / write location makes every
 * opted-in host run unconfigured, and a missing `XDG_CONFIG_HOME` in an
 * overridden env would write settings the spawned host never reads. The write
 * is asserted byte-for-byte where the host resolves it; the missing-env arm
 * must fail loudly, never guess a path.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RecordedHost, scenarioWorkDir } from "../qa/index.js";

const SCRIPTED_HOST = fileURLToPath(new URL("./helpers/qa-scripted-host.js", import.meta.url));

test("configureProvider writes the settings the spawned host resolves", async () => {
  const workDir = await scenarioWorkDir("provider-config");
  try {
    const host = await RecordedHost.open({
      museBin: process.execPath,
      argv: [SCRIPTED_HOST, "faithful"],
      workDir,
      label: "provider-config",
      configureProvider: "echo",
    });
    await host.initialize();
    await host.request("list", "session/list", {});
    await host.finish();

    const settingsPath = join(
      workDir,
      "provider-config-home",
      "config",
      "muse",
      "settings.json",
    );
    const settings: unknown = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(
      settings,
      { schema_version: 1, provider: "echo" },
      "the host reads exactly this file (env XDG_CONFIG_HOME + /muse/settings.json); any drift in shape or location runs the host unconfigured and revives the D19535 false positive",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});

test("configureProvider refuses an env with no XDG_CONFIG_HOME", async () => {
  const workDir = await scenarioWorkDir("provider-config-noenv");
  try {
    await assert.rejects(
      RecordedHost.open({
        museBin: process.execPath,
        argv: [SCRIPTED_HOST, "faithful"],
        workDir,
        label: "provider-config-noenv",
        env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
        configureProvider: "echo",
      }),
      /XDG_CONFIG_HOME/,
      "guessing a config path here writes settings the spawned host never reads — the scenario would run logged-out while believing it opted in",
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
