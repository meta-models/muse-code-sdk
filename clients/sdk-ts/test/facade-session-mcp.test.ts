/**
 * FR-79107-3 — `spawn` requests `sessionMcp` (ADR 32760 D3), and `startSession`
 * and `resumeSession` forward `config` (per-session MCP servers) only when the
 * host granted it in the handshake. A
 * `config` naming servers on a connection without that grant is refused, typed,
 * before anything is sent; the refusal covers only that open, so the same
 * client keeps opening sessions without servers. As on the host (ADR 32760 D3),
 * a `config` naming no server needs no grant.
 *
 * Transcript-level proof against an inline host. Host bug #77053 keeps a live
 * host from starting these servers, so no arm claims the servers ran.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  Connection,
  EXPECTED_SCHEMA_FINGERPRINT,
  MuseCapabilityNotGrantedError,
  MuseClient,
} from "../src/index.js";
import type { StartSessionOptions } from "../src/index.js";
import { FakeDuplex, settleMicrotasks } from "./helpers/fake-duplex.js";

const CLIENT_INFO = { name: "sdk_test", version: "0.0.0" };
// Failure-only cap for arms that spawn a real child.
const ARM_TIMEOUT = 20_000;

const CONFIG: NonNullable<StartSessionOptions["config"]> = {
  mcpServers: {
    docs: { transport: "stdio", command: "docs-mcp", args: ["--stdio"] },
    search: { transport: "streamableHttp", url: "https://example.invalid/mcp" },
  },
};

/**
 * An inline host that, like a real one, grants only what the client requested
 * among the capabilities it `offers` (an empty offer is a host with
 * per-session MCP turned off). Opens echo the params they received, and
 * `session/list` reports the `initialize` request's capabilities and every
 * method received after it, so an arm can prove what did and did not reach
 * the wire.
 */
function inlineHost(offers: readonly string[]): string {
  return [
    'const { createInterface } = require("node:readline");',
    "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
    `const offers = ${JSON.stringify(offers)};`,
    "const received = [];",
    "let requested;",
    "let capabilities;",
    "createInterface({ input: process.stdin }).on('line', (line) => {",
    "  const frame = JSON.parse(line);",
    "  if (frame.id === undefined) return;",
    "  if (frame.method === 'initialize') {",
    "    capabilities = frame.params.capabilities;",
    "    requested = capabilities?.requestedCapabilities ?? [];",
    "    const granted = requested.filter((name) => offers.includes(name));",
    "    send({ jsonrpc: '2.0', id: frame.id, result: {",
    "      experimentalApi: false, grantedCapabilities: granted, museHome: '/nonexistent',",
    "      platformFamily: 'unix', platformOs: 'linux',",
    `      schema: { fingerprint: ${JSON.stringify(EXPECTED_SCHEMA_FINGERPRINT)}, version: 1 },`,
    "      serverInfo: { name: 'inline', version: '0.0.0' },",
    "      sessionDurability: 'durable', userAgent: 'inline-host/0.0.0' } });",
    "    return;",
    "  }",
    "  received.push(frame.method);",
    "  if (frame.method === 'session/list') {",
    "    send({ jsonrpc: '2.0', id: frame.id, result: { sessions: [], received, requested, capabilities } });",
    "    return;",
    "  }",
    "  const sessionId = frame.params.sessionId ?? 's-1';",
    "  send({ jsonrpc: '2.0', id: frame.id, result: {",
    "    session: { sessionId, status: 'idle' }, viewCursor: 'c-0',",
    "    history: { mode: 'none', items: [] }, pendingRequests: [], echoed: frame.params } });",
    "}).on('close', () => process.exit(0));",
  ].join("\n");
}

async function spawnOffering(
  t: { after: (fn: () => Promise<void>) => void },
  offers: readonly string[],
  capabilities?: NonNullable<Parameters<typeof MuseClient.spawn>[0]["capabilities"]>,
) {
  // A default spawn: the caller requests nothing itself.
  const client = await MuseClient.spawn({
    museBin: process.execPath,
    args: ["-e", inlineHost(offers)],
    clientInfo: CLIENT_INFO,
    ...(capabilities === undefined ? {} : { capabilities }),
  });
  t.after(() => client.close());
  return client;
}

function echoed(opening: unknown): Record<string, unknown> {
  return (opening as { result: { echoed: Record<string, unknown> } }).result.echoed;
}

interface HostView {
  received: string[];
  requested: string[];
  capabilities: Record<string, unknown>;
}

async function hostView(client: MuseClient): Promise<HostView> {
  const listed = (await client.listSessions()) as unknown as HostView;
  return { ...listed, received: listed.received.filter((method) => method !== "session/list") };
}

async function receivedMethods(client: MuseClient): Promise<unknown> {
  return (await hostView(client)).received;
}

test(
  "FR-79107-3: spawn requests sessionMcp and keeps the caller's own requests and posture, once each",
  { timeout: ARM_TIMEOUT },
  async (t) => {
    const posture = {
      experimentalApi: true,
      optOutNotificationMethods: ["item/delta"],
      userInputDialogs: true,
    };
    const client = await spawnOffering(t, ["userShell", "sessionMcp"], {
      ...posture,
      requestedCapabilities: ["userShell", "sessionMcp", "userShell"],
    });

    assert.deepEqual((await hostView(client)).capabilities, {
      ...posture,
      requestedCapabilities: ["userShell", "sessionMcp"],
    });
    assert.deepEqual(client.initializeResult.grantedCapabilities, ["userShell", "sessionMcp"]);
  },
);

test(
  "FR-79107-3: a default spawn on a host offering sessionMcp forwards config verbatim on start and resume",
  { timeout: ARM_TIMEOUT },
  async (t) => {
    const client = await spawnOffering(t, ["sessionMcp"]);
    assert.deepEqual((await hostView(client)).requested, ["sessionMcp"]);

    const started = await client.startSession({ workspaceRoot: "/w", config: CONFIG });
    assert.deepEqual(echoed(started.opening)["config"], CONFIG);

    const resumed = await client.resumeSession({ sessionId: "s-2", config: CONFIG });
    assert.deepEqual(echoed(resumed.opening)["config"], CONFIG);
  },
);

test(
  "FR-79107-3: a host that withholds sessionMcp gets no config naming servers; the client stays usable",
  { timeout: ARM_TIMEOUT },
  async (t) => {
    const client = await spawnOffering(t, []);

    for (const [method, open] of [
      ["session/start", () => client.startSession({ workspaceRoot: "/w", config: CONFIG })],
      ["session/resume", () => client.resumeSession({ sessionId: "s-2", config: CONFIG })],
    ] as const) {
      const error = await open().then(
        () => assert.fail("an ungranted config must be refused"),
        (caught: unknown) => caught,
      );
      assert.ok(error instanceof MuseCapabilityNotGrantedError, `got ${String(error)}`);
      assert.equal(error.capability, "sessionMcp");
      assert.equal(error.method, method);
    }
    assert.deepEqual(await receivedMethods(client), [], "neither refused open reached the wire");

    // Constitution XIII: only the config-bearing open is refused. The same
    // client opens without servers, and a config naming none needs no grant.
    const plain = await client.startSession({ workspaceRoot: "/w" });
    assert.equal("config" in echoed(plain.opening), false);
    const empty = await client.startSession({ workspaceRoot: "/w", config: { mcpServers: {} } });
    assert.deepEqual(echoed(empty.opening)["config"], { mcpServers: {} });
    assert.deepEqual(await receivedMethods(client), ["session/start", "session/start"]);
  },
);

test("FR-79107-3: the refusal names the method it refused", async () => {
  const transport = new FakeDuplex();
  const client = new MuseClient(new Connection(transport), { durability: { kind: "durable" } });

  // A client built around a caller's own connection has no handshake on
  // record, so it cannot show the grant and refuses the same way.
  const error = await client.resumeSession({ sessionId: "s-2", config: CONFIG }).then(
    () => assert.fail("a config with no grant on record must be refused"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof MuseCapabilityNotGrantedError, `got ${String(error)}`);
  assert.equal(error.method, "session/resume");
  assert.match(error.message, /sessionMcp/);
  await settleMicrotasks();
  assert.equal(transport.writes.length, 0);
});
