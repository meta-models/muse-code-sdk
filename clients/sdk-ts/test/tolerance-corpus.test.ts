/**
 * TEST-008 `sdk_tolerance_fixtures_fold_losslessly` — spec 210 Scenario 6,
 * T040/T041. The runner discovers the permanent sdk-tolerance corpus rather
 * than copying its fixtures into this package.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { replayToleranceCorpus } from "./helpers/tolerance-corpus-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..", "..", "..", "..");

// The expected server-notification method sequence per scenario, pinned from
// the committed fixture transcripts — independent of the runner, so a runner
// that silently drops a notification fails here.
const expectedMethods: Record<string, readonly string[]> = {
  "tolerance-unknown-item-kind": [
    "session/started",
    "turn/started",
    "item/completed",
    "item/completed",
    "turn/completed",
  ],
  "tolerance-unknown-state-method": [
    "session/started",
    "session/auraChanged",
    "turn/started",
    "item/completed",
    "item/completed",
    "turn/completed",
  ],
  "tolerance-unknown-stream-kind": [
    "session/started",
    "turn/started",
    "item/completed",
    "item/completed",
    "turn/completed",
  ],
};

test("sdk_tolerance_fixtures_fold_losslessly (TEST-008)", () => {
  const runs = replayToleranceCorpus(projectRoot);
  assert.deepEqual(
    runs.map((run) => run.scenario),
    [
      "tolerance-unknown-item-kind",
      "tolerance-unknown-state-method",
      "tolerance-unknown-stream-kind",
    ],
    "the runner must discover the entire committed sdk-tolerance corpus",
  );

  for (const run of runs) {
    assert.equal(run.provenance, "sdk-tolerance");
    assert.deepEqual(
      run.notifications.map((notification) => notification.method),
      expectedMethods[run.scenario],
      `${run.scenario}: no server notification may crash or disappear`,
    );
  }

  const unknownItem = runs.find((run) => run.scenario === "tolerance-unknown-item-kind");
  assert.ok(unknownItem !== undefined);
  const hologram = unknownItem.items.find((item) => item.kind === "hologramPreview");
  assert.ok(hologram !== undefined, "the unknown item kind must survive the SDK fold");
  assert.equal(hologram.status, "completed");
  assert.equal(hologram.fallbackText, "Rendered a hologram preview of the workspace");
  assert.deepEqual(
    (hologram as unknown as Record<string, unknown>)["sceneGraph"],
    { nodes: 3, palette: "amber" },
    "members unknown to the SDK must survive losslessly, value intact",
  );

  const unknownState = runs.find(
    (run) => run.scenario === "tolerance-unknown-state-method",
  );
  assert.ok(unknownState !== undefined);
  const auraIndex = unknownState.notifications.findIndex(
    (event) => event.method === "session/auraChanged",
  );
  const completedIndex = unknownState.notifications.findIndex(
    (event) => event.method === "turn/completed",
  );
  assert.ok(auraIndex >= 0, "the unknown state notification remains observable");
  assert.ok(completedIndex > auraIndex, "known events after the unknown method must still fold");
  assert.ok(
    unknownState.items.some(
      (item) => item.kind === "agentMessage" && item.text === "Done.",
    ),
    "the known item after the unknown state method must survive",
  );

  const unknownStream = runs.find(
    (run) => run.scenario === "tolerance-unknown-stream-kind",
  );
  assert.ok(unknownStream !== undefined);
  const vendorEvent = unknownStream.notifications.find((event) => {
    const sourceRange = event.params?.["sourceRange"] as
      | { readonly stream?: { readonly kind?: string } }
      | undefined;
    return sourceRange?.stream?.kind === "vendor.audit";
  });
  assert.ok(vendorEvent !== undefined, "the open stream kind must survive losslessly");
  assert.ok(
    unknownStream.items.some(
      (item) =>
        item.kind === "agentMessage" && item.text === "Vendor audit provenance preserved.",
    ),
    "the known item sourced by the unknown stream must not be dropped",
  );
  assert.ok(
    unknownStream.notifications.some((event) => event.method === "turn/completed"),
    "the known terminal after the unknown stream must survive",
  );
});
