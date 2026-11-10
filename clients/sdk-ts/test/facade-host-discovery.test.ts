/**
 * FR-79107-1 — `MuseClient.spawn` finds the host the way the Rust and Python
 * SDKs do: an explicit `museBin` wins, else the first executable `muse` on the
 * process `PATH`; no host at all is a typed `MuseHostDiscoveryError` raised
 * before any process is spawned. The resolution itself is driven with an
 * injected `PATH` and platform, so no arm depends on the runner's own `PATH`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXPECTED_SCHEMA_FINGERPRINT, MuseClient, MuseHostDiscoveryError } from "../src/index.js";
import { discoverMuseBin } from "../src/connection/discovery.js";

const CLIENT_INFO = { name: "sdk_test", version: "0.0.0" };
// Failure-only cap for the arm that spawns a real child.
const ARM_TIMEOUT = 20_000;
// The POSIX arms read execute bits and split PATH on ":"; the win32 arm below
// covers the Windows rule on every runner.
const POSIX_ONLY = { skip: process.platform === "win32" ? "POSIX PATH and execute bits" : false };

async function freshDir(t: { after: (fn: () => Promise<void>) => void }, label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `sdk-ts-discovery-${label}-`));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function installExecutable(dir: string, name: string, body = "#!/bin/sh\nexit 0\n"): Promise<string> {
  const binary = join(dir, name);
  await writeFile(binary, body);
  await chmod(binary, 0o755);
  return binary;
}

test("FR-79107-1: an explicit museBin wins over PATH and is returned verbatim", POSIX_ONLY, async (t) => {
  const onPath = await freshDir(t, "explicit");
  await installExecutable(onPath, "muse");
  assert.equal(await discoverMuseBin("/explicit/muse", onPath, "linux"), "/explicit/muse");
});

test("FR-79107-1: PATH lookup returns the first executable muse, skipping a non-executable one", POSIX_ONLY, async (t) => {
  const notExecutable = await freshDir(t, "plain");
  await writeFile(join(notExecutable, "muse"), "not a program\n");
  const first = await freshDir(t, "first");
  const second = await freshDir(t, "second");
  const expected = await installExecutable(first, "muse");
  await installExecutable(second, "muse");

  const found = await discoverMuseBin(undefined, [notExecutable, "", first, second].join(":"), "linux");

  assert.equal(found, expected);
});

test("FR-79107-1: on Windows the PATH lookup looks for muse.exe, as the Rust SDK does", async (t) => {
  const bare = await freshDir(t, "win-bare");
  await writeFile(join(bare, "muse"), "");
  const withExe = await freshDir(t, "win-exe");
  await writeFile(join(withExe, "muse.exe"), "");

  const found = await discoverMuseBin(undefined, [bare, withExe].join(";"), "win32");

  assert.equal(found, join(withExe, "muse.exe"));
});

test("FR-79107-1: no host is a typed error naming museBin, PATH, and the compatibility page", async (t) => {
  const empty = await freshDir(t, "empty");
  for (const path of [empty, undefined]) {
    const error = await discoverMuseBin(undefined, path, process.platform).then(
      () => assert.fail("discovery must refuse when no muse is on PATH"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof MuseHostDiscoveryError, `got ${String(error)}`);
    assert.equal(error.parameter, "museBin");
    assert.match(error.message, /museBin/);
    assert.match(error.message, /PATH/);
    assert.match(error.message, /does not bundle a host/);
    assert.ok(error.message.includes(error.compatibilityUrl), error.message);
  }
});

/**
 * A `muse` on a private PATH directory that runs an inline MSP host through
 * this Node binary, so the spawn arm proves the PATH tier end to end.
 */
async function installInlineHost(dir: string): Promise<void> {
  const host = [
    'import { createInterface } from "node:readline";',
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    "createInterface({ input: process.stdin }).on('line', (line) => {",
    "  const frame = JSON.parse(line);",
    "  if (frame.method !== 'initialize') return;",
    "  send({ jsonrpc: '2.0', id: frame.id, result: {",
    "    experimentalApi: false, grantedCapabilities: [], museHome: '/nonexistent',",
    "    platformFamily: 'unix', platformOs: 'linux',",
    `    schema: { fingerprint: ${JSON.stringify(EXPECTED_SCHEMA_FINGERPRINT)}, version: 1 },`,
    "    serverInfo: { name: 'path-host', version: '0.0.0' },",
    "    sessionDurability: 'durable', userAgent: 'path-host/0.0.0' } });",
    "}).on('close', () => process.exit(0));",
  ].join("\n");
  await writeFile(join(dir, "host.mjs"), host);
  await installExecutable(
    dir,
    "muse",
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(dir, "host.mjs"))} "$@"\n`,
  );
}

test(
  "FR-79107-1: MuseClient.spawn without museBin runs the muse found on PATH",
  { ...POSIX_ONLY, timeout: ARM_TIMEOUT },
  async (t) => {
    const dir = await freshDir(t, "spawn");
    await installInlineHost(dir);
    const saved = process.env["PATH"];
    process.env["PATH"] = dir;
    t.after(() => {
      process.env["PATH"] = saved;
    });

    const client = await MuseClient.spawn({ clientInfo: CLIENT_INFO });
    try {
      assert.equal(client.initializeResult.serverInfo.name, "path-host");
    } finally {
      await client.close();
    }
    assert.deepEqual(await client.exit, { kind: "cleanShutdown" });
  },
);

test("FR-79107-1: MuseClient.spawn without museBin and no muse on PATH refuses before spawning", async (t) => {
  const empty = await freshDir(t, "spawn-empty");
  const saved = process.env["PATH"];
  process.env["PATH"] = empty;
  t.after(() => {
    process.env["PATH"] = saved;
  });

  // A spawn attempt would surface as MuseHostStartError; the discovery error
  // proves no process was started.
  await assert.rejects(MuseClient.spawn({ clientInfo: CLIENT_INFO }), MuseHostDiscoveryError);
});

test(
  "FR-79107-1: the spawn env's PATH does not steer the search; only the process PATH does",
  POSIX_ONLY,
  async (t) => {
    const empty = await freshDir(t, "env-empty");
    const withMuse = await freshDir(t, "env-muse");
    await installInlineHost(withMuse);
    const saved = process.env["PATH"];
    process.env["PATH"] = empty;
    t.after(() => {
      process.env["PATH"] = saved;
    });

    await assert.rejects(
      MuseClient.spawn({ clientInfo: CLIENT_INFO, env: { ...process.env, PATH: withMuse } }),
      MuseHostDiscoveryError,
    );
  },
);
