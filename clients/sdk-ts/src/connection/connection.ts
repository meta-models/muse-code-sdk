/**
 * Duplex-agnostic MSP NDJSON connection (spec 14990 FR-012/014/015/016).
 *
 * The transport supplies decoded UTF-8 chunks. Chunks may be empty and may
 * split anywhere — including mid surrogate pair: the byte accounting below
 * reconciles split pairs (FR-012(a)), so transports need not align chunks
 * to character boundaries. The Node child-process binding — which sets
 * stdout's encoding before implementing this interface — is one
 * well-behaved transport, not the general guarantee.
 */

import type {
  ErrorKind,
  ErrorObject,
  ErrorResponse,
  Notification,
  Request,
  RequestId,
  SuccessResponse,
} from "@muse-code/msp";

const DEFAULT_FRAME_LIMIT_BYTES = 10_485_760;

/**
 * The two-way text stream a `Connection` speaks MSP over.
 *
 * Implement it to run the protocol over any duplex channel: yield decoded
 * UTF-8 chunks on `incoming` and accept outgoing frames through `write`.
 * Chunks may be empty and may split anywhere — even mid surrogate pair — the
 * connection reassembles them. If your transport decodes bytes itself, use a
 * streaming decoder: a multi-byte character split across two byte chunks and
 * decoded separately becomes a replacement character before the connection
 * ever sees it. The SDK's spawned child-process stdio binding sets the stream
 * encoding, so it is safe, and is one ready-made implementation.
 */
export interface DuplexTransport {
  readonly incoming: AsyncIterable<string>;
  write(chunk: string): Promise<void>;
  /**
   * `flushed` settles once every frame the connection had accepted when
   * `close()` was called has been HANDED to `write()` — submission, not
   * completion. A process-owning transport waits for it inside its own
   * shutdown budget before ending the peer's input, so a frame still queued
   * on a microtask is not dropped; it is never GATED by it, because
   * completion is exactly what a wedged peer withholds. Optional and
   * additive: a transport that ignores it behaves as before.
   */
  close?(flushed?: Promise<void>): void | Promise<void>;
}

/**
 * Module-private friend seam (never on the package barrel, like spawn.ts's
 * `ownedTransport`): the submission tail a process-owning transport adopts as
 * its DEFAULT `flushed`, so a close routed around this class — e.g. the
 * public `child.close()` — gets the same step 0 (PR #22819 round 4).
 */
export const submissionTail = Symbol("Connection.submissionTail");

/**
 * Tuning knobs for a `Connection`. Every option is optional: the defaults
 * suit a spawned host, so most applications never pass this at all.
 */
export interface ConnectionOptions {
  readonly frameLimitBytes?: number;
  readonly mintCommandId?: () => string;
  /** Injectable for deterministic transcript clients; values must be unique in flight. */
  readonly mintRequestId?: () => RequestId;
}

/**
 * Per-command overrides for `Connection.command`: pin a command id so a
 * reconnect can replay the same logical command, cap the attempt count, or
 * supply your own retry delay.
 */
export interface CommandOptions {
  /** Reuse this id for a reconnect/replay of the same logical command. */
  readonly commandId?: string;
  /** Total attempts, including the first. */
  readonly maxAttempts?: number;
  /** Injectable so deterministic tests do not sleep. */
  readonly retryDelay?: (attempt: number, error: MspError) => Promise<void>;
}

/** Handles one server-initiated request and resolves with the result to send back. */
export type ServerRequestHandler = (request: Request) => Promise<Record<string, unknown>>;
/** Receives every server notification, in arrival order. */
export type NotificationHandler = (notification: Notification) => void;
/** Receives each framing or correlation violation the connection detects on its inbound stream. */
export type ProtocolErrorHandler = (error: ProtocolError) => void;

interface PendingRequest {
  readonly resolve: (value: Record<string, unknown>) => void;
  readonly reject: (error: unknown) => void;
}

interface CommandMemory {
  readonly signature: string;
  ack?: Record<string, unknown>;
}

/** The one typed error family consumers branch on (INV-012). */
export class MspError extends Error {
  readonly code: number;
  readonly kind: ErrorKind;
  readonly data: Readonly<Record<string, unknown>>;
  readonly retryable: boolean | undefined;

  constructor(error: ErrorObject) {
    super(error.message);
    this.name = "MspError";
    this.code = error.code;
    this.kind = error.data?.kind ?? "unknown";
    this.data = error.data === undefined ? {} : { ...error.data };
    this.retryable = error.data?.retryable;
  }
}

/** A local framing/correlation violation, never a server-authored MSP error. */
export class ProtocolError extends Error {
  readonly line: string | undefined;

  constructor(message: string, line?: string) {
    super(message);
    this.name = "ProtocolError";
    this.line = line;
  }
}

function requestKey(id: RequestId): string {
  return `${typeof id === "number" ? "number" : "string"}:${String(id)}`;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const scalar of text) {
    const point = scalar.codePointAt(0) as number;
    bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** FM-007: error evidence is bounded in UTF-8 BYTES, never code units. */
function truncateToUtf8Bytes(text: string, limitBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const scalar of text) {
    const point = scalar.codePointAt(0) as number;
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + width > limitBytes) break;
    bytes += width;
    end += scalar.length;
  }
  return text.slice(0, end);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Create the SDK-owned UUIDv7 command-id source for a connection/client. */
export function createUuidV7Mint(): () => string {
  let lastMs = -1;
  let sequence = 0;
  return () => {
    let now = Date.now();
    if (now <= lastMs) {
      now = lastMs;
      sequence += 1;
      if (sequence > 0x0fff) {
        now += 1;
        sequence = 0;
      }
    } else {
      sequence = 0;
    }
    lastMs = now;
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    let timestamp = now;
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = timestamp & 0xff;
      timestamp = Math.floor(timestamp / 256);
    }
    bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
    bytes[7] = sequence & 0xff;
    bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
}

async function defaultRetryDelay(attempt: number): Promise<void> {
  const ceilingMs = Math.min(2_000, 50 * 2 ** Math.max(0, attempt - 1));
  const delayMs = Math.floor(Math.random() * (ceilingMs + 1));
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * One MSP connection over newline-delimited JSON.
 *
 * The connection sends your requests and commands, correlates their
 * responses, enforces the frame-size limit, and hands inbound notifications
 * and server requests to the handlers you register. It is transport-agnostic:
 * pair it with any `DuplexTransport`. Most applications never build one
 * directly — `MuseClient.spawn` or `spawnMspConnection` does it for you;
 * reach for a bare `Connection` when you need the raw notification feed or
 * your own transport.
 */
export class Connection {
  readonly #transport: DuplexTransport;
  readonly #frameLimitBytes: number;
  readonly #mintCommandId: () => string;
  readonly #mintRequestId: () => RequestId;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #commands = new Map<string, CommandMemory>();

  #nextRequestId = 1;
  #serverRequestHandler: ServerRequestHandler | undefined;
  #notificationHandler: NotificationHandler | undefined;
  #protocolErrorHandler: ProtocolErrorHandler | undefined;
  #writeTail: Promise<void> = Promise.resolve();
  // Settles when every accepted frame has been HANDED to the transport, as
  // opposed to #writeTail, which settles when the peer has taken it.
  #submitTail: Promise<void> = Promise.resolve();
  #writeFailure: unknown;
  #buffer = "";
  #bufferBytes = 0; // FR-012: incremental accounting — never a full-buffer rescan per chunk
  // FR-012: the last UTF-16 unit of #buffer (-1 when empty), maintained from each
  // fresh chunk so the surrogate-pair reconciliation below never READS #buffer on
  // the hot no-newline path — reading it (charCodeAt/indexOf/regex) flattens the
  // V8 rope and copies the whole buffer per chunk, the O(bytes^2) this FR bans.
  #bufferTailCode = -1;
  #droppingOversized = false;
  #finished = false;
  readonly #closedPromise: Promise<void>;
  #resolveClosed: (() => void) | undefined;

  constructor(transport: DuplexTransport, options?: ConnectionOptions) {
    this.#transport = transport;
    this.#frameLimitBytes = options?.frameLimitBytes ?? DEFAULT_FRAME_LIMIT_BYTES;
    this.#mintCommandId = options?.mintCommandId ?? createUuidV7Mint();
    this.#mintRequestId = options?.mintRequestId ?? (() => {
      const id = this.#nextRequestId;
      this.#nextRequestId += 1;
      return id;
    });
    this.#closedPromise = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
    void this.#readLoop();
  }

  get closed(): Promise<void> {
    return this.#closedPromise;
  }

  /** See {@link submissionTail}. */
  [submissionTail](): Promise<void> {
    return this.#submitTail;
  }

  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#finished) return Promise.reject(new ProtocolError("connection is closed"));
    const id = this.#mintRequestId();
    if (typeof id !== "string" && (typeof id !== "number" || !Number.isInteger(id))) {
      return Promise.reject(new ProtocolError("request id must be a string or integer"));
    }
    if (this.#pending.has(requestKey(id))) {
      return Promise.reject(new ProtocolError(`request id ${String(id)} is already in flight`));
    }
    const request: Request = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(requestKey(id), { resolve, reject });
      void this.#write(request).catch((error: unknown) => {
        this.#pending.delete(requestKey(id));
        reject(error);
      });
    });
  }

  /**
   * Take one id from THIS connection's single `commandId` minter (INV-013).
   *
   * Exposed for the callers that need the id BEFORE the ack: `sendUserTurn`
   * records its optimistic SS4.13 entry under it, and an entry created only on
   * the ack is invisible for exactly the window it exists to cover. The
   * alternative was a facade-side mint, which is the second minter INV-013
   * forbids — delegating here keeps the single-minter property intact and
   * preserves the injected `mintCommandId` seam for deterministic transcripts.
   *
   * Pair it with `command(..., { commandId })`, which reuses the id instead of
   * minting a second one.
   */
  mintCommandId(): string {
    return this.#mintCommandId();
  }

  notify(method: string, params?: Record<string, unknown>): void {
    const notification: Notification = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
    void this.#write(notification).catch((error: unknown) => this.#finish(error));
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.#serverRequestHandler = handler;
  }

  onNotification(handler: NotificationHandler): void {
    this.#notificationHandler = handler;
  }

  onProtocolError(handler: ProtocolErrorHandler): void {
    this.#protocolErrorHandler = handler;
  }

  async flush(): Promise<void> {
    await this.#writeTail;
    if (this.#writeFailure !== undefined) throw this.#writeFailure;
  }

  async command(
    method: string,
    params: Record<string, unknown>,
    options?: CommandOptions,
  ): Promise<Record<string, unknown>> {
    const commandId = options?.commandId ?? this.#mintCommandId();
    const commandParams = { ...params, commandId };
    const signature = canonical({ method, params: commandParams });
    const memory = this.#commands.get(commandId);
    if (memory !== undefined && memory.signature !== signature) {
      throw new ProtocolError(`commandId ${commandId} was reused with a different payload`);
    }
    const remembered = memory ?? { signature };
    this.#commands.set(commandId, remembered);
    const maxAttempts = Math.max(1, options?.maxAttempts ?? 3);
    const retryDelay = options?.retryDelay ?? defaultRetryDelay;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const ack = await this.request(method, commandParams);
        // session/start's and session/resume's result schemas omit the
        // redundant commandId echo (the two omitting families recorded in
        // specs/14990-muse-sdk/contracts/sdk-surface.md; approval/decide
        // DOES echo it). When a result carries it, preserve the strict echo
        // check (TEST-018).
        if (ack["commandId"] !== undefined && ack["commandId"] !== commandId) {
          throw new ProtocolError(
            `${method} ack commandId ${String(ack["commandId"])} did not echo ${commandId}`,
          );
        }
        if (remembered.ack !== undefined && canonical(remembered.ack) !== canonical(ack)) {
          throw new ProtocolError(
            `${method} replay for commandId ${commandId} did not return a value-identical ack`,
          );
        }
        remembered.ack = { ...ack };
        return ack;
      } catch (error) {
        const retryableNothingAdmitted =
          error instanceof MspError &&
          ((error.code === -32001 && error.kind === "overloaded") ||
            (error.code === -32031 && error.kind === "backpressured"));
        if (!retryableNothingAdmitted || attempt === maxAttempts) throw error;
        await retryDelay(attempt, error);
      }
    }
    throw new ProtocolError("unreachable command retry state");
  }

  async close(): Promise<void> {
    // COMPLETION must not gate teardown — that is the #15943 hang, since a
    // peer that stopped reading never completes a write. SUBMISSION must,
    // though: `#write` hands the frame to the transport on a later
    // microtask, so ending the peer's input synchronously here dropped a
    // just-accepted `notify()` and rejected close() with a raw
    // ERR_STREAM_WRITE_AFTER_END on a HEALTHY peer (PR #22819 round 3).
    // The submission promise goes TO the transport, which waits for it
    // inside its own shutdown budget, so this class still knows nothing
    // about processes, signals, or timeouts.
    //
    // The guarantee is SCOPED to transports that implement close() (PR
    // #22819 round 4). A close-less transport has no budget to bound the
    // wait with, and submission of frame N+1 only happens once frame N
    // COMPLETES — exactly what a wedged peer withholds — so awaiting it here
    // would hang teardown outright, where previously `#finish` at least
    // rejected in-flight requests and settled `closed`. Finishing
    // immediately is the honest behaviour for a transport that never told us
    // how long it may take.
    const tail = this.#writeTail;
    if (this.#transport.close !== undefined) {
      await this.#transport.close(this.#submitTail);
      // Bounded by the transport's own shutdown: the peer is gone by now, so
      // a pending write has errored and the tail records `#writeFailure`.
      await tail;
    } else {
      // Nothing here may wait on the peer: a stuck write's tail would never
      // settle either. `#finish` has already rejected every in-flight
      // request and settled `closed`; `flush()` still surfaces a later
      // write failure.
      this.#finish(new ProtocolError("connection closed"));
    }
    await this.#closedPromise;
  }

  async #write(frame: Request | Notification | SuccessResponse | ErrorResponse): Promise<void> {
    if (this.#finished) throw new ProtocolError("connection is closed");
    const line = `${JSON.stringify(frame)}\n`;
    let markSubmitted!: () => void;
    const submitted = new Promise<void>((resolve) => {
      markSubmitted = resolve;
    });
    this.#submitTail = this.#submitTail.then(() => submitted);
    const write = this.#writeTail.then(async () => {
      try {
        if (this.#finished) throw new ProtocolError("connection is closed");
        // Invoking write() IS submission: the transport's synchronous prefix
        // has reached the underlying stream by the time the call returns.
        const inFlight = this.#transport.write(line);
        markSubmitted();
        await inFlight;
      } catch (error) {
        // A frame that can never be submitted must not wedge close() either.
        markSubmitted();
        throw error;
      }
    });
    this.#writeTail = write.catch((error: unknown) => {
      this.#writeFailure = error;
      this.#finish(error);
    });
    await write;
  }

  async #readLoop(): Promise<void> {
    try {
      for await (const chunk of this.#transport.incoming) this.#ingest(chunk);
      if (!this.#droppingOversized && this.#buffer.length > 0) {
        this.#protocolError(new ProtocolError("inbound frame ended without a newline", this.#buffer));
      }
      this.#finish(new ProtocolError("connection reached EOF"));
    } catch (error) {
      this.#finish(error);
    }
  }

  #ingest(chunk: string): void {
    let remaining = chunk;
    if (this.#droppingOversized) {
      const newline = remaining.indexOf("\n");
      if (newline < 0) return;
      this.#droppingOversized = false;
      remaining = remaining.slice(newline + 1);
    }
    // FR-012: a chunk boundary can split a surrogate pair; the lone halves
    // counted 3+3 UTF-8 bytes as they arrived, but the joined pair counts 4 at
    // line-extract. Reconcile the +2 residue now, or legal frames accumulate
    // drift until one false-trips the frame limit.
    if (remaining.length === 0) return;
    const chunkHead = remaining.charCodeAt(0);
    if (
      this.#bufferTailCode >= 0xd800 &&
      this.#bufferTailCode <= 0xdbff &&
      chunkHead >= 0xdc00 &&
      chunkHead <= 0xdfff
    ) {
      this.#bufferBytes -= 2;
    }
    this.#buffer += remaining;
    this.#bufferBytes += utf8ByteLength(remaining);
    this.#bufferTailCode = remaining.charCodeAt(remaining.length - 1);
    // FR-012: the retained buffer is newline-free on entry (the drain below runs
    // to exhaustion), so only the fresh chunk can carry a newline. Gating the
    // drain here keeps ingest O(bytes) instead of rescanning the whole buffer
    // from offset 0 on every newline-less chunk (O(bytes^2)).
    if (remaining.includes("\n")) {
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        this.#bufferBytes -= utf8ByteLength(line) + 1;
        this.#line(line);
      }
      // No post-drain tail refresh needed: the retained buffer's last unit IS
      // the chunk's last unit (already recorded above) — or the chunk ended in
      // "\n", which can never pass the high-surrogate check that is this
      // field's only reader. Pinned by TEST-017's interleaved-chunk arm.
    }
    if (this.#bufferBytes > this.#frameLimitBytes) {
      this.#protocolError(
        new ProtocolError(
          `inbound frame exceeds ${this.#frameLimitBytes} bytes`,
          truncateToUtf8Bytes(this.#buffer, this.#frameLimitBytes),
        ),
      );
      this.#buffer = "";
      this.#bufferBytes = 0;
      this.#bufferTailCode = -1;
      this.#droppingOversized = true;
    }
  }

  #line(raw: string): void {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) return;
    if (utf8ByteLength(line) > this.#frameLimitBytes) {
      this.#protocolError(
        new ProtocolError(
          `inbound frame exceeds ${this.#frameLimitBytes} bytes`,
          truncateToUtf8Bytes(line, this.#frameLimitBytes),
        ),
      );
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.#protocolError(new ProtocolError("inbound frame is not valid JSON", line));
      return;
    }
    if (!isObject(parsed) || parsed["jsonrpc"] !== "2.0") {
      this.#protocolError(new ProtocolError("inbound frame is not a JSON-RPC 2.0 object", line));
      return;
    }
    const method = parsed["method"];
    const id = parsed["id"];
    if (typeof method === "string") {
      if (typeof id === "string" || typeof id === "number") {
        if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) {
          this.#protocolError(new ProtocolError("server request id must be a positive integer", line));
          return;
        }
        void this.#serverRequest(parsed as unknown as Request).catch((error: unknown) => {
          this.#finish(error);
        });
        return;
      }
      this.#notificationHandler?.(parsed as unknown as Notification);
      return;
    }
    if (typeof id !== "string" && typeof id !== "number") {
      this.#protocolError(new ProtocolError("response has no usable id", line));
      return;
    }
    this.#response(parsed, id, line);
  }

  #response(frame: Record<string, unknown>, id: RequestId, line: string): void {
    const pending = this.#pending.get(requestKey(id));
    if (pending === undefined) {
      this.#protocolError(new ProtocolError(`response for unknown request id ${String(id)}`, line));
      return;
    }
    const hasResult = Object.hasOwn(frame, "result");
    const hasError = Object.hasOwn(frame, "error");
    if (hasResult === hasError) {
      // FR-014: the MATCHED caller must settle — with no local timeout
      // (INV-006) an unrejected caller would hang until EOF.
      const violation = new ProtocolError("response must carry exactly one of result or error", line);
      this.#pending.delete(requestKey(id));
      pending.reject(violation);
      this.#protocolError(violation);
      return;
    }
    this.#pending.delete(requestKey(id));
    if (hasResult) {
      const result = frame["result"];
      if (!isObject(result)) {
        pending.reject(new ProtocolError("response result must be an object", line));
        return;
      }
      pending.resolve(result);
      return;
    }
    const error = frame["error"];
    if (
      !isObject(error) ||
      typeof error["code"] !== "number" ||
      !Number.isInteger(error["code"]) ||
      typeof error["message"] !== "string"
    ) {
      pending.reject(new ProtocolError("error response has an invalid error object", line));
      return;
    }
    const data = error["data"];
    if (!isObject(data) || typeof data["kind"] !== "string") {
      pending.reject(new ProtocolError("MSP error response has no data.kind", line));
      return;
    }
    pending.reject(
      new MspError({
        code: error["code"],
        message: error["message"],
        data: data as unknown as ErrorObject["data"],
      }),
    );
  }

  async #serverRequest(request: Request): Promise<void> {
    const id = request.id;
    try {
      if (this.#serverRequestHandler === undefined) {
        throw new MspError({
          code: -32601,
          message: `method not found: ${request.method}`,
          data: { kind: "methodNotFound", retryable: false },
        });
      }
      const result = await this.#serverRequestHandler(request);
      // FM-009: a failed reply write finishes the connection; it must not
      // escape this fire-and-forget task as an unhandled rejection.
      await this.#write({ jsonrpc: "2.0", id, result }).catch((writeError: unknown) =>
        this.#finish(writeError),
      );
    } catch (error) {
      const typed =
        error instanceof MspError
          ? error
          : new MspError({
              code: -32603,
              message: error instanceof Error ? error.message : "server request handler failed",
              data: { kind: "internal" },
            });
      await this.#write({
        jsonrpc: "2.0",
        id,
        error: {
          code: typed.code,
          message: typed.message,
          data: typed.data as unknown as ErrorObject["data"],
        },
      }).catch((writeError: unknown) => this.#finish(writeError)); // FM-009
    }
  }

  #protocolError(error: ProtocolError): void {
    this.#protocolErrorHandler?.(error);
  }

  #finish(reason: unknown): void {
    if (this.#finished) return;
    this.#finished = true;
    const error = reason instanceof Error ? reason : new ProtocolError(String(reason));
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#resolveClosed?.();
    this.#resolveClosed = undefined;
  }
}
