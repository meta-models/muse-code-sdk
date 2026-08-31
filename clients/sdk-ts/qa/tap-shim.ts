/**
 * The wire tap, as a process.
 *
 * The harness never reaches inside `@muse-code/sdk` to see the wire (charter
 * decision 4: no SDK-internal imports). Instead the SDK is told to spawn THIS
 * shim, and the shim spawns the real MSP host. Every byte in both directions
 * is appended to a tap file before it is forwarded, so the recording is a
 * faithful transcript of what the SDK actually wrote and actually read — not
 * a re-derivation of what it should have.
 *
 * The tap is append-only and SYNCHRONOUS: an async write can be lost when the
 * child exits, and a lost frame reads as "the host never said it", which is
 * the exact false finding a QA harness must never manufacture.
 *
 * Usage: node tap-shim.js <tapFile> <command> [args...]
 * Exit:  the child's exit code, or 128+signal when the child was signalled.
 *        70 when the shim itself could not start the child.
 */

import { spawn } from "node:child_process";
import { appendFileSync, closeSync, openSync } from "node:fs";
import { constants } from "node:os";

const [tapFile, command, ...args] = process.argv.slice(2);

if (tapFile === undefined || command === undefined) {
  process.stderr.write("tap-shim: usage: tap-shim.js <tapFile> <command> [args...]\n");
  process.exit(70);
}
const tapPath: string = tapFile;

// Create/truncate up front so a run that records nothing is distinguishable
// from a run whose tap file was never opened.
closeSync(openSync(tapPath, "w"));

let sequence = 0;

function record(direction: string, chunk: Buffer): void {
  sequence += 1;
  appendFileSync(
    tapPath,
    `${JSON.stringify({ d: direction, seq: sequence, b: chunk.toString("base64") })}\n`,
  );
}

/**
 * Leave only after stdout has actually drained; a dropped tail is a lie.
 *
 * Setting `exitCode` rather than calling `process.exit` is what makes that
 * true. Node emits `'drain'` only after some `write()` returned false, so a
 * small tail still in flight when the child dies (`writableLength > 0`, but
 * `needDrain` never set — the host-dumps-frames-then-crashes case this tap
 * exists to witness) would park on a `'drain'` that never fires, and the shim
 * would later exit naturally with code 0. `classifyExit` maps 0 to
 * `cleanShutdown`, so a crashed host would pass as clean. A pending stdio
 * write keeps the loop alive on its own: everything still flushes, and the
 * child's status survives.
 *
 * The flip side (#23615): once the child is gone, nothing BUT that pending
 * write may keep the loop alive. The SDK holds the shim's stdin open for as
 * long as it is awaiting a response, so a still-listening stdin would spin the
 * loop forever — the shim never exits, the SDK never sees EOF, and a pending
 * request (`initialize` while the host dies pre-handshake — FM-QA-004's
 * request-await half) deadlocks the
 * whole QA pass. Release stdin and the write side to the dead child here; the
 * loop then empties exactly when the tail has flushed, and the SDK observes
 * EOF precisely as it does with no shim in between.
 */
function exitAfterFlush(status: number): void {
  process.exitCode = status;
  process.stdin.pause();
  process.stdin.unref();
  child.stdin.end();
}

const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });

// The harness owns the close bound, but only the shim knows who to signal: the
// SDK's public barrel exposes no pid and the charter forbids reaching past it
// (decision 4). So the two pids travel through the tap — the harness's own
// channel — and a `hostDidNotExit` timeout can terminate a wedged host instead
// of leaking it. `readWireLog` ignores any record whose direction is not `>`/`<`.
appendFileSync(
  tapPath,
  `${JSON.stringify({ d: "#", seq: 0, shim: process.pid, child: child.pid ?? null })}\n`,
);

child.on("error", (error) => {
  process.stderr.write(`tap-shim: cannot spawn ${command}: ${error.message}\n`);
  process.exit(70);
});

process.stdin.on("data", (chunk: Buffer) => {
  record(">", chunk);
  child.stdin.write(chunk);
});
process.stdin.on("end", () => child.stdin.end());
// The host half can die first; forwarding into a closed stdin must not kill
// the shim before it has recorded the host's last frames.
child.stdin.on("error", () => {});

child.stdout.on("data", (chunk: Buffer) => {
  record("<", chunk);
  process.stdout.write(chunk);
});

child.on("close", (code, signal) => {
  if (signal !== null) {
    const number = (constants.signals as Record<string, number | undefined>)[signal];
    exitAfterFlush(128 + (number ?? 0));
    return;
  }
  exitAfterFlush(code ?? 0);
});
