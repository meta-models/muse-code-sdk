/** An in-memory MSP host behind the `spawnFn` seam, shared by the seam and abort arms. */

import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { EXPECTED_SCHEMA_FINGERPRINT } from "../../src/index.js";

/**
 * A `spawnFn` whose children are in-memory MSP hosts: each answers
 * `initialize` and `session/start` on stdout, and exits 0 once its stdin
 * ends, as an orderly host does at SS2.1.2 EOF.
 */
export function inMemoryHostSpawn(
  options: {
    /** Called with each frame's method as the host receives it. */
    readonly onMethod?: (method: string) => void;
  } = {},
): {
  readonly spawnFn: typeof spawn;
  readonly calls: Array<{ readonly cmd: string; readonly args: readonly string[] }>;
  readonly methods: string[];
  /** True once any child's stdin has ended (the SS2.1.2 EOF). */
  readonly stdinEnded: () => boolean;
} {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  const methods: string[] = [];
  let ended = false;
  const spawnFn = (cmd: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
    calls.push({ cmd, args: [...args] });
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const send = (value: Record<string, unknown>): void => {
      stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...value })}\n`);
    };
    const respond = (frame: { id?: unknown; method?: string }): void => {
      if (frame.method !== undefined) {
        methods.push(frame.method);
        options.onMethod?.(frame.method);
      }
      if (frame.method === "initialize") {
        send({
          id: frame.id,
          result: {
            experimentalApi: false,
            grantedCapabilities: [],
            museHome: "/nonexistent",
            platformFamily: "unix",
            platformOs: "linux",
            schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT, version: 1 },
            serverInfo: { name: "in-memory", version: "0.0.0" },
            sessionDurability: "ephemeral",
            userAgent: "in-memory-host/0.0.0",
          },
        });
      } else if (frame.method === "session/start") {
        send({
          id: frame.id,
          result: { session: { sessionId: "s-1", status: "idle" }, viewCursor: "c-0" },
        });
      }
    };
    let buffered = "";
    const exit = (code: number | null, signal: NodeJS.Signals | null): void => {
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit("close", code, signal));
    };
    child["stdout"] = stdout;
    child["stderr"] = stderr;
    child["stdin"] = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        buffered += chunk.toString("utf8");
        let newline: number;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          respond(JSON.parse(buffered.slice(0, newline)) as { id?: unknown; method?: string });
          buffered = buffered.slice(newline + 1);
        }
        callback();
      },
      final(callback) {
        ended = true;
        callback();
        exit(0, null);
      },
    });
    child["kill"] = (signal: NodeJS.Signals = "SIGTERM") => {
      exit(null, signal);
      return true;
    };
    return child as unknown as ChildProcessWithoutNullStreams;
  };
  return { spawnFn: spawnFn as unknown as typeof spawn, calls, methods, stdinEnded: () => ended };
}
