// The two loopback routes and Responses SSE shape come from
// clients/sdk-quickstart/src/provider.ts; holds here use child-request receipts.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";

export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Json : {};
}
export function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
export function at(value: unknown, ...keys: string[]): unknown {
  for (const key of keys) value = object(value)[key];
  return value;
}

/** Subscribers register before probing; an append cannot fall between them. */
export class Changes {
  readonly #waiters = new Set<() => void>();
  notify(): void { for (const wake of this.#waiters) wake(); }

  async waitFor<T>(description: string, probe: () => T | undefined | Promise<T | undefined>): Promise<T> {
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    // Failure-only cap; notifications, never elapsed time, advance the test.
    const failed = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`failure-only cap: ${description}`)), 60_000);
    });
    const observe = async (): Promise<T> => {
      while (!stopped) {
        let wake!: () => void;
        const next = new Promise<void>((resolve) => { wake = resolve; });
        this.#waiters.add(wake);
        try {
          const result = await probe();
          if (result !== undefined) return result;
          await next;
        } finally { this.#waiters.delete(wake); }
      }
      throw new Error(`observation stopped: ${description}`);
    };
    try { return await Promise.race([observe(), failed]); }
    finally { stopped = true; clearTimeout(timer); this.notify(); }
  }
}

function sse(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n`; }
function responseFrame(id: string, status: string, extra: Json = {}): Json {
  return { id, object: "response", model: "fixture-meta", status, output: [], ...extra };
}
function reply(response: ServerResponse, id: string, content: Json): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    sse({ type: "response.created", sequence_number: 1, response: responseFrame(id, "in_progress") }) +
    sse({ ...content, sequence_number: 2, output_index: 0 }) +
    sse({ type: "response.completed", sequence_number: 3,
      response: responseFrame(id, "completed", { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) }),
  );
}
function text(response: ServerResponse, value: string): void {
  reply(response, "sdk64-text", { type: "response.output_text.delta", item_id: "sdk64-message", content_index: 0, delta: value });
}
function tool(response: ServerResponse, name: string, callId: string, args: Json): void {
  reply(response, callId, { type: "response.function_call_arguments.done", item_id: `fc_${callId}`, name, call_id: callId, arguments: JSON.stringify(args) });
}
function toolNames(body: Json): string[] {
  return array(body["tools"]).flatMap((entry) => {
    const tool = object(entry);
    if (tool["type"] === "namespace") return toolNames(tool);
    const name = tool["name"] ?? at(tool, "function", "name");
    return typeof name === "string" ? [name] : [];
  });
}
function latestUser(body: Json): string {
  const message = array(body["input"]).findLast((item) => at(item, "role") === "user");
  return JSON.stringify(message ?? "");
}
function hasResult(body: Json, callId: string): boolean {
  return array(body["input"]).some((item) => at(item, "type") === "function_call_output" && at(item, "call_id") === callId);
}

export async function workflowProvider(): Promise<{
  baseUrl: string;
  requests: Json[];
  errors: string[];
  holdFirstChild(phase: string): void;
  waitForHeldChild(phase: string): Promise<void>;
  waitForCompletionDelivery(phase: string): Promise<void>;
  childSteps(phase: string): number[];
  close(): Promise<void>;
}> {
  const requests: Json[] = [];
  const errors: string[] = [];
  const changes = new Changes();
  const called = new Set<string>();
  const children = new Map<string, number[]>();
  const held = new Set<string>();
  let holdPhase: string | undefined;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    request.on("end", () => {
      try {
        if (request.method === "GET" && request.url?.endsWith("/muse-code/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", data: [{ id: "fixture-meta", object: "model", metadata: { "muse-code": {
            name: "SDK workflow fixture", release_date: "2026-01-01", is_hidden: false,
            tool_call: true, reasoning: true, limit: { context: 1_000_000, output: 4096 },
          } } }] }));
          return;
        }
        assert.equal(request.method, "POST");
        assert.ok(request.url?.endsWith("/responses"), `unexpected provider route ${request.url}`);
        const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        requests.push(body);
        changes.notify();
        const names = toolNames(body);
        const user = latestUser(body);
        const child = /SDK64_CHILD:([a-z0-9-]+):([12])/.exec(user);
        if (names.includes("submit_result") && JSON.stringify(body).includes("Run this generated workflow host.")) {
          assert.ok(child, "generated child must carry its own step marker");
          const phase = child[1]!;
          const step = Number(child[2]);
          const callId = `sdk64-result-${phase}-${step}`;
          if (hasResult(body, callId)) { text(response, `SDK64 child ${phase}:${step} closed`); return; }
          const steps = children.get(phase) ?? [];
          steps.push(step); children.set(phase, steps);
          if (phase === holdPhase && step === 1) {
            held.add(phase); changes.notify();
            return;
          }
          tool(response, "submit_result", callId, { text: `SDK64_RESULT:${phase}:${step}`, notes: null });
          return;
        }
        const phase = /SDK64_WORKFLOW:([a-z0-9-]+)/.exec(user)?.[1];
        if (phase !== undefined && !called.has(phase)) {
          assert.ok(names.includes("workflow"), "the parent must expose the real Workflow tool");
          called.add(phase);
          tool(response, "workflow", phase, {
            name: `generated.sdk64-${phase}`,
            script: `export default async function workflow(host) {
  await host.agent({ input: "SDK64_CHILD:${phase}:1. Call submit_result exactly once with text SDK64_RESULT:${phase}:1." });
  const second = await host.agent({ input: "SDK64_CHILD:${phase}:2. Call submit_result exactly once with text SDK64_RESULT:${phase}:2." });
  return { output_ref: second.ref };
}`,
          });
          return;
        }
        text(response, `SDK64 parent acknowledged ${phase ?? "completion"}`);
      } catch (error) {
        errors.push(String(error)); changes.notify();
        response.writeHead(500); response.end(String(error));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  const checkErrors = (): void => assert.deepEqual(errors, [], "the scripted endpoint must route every request");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, requests, errors,
    holdFirstChild(phase) { assert.equal(holdPhase, undefined); holdPhase = phase; },
    async waitForHeldChild(phase) {
      await changes.waitFor("the real resumed first child reaches its held provider response", () => {
        checkErrors(); return held.has(phase) ? true : undefined;
      });
    },
    async waitForCompletionDelivery(phase) {
      await changes.waitFor("the completed workflow is delivered to the parent model", () => {
        checkErrors();
        return requests.some((body) => array(body["input"]).some((item) => {
          const content = at(item, "content");
          if (typeof content !== "string") return false;
          const envelope = /^<workflow-launch-reconciled>(.*)<\/workflow-launch-reconciled>$/s.exec(content);
          if (envelope === null) return false;
          const receipt = object(JSON.parse(envelope[1]!));
          return receipt["type"] === "workflow_launch_reconciled" && receipt["call_id"] === phase
            && at(receipt, "final_summary", "status") === "completed";
        })) ? true : undefined;
      });
    },
    childSteps(phase) { return [...(children.get(phase) ?? [])].sort(); },
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closed;
    },
  };
}
