/**
 * FR-100032-3/4 — `Connection` and `MuseClient.command`/`request` are typed
 * from the generated stable method → type maps (loosely typed params for a
 * listed method resolve to a deprecated untyped overload for one release),
 * and notification listeners get typed params.
 *
 * Half of this file is checked by the compiler, not at run time: each
 * `@ts-expect-error` line fails the BUILD if the call it marks starts to
 * typecheck, so a typing that loosens to `Record<string, unknown>` cannot
 * pass. The runtime arms prove the wire behaviour under the new types.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import type {
  ModelListResult,
  Notification,
  TaskCommandResult,
  TurnCompletedParams,
  UsageReadResult,
} from "@muse-code/msp";

import type { MethodName, UnlistedMethod } from "../src/connection/surface.js";
import { Connection, MuseClient, ProtocolError } from "../src/index.js";
import type { MuseClientOptions } from "../src/index.js";
import {
  answer,
  FakeDuplex,
  frame,
  sentFrame,
  sentParams,
  settleMicrotasks,
  waitForWrites,
} from "./helpers/fake-duplex.js";

const DURABLE: MuseClientOptions = { durability: { kind: "durable" } };

/** Compiles only when `A` and `B` are the same type. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function assertType<_T extends true>(): void {}

/**
 * Type-only arms: never called, so nothing is written to a transport. The
 * compiler checks every line, including the `@ts-expect-error` ones.
 */
function typeArms(stable: Connection): void {
  // A known method's result comes from the map.
  const listed = stable.request("model/list", { sessionId: "s-1" });
  assertType<Equal<typeof listed, Promise<ModelListResult & Record<string, unknown>>>>();
  // A params-less method takes none; an all-optional one may omit them. Both
  // resolve to the typed overload, not the deprecated loose one.
  const usage = stable.request("usage/read");
  assertType<Equal<typeof usage, Promise<UsageReadResult & Record<string, unknown>>>>();
  const allOptional = stable.request("model/list");
  assertType<Equal<typeof allOptional, Promise<ModelListResult & Record<string, unknown>>>>();
  // Params that do not match a listed method's type resolve to the deprecated
  // loose overload for one release (ADR 25304 D3): untyped, never typed.
  const bogus = stable.request("model/list", { bogus: 1 });
  assertType<Equal<typeof bogus, Promise<Record<string, unknown>>>>();
  // An explicit type argument rules out the untyped fallback, so these fail
  // to compile only if that fallback ever accepts a listed method.
  // @ts-expect-error -- a listed method never takes the untyped fallback
  void stable.request<"model/list">("model/list", { bogus: 1 });
  // @ts-expect-error -- same for command
  void stable.command<"task/stop">("task/stop", { sessionId: "s-1" });
  const missing = stable.request("task/list");
  assertType<Equal<typeof missing, Promise<Record<string, unknown>>>>();
  const extra = stable.request("usage/read", { sessionId: "s-1" });
  assertType<Equal<typeof extra, Promise<Record<string, unknown>>>>();
  // A method the surface does not name stays sendable, untyped.
  const unlisted = stable.request("vendor/custom", { anything: true });
  assertType<Equal<typeof unlisted, Promise<Record<string, unknown>>>>();
  // Only the non-deprecated unlisted overload takes a type argument here, so
  // this fails if an unlisted name ever falls through to the catch-all.
  const unlistedExplicit = stable.request<"vendor/custom">("vendor/custom", { anything: true });
  assertType<Equal<typeof unlistedExplicit, Promise<Record<string, unknown>>>>();
  // A plain `string` stays untyped and is not routed to the deprecated fallback.
  assertType<Equal<UnlistedMethod<MethodName, string>, string>>();

  // A non-literal method still compiles, untyped, through a deprecated
  // fallback (it cannot be checked), as it did before these types.
  const generic = <M extends string>(method: M) => stable.request(method, {});
  assertType<Equal<ReturnType<typeof generic>, Promise<Record<string, unknown>>>>();
  const genericCommand = <M extends string>(method: M) => stable.command(method, {});
  assertType<Equal<ReturnType<typeof genericCommand>, Promise<Record<string, unknown>>>>();
  const mixed = (cond: boolean) => stable.request(cond ? "task/stop" : "vendor/x", {});
  assertType<Equal<ReturnType<typeof mixed>, Promise<Record<string, unknown>>>>();

  // `command` leaves `commandId` out: the connection mints it.
  const stopped = stable.command("task/stop", { sessionId: "s-1", taskId: "t-1" });
  assertType<Equal<typeof stopped, Promise<TaskCommandResult & Record<string, unknown>>>>();
  const looseStop = stable.command("task/stop", { sessionId: "s-1" });
  assertType<Equal<typeof looseStop, Promise<Record<string, unknown>>>>();

  const untypedCommand = stable.command("vendor/echo", { text: "hi" });
  assertType<Equal<typeof untypedCommand, Promise<Record<string, unknown>>>>();

  // Notification listeners get the method's params type.
  stable.addNotificationListener("turn/completed", (params, notification) => {
    assertType<Equal<typeof params, TurnCompletedParams>>();
    assertType<Equal<typeof notification, Notification>>();
  });
  // @ts-expect-error -- not a notification the stable surface names
  stable.addNotificationListener("vendor/pinged", () => undefined);
}

function clientTypeArms(stable: MuseClient): void {
  const stopped = stable.command("task/stop", { sessionId: "s-1", taskId: "t-1" });
  assertType<Equal<typeof stopped, Promise<TaskCommandResult & Record<string, unknown>>>>();
  // Params that would otherwise type-check, so the refusal is the only error.
  // @ts-expect-error -- the facade owns `turn/start`
  void stable.command("turn/start", { sessionId: "s-1", input: [] });
  // @ts-expect-error -- the facade owns `turn/start`, on `request` too
  void stable.request("turn/start", { sessionId: "s-1", input: [], commandId: "c-1" });
  const looseStop = stable.command("task/stop", { sessionId: "s-1" });
  assertType<Equal<typeof looseStop, Promise<Record<string, unknown>>>>();
  // A non-literal method compiles untyped through the deprecated fallback,
  // which still refuses a facade-owned member.
  const mixed = (cond: boolean) => stable.request(cond ? "model/list" : "vendor/x", {});
  assertType<Equal<ReturnType<typeof mixed>, Promise<Record<string, unknown>>>>();
  const mixedCommand = (cond: boolean) => stable.command(cond ? "task/stop" : "vendor/x", {});
  assertType<Equal<ReturnType<typeof mixedCommand>, Promise<Record<string, unknown>>>>();
  // MuseClient's fallback is generic, so pin the unlisted helper directly.
  assertType<Equal<UnlistedMethod<MethodName, "vendor/echo">, "vendor/echo">>();
  // @ts-expect-error -- a generic name cannot be checked against the facade-owned set; widen it to `string`
  void (<M extends string>(m: M) => stable.request(m, {}));
  const widened = <M extends string>(m: M) => stable.request(m as string, {});
  assertType<Equal<ReturnType<typeof widened>, Promise<Record<string, unknown>>>>();
  // @ts-expect-error -- a union with a facade-owned member is still refused
  void ((cond: boolean) => stable.command(cond ? "turn/start" : "vendor/x", {}));
  // A method the surface does not list goes through untyped.
  const untyped = stable.command("vendor/echo", { text: "hi" });
  assertType<Equal<typeof untyped, Promise<Record<string, unknown>>>>();

  // `request` is typed the same way, with the same refusal and fallback.
  const listed = stable.request("model/list");
  assertType<Equal<typeof listed, Promise<ModelListResult & Record<string, unknown>>>>();
  const bogus = stable.request("model/list", { bogus: 1 });
  assertType<Equal<typeof bogus, Promise<Record<string, unknown>>>>();
  // @ts-expect-error -- the facade owns `view/page`
  void stable.request("view/page", { sessionId: "s-1", limit: 1 });
}
void typeArms;
void clientTypeArms;

test("FR-100032-3: a typed request sends the same frame and resolves with the result", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);

  const pending = connection.request("model/list", { sessionId: "s-1" });
  await waitForWrites(transport, 1);
  assert.equal(sentFrame(transport, 0)["method"], "model/list");
  assert.deepEqual(sentParams(transport, 0), { sessionId: "s-1" });
  answer(transport, 0, { models: [] });

  const result = await pending;
  assert.deepEqual(result.models, []);
});

test("FR-100032-3: a typed client command mints and stamps commandId like any other", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport, { mintCommandId: () => "mint-0" });
  const client = new MuseClient(connection, DURABLE);

  const pending = client.command("task/stop", { sessionId: "s-1", taskId: "t-1" });
  await waitForWrites(transport, 1);
  assert.equal(sentFrame(transport, 0)["method"], "task/stop");
  assert.deepEqual(sentParams(transport, 0), { sessionId: "s-1", taskId: "t-1", commandId: "mint-0" });
  answer(transport, 0, { commandId: "mint-0", status: "accepted", taskId: "t-1" });

  assert.equal((await pending).taskId, "t-1");
});

test("FR-100032-4: a notification listener gets its method's params after the raw handler", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const order: string[] = [];
  const received: unknown[] = [];
  connection.onNotification((notification) => order.push(`handler:${notification.method}`));
  connection.addNotificationListener("turn/completed", (params, notification) => {
    order.push(`listener:${notification.method}`);
    received.push(params);
  });
  connection.addNotificationListener("turn/completed", (_params, notification) => {
    order.push(`listener2:${notification.method}`);
  });

  const params = { sessionId: "s-1", turnId: "t-1", terminal: "completed" };
  transport.chunks.push(frame({ jsonrpc: "2.0", method: "turn/completed", params }));
  transport.chunks.push(frame({ jsonrpc: "2.0", method: "turn/started", params: { sessionId: "s-1" } }));
  await settleMicrotasks();

  assert.deepEqual(order, [
    "handler:turn/completed",
    "listener:turn/completed",
    "listener2:turn/completed",
    "handler:turn/started",
  ]);
  assert.deepEqual(received, [params], "a listener hears only its own method");
});

test("FR-100032-4: removing a listener stops it, and one added during dispatch waits for the next frame", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const heard: string[] = [];
  const removeFirst = connection.addNotificationListener("turn/completed", () => {
    heard.push("first");
    removeFirst();
    connection.addNotificationListener("turn/completed", () => heard.push("added"));
  });

  const completed = frame({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s-1" } });
  transport.chunks.push(completed);
  transport.chunks.push(completed);
  await settleMicrotasks();

  assert.deepEqual(heard, ["first", "added"]);
});

test("FR-100032-4: a throwing listener is reported and keeps the connection, its other listeners and pending calls", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const reported: ProtocolError[] = [];
  connection.onProtocolError((error) => reported.push(error));
  const heard: string[] = [];
  connection.addNotificationListener("turn/completed", () => {
    throw new Error("listener bug");
  });
  connection.addNotificationListener("turn/completed", () => heard.push("second"));

  const pending = connection.request("model/list");
  await waitForWrites(transport, 1);
  transport.chunks.push(frame({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s-1" } }));
  await settleMicrotasks();
  answer(transport, 0, { models: [] });

  assert.deepEqual((await pending).models, [], "a pending call still resolves");
  assert.deepEqual(heard, ["second"], "the next listener still runs");
  assert.equal(reported.length, 1);
  assert.match(reported[0]?.message ?? "", /listener for turn\/completed threw: Error: listener bug/);
  assert.ok(reported[0]?.cause instanceof Error, "the listener's own error rides as cause");
  assert.equal((reported[0]?.cause as Error).message, "listener bug");
});

test("FR-100032-4: a listener that throws a value with no string form, or rejects, is still only reported", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const reported: ProtocolError[] = [];
  connection.onProtocolError((error) => reported.push(error));
  const unprintable: unknown = Object.create(null);
  connection.addNotificationListener("turn/completed", () => {
    throw unprintable;
  });
  connection.addNotificationListener("turn/completed", async () => {
    throw new Error("async listener bug");
  });

  const pending = connection.request("model/list");
  await waitForWrites(transport, 1);
  transport.chunks.push(frame({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s-1" } }));
  await settleMicrotasks();
  answer(transport, 0, { models: [] });

  assert.deepEqual((await pending).models, [], "a pending call still resolves");
  assert.equal(reported.length, 2);
  assert.equal(reported[0]?.cause, unprintable);
  assert.match(reported[1]?.message ?? "", /listener for turn\/completed threw: Error: async listener bug/);
});

test("FR-100032-4: with no onProtocolError handler, a throwing listener becomes a process warning", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const warnings: Error[] = [];
  const onWarning = (warning: Error): void => {
    warnings.push(warning);
  };
  process.on("warning", onWarning);
  try {
    connection.addNotificationListener("turn/completed", () => {
      throw new Error("unobserved listener bug");
    });
    transport.chunks.push(frame({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s-1" } }));
    await settleMicrotasks();
    // `process.emitWarning` delivers on the next tick.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    process.off("warning", onWarning);
  }
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0] instanceof ProtocolError);
  assert.equal((warnings[0]?.cause as Error).message, "unobserved listener bug");
});

/** The emitted declarations, which is what editors read for `@deprecated`. */
function emitted(relative: string): string {
  const distTest = dirname(fileURLToPath(import.meta.url));
  return readFileSync(join(distTest, "..", "src", relative), "utf8");
}

test("FR-100032-3: every loose overload ships marked @deprecated (the D3 deprecation window)", () => {
  const deprecatedBefore = (source: string, signature: string): boolean => {
    const at = source.indexOf(signature);
    if (at < 0) return false;
    const docEnd = source.lastIndexOf("*/", at);
    const docStart = source.lastIndexOf("/**", docEnd);
    return docStart >= 0 && source.slice(docStart, docEnd).includes("@deprecated") &&
      source.slice(docEnd + 2, at).trim() === "";
  };
  const connection = emitted("connection/connection.d.ts");
  const client = emitted("facade/client.d.ts");
  for (const [source, signature] of [
    [connection, "request(method: MethodName, params?: Record<string, unknown>)"],
    [connection, "command(method: MethodName, params: Record<string, unknown>, options?: CommandOptions)"],
    [client, "request(method: RawMethodName, params?: Record<string, unknown>)"],
    [client, "command(method: RawMethodName, params: Record<string, unknown>, options?: CommandOptions)"],
    // The non-literal fallbacks are loose too.
    [connection, "request(method: string, params?: Record<string, unknown>)"],
    [connection, "command(method: string, params: Record<string, unknown>, options?: CommandOptions)"],
    [client, "request<M extends string>(method: NotFacadeOwned<M>, params?: Record<string, unknown>)"],
    [client, "command<M extends string>(method: NotFacadeOwned<M>, params: Record<string, unknown>, options?: CommandOptions)"],
  ] as const) {
    assert.ok(deprecatedBefore(source, signature), `${signature} must ship with an @deprecated doc`);
  }
});

test("FR-100032-4: an async listener from another realm that rejects is reported, not left unhandled", async () => {
  const transport = new FakeDuplex();
  const connection = new Connection(transport);
  const reported: ProtocolError[] = [];
  connection.onProtocolError((error) => reported.push(error));
  // A promise from a `vm` context fails `instanceof Promise` in this realm.
  const foreign = runInNewContext("(async () => { throw new Error('foreign realm bug'); })") as () => Promise<void>;
  connection.addNotificationListener("turn/completed", () => foreign());

  transport.chunks.push(frame({ jsonrpc: "2.0", method: "turn/completed", params: { sessionId: "s-1" } }));
  await settleMicrotasks();

  assert.equal(reported.length, 1);
  assert.match(reported[0]?.message ?? "", /foreign realm bug/);
});
