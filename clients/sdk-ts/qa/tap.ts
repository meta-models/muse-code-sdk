/** Route an SDK spawn through the wire tap, and read the recording back. */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { ConnectionOptions } from "../src/index.js";

/** The compiled shim, resolved from this module so the layout stays one fact. */
export const TAP_SHIM_PATH = fileURLToPath(new URL("./tap-shim.js", import.meta.url));

export interface TappedSpawnOptions {
  /** Where the recording is written. Truncated by the shim at spawn. */
  readonly tapFile: string;
  /** The REAL host binary. The harness never substitutes a stand-in here. */
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly connection?: ConnectionOptions;
  readonly onStderr?: (chunk: string) => void;
}

/**
 * The options to hand `spawnMspConnection`. The SDK spawns the shim; the shim
 * spawns `command`. Nothing else about the SDK's behaviour changes, which is
 * the point: the tap must not be a second implementation of the transport.
 */
export function tappedSpawnOptions(options: TappedSpawnOptions): {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly connection?: ConnectionOptions;
  readonly onStderr?: (chunk: string) => void;
} {
  return {
    command: process.execPath,
    args: [TAP_SHIM_PATH, options.tapFile, options.command, ...(options.args ?? [])],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.connection === undefined ? {} : { connection: options.connection }),
    ...(options.onStderr === undefined ? {} : { onStderr: options.onStderr }),
  };
}

export type WireDirection = "clientToHost" | "hostToClient";

export interface WireFrame {
  readonly direction: WireDirection;
  /** Ordinal within this direction. */
  readonly index: number;
  /** Ordinal across BOTH directions, in the order the tap completed them. */
  readonly order: number;
  readonly raw: string;
  /** The parsed frame, or `undefined` when the line is not a JSON object. */
  readonly json: Record<string, unknown> | undefined;
}

export interface WireLog {
  readonly frames: readonly WireFrame[];
  readonly outbound: readonly WireFrame[];
  readonly inbound: readonly WireFrame[];
  /** Bytes recorded after the last newline — a half-frame nobody completed. */
  readonly trailing: Readonly<Record<WireDirection, string>>;
}

interface TapRecord {
  readonly d: string;
  readonly seq: number;
  readonly b: string;
}

/** The shim's `#` header: who to signal when a host has to be torn down. */
export interface TapPids {
  readonly shim: number | undefined;
  readonly child: number | undefined;
}

/**
 * Read the shim's pid header without reassembling the whole recording.
 *
 * A close timeout has to terminate the host BEFORE the tap is read — the shim
 * can still be appending — so this stays a separate, cheap read.
 */
export async function readTapPids(tapFile: string): Promise<TapPids> {
  let text: string;
  try {
    text = await readFile(tapFile, "utf8");
  } catch {
    return { shim: undefined, child: undefined };
  }
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const record = parseFrame(line);
    if (record?.["d"] !== "#") continue;
    const shim = record["shim"];
    const child = record["child"];
    return {
      shim: typeof shim === "number" ? shim : undefined,
      child: typeof child === "number" ? child : undefined,
    };
  }
  return { shim: undefined, child: undefined };
}

function parseFrame(raw: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reassemble the recording into NDJSON frames.
 *
 * Chunk boundaries are not frame boundaries: a single host write can carry
 * half a frame, and a single read can carry three. Buffering per direction and
 * splitting on newline is the same framing the SDK does, which is what makes
 * "the wire said Y" comparable to "the public API said X".
 *
 * The buffering is over BYTES, and the decode to UTF-8 happens only once a
 * whole frame is in hand. A pipe read can end mid-code-point (any frame with
 * emoji or CJK larger than one pipe buffer), and decoding each chunk on its own
 * would turn the two halves into U+FFFD — so the reassembled wire would stop
 * matching what the host really sent while the SDK, which decodes the stream,
 * still saw the truth. That gap manufactures phantom facade findings out of
 * faithful traffic, which is the one thing this harness must never do.
 */
export async function readWireLog(tapFile: string): Promise<WireLog> {
  const text = await readFile(tapFile, "utf8");
  const buffers: Record<WireDirection, Buffer> = {
    clientToHost: Buffer.alloc(0),
    hostToClient: Buffer.alloc(0),
  };
  const counts: Record<WireDirection, number> = { clientToHost: 0, hostToClient: 0 };
  const frames: WireFrame[] = [];

  for (const line of text.split("\n")) {
    if (line === "") continue;
    const record = parseFrame(line) as unknown as TapRecord | undefined;
    if (record === undefined || typeof record.b !== "string") continue;
    // Anything that is not a directional byte record (the `#` pid header) is
    // metadata, never wire traffic — folding it into a direction would inject
    // bytes the host never sent.
    if (record.d !== ">" && record.d !== "<") continue;
    const direction: WireDirection = record.d === ">" ? "clientToHost" : "hostToClient";
    buffers[direction] = Buffer.concat([buffers[direction], Buffer.from(record.b, "base64")]);
    let newline = buffers[direction].indexOf(0x0a);
    while (newline >= 0) {
      const raw = buffers[direction].subarray(0, newline).toString("utf8");
      buffers[direction] = buffers[direction].subarray(newline + 1);
      if (raw.trim() !== "") {
        frames.push({
          direction,
          index: counts[direction],
          order: frames.length,
          raw,
          json: parseFrame(raw),
        });
        counts[direction] += 1;
      }
      newline = buffers[direction].indexOf(0x0a);
    }
  }

  return {
    frames,
    outbound: frames.filter((frame) => frame.direction === "clientToHost"),
    inbound: frames.filter((frame) => frame.direction === "hostToClient"),
    trailing: {
      clientToHost: buffers.clientToHost.toString("utf8"),
      hostToClient: buffers.hostToClient.toString("utf8"),
    },
  };
}
