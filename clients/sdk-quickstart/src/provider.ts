/**
 * The journey's provider-configured mode: a loopback fake first-party endpoint
 * plus the `HOME` that points `muse serve` at it.
 *
 * This is the TypeScript twin of `FakeMetaEndpoint` in
 * `crates/cli/tests/msp_serve_assembly.rs` (issue #23555). It serves the same
 * two routes with the same bodies, and the `HOME` it seeds carries the same
 * two files with the same shape:
 *
 *   `GET  <base>/muse-code/models` -> one visible, dated row, so the host's
 *                                     `pick_default_model_from` yields a model.
 *   `POST <base>/responses`        -> a text SSE turn, or ONE scripted `bash`
 *                                     tool call (see below).
 *   `$HOME/.config/muse/settings.json` -> `endpoint_transport` at that base URL
 *                                         with `auth: "bearer"`.
 *   `$HOME/.config/muse/auth.json`     -> a stored credential in the `meta` slot.
 *
 * Nothing here reaches the network: the listener binds `127.0.0.1:0` and the
 * stored credential is a fixed dummy the fake never checks. There is no live
 * provider and no API key, so this mode is safe to run in CI on every PR — it
 * is what lets the journey assert the turn, approval and cancel segments for
 * real instead of expect-blocking them.
 *
 * The credential-free mode (no `home` seeded) is still supported and is the
 * documented no-provider degradation path; see README.md.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The catalog's single model id. */
const FAKE_MODEL_ID = "fake-model";

/**
 * The stored credential. It is LOAD-BEARING that one exists at all — a keyless
 * rig makes the "credentialed" arm credential-independent (the review round on
 * TEST-23555-1 in `msp_serve_assembly.rs`) — but its value is never checked,
 * so it is a fixed literal and not a secret.
 */
const DUMMY_API_KEY = "quickstart-journey-dummy-key";

export interface FakeProviderOptions {
  /**
   * Substrings that appear together in the completion request body of the ONE
   * turn that should get the scripted tool call, and in no other request.
   *
   * Routing by CONTENT rather than by request index is load-bearing, exactly as
   * it is in `msp_serve_assembly.rs`: a serve turn also drives the reminder
   * plugins' own child sessions against this same endpoint, and one of those
   * lands FIRST — an index-ordered script feeds the tool call to a child whose
   * toolset cannot call it.
   */
  readonly scriptedToolCallWhen: readonly string[];
  /** The command the scripted `bash` tool call asks to run. */
  readonly scriptedToolCallCommand: string;
  /** The text every other completion answers with. */
  readonly replyText: string;
}

/** A running fake endpoint and the `HOME` configured to talk to it. */
export interface ConfiguredProvider {
  /** The seeded `HOME` to hand `JourneyOptions.home`. */
  readonly home: string;
  /** The loopback base URL the seeded `HOME` points at. */
  readonly baseUrl: string;
  /** How many times the model catalog was fetched. */
  catalogGets(): number;
  /**
   * How many scripted tool calls were served. The harness's own contract is
   * that this is AT MOST ONE: after the approval segment's turn, its artifact
   * name is in the replayed history of every later turn, so a content match
   * with no once-only guard hands the `cancel` segment a tool call too and
   * parks it on an approval nobody answers.
   */
  scriptedToolCalls(): number;
  /** Stop the listener and drop every connection it is still holding. */
  close(): Promise<void>;
}

/**
 * How long each completion is held open between its first delta and its
 * `response.completed`.
 *
 * The `cancel` segment asserts that a RUNNING turn can be cancelled. An
 * endpoint that answers instantly turns that into a race the journey loses
 * intermittently: the turn reaches terminal before `turn/cancel` is admitted
 * and the host rejects the cancel with `already_terminal`. That race is
 * precisely the excuse the retired expect-block used to carry, so the fake
 * removes it at the source instead of re-importing it — the turn is
 * unambiguously in flight when the cancel lands.
 *
 * The value is slack, but it is NOT free slack: a serve turn drives the
 * reminder plugins' child sessions through this same endpoint, so a segment
 * waits on several holds in series. Measured on the release host, the `turn`
 * segment costs about five holds end to end. 3s therefore buys a ~30x margin
 * over the ~100ms window the host leaves on its own, while keeping `turn` near
 * 15s against its 60s `STREAM_BUDGET_MS` — a 5s hold would put `turn` at ~25s,
 * 42% of that budget, trading a cancel race for a timeout race.
 */
const HOLD_MS = 3_000;

function sse(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

/** One visible, dated row so the host's default-model pick yields a model. */
function catalogBody(): string {
  return JSON.stringify({
    object: "list",
    data: [
      {
        id: FAKE_MODEL_ID,
        object: "model",
        metadata: {
          "muse-code": {
            release_date: "2026-01-01",
            is_hidden: false,
            limit: { context: 1_000_000, output: 1024 },
          },
        },
      },
    ],
  });
}

function responseFrame(id: string, status: string, extra: Record<string, unknown> = {}): unknown {
  return { id, object: "response", model: FAKE_MODEL_ID, status, output: [], ...extra };
}

/** The head of a completion: created, then the one content-bearing event. */
function completionHead(text: string): string {
  return (
    sse({
      type: "response.created",
      sequence_number: 1,
      response: responseFrame("resp_journey_text", "in_progress"),
    }) +
    sse({
      type: "response.output_text.delta",
      sequence_number: 2,
      output_index: 0,
      item_id: "msg_journey_text",
      content_index: 0,
      delta: text,
    })
  );
}

/** The head of the scripted `bash` tool call (serve composes exec's managed
 * shell tool family, FR-24146-1: the model-visible tool is `bash`, whose
 * strict schema also requires `description` under the default titles gate). */
function toolCallHead(callId: string, command: string): string {
  return (
    sse({
      type: "response.created",
      sequence_number: 1,
      response: responseFrame("resp_journey_tool", "in_progress"),
    }) +
    sse({
      type: "response.function_call_arguments.done",
      sequence_number: 2,
      output_index: 0,
      item_id: `fc_${callId}`,
      name: "bash",
      call_id: callId,
      arguments: JSON.stringify({ command, description: "Write the approval artifact" }),
    })
  );
}

function completionTail(id: string): string {
  return sse({
    type: "response.completed",
    sequence_number: 3,
    response: responseFrame(id, "completed", {
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
  });
}

/**
 * Start the loopback endpoint and seed a `HOME` that points at it.
 *
 * The caller owns the returned handle and MUST `close()` it; the listener and
 * its hold timers keep the process alive otherwise.
 */
export async function startConfiguredProvider(
  options: FakeProviderOptions,
): Promise<ConfiguredProvider> {
  const catalog = catalogBody();
  let catalogGets = 0;
  let scriptedToolCalls = 0;
  /** Every in-flight hold, so `close()` can never be blocked by one. */
  const holds = new Set<NodeJS.Timeout>();

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (request.method === "GET" && (request.url ?? "").endsWith("/muse-code/models")) {
        catalogGets += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(catalog);
        return;
      }

      // Once-only, content-routed: see `scriptedToolCallWhen` and
      // `scriptedToolCalls` above for why both halves are load-bearing.
      const isScripted =
        scriptedToolCalls === 0 &&
        options.scriptedToolCallWhen.every((needle) => body.includes(needle));

      let head: string;
      let responseId: string;
      if (isScripted) {
        scriptedToolCalls += 1;
        responseId = "resp_journey_tool";
        head = toolCallHead(`call_journey_${String(scriptedToolCalls)}`, options.scriptedToolCallCommand);
      } else {
        responseId = "resp_journey_text";
        head = completionHead(options.replyText);
      }

      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(head);
      const hold = setTimeout(() => {
        holds.delete(hold);
        // A cancelled turn aborts the request, so the socket is often already
        // gone by now. Finishing a dead response is a no-op, not an error.
        if (!response.writableEnded) response.end(completionTail(responseId));
      }, HOLD_MS);
      holds.add(hold);
    });
    // An aborted request (the cancel path) must not reach the process as an
    // unhandled error event.
    request.on("error", () => undefined);
    response.on("error", () => undefined);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("the fake provider endpoint did not bind a TCP port");
  }
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  const home = await mkdtemp(join(tmpdir(), "muse-quickstart-provider-home-"));
  const configDir = join(home, ".config", "muse");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "settings.json"),
    `${JSON.stringify({ schema_version: 1, endpoint_transport: { base_url: baseUrl, auth: "bearer" } }, null, 2)}\n`,
  );
  await writeFile(
    join(configDir, "auth.json"),
    `${JSON.stringify({ schema_version: 1, providers: { meta: { api_key: DUMMY_API_KEY } } })}\n`,
  );

  return {
    home,
    baseUrl,
    catalogGets: () => catalogGets,
    scriptedToolCalls: () => scriptedToolCalls,
    close: async () => {
      for (const hold of holds) clearTimeout(hold);
      holds.clear();
      // Sockets the host left open would keep `close` pending forever.
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
