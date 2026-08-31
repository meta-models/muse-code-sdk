/**
 * A scripted MSP host used ONLY to prove the wire-tap oracle can fail.
 *
 * The real `tbh serve` is the harness's subject everywhere else (see
 * `qa-real-binary.test.ts`). It cannot play this role: the deviations below
 * are things a correct host never does, so there is no way to ask the real
 * binary to produce one. Proving the oracle discriminates therefore needs a
 * host that will lie on command — and an oracle that passes on both correct
 * and incorrect wire traffic has oracled nothing.
 *
 * Usage: node qa-scripted-host.js <arm>
 */

import { createInterface } from "node:readline";

import { EXPECTED_SCHEMA_FINGERPRINT } from "../../src/index.js";

type Arm = "faithful" | "duplicateResponse" | "errorWithoutKind";

const arm = (process.argv[2] ?? "faithful") as Arm;

function send(frame: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function initializeResult(): Record<string, unknown> {
  return {
    experimentalApi: false,
    grantedCapabilities: [],
    museHome: "/nonexistent",
    platformFamily: "unix",
    platformOs: "linux",
    schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT, version: 1 },
    serverInfo: { name: "scripted", version: "0.0.0" },
    sessionDurability: "durable",
    userAgent: "scripted-host/0.0.0",
  };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  if (line.trim() === "") return;
  const frame = JSON.parse(line) as { id?: unknown; method?: unknown };
  if (frame.method === "initialize") {
    send({ jsonrpc: "2.0", id: frame.id, result: initializeResult() });
    return;
  }
  if (frame.method === "initialized" || frame.id === undefined) return;

  if (frame.method === "session/list") {
    switch (arm) {
      case "duplicateResponse":
        // The lie: one request id, two answers. The SDK settles on the first
        // and drops the second, so only the wire remembers it happened.
        send({ jsonrpc: "2.0", id: frame.id, result: { nextCursor: null, sessions: [] } });
        send({ jsonrpc: "2.0", id: frame.id, result: { nextCursor: null, sessions: ["ghost"] } });
        return;
      case "errorWithoutKind":
        // Schema-legal (`ErrorObject.data` is optional) and yet it blanks the
        // client's only branch point.
        send({
          jsonrpc: "2.0",
          id: frame.id,
          error: { code: -32603, message: "something went wrong" },
        });
        return;
      default:
        send({ jsonrpc: "2.0", id: frame.id, result: { nextCursor: null, sessions: [] } });
        return;
    }
  }
  send({
    jsonrpc: "2.0",
    id: frame.id,
    error: { code: -32601, message: "method not found", data: { kind: "methodNotFound" } },
  });
});

lines.on("close", () => process.exit(0));
