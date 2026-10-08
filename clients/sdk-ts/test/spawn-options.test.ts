/**
 * Spawn-options pin: a spawned `muse serve` is never meant to be seen, so
 * the SDK hides its console window itself (#45141, FR-45141-1).
 *
 * `windowsHide` is observable only on Windows (and only by the absence of a
 * console window), so the helper tests pin the exact options object through
 * the module-only `buildSpawnOptions` seam (the same module-only-test-seam
 * precedent as `isBenignCloseRace`), and the wiring test observes the
 * options `MuseServeChild.spawn` actually passes through a `spawnFn` stub —
 * a `windowsHide` override at the call site fails the pin.
 */

import { EventEmitter } from "node:events";
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptions,
  spawn,
} from "node:child_process";

import { MuseServeChild, buildSpawnOptions } from "../src/connection/spawn.js";

test("spawned hosts hide their console window on Windows (#45141)", () => {
  const options = buildSpawnOptions({ detached: false });
  assert.equal(
    options.windowsHide,
    true,
    "muse serve must never pop a console window on a GUI embedding (#45141)",
  );
});

test("spawn options still carry cwd, env, and detached through (#45141)", () => {
  const env = { PATH: "/bin" };
  const options = buildSpawnOptions({ cwd: "/workspace", env, detached: true });
  assert.equal(options.cwd, "/workspace");
  assert.equal(options.env, env);
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, true);
});

/** A spawned-nothing child: the wiring stub below never starts a process. */
function fakeChild(): ChildProcessWithoutNullStreams {
  const withEncoding = (): EventEmitter & { setEncoding: (encoding: string) => void } => {
    const stream = new EventEmitter() as EventEmitter & {
      setEncoding: (encoding: string) => void;
    };
    stream.setEncoding = () => {};
    return stream;
  };
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter;
  };
  child.stdout = withEncoding();
  child.stderr = withEncoding();
  child.stdin = new EventEmitter();
  return child as unknown as ChildProcessWithoutNullStreams;
}

test("MuseServeChild.spawn hands windowsHide through to the spawn call (#45141)", () => {
  const seen: Array<{ cmd: string; args: readonly string[]; options: SpawnOptions }> = [];
  const child = MuseServeChild.spawn({
    museBin: "muse-serve",
    args: ["--stdio"],
    spawnFn: ((cmd: string, args: readonly string[], options: SpawnOptions) => {
      seen.push({ cmd, args: [...args], options });
      return fakeChild();
    }) as unknown as typeof spawn,
  });
  assert.ok(child instanceof MuseServeChild);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.cmd, "muse-serve");
  assert.deepEqual(seen[0]?.args, ["--stdio"]);
  assert.equal(
    seen[0]?.options.windowsHide,
    true,
    "a call-site windowsHide override must fail this pin, not slip past the helper pin (#45141)",
  );
});
