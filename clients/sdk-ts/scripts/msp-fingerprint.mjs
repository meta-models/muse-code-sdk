#!/usr/bin/env node
/**
 * The MSP schema fingerprint, in dependency-free Node (ADR 77546 D4).
 *
 * This module is the JavaScript implementation of the fingerprint
 * normalization, for the TypeScript SDK build: the `prebuild`/`precheck`
 * step stamps the derived stable value into the compiled output, so the
 * committed source carries the derivation hook and no literal. The same CLI
 * serves the Rust real-bundle proof, which invokes it as
 * `msp-fingerprint.mjs <stable|experimental> <schema.json|->` (the
 * receipt-pins gate checks the hook shape only and never spawns Node).
 *
 * Plain JavaScript, Node builtins only (`node:crypto`, `node:fs`,
 * `node:path`, `node:url`): it runs on the mirror's Node without a
 * toolchain, so no TypeScript syntax may appear here.
 *
 * The normalization mirrors `scripts/msp_fingerprint.py` (and, through it,
 * the canonical Rust implementation): strip the
 * experimental surface for the stable variant, collapse single-branch
 * string enums, sort keys, hash the preimage under a domain tag.
 *
 * Conformance is proven, not eyeballed: the sdk-ts vector suite runs this
 * module against the shared fixture the compiled implementation proves as
 * well (`schema/msp/fingerprint-vectors.json`). A port that cannot
 * reproduce a vector fails its suite.
 *
 * Parser-parity notes (places where V8 differs from serde_json/Python and
 * this port compensates, so all three refuse-or-hash identically):
 * - Invalid UTF-8 bytes: `TextDecoder` with `fatal: true` refuses where
 *   `Buffer.toString` would silently substitute U+FFFD.
 * - Unpaired surrogates: `JSON.parse` accepts `\ud800` escapes and would
 *   hash them, where the canonical parser refuses — so parsed strings are
 *   scanned and refused as `unparseable-document`, the canonical kind.
 * - Key order: `Array.sort` compares UTF-16 code units, which misorders
 *   non-BMP keys against U+E000-U+FFFF; the sort compares code points.
 *   Emission is explicit for the same reason: a plain object iterates
 *   integer-like keys numerically (2 before 10), so the canonical
 *   serializer emits the sorted order instead of `JSON.stringify`.
 * - `NaN`/`Infinity` literals: `JSON.parse` already refuses them, matching
 *   the canonical refusal with no extra work.
 *
 * Known limitation (JS-only — the Python port keeps `2.0`, like the
 * canonical form): an integral float literal (`2.0`, `1e3`) parses to a JS
 * number that serializes without the fraction, where the canonical form
 * keeps it (`2.0`). No schema carries one (floats appear only inside
 * strings), and the real-bundle proof fails closed if one appears.
 * Known limitation (JS-only too — the Python port keeps the literal): an
 * integer above 2^53-1 parses to the nearest double
 * (`9007199254740993` becomes `...992`), where the canonical form keeps
 * the literal. Latent: the largest integer any committed schema carries is
 * 2^53-1 itself (a `maximum`), and the real-bundle proof fails closed if a
 * larger one appears.
 *
 * Error vocabulary (matches the fixture's `error` member):
 *   unparseable-document, dangling-reference, emptied-enum,
 *   unencodable-preimage.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NORMALIZATION_VERSION = 1;
const DOMAIN = "muse.msp.schema-bundle";
const STABILITY_KEY = "x-msp-stability";
const EXPERIMENTAL_WORD = "experimental";
const OPENNESS_KEY = "x-msp-openness";

/** A fingerprint refusal, carrying the fixture's error vocabulary word. */
export class FingerprintError extends Error {
  constructor(kind, detail) {
    super(detail);
    this.name = "FingerprintError";
    this.kind = kind;
  }
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExperimental(node) {
  return isObject(node) && node[STABILITY_KEY] === EXPERIMENTAL_WORD;
}

/**
 * Drop experimental-marked elements, mirroring canonical order exactly.
 * In place, like the canonical pass. Members of the root object itself
 * are kept, never removed.
 */
function removeExperimentalElements(value) {
  if (isObject(value)) {
    const removedProperties = [];
    for (const [key, member] of Object.entries(value)) {
      if (isObject(member)) {
        if (key === "properties") {
          for (const [name, child] of Object.entries(member)) {
            if (isExperimental(child)) removedProperties.push(name);
          }
        }
        for (const name of Object.keys(member)) {
          if (isExperimental(member[name])) delete member[name];
        }
      } else if (Array.isArray(member)) {
        value[key] = member.filter((item) => !isExperimental(item));
      }
    }
    const required = value["required"];
    if (removedProperties.length > 0 && Array.isArray(required)) {
      const kept = required.filter((entry) => !removedProperties.includes(entry));
      if (kept.length === 0) {
        delete value["required"];
      } else {
        value["required"] = kept;
      }
    }
    for (const member of Object.values(value)) {
      removeExperimentalElements(member);
    }
  } else if (Array.isArray(value)) {
    const kept = value.filter((item) => !isExperimental(item));
    value.length = 0;
    value.push(...kept);
    for (const item of value) {
      removeExperimentalElements(item);
    }
  }
}

/**
 * Strip experimental surface, returning the removed `$defs` names. The
 * names travel as a set — never smuggled through a live document key —
 * so a top-level `__removed__` member stays input bytes.
 */
function stripDefinitions(document) {
  const defs = document["$defs"];
  const removed = new Set();
  if (isObject(defs)) {
    for (const [name, member] of Object.entries(defs)) {
      if (isExperimental(member)) removed.add(name);
    }
  }
  removeExperimentalElements(document);
  return removed;
}

function findDangling(document, removed) {
  if (removed.size === 0) return undefined;
  if (isObject(document)) {
    const target = document["$ref"];
    if (typeof target === "string" && target.startsWith("#/$defs/")) {
      const name = target.slice("#/$defs/".length);
      if (removed.has(name)) return name;
    }
    for (const member of Object.values(document)) {
      const found = findDangling(member, removed);
      if (found !== undefined) return found;
    }
  } else if (Array.isArray(document)) {
    for (const item of document) {
      const found = findDangling(item, removed);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function firstEmptiedEnum(document) {
  if (!isObject(document)) return undefined;
  const defs = document["$defs"];
  if (!isObject(defs)) return undefined;
  for (const name of Object.keys(defs).sort(compareCodePoints)) {
    const member = defs[name];
    if (isObject(member) && Array.isArray(member["oneOf"]) && member["oneOf"].length === 0) {
      return name;
    }
  }
  return undefined;
}

function collapseSingleBranchEnums(value) {
  if (isObject(value)) {
    const branches = value["oneOf"];
    if (Array.isArray(branches) && branches.length === 1) {
      const branch = branches[0];
      if (
        isObject(branch) &&
        Object.keys(branch).every(
          (key) => key === "type" || key === "enum" || key === OPENNESS_KEY,
        ) &&
        branch["type"] === "string" &&
        Array.isArray(branch["enum"])
      ) {
        delete value["oneOf"];
        value["type"] = "string";
        value["enum"] = branch["enum"];
      }
    }
    for (const member of Object.values(value)) {
      collapseSingleBranchEnums(member);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collapseSingleBranchEnums(item);
    }
  }
}

/**
 * Code-point order, matching Python's `sorted` on strings and Rust's byte
 * order over valid UTF-8. `Array.sort`'s default UTF-16 code-unit order
 * misorders non-BMP keys against U+E000-U+FFFF.
 */
function compareCodePoints(a, b) {
  const as = Array.from(a);
  const bs = Array.from(b);
  const shared = Math.min(as.length, bs.length);
  for (let i = 0; i < shared; i++) {
    const ac = as[i].codePointAt(0) ?? 0;
    const bc = bs[i].codePointAt(0) ?? 0;
    if (ac !== bc) return ac - bc;
  }
  return as.length - bs.length;
}

/**
 * Canonical JSON encoding: object keys emit in code-point order at every
 * level. `JSON.stringify` on a plain object cannot do this — integer-like
 * keys (`"2"`, `"10"`) iterate in ascending numeric order regardless of
 * insertion, so a rebuild-then-stringify emits 2 before 10 where the
 * canonical byte order puts 10 first. Primitives encode through the
 * builtin, so strings, numbers, and escapes stay byte-identical to
 * `JSON.stringify`; only key emission order is custom. Assumes JSON values
 * (the preimage is built from parsed JSON): `undefined`/functions/symbols
 * follow the builtin's rules (skipped in objects, null in arrays).
 */
function serializeCanonical(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      const encoded = serializeCanonical(item);
      items.push(encoded === undefined ? "null" : encoded);
    }
    return `[${items.join(",")}]`;
  }
  const members = [];
  for (const key of Object.keys(value).sort(compareCodePoints)) {
    const encoded = serializeCanonical(value[key]);
    if (encoded !== undefined) {
      members.push(`${JSON.stringify(key)}:${encoded}`);
    }
  }
  return `{${members.join(",")}}`;
}

/** True when the string carries an unpaired surrogate (no UTF-8 form). */
function hasUnpairedSurrogate(text) {
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function refuseUnpairedSurrogates(value) {
  if (typeof value === "string") {
    if (hasUnpairedSurrogate(value)) {
      throw new FingerprintError(
        "unparseable-document",
        "bundle document contains an unpaired surrogate, which has no UTF-8 form",
      );
    }
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) {
      refuseUnpairedSurrogates(key);
      refuseUnpairedSurrogates(value[key]);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      refuseUnpairedSurrogates(item);
    }
  }
}

/**
 * Fingerprint schema bytes for `variant` ("stable" or "experimental").
 *
 * Throws FingerprintError (with `kind` in the fixture vocabulary) for
 * unparseable, dangling, emptied, or unencodable inputs, and Error for an
 * unknown variant.
 */
export function bundleFingerprint(variant, schemaJson) {
  if (variant !== "stable" && variant !== "experimental") {
    throw new Error(`unknown bundle variant ${JSON.stringify(variant)}`);
  }
  let text;
  if (typeof schemaJson === "string") {
    text = schemaJson;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(schemaJson);
    } catch (error) {
      throw new FingerprintError(
        "unparseable-document",
        `bundle bytes are not valid UTF-8: ${error.message}`,
      );
    }
  }
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new FingerprintError(
      "unparseable-document",
      `bundle document is not valid JSON: ${error.message}`,
    );
  }
  refuseUnpairedSurrogates(document);
  if (variant === "stable" && isObject(document)) {
    const removed = stripDefinitions(document);
    const dangling = findDangling(document, removed);
    if (dangling !== undefined) {
      throw new FingerprintError(
        "dangling-reference",
        `stripping left a reference to \`${dangling}\`, which the stable document no longer defines`,
      );
    }
    const emptied = firstEmptiedEnum(document);
    if (emptied !== undefined) {
      throw new FingerprintError(
        "emptied-enum",
        `stripping left \`${emptied}\` with an empty \`oneOf\``,
      );
    }
  }
  // Collapse is stable-only, like the canonical strip it rides
  // inside: experimental bundles keep their oneOf branches verbatim.
  if (variant === "stable") {
    collapseSingleBranchEnums(document);
  }
  // Field order is part of the digest contract (the typed preimage
  // shape): normalization_version, domain, experimental, document. The
  // envelope keeps its declared order spelled out — only the document's
  // keys sort, via the canonical serializer (a plain-object preimage
  // would also mis-emit integer-like keys, see `serializeCanonical`).
  let encoded;
  try {
    encoded =
      `{"normalization_version":${serializeCanonical(NORMALIZATION_VERSION)}` +
      `,"domain":${serializeCanonical(DOMAIN)}` +
      `,"experimental":${serializeCanonical(variant === "experimental")}` +
      `,"document":${serializeCanonical(document)}}`;
  } catch (error) {
    throw new FingerprintError(
      "unencodable-preimage",
      `preimage does not serialize: ${error.message}`,
    );
  }
  if (typeof encoded !== "string") {
    throw new FingerprintError("unencodable-preimage", "preimage does not serialize");
  }
  return "sha256:" + createHash("sha256").update(encoded, "utf8").digest("hex");
}

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAMPED_FILE = join(packageDir, "src", "fingerprint.stamped.ts");
const STAMPED_SYMBOL = "STAMPED_SCHEMA_FINGERPRINT";
/** Same layout convention as `bundle-msp-types.mjs`: the schema sits two levels above the package. */
const STABLE_SCHEMA = join(packageDir, "..", "..", "schema", "msp", "stable", "msp.schema.json");

function fail(message) {
  console.error(`msp-fingerprint: ${message}`);
  process.exit(1);
}

/**
 * The build step: derive the stable fingerprint from the committed schema
 * bytes and stamp it into the generated module the SDK imports. Skips the
 * write when the value is unchanged, so an unrelated build does not churn
 * `tsc --build` inputs.
 */
export function stamp() {
  let schemaBytes;
  try {
    schemaBytes = readFileSync(STABLE_SCHEMA);
  } catch (error) {
    fail(`cannot read ${STABLE_SCHEMA}: ${error.message}`);
  }
  let fingerprint;
  try {
    fingerprint = bundleFingerprint("stable", schemaBytes);
  } catch (error) {
    if (error instanceof FingerprintError) {
      fail(`${STABLE_SCHEMA} refuses fingerprinting (${error.kind}): ${error.message}`);
    }
    throw error;
  }
  const body = [
    "// GENERATED by `node scripts/msp-fingerprint.mjs --stamp` (runs on every",
    "// `npm run build` / `npm run check`). Do not edit: the value derives from",
    "// schema/msp/stable/msp.schema.json through the port in",
    "// scripts/msp-fingerprint.mjs. A schema advance moves this value at the",
    "// next build; the file itself is gitignored and never committed.",
    `export const ${STAMPED_SYMBOL} = ${JSON.stringify(fingerprint)};`,
    "",
  ].join("\n");
  let current;
  try {
    current = readFileSync(STAMPED_FILE, "utf8");
  } catch {
    current = undefined;
  }
  if (current === body) return;
  try {
    writeFileSync(STAMPED_FILE, body);
  } catch (error) {
    fail(`cannot write ${STAMPED_FILE}: ${error.message}`);
  }
}

function main(argv) {
  if (argv.length === 3 && argv[2] === "--stamp") {
    stamp();
    return 0;
  }
  if (argv.length !== 4 || (argv[2] !== "stable" && argv[2] !== "experimental")) {
    console.error(`usage: ${argv[1]} <stable|experimental> <schema.json|->`);
    console.error(`   or: ${argv[1]} --stamp`);
    return 2;
  }
  const variant = argv[2];
  const source = argv[3];
  let schemaJson;
  let label;
  if (source === "-") {
    try {
      schemaJson = readFileSync(0);
    } catch (error) {
      console.error(`cannot read <stdin>: ${error.message}`);
      return 1;
    }
    label = "<stdin>";
  } else {
    try {
      schemaJson = readFileSync(source);
    } catch (error) {
      console.error(`cannot read ${source}: ${error.message}`);
      return 1;
    }
    label = source;
  }
  try {
    console.log(bundleFingerprint(variant, schemaJson));
  } catch (error) {
    if (error instanceof FingerprintError) {
      console.error(`${label} refuses fingerprinting (${error.kind}): ${error.message}`);
      return 1;
    }
    throw error;
  }
  return 0;
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  process.exitCode = main(process.argv);
}
