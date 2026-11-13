#!/usr/bin/env node
/**
 * The public-package leak gate (FR-97527-5): the built `@muse-code/sdk`
 * carries no experimental-only name.
 *
 * The set is computed at check time from the two schema bundles, never from
 * a committed list: methods, notifications and requests as exact strings,
 * item kinds as quoted literals, experimental-only `$defs` as identifiers,
 * and experimental-only fields as members declared inside their owning
 * interface. Code files (`.js`, `.ts`) are comment-stripped before matching
 * — a doc comment may cite a method in prose (the `permissionProfile/list`
 * precedent in the shipped stable declarations) — while the README and the
 * manifest are scanned raw, because the front page advertising an
 * experimental feature is the leak.
 *
 * Three venues run this: the `sdk-ts` pull-request job over the built
 * `dist/` tree; `packaging-contract` (and its early-gates stand-in), where
 * that job is planned, over the sources, `src` plus README and manifest (#99863: the Buildkite job container
 * has no npm registry, and `dist/src` is the compilation of `src` and nothing
 * else); and Gate 7 of `scripts/publish-sdk-npm.sh` over the packed tarball.
 * Both bundles travel in the public mirror's closure, so the publish gate
 * enforces there too.
 *
 * Exit 0 when clean, 1 on findings (each names the entry, its class and the
 * file), 2 on usage failures. An unscannable member fails closed.
 *
 * Usage:
 *   check-sdk-experimental-leak.mjs --stable <bundle> --experimental <bundle>
 *     (--tarball <file.tgz> | (--dir <dir> | --file <file>)...)
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CHECK = "check-sdk-experimental-leak";

/** Identifier characters for the def-name boundary (JS identifier set). */
const IDENT = "[A-Za-z0-9_$]";

/** Keywords after which a `/` opens a regex, not a division. */
const REGEX_KEYWORDS = new Set([
  "case",
  "delete",
  "do",
  "else",
  "in",
  "instanceof",
  "new",
  "of",
  "return",
  "throw",
  "typeof",
  "void",
]);

function fail(message) {
  console.error(`${CHECK}: ${message}`);
  process.exit(2);
}

function usage() {
  console.error(
    `usage: ${CHECK}.mjs --stable <bundle> --experimental <bundle> ` +
      `(--tarball <tgz> | (--dir <dir> | --file <file>)...)`,
  );
  process.exit(2);
}

function parseArgs(argv) {
  const args = { dirs: [], files: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--help" || flag === "-h") usage();
    const key = {
      "--dir": "dir",
      "--experimental": "experimental",
      "--file": "file",
      "--stable": "stable",
      "--tarball": "tarball",
    }[flag];
    if (key === undefined || i + 1 >= argv.length) usage();
    i += 1;
    if (key === "dir") args.dirs.push(argv[i]);
    else if (key === "file") args.files.push(argv[i]);
    else args[key] = argv[i];
  }
  if (args.stable === undefined || args.experimental === undefined) usage();
  const listed = args.dirs.length + args.files.length > 0;
  if (listed === (args.tarball !== undefined)) usage();
  return args;
}

function readBundle(label, path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    fail(`cannot read ${label} bundle at ${path}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} bundle at ${path} is not valid JSON`);
  }
  throw new Error("unreachable");
}

function sectionNames(document, section) {
  const entries = document[section] ?? {};
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    fail(`bundle section "${section}" is not an object`);
  }
  return new Set(Object.keys(entries));
}

function itemKinds(document) {
  const def = document.$defs?.ItemKind;
  if (def === undefined) fail("bundle has no $defs.ItemKind");
  const kinds = new Set(def.enum ?? []);
  for (const variant of def.oneOf ?? []) {
    if (typeof variant?.const === "string") kinds.add(variant.const);
  }
  return kinds;
}

/**
 * The experimental-only set, derived at check time: methods (requests and
 * notifications included), item kinds, `$defs` names, and (def, prop) fields
 * present in experimental but absent from the same-named stable def.
 */
export function experimentalOnlySets(experimental, stable) {
  const methods = new Set();
  for (const section of ["methods", "notifications", "requests"]) {
    const stableNames = sectionNames(stable, section);
    for (const name of sectionNames(experimental, section)) {
      if (!stableNames.has(name)) methods.add(name);
    }
  }
  const stableKinds = itemKinds(stable);
  const kinds = new Set([...itemKinds(experimental)].filter((kind) => !stableKinds.has(kind)));
  const experimentalDefs = experimental.$defs ?? {};
  const stableDefs = stable.$defs ?? {};
  const defs = new Set(
    Object.keys(experimentalDefs).filter((name) => stableDefs[name] === undefined),
  );
  const fields = [];
  for (const name of Object.keys(experimentalDefs)) {
    const experimentalProps = experimentalDefs[name]?.properties;
    const stableProps = stableDefs[name]?.properties;
    if (typeof experimentalProps !== "object" || experimentalProps === null) continue;
    if (typeof stableProps !== "object" || stableProps === null) {
      // A def with no stable properties object is either experimental-only
      // (already covered as a def) or shapeless on both sides (nothing to
      // compare); neither yields a field finding.
      continue;
    }
    for (const prop of Object.keys(experimentalProps)) {
      if (!(prop in stableProps)) fields.push({ name, prop });
    }
  }
  fields.sort((a, b) => a.name.localeCompare(b.name) || a.prop.localeCompare(b.prop));
  return { defs, fields, kinds, methods };
}

/**
 * Strip line and block comments, keeping strings, template literals (with
 * nested `${}`) and regex literals verbatim. A `/` opens a regex when the
 * previous significant token cannot end an expression: anything but an
 * identifier or number (keywords excepted), a string, or `)`, `]`, `}`.
 */
export function stripComments(source) {
  const out = [];
  const stack = [{ template: false }];
  let i = 0;
  const frame = () => stack[stack.length - 1];
  const push = (text) => {
    out.push(text);
  };
  // The last significant code character, plus the identifier before it when
  // the slash test needs the keyword check.
  let previous = "";
  let previousWord = "";
  const noteCode = (text) => {
    for (const char of text) {
      if (/\s/.test(char)) continue;
      if (new RegExp(`^${IDENT}$`).test(char)) {
        previousWord += char;
      } else {
        previousWord = "";
      }
      previous = char;
    }
  };
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1] ?? "";
    const mode = frame();
    if (mode.string !== undefined) {
      // Inside '...' or "...": escapes preserved, no comment starts.
      push(char);
      if (char === "\\" && i + 1 < source.length) {
        push(source[i + 1]);
        i += 2;
        continue;
      }
      if (char === mode.string) stack.pop();
      i += 1;
      continue;
    }
    if (mode.regex) {
      // Inside /.../flags: the content is code, kept verbatim.
      push(char);
      if (char === "\\" && i + 1 < source.length) {
        push(source[i + 1]);
        i += 2;
        continue;
      }
      if (char === "[") {
        mode.classDepth = (mode.classDepth ?? 0) + 1;
      } else if (char === "]") {
        mode.classDepth = Math.max(0, (mode.classDepth ?? 0) - 1);
      } else if (char === "/" && (mode.classDepth ?? 0) === 0) {
        stack.pop();
        noteCode("/");
      }
      i += 1;
      continue;
    }
    if (mode.template && !mode.expr) {
      // Template literal text: escapes and `//` kept; `${` opens code.
      push(char);
      if (char === "\\" && i + 1 < source.length) {
        push(source[i + 1]);
        i += 2;
        continue;
      }
      if (char === "`") {
        stack.pop();
        noteCode("`");
      } else if (char === "$" && next === "{") {
        push(next);
        stack.push({ template: false });
        noteCode("${");
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      stack.push({ string: char, template: false });
      push(char);
      i += 1;
      continue;
    }
    if (char === "`") {
      stack.push({ expr: false, template: true });
      push(char);
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i + 1 < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (char === "/") {
      const opensRegex =
        previous === "" ||
        previous === "(" ||
        previous === "," ||
        previous === "=" ||
        previous === ":" ||
        previous === "[" ||
        previous === "!" ||
        previous === "&" ||
        previous === "|" ||
        previous === "?" ||
        previous === "{" ||
        previous === "}" ||
        previous === ";" ||
        previous === "+" ||
        previous === "-" ||
        previous === "*" ||
        previous === "%" ||
        previous === "<" ||
        previous === ">" ||
        previous === "^" ||
        previous === "~" ||
        REGEX_KEYWORDS.has(previousWord);
      if (opensRegex) {
        stack.push({ classDepth: 0, regex: true, template: false });
        push(char);
        i += 1;
        continue;
      }
      push(char);
      noteCode(char);
      i += 1;
      continue;
    }
    if (char === "}" && stack.length > 1 && !frame().template) {
      // A `}` closes a `${}` substitution only when the template frame is
      // directly below; otherwise it is ordinary code.
      const below = stack[stack.length - 2];
      if (below?.template === true && below.expr === false) {
        stack.pop();
        push(char);
        noteCode(char);
        i += 1;
        continue;
      }
    }
    push(char);
    noteCode(char);
    i += 1;
  }
  return out.join("");
}

function identifierRegex(name) {
  return new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[$]/g, "\\$")}(?![A-Za-z0-9_$])`);
}

/** The declared body of `interface NAME` or `type NAME = {...}`, if any. */
function declarationSpan(code, name) {
  const escaped = name.replace(/[$]/g, "\\$");
  const match = new RegExp(
    `(?:interface\\s+${escaped}\\b[^{]*\\{|type\\s+${escaped}\\b[^=]*=\\s*\\{)`,
  ).exec(code);
  if (match === null || match.index === undefined) return null;
  let depth = 0;
  for (let i = match.index + match[0].length - 1; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(match.index + match[0].length, i);
    }
  }
  return null;
}

const CODE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts"]);
const DECLARATION_EXTENSIONS = new Set([".cts", ".d.ts", ".mts", ".ts"]);

function isDeclarationFile(name) {
  return name.endsWith(".d.ts") || DECLARATION_EXTENSIONS.has(name.slice(name.lastIndexOf(".")));
}

/**
 * Scan file texts against the experimental-only sets. Each finding names the
 * offending entry, its class and the file. Findings sort by file, then by
 * the entry's first offset, so output is stable.
 */
export function scanFiles(files, sets) {
  const findings = [];
  const defPatterns = [...sets.defs].sort().map((name) => ({ name, pattern: identifierRegex(name) }));
  for (const { name, text } of files) {
    const code = CODE_EXTENSIONS.has(name.slice(name.lastIndexOf("."))) ? stripComments(text) : text;
    const at = (entry) => code.indexOf(entry);
    for (const method of [...sets.methods].sort()) {
      const offset = at(method);
      if (offset !== -1) findings.push({ entry: method, file: name, kind: "method", offset });
    }
    for (const kind of [...sets.kinds].sort()) {
      const quoted = [`"${kind}"`, `'${kind}'`, `\`${kind}\``];
      const offsets = quoted.map((literal) => at(literal)).filter((offset) => offset !== -1);
      if (offsets.length > 0) {
        findings.push({ entry: kind, file: name, kind: "item kind", offset: Math.min(...offsets) });
      }
    }
    for (const { name: def, pattern } of defPatterns) {
      const match = pattern.exec(code);
      if (match?.index !== undefined) {
        findings.push({ entry: def, file: name, kind: "definition", offset: match.index });
      }
    }
    if (isDeclarationFile(name)) {
      for (const { name: def, prop } of sets.fields) {
        const span = declarationSpan(code, def);
        if (span === null) continue;
        const match = new RegExp(
          `(?<!${IDENT})${prop.replace(/[$]/g, "\\$")}\\??:(?!${IDENT})`,
        ).exec(span);
        if (match?.index !== undefined) {
          findings.push({
            entry: `${def}.${prop}`,
            file: name,
            kind: "field",
            offset: code.indexOf(span) + match.index,
          });
        }
      }
    }
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset);
  return findings.map(({ entry, file, kind }) => ({ entry, file, kind }));
}

function collectFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        const nested = walk(path);
        if (nested !== null) return nested;
        continue;
      }
      if (!entry.isFile()) continue;
      const text = readTextFile(path);
      if (text === null) return { name: relative(dir, path), text: null };
      files.push({ name: relative(dir, path), text });
    }
    return null;
  };
  const unreadable = walk(dir);
  return { files, unreadable };
}

function readTextFile(path) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    return null;
  }
}

function main(argv) {
  const args = parseArgs(argv);
  const stable = readBundle("stable", args.stable);
  const experimental = readBundle("experimental", args.experimental);
  const sets = experimentalOnlySets(experimental, stable);
  const files = [];
  const unreadable = [];
  if (args.tarball !== undefined) {
    try {
      statSync(args.tarball).isFile();
    } catch {
      fail(`cannot read tarball at ${args.tarball}`);
    }
    const scratch = mkdtempSync(join(tmpdir(), "sdk-leak-"));
    try {
      execFileSync("tar", ["-xzf", args.tarball, "-C", scratch], { stdio: "pipe" });
    } catch {
      rmSync(scratch, { force: true, recursive: true });
      fail(`cannot extract tarball at ${args.tarball}`);
    }
    const collected = collectFiles(scratch);
    rmSync(scratch, { force: true, recursive: true });
    files.push(...collected.files);
    if (collected.unreadable !== null) unreadable.push(collected.unreadable);
  }
  for (const dir of args.dirs) {
    try {
      statSync(dir).isDirectory();
    } catch {
      fail(`cannot read directory at ${dir}`);
    }
    const collected = collectFiles(dir);
    files.push(
      ...collected.files.map((file) => ({ ...file, name: join(dir, file.name) })),
    );
    if (collected.unreadable !== null) {
      unreadable.push({ ...collected.unreadable, name: join(dir, collected.unreadable.name) });
    }
  }
  for (const path of args.files) {
    const text = readTextFile(path);
    if (text === null) {
      try {
        statSync(path).isFile();
      } catch {
        fail(`cannot read file at ${path}`);
      }
      unreadable.push({ name: path });
      continue;
    }
    files.push({ name: path, text });
  }
  if (unreadable.length > 0) {
    for (const entry of unreadable) {
      console.error(
        `${CHECK}: experimental-only names cannot be ruled out in ${entry.name}: ` +
          `the member is not UTF-8 text and fails closed`,
      );
    }
    process.exit(1);
  }
  const findings = scanFiles(files, sets);
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `${CHECK}: experimental-only ${finding.kind} "${finding.entry}" in ${finding.file}`,
      );
    }
    console.error(
      `${CHECK}: ${findings.length} finding(s); the public package must not name experimental-only surface`,
    );
    process.exit(1);
  }
}

const invokedAsScript =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedAsScript) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
