/**
 * The in-memory `DuplexTransport` the transport-less suites drive `Connection`
 * with. Extracted here because three test files had byte-identical copies
 * (`connection.test.ts`, `connection-error-arms.test.ts`, `facade-client.ts`),
 * which crosses the repo's two-consumer bar for a shared path and meant any
 * frame-shape change had to be made in triplicate.
 *
 * The two older suites migrate in their own lane; this is the seam they move to.
 */

import assert from "node:assert/strict";

import type { DuplexTransport } from "../../src/index.js";

/** A push-driven async iterable of inbound chunks. */
export class AsyncChunks implements AsyncIterable<string> {
  readonly #chunks: string[] = [];
  readonly #waiters: Array<(value: IteratorResult<string>) => void> = [];
  #ended = false;

  push(chunk: string): void {
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#chunks.push(chunk);
    else waiter({ done: false, value: chunk });
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: async () => {
        const chunk = this.#chunks.shift();
        if (chunk !== undefined) return { done: false, value: chunk };
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<string>>((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

/** Records every outbound line and lets a test feed inbound ones. */
export class FakeDuplex implements DuplexTransport {
  readonly chunks = new AsyncChunks();
  readonly writes: string[] = [];
  readonly incoming = this.chunks;

  async write(chunk: string): Promise<void> {
    this.writes.push(chunk);
  }

  async close(): Promise<void> {
    this.chunks.end();
  }
}

/** Newline-frame one JSON value the way the wire does. */
export function frame(value: Record<string, unknown>): string {
  return `${JSON.stringify(value)}\n`;
}

/** Spin the microtask queue until `count` writes have landed, then assert it. */
export async function waitForWrites(transport: FakeDuplex, count: number): Promise<void> {
  for (let turn = 0; turn < 100 && transport.writes.length < count; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(transport.writes.length, count, `expected ${count} write(s)`);
}

/**
 * Spin the microtask queue a fixed number of turns without asserting anything.
 *
 * For the arms whose subject is a frame that must NOT be written (D-006's
 * pre-wire refusal, D-008's no-handler posture): `waitForWrites` cannot express
 * "nothing more is coming", so those arms settle the queue and then assert the
 * write count directly.
 */
export async function settleMicrotasks(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve();
}

/** The nth outbound frame, parsed. */
export function sentFrame(transport: FakeDuplex, index: number): Record<string, unknown> {
  const raw = transport.writes[index];
  assert.ok(raw !== undefined, `expected an outbound frame at index ${index}`);
  return JSON.parse(raw) as Record<string, unknown>;
}

/** The nth outbound frame's `params`. */
export function sentParams(transport: FakeDuplex, index: number): Record<string, unknown> {
  return sentFrame(transport, index)["params"] as Record<string, unknown>;
}

/** Answer the nth outbound request with a success result. */
export function answer(
  transport: FakeDuplex,
  index: number,
  result: Record<string, unknown>,
): void {
  transport.chunks.push(frame({ jsonrpc: "2.0", id: sentFrame(transport, index)["id"], result }));
}

/** Answer the nth outbound request with an MSP error object. */
export function answerError(
  transport: FakeDuplex,
  index: number,
  error: Record<string, unknown>,
): void {
  transport.chunks.push(frame({ jsonrpc: "2.0", id: sentFrame(transport, index)["id"], error }));
}
