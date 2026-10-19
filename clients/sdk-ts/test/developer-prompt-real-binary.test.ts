// Spec 207 amendment 32029 TEST-32029-16: the built stdio server and the
// generated SDK Connection, with a recording provider, for both client-switch
// directions (ADR 32029 D25's desktop/terminal example).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { Notification, SessionResumeParams, SessionStartParams } from "@muse-code/msp";
import { spawnMspConnection } from "../src/connection/spawn.js";
import type { SpawnedMspConnection } from "../src/connection/spawn.js";
import { MspError } from "../src/connection/connection.js";

const binary = process.env["TBH_32029_SDK_E2E_BIN"];
const skip = binary === undefined
  ? "NOT RUN: set TBH_32029_SDK_E2E_BIN to a muse binary built from this tree; a skip is not acceptance"
  : false;

const DESKTOP = "sdk-32029 desktop: rich cards and widgets are supported; use them when useful.";
const TERMINAL = "sdk-32029 terminal: plain text only; cards and widgets are unsupported.";
const SETTINGS = "sdk-32029 settings: answer in one short sentence.";

type Json = Record<string, unknown>;

/** A loopback Meta endpoint: one catalog row, a text turn, every body kept. */
async function recordingProvider(): Promise<{ baseUrl: string; bodies: Json[]; close(): Promise<void> }> {
  const bodies: Json[] = [];
  const sse = (value: unknown): string => `data: ${JSON.stringify(value)}\n\n`;
  const frame = (status: string, extra: Json = {}): Json =>
    ({ id: "resp_32029", object: "response", model: "fake-model", status, output: [], ...extra });
  const server: Server = createServer((request, response) => {
    if (request.method === "GET" && request.url?.endsWith("/muse-code/models") === true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model",
        metadata: { "muse-code": { release_date: "2026-01-01", is_hidden: false,
          limit: { context: 1_000_000, output: 1024 } } } }] }));
      return;
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", () => {
      bodies.push(JSON.parse(raw) as Json);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        sse({ type: "response.created", sequence_number: 1, response: frame("in_progress") }) +
        sse({ type: "response.output_text.delta", sequence_number: 2, output_index: 0,
          item_id: "msg_32029", content_index: 0, delta: "ok-32029" }) +
        sse({ type: "response.completed", sequence_number: 3,
          response: frame("completed", { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    bodies,
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

function roleTexts(body: Json, role: string): string[] {
  const input = Array.isArray(body["input"]) ? body["input"] as Json[] : [];
  return input.filter((item) => item["role"] === role).map((item) => {
    const content = item["content"];
    if (typeof content === "string") return content;
    return Array.isArray(content)
      ? (content as Json[]).map((part) => typeof part["text"] === "string" ? part["text"] : "").join("")
      : "";
  });
}

/** The main agent advertises its working tools; reminder children only their
 *  decision tool, and they embed the parent conversation and can post first. */
function isMainAgentRequest(body: Json): boolean {
  const tools = Array.isArray(body["tools"]) ? body["tools"] as Json[] : [];
  const flat = tools.flatMap((tool) => tool["type"] === "namespace" && Array.isArray(tool["tools"])
    ? tool["tools"] as Json[] : [tool]);
  return flat.some((tool) => tool["name"] === "read_file");
}

/** Gate-written developer text: the runtime appends `<system-reminder>`
 *  blocks to the same message, so compare only what precedes the first. */
function gateDeveloperTexts(body: Json): string[] {
  return roleTexts(body, "developer")
    .map((text) => text.split("\n\n<system-reminder")[0] ?? "")
    .filter((text) => text.startsWith("sdk-32029 "));
}

/** One HOME shared by every process of a scenario, so restarts are real. */
class Rig {
  readonly home: string;
  readonly workspace: string;
  readonly provider: Awaited<ReturnType<typeof recordingProvider>>;

  private constructor(home: string, workspace: string, provider: Rig["provider"]) {
    this.home = home; this.workspace = workspace; this.provider = provider;
  }

  /** Live mode: the copied `endpoint_transport` block replaces the fake. */
  private transport: Json | undefined;

  static async create(t: TestContext, liveTransport?: Json): Promise<Rig> {
    const home = await mkdtemp(join(tmpdir(), "sdk-32029-"));
    const workspace = join(home, "workspace");
    await mkdir(workspace, { recursive: true });
    const provider = await recordingProvider();
    t.after(() => provider.close());
    const rig = new Rig(home, workspace, provider);
    rig.transport = liveTransport;
    await rig.settings(undefined);
    await writeFile(join(home, ".config", "muse", "auth.json"),
      JSON.stringify({ schema_version: 1, providers: { meta: { api_key: "unused" } } }));
    return rig;
  }

  settingsPath(): string { return join(this.home, ".config", "muse", "settings.json"); }

  async settings(developerPrompt: string | undefined): Promise<void> {
    await mkdir(join(this.home, ".config", "muse"), { recursive: true });
    const document: Json = { schema_version: 1,
      endpoint_transport: this.transport ?? { base_url: this.provider.baseUrl, auth: "bearer" } };
    if (developerPrompt !== undefined) document["run"] = { developer_prompt: developerPrompt };
    await writeFile(this.settingsPath(), JSON.stringify(document));
  }

  /** A fresh process and Connection: a reconnect the SDK cache cannot mask. */
  async connect(): Promise<Client> {
    const handshake = spawnMspConnection({
      command: binary ?? "",
      args: ["serve", "--disable-sandbox"],
      cwd: this.workspace,
      env: { PATH: process.env["PATH"], HOME: this.home, TBH_CREDENTIAL_BACKEND: "file",
        TBH_DISABLE_TELEMETRY: "1", MUSE_EXPERIMENTAL_SDK_ENABLED: "on", TBH_IS_E2E_TEST: "1",
        TBH_E2E_SESSION_NAME_ACCOUNT_HOME: this.home },
    });
    const notifications: Notification[] = [];
    const waiters = new Set<() => void>();
    handshake.onNotification((notification) => {
      notifications.push(notification);
      for (const wake of waiters) wake();
    });
    const spawned = await handshake.initialize({ clientInfo: { name: "sdk_32029_e2e", version: "1" } });
    return new Client(spawned, this.provider.bodies, notifications, waiters);
  }
}

class Client {
  constructor(
    readonly spawned: SpawnedMspConnection,
    private readonly bodies: Json[],
    private readonly notifications: Notification[],
    private readonly waiters: Set<() => void>,
  ) {}

  async start(workspace: string, developerPrompt: string | undefined): Promise<string> {
    const params: Omit<SessionStartParams, "commandId"> = { workspaceRoot: workspace };
    if (developerPrompt !== undefined) params.config = { developerPrompt };
    const result = await this.spawned.connection.command("session/start", params as Json);
    const session = result["session"] as Json;
    return String(session["sessionId"]);
  }

  async resume(sessionId: string, config: SessionResumeParams["config"]): Promise<Json> {
    const params: Omit<SessionResumeParams, "commandId"> = { sessionId, excludeItems: true };
    if (config !== undefined) params.config = config;
    return await this.spawned.connection.command("session/resume", params as Json);
  }

  /** The agent message text a turn produced (live mode reads model output). */
  agentText(sinceNotification: number): string {
    return this.notifications.slice(sinceNotification)
      .filter((n) => n.method === "item/completed")
      .map((n) => (n.params as Json | undefined)?.["item"] as Json | undefined)
      .filter((item) => item?.["type"] === "agentMessage")
      .map((item) => String(item?.["text"] ?? ""))
      .join("\n");
  }

  notificationCount(): number { return this.notifications.length; }

  /** One completed turn, live: waits for turn/completed and returns output. */
  async liveTurn(sessionId: string, text: string): Promise<string> {
    const seen = this.notifications.length;
    await this.spawned.connection.command("turn/start",
      { sessionId, input: [{ type: "text", text }], ifBusy: "steer" });
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.notifications.slice(seen).some((n) => n.method === "turn/completed"
          && (n.params as Json | undefined)?.["sessionId"] === sessionId)) {
          this.waiters.delete(check);
          resolve();
        }
      };
      this.waiters.add(check);
      check();
    });
    return this.agentText(seen);
  }

  /** One completed turn; returns this test's developer texts in its main
   *  request (the runtime may add developer messages of its own). */
  async turn(sessionId: string, marker: string): Promise<string[]> {
    const mark = this.bodies.length;
    const seen = this.notifications.length;
    await this.spawned.connection.command("turn/start",
      { sessionId, input: [{ type: "text", text: marker }], ifBusy: "steer" });
    // Notification receipts, never elapsed time, advance this wait.
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.notifications.slice(seen).some((n) => n.method === "turn/completed"
          && (n.params as Json | undefined)?.["sessionId"] === sessionId)) {
          this.waiters.delete(check);
          resolve();
        }
      };
      this.waiters.add(check);
      check();
    });
    const request = this.bodies.slice(mark).find((body) => isMainAgentRequest(body)
      && roleTexts(body, "user").some((text) => text.includes(marker)));
    assert.ok(request, `turn ${marker} made a main-agent provider request`);
    return gateDeveloperTexts(request);
  }

  async close(): Promise<void> { await this.spawned.close(); }
}

/** One switch direction: `from` at start, `to` on resume, then recovery. */
async function switchDirection(t: TestContext, from: string, to: string): Promise<void> {
  const rig = await Rig.create(t);
  const settingsBefore = await readFile(rig.settingsPath());

  let client = await rig.connect();
  const session = await client.start(rig.workspace, from);
  const sibling = await client.start(rig.workspace, undefined);
  assert.deepEqual(await client.turn(session, `${from} first`), [from], "the start override reaches the request");
  await client.close();

  // Reconnect, switch: the new instructions are saved before success and
  // reach the next admitted request, although the old records remain.
  client = await rig.connect();
  await client.resume(session, { developerPrompt: to });
  assert.deepEqual(await client.turn(session, `${to} switched`), [to], "the switched instructions reach the request");
  await client.close();

  // Durable restart with neither input: the saved switch is recovered.
  client = await rig.connect();
  await client.resume(session, undefined);
  assert.deepEqual(await client.turn(session, `${to} recovered`), [to], "a client with neither input recovers the saved switch");
  // The sibling keeps its own (absent) instructions; settings bytes unchanged.
  await client.resume(sibling, undefined);
  assert.deepEqual(await client.turn(sibling, "sibling untouched"), [], "the sibling's instructions are untouched");
  await client.close();
  assert.deepEqual(await readFile(rig.settingsPath()), settingsBefore, "no switch writes the settings file");
}

test("TEST-32029-16: desktop to terminal switch over the built server and generated Connection",
  { skip }, async (t) => { await switchDirection(t, DESKTOP, TERMINAL); });

test("TEST-32029-16: terminal to desktop (reverse) switch",
  { skip }, async (t) => { await switchDirection(t, TERMINAL, DESKTOP); });

test("TEST-32029-16: settings-only selection, recorded fallback, blank fallback and null refusal",
  { skip }, async (t) => {
    const rig = await Rig.create(t);
    let client = await rig.connect();
    const session = await client.start(rig.workspace, DESKTOP);
    await client.turn(session, "desktop recorded");
    await client.close();

    // Silence keeps the recorded text: no capability is inferred.
    client = await rig.connect();
    await client.resume(session, undefined);
    assert.deepEqual(await client.turn(session, "silence"), [DESKTOP], "neither input falls back to the record");
    await client.close();

    // Settings alone select and save.
    await rig.settings(SETTINGS);
    client = await rig.connect();
    await client.resume(session, undefined);
    assert.deepEqual(await client.turn(session, "settings selected"), [SETTINGS], "settings win over the record");
    await client.close();

    // Blank is omission: with settings gone, the saved selection holds.
    await rig.settings(undefined);
    client = await rig.connect();
    await client.resume(session, { developerPrompt: "   " });
    assert.deepEqual(await client.turn(session, "blank"), [SETTINGS], "blank falls back to the saved selection");

    // Null is refused before any effect.
    const before = rig.provider.bodies.length;
    // Deliberately invalid wire input: the generated type forbids null.
    await assert.rejects(
      client.resume(session, { developerPrompt: null as unknown as string }),
      (error: unknown) => error instanceof MspError,
      "a null developerPrompt is refused",
    );
    assert.equal(rig.provider.bodies.length, before, "the refusal makes no provider request");
    await client.close();
  });

const liveSettings = process.env["TBH_32029_SDK_LIVE_SETTINGS"];
const liveSkip = binary === undefined || liveSettings === undefined
  ? "NOT RUN: live leg needs TBH_32029_SDK_E2E_BIN and TBH_32029_SDK_LIVE_SETTINGS (a settings.json whose endpoint_transport is copied); a skip is not acceptance"
  : false;
const CARD_ASK = "Show me a three-item packing list for a beach day as a rich card widget. If cards or widgets are unsupported here, say so in plain text and give the list as plain text.";

/** The session log's lines that carry `text` (request evidence on disk). */
async function logLinesWith(home: string, sessionId: string, text: string): Promise<number> {
  const { readdir } = await import("node:fs/promises");
  let count = 0;
  const visit = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === "session.jsonl" && dir.endsWith(sessionId)) {
        count += (await readFile(path, "utf8")).split("\n").filter((line) => line.includes(text)).length;
      }
    }
  };
  await visit(join(home, ".local", "share", "muse", "sessions"));
  return count;
}

test("TEST-32029-16 live: unsupported-card output after terminal selection, reverse switch, settings-only and neither-input fallback",
  { skip: liveSkip, timeout: 900_000 }, async (t) => {
    const owner = JSON.parse(await readFile(liveSettings!, "utf8")) as Json;
    const transport = owner["endpoint_transport"] as Json | undefined;
    assert.ok(transport !== undefined, "the live settings name an endpoint_transport");
    const rig = await Rig.create(t, transport);
    const outputs: Json[] = [];
    const step = async (name: string, client: Client, session: string, expected: string): Promise<void> => {
      const before = await logLinesWith(rig.home, session, expected);
      const output = await client.liveTurn(session, CARD_ASK);
      const after = await logLinesWith(rig.home, session, expected);
      outputs.push({ step: name, expected, requestEvidenceLines: after - before, output });
      console.log(`LIVE_32029 ${name}: ${JSON.stringify(output)}`);
      assert.ok(after > before, `[${name}] the turn's durable model records carry the selected instructions`);
    };

    let client = await rig.connect();
    const session = await client.start(rig.workspace, DESKTOP);
    await client.close();
    client = await rig.connect();
    await client.resume(session, { developerPrompt: TERMINAL });
    await step("terminal-selected", client, session, TERMINAL);
    await client.close();
    client = await rig.connect();
    await client.resume(session, { developerPrompt: DESKTOP });
    await step("reverse-to-desktop", client, session, DESKTOP);
    await client.close();
    await rig.settings(TERMINAL);
    client = await rig.connect();
    await client.resume(session, undefined);
    await step("settings-only", client, session, TERMINAL);
    await client.close();
    await rig.settings(undefined);
    client = await rig.connect();
    await client.resume(session, undefined);
    await step("neither-input-fallback", client, session, TERMINAL);
    await client.close();
    const evidence = process.env["TBH_32029_EVIDENCE_DIR"];
    if (evidence !== undefined) await writeFile(join(evidence, "test16-live.json"), JSON.stringify(outputs, null, 2));
  });
