/**
 * The fingerprint-vector proof for the dependency-free Node port.
 *
 * `scripts/msp-fingerprint.mjs` computes the schema fingerprint without the
 * compiled protocol crate (ADR 77546 D4: the TypeScript SDK derives its pin
 * at build). This suite runs it against the same shared fixture the compiled
 * implementation proves (`schema/msp/fingerprint-vectors.json`): frozen
 * values plus the twin relations, structurally. A port that cannot reproduce
 * a vector fails here.
 *
 * The suite shells out to the port's CLI per vector — the same CLI the
 * receipt-pins gate and the Rust real-bundle proof invoke — so the CLI shape
 * itself is exercised, not just the algorithm.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** `dist/test/` -> `dist/` -> `clients/sdk-ts/`. */
const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..", "..");
/** `dist/test/` -> `dist/` -> `clients/sdk-ts/` -> `clients/` -> project root. */
const projectRoot = join(here, "..", "..", "..", "..");

const PORT = join(packageRoot, "scripts", "msp-fingerprint.mjs");

interface Vector {
  name: string;
  variant: string;
  schema: string;
  fingerprint?: string;
  error?: string;
}

function vectors(): Vector[] {
  const fixture = JSON.parse(
    readFileSync(join(projectRoot, "schema", "msp", "fingerprint-vectors.json"), "utf8"),
  ) as { vectors: Vector[] };
  assert.ok(fixture.vectors.length > 0, "an empty vector file proves nothing");
  const names = fixture.vectors.map((vector) => vector.name);
  assert.equal(new Set(names).size, names.length, "vector names are unique keys");
  return fixture.vectors;
}

interface PortResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runPort(variant: string, schema: string): Promise<PortResult> {
  // `spawn`, not `execFile`: the schema travels on stdin (`-`), and
  // `ExecFileOptions` carries no typed `input` in this @types/node.
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PORT, variant, "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.write(schema, "utf8");
    child.stdin.end();
  });
}

/** The refusal kind from the CLI's `<label> refuses fingerprinting (<kind>)` stderr contract. */
function refusalKind(stderr: string): string | undefined {
  return /refuses fingerprinting \(([^)]+)\)/.exec(stderr)?.[1];
}

test("the Node port proves every shared vector", async () => {
  const actuals = new Map<string, string>();
  for (const vector of vectors()) {
    const result = await runPort(vector.variant, vector.schema);
    if (vector.error !== undefined) {
      assert.notEqual(
        result.code,
        0,
        `vector \`${vector.name}\` must refuse, but the port printed ${JSON.stringify(result.stdout.trim())}`,
      );
      assert.equal(
        refusalKind(result.stderr),
        vector.error,
        `vector \`${vector.name}\` refused differently (${result.stderr.trim()})`,
      );
    } else {
      assert.equal(
        result.code,
        0,
        `vector \`${vector.name}\` must fingerprint, but the port refused (${result.stderr.trim()})`,
      );
      const actual = result.stdout.trim();
      assert.equal(actual, vector.fingerprint, `vector \`${vector.name}\` moved (actual ${actual})`);
      actuals.set(vector.name, actual);
    }
  }
  // The twin relations, structurally: a strip twin equals its stripped
  // input, key order and whitespace never move the value, and the
  // variant tag separates the two renders of one document. The presence
  // guards come first: without them two absent twins compare
  // undefined == undefined and the arm passes vacuously.
  const present = (name: string, why: string) =>
    assert.ok(actuals.has(name), `vector \`${name}\` must have fingerprinted (${why})`);
  const equal = (a: string, b: string, why: string) => {
    present(a, why);
    present(b, why);
    assert.equal(actuals.get(a), actuals.get(b), why);
  };
  equal("strip-stable", "strip-twin", "the strip twin must equal its stripped input");
  equal(
    "minimal-stable",
    "reordered-whitespace",
    "key order and whitespace must not move the value",
  );
  equal("collapse-branch", "collapse-twin", "the collapsed twin must equal its flat form");
  equal("emptied-required", "emptied-required-twin", "an emptied `required` drops the key");
  equal("anyof-drop-arm", "anyof-drop-twin", "an experimental `anyOf` arm drops, not nulls");
  equal(
    "kept-root-member",
    "kept-root-member-twin",
    "a root-direct experimental member is kept, stripped",
  );
  equal("enumless-oneof", "enumless-oneof-twin", "an enum-less lone branch never collapses");
  present("experimental-oneof-kept", "experimental never collapses oneOf");
  present("experimental-oneof-flat", "experimental never collapses oneOf");
  assert.notEqual(
    actuals.get("experimental-oneof-kept"),
    actuals.get("experimental-oneof-flat"),
    "experimental never collapses oneOf",
  );
  present("minimal-stable", "the variant tag must separate the two renders");
  present("minimal-experimental", "the variant tag must separate the two renders");
  assert.notEqual(
    actuals.get("minimal-stable"),
    actuals.get("minimal-experimental"),
    "the variant tag must separate the two renders",
  );
});
