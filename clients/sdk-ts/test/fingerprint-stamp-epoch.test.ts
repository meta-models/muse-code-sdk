/**
 * TEST-22936-16 (spec 14990 amendment #22936 FR-22936-5; ADR 22936 D5): the
 * build's stamp step fails closed on a bundle that declares no usable root
 * `compatibilityEpoch`: exit 1, the failure named, nothing substituted and
 * nothing written. The committed bundle itself stamps clean (the control),
 * and a copy that declares epoch 3 stamps 3: the pin is read from the
 * bundle, never a constant.
 * Every run writes to a file under the test's own temporary directory, so
 * the package's real stamped module is never the test's output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
/** `dist/test/` -> `dist/` -> `clients/sdk-ts/` -> `clients/` -> project root. */
const projectRoot = join(here, "..", "..", "..", "..");

const PORT = join(packageRoot, "scripts", "msp-fingerprint.mjs");
const STABLE_SCHEMA = join(projectRoot, "schema", "msp", "stable", "msp.schema.json");
const STAMPED_FILE = join(packageRoot, "src", "fingerprint.stamped.ts");

interface StampResult {
  readonly code: number | null;
  readonly stderr: string;
}

async function runStamp(schemaPath: string, outputPath: string): Promise<StampResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PORT, "--stamp", schemaPath, outputPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function stampedModule(): string | undefined {
  return existsSync(STAMPED_FILE) ? readFileSync(STAMPED_FILE, "utf8") : undefined;
}

test("TEST-22936-16: the stamp step refuses a bundle without a usable root compatibilityEpoch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "msp-stamp-epoch-"));
  try {
    const bundle = JSON.parse(readFileSync(STABLE_SCHEMA, "utf8")) as Record<string, unknown>;
    assert.equal(typeof bundle.compatibilityEpoch, "number", "the committed bundle declares its epoch");

    // The control: the committed bundle's own content stamps clean, so the
    // refusals below come from the member, not from the harness.
    const intact = join(dir, "intact.json");
    writeFileSync(intact, JSON.stringify(bundle));
    const before = stampedModule();
    const controlOut = join(dir, "control.stamped.ts");
    const control = await runStamp(intact, controlOut);
    assert.equal(control.code, 0, `control: ${control.stderr}`);
    const written = readFileSync(controlOut, "utf8");
    assert.ok(
      written.includes(`STAMPED_SCHEMA_COMPATIBILITY_EPOCH = ${String(bundle.compatibilityEpoch)};`),
      `the control stamps the bundle's epoch: ${written}`,
    );
    assert.ok(written.includes("STAMPED_SCHEMA_FINGERPRINT = "), "the control stamps the fingerprint");
    assert.equal(stampedModule(), before, "the real stamped module is not the test's output");

    // The pin is read from the bundle, never a constant: the committed
    // bundle's own epoch is 0 today, so the control alone cannot tell a
    // hard-coded stamp apart; a copy at epoch 3 must stamp 3.
    const bumped: Record<string, unknown> = { ...bundle, compatibilityEpoch: 3 };
    const bumpedPath = join(dir, "bumped.json");
    writeFileSync(bumpedPath, JSON.stringify(bumped));
    const bumpedOut = join(dir, "bumped.stamped.ts");
    const bumpedRun = await runStamp(bumpedPath, bumpedOut);
    assert.equal(bumpedRun.code, 0, `bumped: ${bumpedRun.stderr}`);
    assert.ok(
      readFileSync(bumpedOut, "utf8").includes("STAMPED_SCHEMA_COMPATIBILITY_EPOCH = 3;"),
      "a bundle at epoch 3 stamps epoch 3",
    );
    assert.equal(stampedModule(), before, "bumped: the real stamped module is untouched");

    const malformed: ReadonlyArray<readonly [string, unknown]> = [
      ["absent", undefined],
      ["negative", -1],
      ["fractional", 1.5],
      ["string", "1"],
    ];
    for (const [name, value] of malformed) {
      const copy: Record<string, unknown> = { ...bundle };
      if (value === undefined) {
        delete copy.compatibilityEpoch;
      } else {
        copy.compatibilityEpoch = value;
      }
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(copy));
      const out = join(dir, `${name}.stamped.ts`);
      const result = await runStamp(path, out);
      assert.equal(result.code, 1, `${name}: ${result.stderr}`);
      // The message says which arm failed: an absent member or a present one
      // with a value that is not a non-negative integer.
      const expected =
        value === undefined
          ? "declares no root `compatibilityEpoch`"
          : "declares a root `compatibilityEpoch` that is not a non-negative integer";
      assert.ok(
        result.stderr.includes(expected),
        `${name}: the failure names the member and the arm: ${result.stderr}`,
      );
      assert.ok(!existsSync(out), `${name}: nothing is substituted or written`);
      assert.equal(stampedModule(), before, `${name}: the real stamped module is untouched`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
