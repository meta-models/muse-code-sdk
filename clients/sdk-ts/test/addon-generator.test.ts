/**
 * TEST-97527-4 (FR-97527-4) — the experimental add-on generator.
 *
 * `scripts/generate-sdk-experimental-addon.mjs` reads the experimental and
 * stable schema bundles plus the previous release's stable bundle and emits
 * the version-locked `@muse-code/sdk-experimental` package: typed wrappers
 * for experimental-only methods, extensions for experimental-only
 * notifications, the mismatch gate, and one-release re-exports for
 * just-promoted features. Everything derives at generation time — the
 * experimental-only set, the promotion window, the expected fingerprint —
 * never from a committed list.
 *
 * Fixtures are SYNTHETIC (`x/…` names): no real experimental name may appear
 * in this suite (the public package this file ships beside must never name
 * one). The suite generates into a temp dir, typechecks the output with the
 * workspace `tsc`, and imports the built package for the behavioral arms.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `dist/test/` -> `dist/` -> `clients/sdk-ts/` -> `clients/` -> project root. */
const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..", "..");
const script = join(projectRoot, "scripts", "generate-sdk-experimental-addon.mjs");
const tsc = join(projectRoot, "node_modules", ".bin", "tsc");
const sdkDir = join(projectRoot, "clients", "sdk-ts");
const fingerprintPort = join(sdkDir, "scripts", "msp-fingerprint.mjs");

const HOST_VERSION = "0.0.0-test";

const STABLE_FIXTURE = {
  $defs: {
    ItemKind: { enum: ["stableA", "stableB"] },
    SChangedParams: { properties: { sessionId: { type: "string" } }, type: "object" },
    SNewParams: { properties: { sessionId: { type: "string" } }, type: "object" },
    SNewResult: { properties: { ok: { type: "boolean" } }, type: "object" },
    SOldParams: { properties: { sessionId: { type: "string" } }, type: "object" },
    SOldResult: { properties: { ok: { type: "boolean" } }, type: "object" },
    SPingParams: { properties: { sessionId: { type: "string" } }, type: "object" },
    SPingResult: { properties: { pong: { type: "boolean" } }, type: "object" },
  },
  methods: {
    "s/new": {
      params: { $ref: "#/$defs/SNewParams" },
      result: { $ref: "#/$defs/SNewResult" },
      "x-msp-descriptor": "s/new",
    },
    "s/old": {
      params: { $ref: "#/$defs/SOldParams" },
      result: { $ref: "#/$defs/SOldResult" },
      "x-msp-descriptor": "s/old",
    },
    "s/ping": {
      params: { $ref: "#/$defs/SPingParams" },
      result: { $ref: "#/$defs/SPingResult" },
      "x-msp-descriptor": "s/ping",
    },
  },
  notifications: {
    "s/changed": {
      params: { $ref: "#/$defs/SChangedParams" },
      "x-msp-descriptor": "s/changed",
    },
  },
  requests: {},
};

const PREVIOUS_STABLE_FIXTURE = {
  $defs: STABLE_FIXTURE.$defs,
  methods: {
    "s/old": STABLE_FIXTURE.methods["s/old"],
    "s/ping": STABLE_FIXTURE.methods["s/ping"],
  },
  notifications: STABLE_FIXTURE.notifications,
  requests: {},
};

const EXPERIMENTAL_FIXTURE = {
  $defs: {
    ...STABLE_FIXTURE.$defs,
    ItemKind: {
      oneOf: [
        { enum: ["stableA", "stableB"], type: "string" },
        { const: "xKind", type: "string", "x-msp-stability": "experimental" },
      ],
    },
    XAlphaResult: { properties: { alpha: { type: "string" } }, type: "object" },
    XBetaParams: { properties: { sessionId: { type: "string" } }, type: "object" },
    XBetaResult: { properties: { beta: { type: "string" } }, type: "object" },
    XEventParams: { properties: { sessionId: { type: "string" } }, type: "object" },
  },
  methods: {
    ...STABLE_FIXTURE.methods,
    "x/alpha": {
      result: { $ref: "#/$defs/XAlphaResult" },
      "x-msp-descriptor": "x/alpha",
      "x-msp-stability": "experimental",
    },
    "x/beta": {
      params: { $ref: "#/$defs/XBetaParams" },
      result: { $ref: "#/$defs/XBetaResult" },
      "x-msp-descriptor": "x/beta",
      "x-msp-stability": "experimental",
    },
  },
  notifications: {
    ...STABLE_FIXTURE.notifications,
    "x/event": {
      params: { $ref: "#/$defs/XEventParams" },
      "x-msp-descriptor": "x/event",
      "x-msp-stability": "experimental",
    },
  },
  requests: {
    "x/ask": {
      params: { $ref: "#/$defs/XBetaParams" },
      result: { $ref: "#/$defs/XBetaResult" },
      "x-msp-descriptor": "x/ask",
      "x-msp-stability": "experimental",
    },
  },
};

/** Mutable view for tampering fixture copies in the negative arms. */
interface MutableTestBundle {
  $defs: { ItemKind: { oneOf?: Array<Record<string, unknown>> } };
  methods: Record<string, Record<string, unknown>>;
  notifications: Record<string, Record<string, unknown>>;
  requests: Record<string, Record<string, unknown>>;
}

/** Minimal experimental declarations fixture: `$def` X becomes `interface X`. */
const MSP_TYPES_FIXTURE = `export interface SNewParams {
  readonly sessionId: string;
}
export interface SNewResult {
  readonly ok: boolean;
}
export interface XAlphaResult {
  readonly alpha: string;
}
export interface XBetaParams {
  readonly sessionId: string;
}
export interface XBetaResult {
  readonly beta: string;
}
export interface XEventParams {
  readonly sessionId: string;
}
`;

function writeFixtures(dir: string): {
  readonly experimental: string;
  readonly mspTypes: string;
  readonly previousStable: string;
  readonly stable: string;
} {
  const stable = join(dir, "stable.json");
  const experimental = join(dir, "experimental.json");
  const previousStable = join(dir, "previous.json");
  const mspTypes = join(dir, "msp.d.ts");
  writeFileSync(stable, JSON.stringify(STABLE_FIXTURE));
  writeFileSync(experimental, JSON.stringify(EXPERIMENTAL_FIXTURE));
  writeFileSync(previousStable, JSON.stringify(PREVIOUS_STABLE_FIXTURE));
  writeFileSync(mspTypes, MSP_TYPES_FIXTURE);
  return { experimental, mspTypes, previousStable, stable };
}

function generate(args: readonly string[]): { readonly out: string; readonly root: string } {
  const root = mkdtempSync(join(tmpdir(), "sdk-experimental-addon-"));
  mkdirSync(join(root, "in"), { recursive: true });
  const fixtures = writeFixtures(join(root, "in"));
  const out = join(root, "out");
  execFileSync(
    process.execPath,
    [
      script,
      "--stable",
      fixtures.stable,
      "--experimental",
      fixtures.experimental,
      "--previous-stable",
      fixtures.previousStable,
      "--msp-types",
      fixtures.mspTypes,
      "--host-version",
      HOST_VERSION,
      "--out",
      out,
      ...args,
    ],
    { stdio: "pipe" },
  );
  return { out, root };
}

function cleanup(root: string): void {
  rmSync(root, { force: true, recursive: true });
}

/** Link the real SDK for types, compile the emitted tree, import the result. */
async function buildGenerated(out: string): Promise<Record<string, unknown>> {
  mkdirSync(join(out, "node_modules", "@muse-code"), { recursive: true });
  symlinkSync(sdkDir, join(out, "node_modules", "@muse-code", "sdk"), "dir");
  writeFileSync(
    join(out, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        allowJs: false,
        declaration: true,
        module: "nodenext",
        moduleResolution: "nodenext",
        outDir: "dist",
        rootDir: "src",
        skipLibCheck: true,
        strict: true,
        target: "es2022",
      },
      include: ["src/**/*.ts"],
    }),
  );
  execFileSync(tsc, ["-p", out], { stdio: "pipe" });
  // tsc does not carry the vendored declarations into dist/; the release
  // build copies them the same way before packing (step 6).
  writeFileSync(
    join(out, "dist", "msp.d.ts"),
    readFileSync(join(out, "src", "msp.d.ts"), "utf8"),
  );
  return (await import(pathToFileURL(join(out, "dist", "index.js")).href)) as Record<string, unknown>;
}

/** Call a generated client method by name, failing loudly when it is absent. */
async function callMethod(
  client: { [method: string]: unknown },
  method: string,
  params?: unknown,
): Promise<unknown> {
  const fn = client[method];
  assert.equal(typeof fn, "function", `expected generated method ${method}`);
  return (fn as (this: unknown, params?: unknown) => Promise<unknown>).call(client, params);
}

test("the generator emits wrappers for exactly the experimental-only methods", () => {
  const { out, root } = generate([]);
  try {
    const client = readFileSync(join(out, "src", "client.ts"), "utf8");
    assert.ok(client.includes("async xAlpha("), "params-less experimental method");
    assert.ok(client.includes("async xBeta("), "experimental method with params");
    assert.ok(!client.includes("sPing("), "no stable leakage");
    assert.ok(client.includes("async sNew("), "just-promoted method kept for one release");
    assert.ok(client.includes("@deprecated"), "the kept wrapper is marked deprecated");
    assert.ok(!client.includes("sOld("), "promoted two releases back is gone");
  } finally {
    cleanup(root);
  }
});

test("the emitted package typechecks and versions lock to the host", async () => {
  const { out, root } = generate([]);
  try {
    const manifest = JSON.parse(readFileSync(join(out, "package.json"), "utf8")) as Record<string, unknown>;
    assert.equal(manifest["name"], "@muse-code/sdk-experimental");
    assert.equal(manifest["version"], HOST_VERSION);
    assert.deepEqual(manifest["dependencies"] ?? {}, {}, "zero runtime dependencies");
    const addon = await buildGenerated(out);
    assert.equal(addon["ADDON_HOST_VERSION"], HOST_VERSION);
    assert.match(addon["EXPECTED_EXPERIMENTAL_FINGERPRINT"] as string, /^sha256:[0-9a-f]{64}$/);
  } finally {
    cleanup(root);
  }
});

test("a fingerprint mismatch fails the experimental call typed while stable calls succeed", async () => {
  const { out, root } = generate([]);
  try {
    const addon = await buildGenerated(out);
    const calls: Array<{ method: string; params: unknown }> = [];
    const requester = {
      request: async (method: string, params?: unknown): Promise<unknown> => {
        calls.push({ method, params });
        return { beta: "ok" };
      },
    };
    const ExpectedMismatch = addon["ExperimentalSchemaMismatch"] as new (...args: never[]) => Error;
    const ExperimentalClient = addon["ExperimentalClient"] as new (
      requester: unknown,
      served: string | undefined,
    ) => { [method: string]: unknown };
    const expected = addon["EXPECTED_EXPERIMENTAL_FINGERPRINT"] as string;
    // Wrong fingerprint: the experimental call fails typed, before any frame.
    const skewed = new ExperimentalClient(requester, "sha256:0000000000000000000000000000000000000000000000000000000000000000");
    await assert.rejects(callMethod(skewed, "xBeta", { sessionId: "s-1" }), (error: unknown) => {
      assert.ok(error instanceof ExpectedMismatch);
      assert.equal((error as { expected?: unknown }).expected, expected);
      return true;
    });
    // Absent member (a host that predates the report): same typed failure.
    const unknown = new ExperimentalClient(requester, undefined);
    await assert.rejects(callMethod(unknown, "xBeta", { sessionId: "s-1" }), ExpectedMismatch);
    // Stable calls on the same connection are unaffected either way.
    assert.deepEqual(await requester.request("s/ping", { sessionId: "s-1" }), { beta: "ok" });
    assert.deepEqual(calls, [{ method: "s/ping", params: { sessionId: "s-1" } }]);
    // Matching fingerprint: the typed call goes through.
    const matched = new ExperimentalClient(requester, expected);
    assert.deepEqual(await callMethod(matched, "xBeta", { sessionId: "s-1" }), { beta: "ok" });
  } finally {
    cleanup(root);
  }
});

test("the emitted extensions observe experimental notifications with typed state", async () => {
  const { out, root } = generate([]);
  try {
    const addon = await buildGenerated(out);
    const all = addon["allExperimentalExtensions"] as (onError?: (error: unknown) => void) => Array<{
      apply(params: unknown): void;
      current: unknown;
      method: string;
    }>;
    const extensions = all();
    assert.deepEqual(
      extensions.map((extension) => extension.method),
      ["x/event"],
    );
    extensions[0]?.apply({ sessionId: "s-1" });
    assert.deepEqual(extensions[0]?.current, { sessionId: "s-1" });
    assert.deepEqual(addon["EXPERIMENTAL_ITEM_KINDS"], ["xKind"]);
  } finally {
    cleanup(root);
  }
});

function generateRaw(files: Record<string, string>, args: readonly string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), "sdk-experimental-addon-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  try {
    execFileSync(
      process.execPath,
      [
        script,
        "--stable",
        join(root, "stable.json"),
        "--experimental",
        join(root, "experimental.json"),
        "--previous-stable",
        join(root, "previous.json"),
        "--msp-types",
        join(root, "msp.d.ts"),
        "--host-version",
        HOST_VERSION,
        "--out",
        join(root, "out"),
        ...args,
      ],
      { stdio: "pipe" },
    );
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
  return root;
}

test("a marker/diff disagreement fails naming the diff", () => {
  const tampered = JSON.parse(JSON.stringify(EXPERIMENTAL_FIXTURE)) as MutableTestBundle;
  const tamperedEntry = tampered.methods["x/alpha"];
  assert.ok(tamperedEntry !== undefined);
  tamperedEntry["x-msp-stability"] = "stable";
  assert.throws(
    () =>
      generateRaw({
        "experimental.json": JSON.stringify(tampered),
        "msp.d.ts": MSP_TYPES_FIXTURE,
        "previous.json": JSON.stringify(PREVIOUS_STABLE_FIXTURE),
        "stable.json": JSON.stringify(STABLE_FIXTURE),
      }),
    /marker\/diff disagreement in "methods": in diff only \[x\/alpha\], marked only \[\]/,
  );
});

test("a wrapper name collision fails naming the methods", () => {
  const colliding = JSON.parse(JSON.stringify(EXPERIMENTAL_FIXTURE)) as MutableTestBundle;
  colliding.methods["xBeta"] = {
    result: { $ref: "#/$defs/XBetaResult" },
    "x-msp-descriptor": "xBeta",
    "x-msp-stability": "experimental",
  };
  assert.throws(() => generateRaw({
    "experimental.json": JSON.stringify(colliding),
    "msp.d.ts": MSP_TYPES_FIXTURE,
    "previous.json": JSON.stringify(PREVIOUS_STABLE_FIXTURE),
    "stable.json": JSON.stringify(STABLE_FIXTURE),
  }), /wrapper name collision: "xBeta" and "x\/beta" both map to "xBeta"/);
});

test("a dangling params $ref fails naming the method", () => {
  const dangling = JSON.parse(JSON.stringify(EXPERIMENTAL_FIXTURE)) as MutableTestBundle;
  const danglingEntry = dangling.methods["x/beta"];
  assert.ok(danglingEntry !== undefined);
  danglingEntry["params"] = { $ref: "#/$defs/NoSuchType" };
  assert.throws(() => generateRaw({
    "experimental.json": JSON.stringify(dangling),
    "msp.d.ts": MSP_TYPES_FIXTURE,
    "previous.json": JSON.stringify(PREVIOUS_STABLE_FIXTURE),
    "stable.json": JSON.stringify(STABLE_FIXTURE),
  }), /method "x\/beta" has a dangling params \$ref: #\/\$defs\/NoSuchType/);
});

/** The promotion window: previous lacks what stable just gained; demoted members are gone. */
const PROMOTION_PREVIOUS = {
  $defs: STABLE_FIXTURE.$defs,
  methods: {
    "s/old": STABLE_FIXTURE.methods["s/old"],
    "s/ping": STABLE_FIXTURE.methods["s/ping"],
  },
  notifications: {
    "s/changed": STABLE_FIXTURE.notifications["s/changed"],
  },
  requests: {
    "s/unasked": {
      params: { $ref: "#/$defs/SOldParams" },
      result: { $ref: "#/$defs/SOldResult" },
      "x-msp-descriptor": "s/unasked",
    },
  },
};

const PROMOTION_STABLE = {
  $defs: STABLE_FIXTURE.$defs,
  methods: {
    "s/ping": STABLE_FIXTURE.methods["s/ping"],
  },
  notifications: {
    "s/announced": {
      params: { $ref: "#/$defs/SChangedParams" },
      "x-msp-descriptor": "s/announced",
    },
    "s/changed": STABLE_FIXTURE.notifications["s/changed"],
  },
  requests: {
    "s/asked": {
      params: { $ref: "#/$defs/SNewParams" },
      result: { $ref: "#/$defs/SNewResult" },
      "x-msp-descriptor": "s/asked",
    },
  },
};

const PROMOTION_EXPERIMENTAL = {
  $defs: {
    ...STABLE_FIXTURE.$defs,
    ItemKind: {
      oneOf: [
        { enum: ["stableA", "stableB"], type: "string" },
        { const: "xKind", type: "string", "x-msp-stability": "experimental" },
      ],
    },
    XZapParams: { properties: { sessionId: { type: "string" } }, type: "object" },
    XZedResult: { properties: { zed: { type: "string" } }, type: "object" },
  },
  methods: {
    ...PROMOTION_STABLE.methods,
    "x/zed": {
      result: { $ref: "#/$defs/XZedResult" },
      "x-msp-descriptor": "x/zed",
      "x-msp-stability": "experimental",
    },
  },
  notifications: {
    ...PROMOTION_STABLE.notifications,
    "x/zap": {
      params: { $ref: "#/$defs/XZapParams" },
      "x-msp-descriptor": "x/zap",
      "x-msp-stability": "experimental",
    },
  },
  requests: {
    ...PROMOTION_STABLE.requests,
  },
};

test("just-promoted notifications and requests ship deprecated shims for one release", () => {
  const root = generateRaw({
    "experimental.json": JSON.stringify(PROMOTION_EXPERIMENTAL),
    "msp.d.ts": MSP_TYPES_FIXTURE,
    "previous.json": JSON.stringify(PROMOTION_PREVIOUS),
    "stable.json": JSON.stringify(PROMOTION_STABLE),
  });
  try {
    const extensions = readFileSync(join(root, "out", "src", "extensions.ts"), "utf8");
    const client = readFileSync(join(root, "out", "src", "client.ts"), "utf8");
    const index = readFileSync(join(root, "out", "src", "index.ts"), "utf8");
    // The promoted notification ships a deprecated class, exported by name.
    assert.ok(extensions.includes("class SAnnouncedExtension"), "promoted notification class");
    assert.ok(index.includes("SAnnouncedExtension"), "promoted class re-exported");
    const deprecatedAt = extensions.indexOf("@deprecated");
    assert.ok(deprecatedAt !== -1, "the promoted class is marked deprecated");
    assert.equal(
      extensions.indexOf("@deprecated", deprecatedAt + 1),
      -1,
      "exactly one deprecation: the experimental class has none",
    );
    assert.ok(deprecatedAt < extensions.indexOf("class SAnnouncedExtension"), "the tag sits above the promoted class");
    // The promoted class is a named re-export, not part of the factory:
    // allExperimentalExtensions answers experimental members only.
    assert.ok(!extensions.includes("new SAnnouncedExtension"), "factory stays experimental-only");
    assert.ok(extensions.includes("new XZapExtension(onError)"), "experimental member still listed");
    // The promoted request's types ride the re-export.
    assert.ok(index.includes("SNewParams"), "promoted request params re-exported");
    assert.ok(index.includes("SNewResult"), "promoted request result re-exported");
    // Demoted members (gone from current stable) emit nothing.
    assert.ok(!client.includes("sOld("), "demoted method gone");
    assert.ok(!index.includes("SOldParams"), "demoted method/request types gone");
    assert.ok(!index.includes("SOldResult"), "demoted method/request types gone");
  } finally {
    cleanup(root);
  }
});

test("the stamped fingerprint matches the port's independent recomputation", async () => {
  const { out, root } = generate([]);
  try {
    const addon = await buildGenerated(out);
    const stamped = addon["EXPECTED_EXPERIMENTAL_FINGERPRINT"] as string;
    const bytes = readFileSync(join(root, "in", "experimental.json"), "utf8");
    const oracle = mkdtempSync(join(tmpdir(), "sdk-experimental-oracle-"));
    try {
      const schema = join(oracle, "schema.json");
      writeFileSync(schema, bytes);
      const recomputed = execFileSync(process.execPath, [fingerprintPort, "experimental", schema], {
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
      assert.equal(stamped, recomputed, "stamp equals the port's recomputation over the same bytes");
    } finally {
      rmSync(oracle, { force: true, recursive: true });
    }
  } finally {
    cleanup(root);
  }
});

test("an extension class collision fails naming the notifications", () => {
  const colliding = JSON.parse(JSON.stringify(EXPERIMENTAL_FIXTURE)) as MutableTestBundle;
  colliding.notifications["xEvent"] = {
    params: { $ref: "#/$defs/XEventParams" },
    "x-msp-descriptor": "xEvent",
    "x-msp-stability": "experimental",
  };
  assert.throws(() => generateRaw({
    "experimental.json": JSON.stringify(colliding),
    "msp.d.ts": MSP_TYPES_FIXTURE,
    "previous.json": JSON.stringify(PREVIOUS_STABLE_FIXTURE),
    "stable.json": JSON.stringify(STABLE_FIXTURE),
  }), /extension class collision: "xEvent" and "x\/event" both map to "XEventExtension"/);
});

test("a dangling notification params $ref fails naming the notification", () => {
  const dangling = JSON.parse(JSON.stringify(EXPERIMENTAL_FIXTURE)) as MutableTestBundle;
  const danglingEntry = dangling.notifications["x/event"];
  assert.ok(danglingEntry !== undefined);
  danglingEntry["params"] = { $ref: "#/$defs/NoSuchType" };
  assert.throws(() => generateRaw({
    "experimental.json": JSON.stringify(dangling),
    "msp.d.ts": MSP_TYPES_FIXTURE,
    "previous.json": JSON.stringify(PREVIOUS_STABLE_FIXTURE),
    "stable.json": JSON.stringify(STABLE_FIXTURE),
  }), /notification "x\/event" has a dangling params \$ref: #\/\$defs\/NoSuchType/);
});

test("a dangling request $ref fails naming the request", () => {
  const dangling = JSON.parse(JSON.stringify(EXPERIMENTAL_FIXTURE)) as MutableTestBundle;
  const danglingEntry = dangling.requests["x/ask"];
  assert.ok(danglingEntry !== undefined);
  danglingEntry["result"] = { $ref: "#/$defs/NoSuchType" };
  assert.throws(() => generateRaw({
    "experimental.json": JSON.stringify(dangling),
    "msp.d.ts": MSP_TYPES_FIXTURE,
    "previous.json": JSON.stringify(PREVIOUS_STABLE_FIXTURE),
    "stable.json": JSON.stringify(STABLE_FIXTURE),
  }), /request "x\/ask" has a dangling result \$ref: #\/\$defs\/NoSuchType/);
});

test("an unmarked ItemKind variant fails naming the kind", () => {
  const tampered = JSON.parse(JSON.stringify(EXPERIMENTAL_FIXTURE)) as MutableTestBundle;
  const variants = tampered.$defs.ItemKind.oneOf;
  assert.ok(variants !== undefined);
  const xKind = variants.find((variant) => variant["const"] === "xKind");
  assert.ok(xKind !== undefined);
  delete xKind["x-msp-stability"];
  assert.throws(() => generateRaw({
    "experimental.json": JSON.stringify(tampered),
    "msp.d.ts": MSP_TYPES_FIXTURE,
    "previous.json": JSON.stringify(PREVIOUS_STABLE_FIXTURE),
    "stable.json": JSON.stringify(STABLE_FIXTURE),
  }), /marker\/diff disagreement in ItemKind: in diff only \[xKind\], marked only \[\]/);
});
