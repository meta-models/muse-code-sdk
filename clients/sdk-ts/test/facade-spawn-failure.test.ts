/**
 * TEST-49791-1 — `MuseClient.spawn` names the real cause when the host is
 * lost before the handshake completes (#49791; Scenario 4, INV-010/INV-011).
 *
 * Before the fix every arm below rejected with whatever the transport saw
 * first (`write EPIPE` on the first frame, or `connection reached EOF`) and
 * the spawn error, the exit row and the captured stderr tail never reached
 * the caller. The arms are the two radar reproductions (a binary that does
 * not exist; a host that writes to stderr and exits 3 before its first
 * frame) plus the signal row, the tail bound, the host that complains on
 * stderr and exits 0 without answering, and the two CONTROLS that must keep
 * their original error: a host that answers `initialize` with an MSP error
 * was not lost, it refused — whether it then exits 0 on our close or 1.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXPECTED_SCHEMA_FINGERPRINT,
  MspError,
  MuseClient,
  MuseHostStartError,
  ProtocolError,
} from "../src/index.js";
import type { MuseClientSpawnOptions } from "../src/index.js";

const CLIENT_INFO = { name: "sdk_test", version: "0.0.0" };
// Failure-only cap: each arm drives a real child, and a regression that
// hangs the close ladder must report, not pin the runner.
const ARM_TIMEOUT = 20_000;

/** A `node -e` host that runs `body` at birth and never reads stdin. */
function hostThat(body: string): Pick<MuseClientSpawnOptions, "museBin" | "args"> {
  return { museBin: process.execPath, args: ["-e", body] };
}

/** The rejection of a `spawn` that MUST fail; an unexpected success is closed and reported. */
async function spawnRejection(
  options: Omit<MuseClientSpawnOptions, "clientInfo">,
): Promise<unknown> {
  let client: MuseClient | undefined;
  try {
    client = await MuseClient.spawn({ clientInfo: CLIENT_INFO, ...options });
  } catch (error) {
    return error;
  }
  await client.close();
  assert.fail("spawn resolved; this arm needs a host that never completes the handshake");
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function asHostStartError(error: unknown): MuseHostStartError {
  assert.ok(
    error instanceof MuseHostStartError,
    `expected MuseHostStartError, got ${describe(error)}`,
  );
  return error;
}

test(
  "TEST-49791-1: a museBin that does not exist surfaces the spawn ENOENT, not an EPIPE",
  { timeout: ARM_TIMEOUT },
  async (t) => {
    // A per-test directory, so the missing path is provably ours and no
    // other arm or lane can create it underneath this one.
    const dir = mkdtempSync(join(tmpdir(), "sdk-spawn-failure-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const museBin = join(dir, "muse-that-does-not-exist");

    const error = asHostStartError(await spawnRejection({ museBin }));

    assert.equal(error.failure.kind, "spawnFailed");
    if (error.failure.kind !== "spawnFailed") return;
    assert.equal(error.failure.error.code, "ENOENT");
    assert.match(error.message, /ENOENT/, error.message);
    assert.ok(error.message.includes(museBin), `message names the path: ${error.message}`);
    assert.deepEqual(error.stderrTail, [], "no process ran, so there is no stderr");
    assert.ok(error.cause instanceof Error, "the transport error rides as cause");
  },
);

test(
  "TEST-49791-1: a host that exits 3 before its first frame surfaces configError, exit code 3 and the stderr tail",
  { timeout: ARM_TIMEOUT },
  async () => {
    const error = asHostStartError(
      await spawnRejection(
        hostThat('process.stderr.write("oops: config is bad\\n", () => process.exit(3))'),
      ),
    );

    assert.equal(error.failure.kind, "hostExited");
    if (error.failure.kind !== "hostExited") return;
    assert.equal(error.failure.exit.kind, "configError");
    assert.equal(error.failure.exit.exitCode, 3);
    assert.equal(error.failure.answeredInitialize, false, "it never answered initialize");
    assert.equal(error.failure.exit.kind === "configError" && error.failure.exit.retry, "fix-config");
    assert.deepEqual(error.failure.exit.kind === "configError" && error.failure.exit.stderrTail, [
      "oops: config is bad",
    ]);
    assert.deepEqual(error.stderrTail, ["oops: config is bad"]);
    assert.match(error.message, /configError/, error.message);
    assert.match(error.message, /exit code 3/, error.message);
    assert.ok(
      error.message.includes("oops: config is bad"),
      `message quotes the stderr tail: ${error.message}`,
    );
    assert.ok(error.cause instanceof Error, "the transport error rides as cause");
  },
);

test(
  "TEST-49791-1: a host killed by a signal before its first frame surfaces the crash row and the signal",
  { timeout: ARM_TIMEOUT },
  async () => {
    const error = asHostStartError(
      await spawnRejection(hostThat('process.kill(process.pid, "SIGKILL")')),
    );

    assert.equal(error.failure.kind, "hostExited");
    if (error.failure.kind !== "hostExited") return;
    assert.equal(error.failure.exit.kind, "crash");
    if (error.failure.exit.kind !== "crash") return;
    assert.equal(error.failure.exit.exitSignal, "SIGKILL");
    assert.equal(error.failure.exit.exitCode, null);
    assert.match(error.message, /crash/, error.message);
    assert.match(error.message, /SIGKILL/, error.message);
  },
);

test(
  "TEST-49791-1: the stderr tail on the error is the SDK's bounded tail, newest lines kept",
  { timeout: ARM_TIMEOUT },
  async () => {
    // Well past the 100-line budget (`MuseServeChild`'s client-local evidence
    // bound, spec 14990 Scenario 4): the error must carry the bound, never
    // the whole stream, and the message quotes only the newest lines.
    const lines = 300;
    const error = asHostStartError(
      await spawnRejection(
        hostThat(
          `process.stderr.write(Array.from({length: ${lines}}, (_, i) => "line-" + i).join("\\n") + "\\n", () => process.exit(1))`,
        ),
      ),
    );

    assert.equal(error.failure.kind, "hostExited");
    if (error.failure.kind !== "hostExited") return;
    assert.equal(error.failure.exit.kind, "unhandledError");
    assert.ok(error.stderrTail.length > 0, "the tail carries evidence");
    assert.ok(
      error.stderrTail.length <= 100,
      `the tail stays within the 100-line budget, got ${error.stderrTail.length}`,
    );
    assert.equal(error.stderrTail.at(-1), `line-${lines - 1}`, "the newest line survives");
    assert.ok(error.message.includes(`line-${lines - 1}`), `message quotes the newest line: ${error.message}`);
    // The message quotes only the newest five tail lines and says so; a line
    // that IS in the bounded tail but older than those five must not appear
    // (an assertion on a line the tail already dropped could never fail).
    assert.match(error.message, /stderr tail \(last 5 of \d+ lines\):/, error.message);
    assert.ok(
      error.stderrTail.includes(`line-${lines - 6}`),
      "precondition: the sixth-newest line is in the bounded tail",
    );
    assert.ok(
      !error.message.includes(`line-${lines - 6}\n`) && !error.message.endsWith(`line-${lines - 6}`),
      `the message quotes only the newest 5 lines: ${error.message}`,
    );
  },
);

test(
  "TEST-49791-1: a host that complains on stderr and exits 0 WITHOUT answering is still a lost host",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The mirror of the refusal controls below: the row is the clean one,
    // but nothing answered `initialize`, so the caller still gets the typed
    // error with the stderr evidence — never the bare `connection reached
    // EOF` (SS2.11 keeps no tail on the clean row; the error does).
    const error = asHostStartError(
      await spawnRejection(
        hostThat('process.stderr.write("nothing to serve here\\n", () => process.exit(0))'),
      ),
    );

    assert.equal(error.failure.kind, "hostExited");
    if (error.failure.kind !== "hostExited") return;
    assert.equal(error.failure.exit.kind, "cleanShutdown");
    assert.deepEqual(error.stderrTail, ["nothing to serve here"]);
    assert.match(error.message, /cleanShutdown/, error.message);
    assert.ok(error.message.includes("nothing to serve here"), error.message);
    assert.ok(error.cause instanceof Error, "the transport error rides as cause");
  },
);

/**
 * A host that ANSWERS `initialize` with an SS1.6 error, then ends the way
 * `ending` says once stdin closes. Its answer is the actionable error.
 */
function refusingHost(ending: "exit 0 on EOF" | "exit 1 on EOF"): string {
  return [
    'const {createInterface} = require("node:readline")',
    'const rl = createInterface({input: process.stdin})',
    'rl.on("line", (line) => {',
    "  const frame = JSON.parse(line)",
    "  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: frame.id, error: {code: -32000, message: 'initialize refused (test)', data: {kind: 'testRefusal'}}}) + '\\n')",
    "})",
    `rl.on("close", () => process.exit(${ending === "exit 0 on EOF" ? 0 : 1}))`,
  ].join("\n");
}

for (const ending of ["exit 0 on EOF", "exit 1 on EOF"] as const) {
  test(
    `TEST-49791-1 control: a host that REFUSES initialize and then ends with ${ending} keeps its typed MSP error`,
    { timeout: ARM_TIMEOUT },
    async () => {
      // The host was not lost: it answered. Neither the clean exit that
      // follows our close() nor a non-clean one may dress the refusal up as a
      // host death — "lost" is decided by the answer, not by the exit row.
      const error = await spawnRejection(hostThat(refusingHost(ending)));

      assert.ok(error instanceof MspError, `expected MspError, got ${describe(error)}`);
      assert.equal(error.kind, "testRefusal");
      assert.ok(!(error instanceof MuseHostStartError), "a refusal is not a lost host");
    },
  );
}

/** Marks the exact bytes the malformed-answer host put on stdout. */
const SENT_MARKER = "sent=";

/**
 * A host that ANSWERS `initialize` with a frame the SDK refuses (`frame` is
 * the JSON text of the response members besides `jsonrpc`/`id`), then ends
 * the way `ending` says once stdin closes.
 *
 * The frame goes out in a spelling no re-serialization produces (a space
 * after the opening brace), and the host echoes those exact bytes on stderr
 * after `SENT_MARKER`, so an arm can prove `ProtocolError.line` is the frame
 * AS RECEIVED, not one rebuilt from the parsed value (#50635).
 */
function malformedAnswerHost(frame: string, ending: "exit 0 on EOF" | "exit 1 on EOF"): string {
  return [
    'const {createInterface} = require("node:readline")',
    'const rl = createInterface({input: process.stdin})',
    'rl.on("line", (line) => {',
    "  const req = JSON.parse(line)",
    `  const out = JSON.stringify(Object.assign({jsonrpc: '2.0', id: req.id}, ${frame})).replace('{', '{ ')`,
    `  process.stderr.write("${SENT_MARKER}" + out + "\\n")`,
    "  process.stdout.write(out + '\\n')",
    "})",
    `rl.on("close", () => process.exit(${ending === "exit 0 on EOF" ? 0 : 1}))`,
  ].join("\n");
}

/** The frame bytes a malformed-answer host reported sending, from its stderr. */
function sentFrame(stderr: readonly string[]): string {
  const line = stderr
    .join("")
    .split("\n")
    .find((candidate) => candidate.startsWith(SENT_MARKER));
  assert.ok(line !== undefined, `the host reported what it sent: ${stderr.join("")}`);
  return line.slice(SENT_MARKER.length);
}

const MALFORMED_ANSWERS = [
  // The version-skew shape: a result with no schema fingerprint.
  { name: "a result with no schema fingerprint", frame: "{result: {}}", message: /no schema fingerprint/ },
  { name: "a non-object result", frame: '{result: "nope"}', message: /result must be an object/ },
  {
    name: "an error with no data.kind",
    frame: "{error: {code: -32000, message: 'refused without a kind'}}",
    message: /no data\.kind/,
  },
] as const;

for (const answer of MALFORMED_ANSWERS) {
  for (const ending of ["exit 0 on EOF", "exit 1 on EOF"] as const) {
    test(
      `TEST-49912-1 control: a host that ANSWERS initialize with ${answer.name} and then ends with ${ending} keeps its ProtocolError`,
      { timeout: ARM_TIMEOUT },
      async () => {
        // The host was not lost: a frame came back and the SDK refused it.
        // That refusal names the real problem (version skew, a broken
        // host), so it is what the caller gets — never a host death built
        // from the exit our own close() caused (#49912).
        const stderr: string[] = [];
        const error = await spawnRejection({
          ...hostThat(malformedAnswerHost(answer.frame, ending)),
          onStderr: (chunk) => stderr.push(chunk),
        });

        assert.ok(
          error instanceof ProtocolError,
          `expected ProtocolError, got ${describe(error)}`,
        );
        assert.ok(!(error instanceof MuseHostStartError), "an answered host is not a lost host");
        assert.match(error.message, answer.message, error.message);
        // `line` is the WHOLE refused frame as received — the JSON-RPC
        // envelope, not just the member the SDK refused — on every arm, so a
        // caller that logs or parses it gets one kind of value whichever
        // check fired (#50588 review).
        assert.ok(error.line !== undefined, "the refused frame rides on the error");
        const frame = JSON.parse(error.line) as Record<string, unknown>;
        assert.equal(frame["jsonrpc"], "2.0", `line is the whole frame: ${error.line}`);
        assert.ok(Object.hasOwn(frame, "id"), `line carries the response id: ${error.line}`);
        assert.ok(
          Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"),
          `line carries the refused member: ${error.line}`,
        );
        // And it is the frame AS RECEIVED: the exact bytes the host sent,
        // whose spelling no JSON.stringify of the parsed value reproduces —
        // so a refusal that rebuilt the frame fails here (#50635).
        // Race-free without a receipt: spawn() rethrows an answered host's
        // error only after its close ladder saw the child's `close` event,
        // which Node emits once every stdio stream has ended, so the sent
        // chunk is already in `stderr`. Without the ladder this assert would
        // rest only on the host writing stderr before stdout and on I/O
        // dispatch order — stable in practice, guaranteed by nothing (#50688).
        assert.equal(error.line, sentFrame(stderr), "line is the received bytes, not a rebuilt frame");
      },
    );
  }
}

test(
  "TEST-49912-2: a host that answers initialize and dies before `initialized` is lost AFTER answering, and says so",
  { timeout: ARM_TIMEOUT },
  async () => {
    // The host gives a usable answer, then closes its stdin and exits before
    // the SDK's `initialized` notification can reach it, so that write fails
    // (EPIPE). The host is lost — but not at startup: "exited before
    // answering initialize" would send the user hunting a startup problem
    // that never happened (#49912; the Python twin's review found the same).
    const answerThenDie = [
      'const {createInterface} = require("node:readline")',
      'const rl = createInterface({input: process.stdin})',
      'rl.on("line", (line) => {',
      "  const req = JSON.parse(line)",
      // Close the read end of our pipe first: the `initialized` write that
      // follows our receipt of the answer can then only fail.
      '  rl.close(); require("node:fs").closeSync(0)',
      `  process.stdout.write(JSON.stringify({jsonrpc: "2.0", id: req.id, result: {protocolVersion: "1", serverInfo: {name: "answer-then-die", version: "0"}, schema: {fingerprint: ${JSON.stringify(EXPECTED_SCHEMA_FINGERPRINT)}}}}) + "\\n", () => process.exit(7))`,
      "})",
    ].join("\n");

    const error = asHostStartError(await spawnRejection(hostThat(answerThenDie)));

    assert.equal(error.failure.kind, "hostExited");
    if (error.failure.kind !== "hostExited") return;
    assert.equal(error.failure.answeredInitialize, true);
    assert.equal(error.failure.exit.kind, "crash");
    assert.equal(error.failure.exit.kind === "crash" && error.failure.exit.exitCode, 7);
    assert.match(error.message, /after answering initialize, before the handshake completed/, error.message);
    assert.ok(!error.message.includes("before answering initialize:"), error.message);
    assert.ok(error.cause instanceof Error, "the transport error rides as cause");
  },
);
