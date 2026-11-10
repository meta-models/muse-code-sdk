// #77912 FM-77912-2, SDK layer: aborting `Session.run` while its turn is queued
// and the session runtime takes no call keeps taking the turn back, under one
// commandId, until the host takes it, against a real `muse serve` host.
import assert from "node:assert/strict";
import { watch } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MuseClient } from "../src/index.js";
import { hermeticEnv } from "../qa/recorder.js";
import { readWireLog, tappedSpawnOptions } from "../qa/tap.js";
import type { WireFrame, WireLog } from "../qa/tap.js";
import { Changes, array, at, object } from "./helpers/workflow-resume-provider.js";
import type { Json } from "./helpers/workflow-resume-provider.js";

const binary = process.env["TBH_SDK_BUSY_UNQUEUE_E2E_BIN"];
const skip = binary === undefined
  ? "NOT RUN: set TBH_SDK_BUSY_UNQUEUE_E2E_BIN to a muse binary built from the #77912 stacked head"
    + " (the ordinary-lane hold and turn/unqueue's runtime_busy answer at least); a skip is not acceptance"
  : false;

const HOLD = "SDK_BUSY_UNQUEUE_HOLD";
const QUEUED = "SDK_BUSY_UNQUEUE_QUEUED";
const AFTER = "SDK_BUSY_UNQUEUE_AFTER";
/** Busy answers to see before the lane frees; each one waits out the host's 30 s request timeout. */
const BUSY_ROUNDS = 2;

function sse(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n`; }
function responseFrame(id: string, status: string, extra: Json = {}): Json {
  return { id, object: "response", model: "fixture-meta", status, output: [], ...extra };
}
function latestUser(body: Json): string {
  const message = array(body["input"]).findLast((item) => at(item, "role") === "user");
  return JSON.stringify(message ?? "");
}

interface HeldTurnProvider {
  readonly baseUrl: string;
  readonly requests: Json[];
  readonly errors: string[];
  /** Model streams now held open. */
  holding(): number;
  /** Answer every held stream, and every later one at once. */
  release(): void;
  close(): Promise<void>;
}

/**
 * A loopback Responses endpoint that keeps open each stream whose latest user
 * message carries HOLD (a retried stream too) until `release`, so turn 1 stays
 * running with no live model. Every other request is answered at once.
 */
async function heldTurnProvider(changes: Changes): Promise<HeldTurnProvider> {
  const requests: Json[] = [];
  const errors: string[] = [];
  const held: { response: ServerResponse; id: string }[] = [];
  let released = false;
  const finish = (response: ServerResponse, id: string): void => {
    response.end(sse({ type: "response.completed", sequence_number: 3,
      response: responseFrame(id, "completed", { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) }));
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", () => undefined);
    response.on("error", () => undefined);
    request.on("end", () => {
      let body: Json;
      try {
        if (request.method === "GET" && request.url?.endsWith("/muse-code/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ object: "list", data: [{ id: "fixture-meta", object: "model", metadata: { "muse-code": {
            name: "SDK busy-unqueue fixture", release_date: "2026-01-01", is_hidden: false,
            tool_call: true, reasoning: true, limit: { context: 1_000_000, output: 4096 },
          } } }] }));
          return;
        }
        assert.equal(request.method, "POST");
        assert.ok(request.url?.endsWith("/responses"), `unexpected provider route ${request.url}`);
        body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        errors.push(String(error)); changes.notify();
        response.writeHead(500); response.end(String(error));
        return;
      }
      requests.push(body);
      const id = `busy-unqueue-${requests.length}`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(sse({ type: "response.created", sequence_number: 1, response: responseFrame(id, "in_progress") }));
      response.write(sse({ type: "response.output_text.delta", sequence_number: 2, output_index: 0,
        item_id: `${id}-message`, content_index: 0, delta: `busy-unqueue reply ${requests.length}` }));
      if (!released && latestUser(body).includes(HOLD)) held.push({ response, id });
      else finish(response, id);
      changes.notify();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`, requests, errors,
    holding: () => held.length,
    release() {
      released = true;
      for (const { response, id } of held.splice(0)) finish(response, id);
    },
    async close() {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections(); await closed;
    },
  };
}

/** The host's answer to `request`: the next inbound frame with its id and no method. */
function answerTo(wire: WireLog, request: WireFrame): WireFrame | undefined {
  const id = request.json?.["id"];
  return wire.inbound.find((frame) => frame.order > request.order
    && frame.json !== undefined && frame.json["method"] === undefined && frame.json["id"] === id);
}
function unqueuesOf(wire: WireLog, turnId: string): WireFrame[] {
  return wire.outbound.filter((frame) => frame.json?.["method"] === "turn/unqueue"
    && at(frame.json, "params", "turnId") === turnId);
}
function assertNoStopFallback(wire: WireLog): void {
  const stop = wire.outbound.find((frame) => ["turn/cancel", "turn/interrupt"].includes(String(frame.json?.["method"])));
  assert.equal(stop, undefined, `the abort fell back to a cancel, so the SDK gave up the take-back: ${stop?.raw}`);
}
function settled<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then((value) => ({ value }), (error: unknown) => ({ error }));
}
async function capped<T>(promise: Promise<T>, capMs: number, description: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  // Failure-only cap; the awaited outcome, never elapsed time, advances the test.
  const failed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`failure-only cap: ${description}`)), capMs);
  });
  try { return await Promise.race([promise, failed]); } finally { clearTimeout(timer); }
}

test("an aborted run keeps taking back its queued turn while the session runtime takes no call", { skip, timeout: 600_000 }, async (t) => {
  assert.ok(binary);
  const root = await mkdtemp(join(tmpdir(), "sdk-busy-unqueue-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  const holdDir = join(root, "lane-hold");
  const tap = join(root, "host.tap.jsonl");
  await mkdir(workspace, { recursive: true }); await mkdir(holdDir);
  // The host's E2E lane hold: `arm` names the session, the host writes `held`, `release` frees the lane.
  const hold = { arm: join(holdDir, "arm"), held: join(holdDir, "held"), release: join(holdDir, "release") };
  const changes = new Changes();
  const provider = await heldTurnProvider(changes);
  const watchers = [watch(root, () => changes.notify()), watch(holdDir, () => changes.notify())];
  const stderr: string[] = [];
  let client: MuseClient | undefined;
  let closed = false;
  t.after(async () => {
    try {
      await writeFile(hold.release, "");
      provider.release();
      if (client !== undefined && !closed) { await client.close(); await client.exit; }
    } finally {
      for (const watcher of watchers) watcher.close();
      await provider.close();
      await writeFile(join(root, "provider.json"), JSON.stringify({ requests: provider.requests, errors: provider.errors }, null, 2));
      await writeFile(join(root, "host.stderr"), stderr.join(""));
      const evidence = process.env["TBH_SDK_BUSY_UNQUEUE_E2E_EVIDENCE"];
      if (evidence !== undefined) {
        await mkdir(evidence, { recursive: true });
        await cp(root, join(evidence, "run-abort-busy-unqueue"), { recursive: true });
      }
      await rm(root, { recursive: true, force: true });
    }
  });
  const env = {
    ...hermeticEnv(home), META_API_KEY: "busy-unqueue-loopback-fixture-only",
    TBH_IS_E2E_TEST: "1", TBH_E2E_SESSION_NAME_ACCOUNT_HOME: home,
    TBH_TMUX_ORDINARY_LANE_HOLD_ARM_FILE: hold.arm,
    TBH_TMUX_ORDINARY_LANE_HOLD_HELD_FILE: hold.held,
    TBH_TMUX_ORDINARY_LANE_HOLD_RELEASE_FILE: hold.release,
  };
  const config = join(home, "config", "muse"); await mkdir(config, { recursive: true });
  await writeFile(join(config, "settings.json"), JSON.stringify({
    schema_version: 1, endpoint_transport: { base_url: provider.baseUrl, auth: "bearer" },
    run: { reminder_roster: { agents: [] } },
  }));
  await writeFile(join(config, "auth.json"), JSON.stringify({ schema_version: 1, providers: { meta: { api_key: env.META_API_KEY } } }));
  const options = tappedSpawnOptions({ tapFile: tap, command: binary,
    args: ["serve", "--provider", "meta", "--model", "fixture-meta"],
    cwd: workspace, env, onStderr: (text) => stderr.push(text) });
  client = await MuseClient.spawn({ ...options, museBin: options.command,
    clientInfo: { name: "sdk_busy_unqueue", version: "1" }, shutdownTimeoutMs: 30_000 });
  const session = await client.startSession({ approvalMode: "allowAll", workspaceRoot: workspace });
  const checkProvider = (): void => assert.deepEqual(provider.errors, [], "the loopback endpoint must route every request");

  // Turn 1 runs and stays running: its model stream is held open.
  const first = await session.sendUserTurn({ input: [{ type: "text", text: HOLD }] });
  const firstOutcome = settled(first.completed);
  await changes.waitFor("the provider holds turn 1's model stream", () => {
    checkProvider(); return provider.holding() > 0 ? true : undefined;
  });

  // Turn 2 queues behind it; its outcome is observed from here on, so an early failure leaves no stray rejection.
  const controller = new AbortController();
  const queued = settled(session.run(QUEUED, { ifBusy: "queue", signal: controller.signal }));
  const turn2 = await changes.waitFor("turn 2's turn/start is acked queued", async () => {
    const wire = await readWireLog(tap);
    const start = wire.outbound.find((frame) => frame.json?.["method"] === "turn/start"
      && JSON.stringify(at(frame.json, "params", "input")).includes(QUEUED));
    const ack = start === undefined ? undefined : answerTo(wire, start);
    if (ack === undefined) return undefined;
    assert.equal(at(ack.json, "result", "disposition"), "queued", `turn 2 did not queue: ${ack.raw}`);
    const turnId = at(ack.json, "result", "turnId");
    assert.equal(typeof turnId, "string");
    return String(turnId);
  });

  // The host stops taking calls on the session's ordinary lane, as a stuck runtime does.
  await writeFile(`${hold.arm}.staged`, session.sessionId);
  await rename(`${hold.arm}.staged`, hold.arm);
  const slots = await changes.waitFor(
    "the session host holds its whole ordinary lane (the binary lacks the ordinary-lane hold, or the arm file did not name its session)",
    async () => {
      const text = (await readFile(hold.held, "utf8").catch(() => "")).trim();
      return text === "" ? undefined : text;
    });
  assert.match(slots, /^[1-9][0-9]*$/, "the host reports how many slots it holds");

  const reason = new Error("busy-unqueue stop");
  controller.abort(reason);
  for (let round = 1; round <= BUSY_ROUNDS; round += 1) {
    await changes.waitFor(
      `the host answers unqueue #${round} runtime_busy (the binary lacks turn/unqueue's runtime_busy answer) and the SDK sends it again`,
      async () => {
        const wire = await readWireLog(tap);
        assertNoStopFallback(wire);
        const unqueues = unqueuesOf(wire, turn2);
        const sent = unqueues[round - 1];
        const answer = sent === undefined ? undefined : answerTo(wire, sent);
        if (answer === undefined) return undefined;
        assert.equal(at(answer.json, "error", "data", "reason"), "runtime_busy", `unqueue #${round} was not answered busy: ${answer.raw}`);
        return unqueues.length > round ? true : undefined;
      },
      120_000);
  }

  // The runtime takes calls again: the resend in flight takes the turn back.
  await writeFile(hold.release, "");
  const stopped = await capped(queued, 120_000, "the aborted run settles once the host takes the turn back");
  assert.ok("error" in stopped, "the aborted run rejects");
  assert.equal(stopped.error, reason, "the aborted run rejects with exactly the abort's reason");
  const reclaimed = await capped(session.turn(turn2).completed, 60_000, "turn 2's wait settles");
  assert.equal(reclaimed.kind, "unqueued", "the queued turn was taken back, not run");

  provider.release();
  const firstEnd = await capped(firstOutcome, 60_000, "turn 1 completes once its model stream is answered");
  assert.ok("value" in firstEnd && firstEnd.value.kind === "completed", "turn 1 completes");
  // Barrier: a turn 2 still queued would launch before this one.
  const after = await capped(session.run(AFTER, { ifBusy: "queue" }), 60_000, "a later turn runs to completion");
  assert.equal(after.outcome.kind, "completed");
  checkProvider();

  await client.close(); const exit = await client.exit; closed = true;
  assert.deepEqual(exit, { kind: "cleanShutdown" }, "healthy EOF must drain without escalation");

  const wire = await readWireLog(tap);
  assertNoStopFallback(wire);
  const unqueues = unqueuesOf(wire, turn2);
  assert.ok(unqueues.length >= BUSY_ROUNDS + 1, `${BUSY_ROUNDS} busy answers, then the take-back; saw ${unqueues.length} unqueues`);
  const commandId = at(unqueues[0]!.json, "params", "commandId");
  assert.equal(typeof commandId, "string");
  for (const [index, unqueue] of unqueues.entries()) {
    const label = `unqueue #${index + 1}`;
    assert.equal(at(unqueue.json, "params", "commandId"), commandId, `${label} keeps the first unqueue's commandId`);
    const answer = answerTo(wire, unqueue);
    assert.ok(answer, `${label} was answered`);
    if (index < unqueues.length - 1) {
      assert.equal(at(answer.json, "error", "code"), -32030, `${label}: ${answer.raw}`);
      assert.equal(at(answer.json, "error", "data", "kind"), "commandRejected");
      assert.equal(at(answer.json, "error", "data", "reason"), "runtime_busy");
      assert.equal(at(answer.json, "error", "data", "retryable"), true);
      assert.equal(at(answer.json, "error", "data", "commandId"), commandId, `${label}'s answer names its commandId`);
      assert.match(String(at(answer.json, "error", "message")), /reclaim/, `${label}'s answer names the call not taken`);
    } else {
      assert.equal(at(answer.json, "result", "status"), "accepted", `the last unqueue takes the turn back: ${answer.raw}`);
      assert.equal(at(answer.json, "result", "turnId"), turn2);
    }
  }
  const notices = (method: string): WireFrame[] => wire.inbound.filter((frame) =>
    frame.json?.["method"] === method && at(frame.json, "params", "turnId") === turn2);
  assert.equal(notices("turn/started").length, 0, "the queued turn never started");
  assert.equal(notices("turn/unqueued").length, 1, "the host reports the take-back once");
  assert.ok(!provider.requests.some((body) => latestUser(body).includes(QUEUED)), "the queued turn never reached the model");
});
