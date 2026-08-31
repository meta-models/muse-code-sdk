/**
 * TEST-013 / #210 T064: replay the two owner-ratified SS4.13 fixtures
 * through the existing transport-less PendingCommand fold.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { PendingCommandSet } from "../src/index.js";
import type { PendingRetirement } from "../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..", "..");

interface TranscriptLine {
  readonly dir: "client" | "server";
  readonly raw: string;
}

type Frame = Record<string, unknown>;

interface ReplayResult {
  readonly anchorAtAck: string | null;
  readonly anchorBeforeRetirement: string | null;
  readonly queueMovementDemands: readonly string[];
  readonly retirement: PendingRetirement<string>;
  readonly ownTurnStarted: boolean;
  readonly ownTurnFailedLaunch: boolean;
}

function object(value: unknown): Frame {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Frame;
}

function string(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function readFrames(scenario: string): readonly { dir: TranscriptLine["dir"]; frame: Frame }[] {
  const path = join(projectRoot, "schema", "msp", "transcripts", scenario, "transcript.ndjson");
  return readFileSync(path, "utf8")
    .trimEnd()
    .split("\n")
    .map((text) => JSON.parse(text) as TranscriptLine)
    .map((line) => ({ dir: line.dir, frame: JSON.parse(line.raw) as Frame }));
}

function replayPendingScenario(scenario: string): ReplayResult {
  const frames = readFrames(scenario);
  const queuedAck = frames.find(({ frame }) => {
    const result = frame["result"];
    return result !== undefined && object(result)["disposition"] === "queued";
  });
  assert.ok(queuedAck !== undefined, `${scenario}: queued ack`);
  const ack = object(queuedAck.frame["result"]);
  const commandId = string(ack["commandId"]);
  const turnId = string(ack["turnId"]);
  const set = new PendingCommandSet<string>();
  const queueMovementDemands: string[] = [];
  let lastItemId: string | null = null;
  let anchorAtAck: string | null = null;
  let anchorBeforeRetirement: string | null = null;
  let retirement: PendingRetirement<string> | undefined;
  let ownTurnStarted = false;
  let ownTurnFailedLaunch = false;

  for (const { dir, frame } of frames) {
    if (dir === "client" && frame["method"] === "turn/start") {
      const params = object(frame["params"]);
      if (params["commandId"] === commandId) {
        const input = object((params["input"] as readonly unknown[])[0]);
        set.submitted({ commandId, input: string(input["text"]), anchorAfterItemId: lastItemId });
      }
      continue;
    }
    if (dir !== "server") continue;

    if (frame["result"] !== undefined && frame["id"] !== undefined) {
      const result = object(frame["result"]);
      if (result["commandId"] === commandId) {
        const answer = {
          turnId: string(result["turnId"]),
          disposition: string(result["disposition"]),
        };
        if (set.get(commandId)?.ack === undefined) {
          set.acked(commandId, answer);
          anchorAtAck = set.get(commandId)?.anchorAfterItemId ?? null;
        } else {
          set.replayAnswered(commandId, { kind: "ack", ack: answer });
        }
      }
      continue;
    }
    if (frame["error"] !== undefined) {
      const error = object(frame["error"]);
      const data = object(error["data"]);
      if (data["commandId"] === commandId) {
        anchorBeforeRetirement = set.get(commandId)?.anchorAfterItemId ?? null;
        const outcome = set.replayAnswered(commandId, {
          kind: "error",
          error: {
            code: Number(error["code"]),
            kind: string(data["kind"]) as "commandRejected",
            reason: string(data["reason"]),
          },
        });
        if (outcome === "held") assert.fail(`${scenario}: durable rejection must retire`);
        retirement = outcome;
      }
      continue;
    }

    const method = frame["method"];
    const params = frame["params"] === undefined ? undefined : object(frame["params"]);
    if (params === undefined) continue;
    if (method === "turn/started" || method === "turn/completed") {
      const eventTurnId = string(params["turnId"]);
      if (eventTurnId === turnId) {
        ownTurnStarted ||= method === "turn/started";
        if (method === "turn/completed" && params["terminal"] === "failed") {
          const error = object(params["error"]);
          ownTurnFailedLaunch = error["kind"] === "launchError";
        }
      }
      queueMovementDemands.push(...set.observedQueueMovement(eventTurnId));
      continue;
    }
    if (method === "item/started" || method === "item/updated" || method === "item/completed") {
      const item = object(params["item"]);
      const itemId = string(item["itemId"]);
      if (item["kind"] === "userMessage" && item["commandId"] === commandId) {
        anchorBeforeRetirement = set.get(commandId)?.anchorAfterItemId ?? null;
        retirement = set.observedUserMessage(commandId, itemId);
      }
      lastItemId = itemId;
    }
  }

  assert.ok(retirement !== undefined, `${scenario}: fixture retires its PendingCommand`);
  return {
    anchorAtAck,
    anchorBeforeRetirement,
    queueMovementDemands,
    retirement,
    ownTurnStarted,
    ownTurnFailedLaunch,
  };
}

test("pending-command corpus folds ack -> launch with a fixed anchor and commandId retirement", () => {
  const run = replayPendingScenario("pending-command-ack-launch");
  assert.equal(
    run.anchorAtAck,
    "0198f032-0001-7000-8000-000000000101",
    "the pending entry anchors after the last item folded before the queued submit",
  );
  assert.equal(run.anchorBeforeRetirement, run.anchorAtAck, "later running items never float the entry");
  assert.equal(run.ownTurnStarted, true);
  assert.equal(run.retirement.kind, "materialized");
  assert.equal(run.retirement.commandId, "018f6a32-2222-7000-8000-0000000000b2");
});

test("pending-command corpus folds ack -> deferred_start_failed as rejected", () => {
  const run = replayPendingScenario("pending-command-ack-reject");
  assert.ok(run.queueMovementDemands.includes("018f6a32-3333-7000-8000-0000000000c3"));
  assert.equal(run.ownTurnStarted, false, "the rejected queued turn never starts");
  assert.equal(run.ownTurnFailedLaunch, true, "the pre-minted turn gets the launchError terminal");
  assert.deepEqual(run.retirement, {
    kind: "rejected",
    commandId: "018f6a32-3333-7000-8000-0000000000c3",
    reason: "deferred_start_failed",
    input: "Run the queued deployment checks",
    restoreToComposer: true,
  });
});
