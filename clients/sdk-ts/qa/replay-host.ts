/**
 * The replay host: re-serve a captured host→client frame sequence, with no
 * product binary in the process tree.
 *
 * This exists for ONE job — facade-vs-binary attribution (`attribution.ts`).
 * Replaying the exact frames the real host sent, into a fresh SDK, answers
 * "is the public API a faithful function of the wire?". If it is, the
 * deviation lives in the frames, so it is the BINARY's; if the API's view
 * changes or disagrees with those frames, it is the FACADE's.
 *
 * It is never a substitute host for a scenario. Scenarios drive the real
 * binary; this one only ever replays what the real binary already said.
 *
 * Usage: node replay-host.js <framesFile>
 *   framesFile: one captured host→client frame per line, in capture order.
 */

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const framesFile = process.argv[2];
if (framesFile === undefined) {
  process.stderr.write("replay-host: usage: replay-host.js <framesFile>\n");
  process.exit(70);
}

interface Frame {
  readonly raw: string;
  readonly json: Record<string, unknown>;
  /** A response answers a request id; a notification does not. */
  readonly isResponse: boolean;
}

const captured: Frame[] = readFileSync(framesFile, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((raw) => {
    const json = JSON.parse(raw) as Record<string, unknown>;
    return { raw, json, isResponse: json["method"] === undefined && "id" in json };
  });

let cursor = 0;

function emit(frame: Frame, id: unknown, commandId: unknown): void {
  // The replaying client mints its OWN request ids and its own UUIDv7
  // commandIds, so both identities are re-correlated to the ones actually in
  // flight. Nothing else is touched: the result, the error, and every field
  // the oracle reads stay byte-identical to what the host sent.
  //
  // The commandId rewrite is not cosmetic. `Connection.command` rejects an
  // ack whose `commandId` does not echo the one it sent (TEST-018), so
  // without it every command-plane replay would fail as a ProtocolError and
  // every command-plane attribution would read `indeterminate`.
  if (!frame.isResponse) {
    process.stdout.write(`${JSON.stringify(frame.json)}\n`);
    return;
  }
  const body: Record<string, unknown> = { ...frame.json, id };
  const result = body["result"];
  if (
    commandId !== undefined &&
    typeof result === "object" &&
    result !== null &&
    "commandId" in result
  ) {
    body["result"] = { ...(result as Record<string, unknown>), commandId };
  }
  process.stdout.write(`${JSON.stringify(body)}\n`);
}

/**
 * Drain captured frames up to and including the next response, then keep
 * draining the notifications that FOLLOWED it.
 *
 * The trailing drain matters: a host emits `turn/completed` after the
 * `turn/start` response, so a replay that stopped at the response would make
 * every notification-shaped observable unreplayable — and an unreplayable
 * observable reads as `indeterminate` attribution, which is a harness defect
 * wearing an honest-looking label.
 */
function answer(id: unknown, commandId: unknown): void {
  let answered = false;
  while (cursor < captured.length) {
    const frame = captured[cursor] as Frame;
    if (answered && frame.isResponse) return;
    cursor += 1;
    emit(frame, id, commandId);
    if (frame.isResponse) answered = true;
  }
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  const frame = JSON.parse(line) as {
    id?: unknown;
    method?: unknown;
    params?: { commandId?: unknown };
  };
  if (frame.id === undefined) return; // a client notification expects nothing
  answer(frame.id, frame.params?.commandId);
});
lines.on("close", () => process.exit(0));
