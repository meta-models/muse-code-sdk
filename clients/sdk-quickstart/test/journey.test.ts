/**
 * The clause-4 acceptance run: the whole journey, against a release-built
 * binary, asserted segment by segment.
 *
 * It runs in the PROVIDER-CONFIGURED mode — the harness's own loopback fake
 * first-party endpoint, no live provider and no API key — so every segment is
 * exercised for real. Since the #24410 clause-4 promotion no segment is
 * expect-blocked: all twelve are required.
 *
 * `MUSE_BIN` is REQUIRED. This test never skips itself: a skipped acceptance
 * artifact reads as proof and is not proof. Build the binary first:
 *
 *   cargo build --release -p tbh-cli --bin tbh
 *   MUSE_BIN=$PWD/target/release/tbh npm run journey:test --workspace @muse-code/sdk-quickstart
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { SEGMENT_IDS, runConfiguredJourney } from "../src/journey.js";
import { formatReport } from "../src/segments.js";
import type { ConfiguredJourneyResult } from "../src/journey.js";
import type { JourneyReport } from "../src/segments.js";

/**
 * The segments that must PASS today: all twelve, written out. Anything not on
 * this list would have to be expect-blocked on a named open issue, and pinning
 * the split here means a future change cannot quietly demote a required
 * segment back into the blocked set.
 */
const REQUIRED_TODAY = [
  "spawn",
  "handshake",
  "session-new",
  "session-effective-model",
  "turn",
  "approval",
  "cancel",
  "resume",
  "resume-effective-model",
  "resume-history",
  "resume-rejects-unknown-cursor",
  "terminate",
] as const;

function requiredBinary(): string {
  const configured = process.env["MUSE_BIN"];
  if (configured === undefined || configured.length === 0) {
    throw new Error(
      "MUSE_BIN is required and must point at a release-built binary.\n" +
        "  cargo build --release -p tbh-cli --bin tbh\n" +
        "  MUSE_BIN=$PWD/target/release/tbh npm run journey:test --workspace @muse-code/sdk-quickstart",
    );
  }
  return configured;
}

const museBin = requiredBinary();

let shared: Promise<ConfiguredJourneyResult> | undefined;
function configured(): Promise<ConfiguredJourneyResult> {
  // One process journey, many assertions: spawning the release host per
  // assertion would multiply a 300MB binary's startup by the segment count.
  shared ??= runConfiguredJourney({ museBin });
  return shared;
}

async function journey(): Promise<JourneyReport> {
  return (await configured()).report;
}

/**
 * The twelve ids, written out. NOT `[...SEGMENT_IDS]`: that is derived from the
 * same SEGMENTS array the journey iterates, so both sides of the comparison
 * move together and renaming or reordering a segment still passes. Literals are
 * the only form of this test that can fail (review round on PR #22835).
 */
const DOCUMENTED_ORDER = [
  "spawn",
  "handshake",
  "session-new",
  "session-effective-model",
  "turn",
  "approval",
  "cancel",
  "resume",
  "resume-effective-model",
  "resume-history",
  "resume-rejects-unknown-cursor",
  "terminate",
] as const;

test("the journey runs every segment in the documented order", { timeout: 600_000 }, async () => {
  const report = await journey();
  assert.deepEqual(report.segments.map((segment) => segment.id), [...DOCUMENTED_ORDER]);
  // The exported list is what README and the spec cite, so it must agree too.
  assert.deepEqual([...SEGMENT_IDS], [...DOCUMENTED_ORDER]);
});

test("every segment that is executable today passes", { timeout: 600_000 }, async () => {
  const report = await journey();
  for (const id of REQUIRED_TODAY) {
    const segment = report.segments.find((candidate) => candidate.id === id);
    assert.ok(segment !== undefined, `segment ${id} is missing from the journey`);
    assert.equal(
      segment.outcome,
      "passed",
      `segment ${id} must pass against a release-built host:\n${formatReport(report)}`,
    );
    assert.equal(segment.expectBlock, undefined, `segment ${id} must carry no expect-block`);
  }
});

test("no expect-block has gone stale", { timeout: 600_000 }, async () => {
  const report = await journey();
  const stale = report.segments.filter((segment) => segment.outcome === "unblocked");
  assert.deepEqual(
    stale.map((segment) => segment.id),
    [],
    `these segments now pass while still expect-blocked; delete their expectBlock:\n${formatReport(report)}`,
  );
});

test("no segment failed for a reason nothing predicted", { timeout: 600_000 }, async () => {
  const report = await journey();
  const unexplained = report.segments.filter((segment) => segment.outcome === "failed");
  assert.deepEqual(
    unexplained.map((segment) => segment.id),
    [],
    `unexplained failures:\n${formatReport(report)}`,
  );
});

test("every expect-blocked segment names at least one open issue", { timeout: 600_000 }, async () => {
  const report = await journey();
  for (const segment of report.segments) {
    if (segment.outcome !== "expectBlocked") continue;
    const block = segment.expectBlock;
    assert.ok(block !== undefined && block.issues.length > 0, `${segment.id} blocks on nothing`);
    assert.ok(block.because.length > 0, `${segment.id} does not say why it is blocked`);
    assert.ok(
      segment.failure !== undefined,
      `${segment.id} is expect-blocked but kept no failure evidence`,
    );
  }
});

test("the journey is green overall", { timeout: 600_000 }, async () => {
  const report = await journey();
  assert.equal(report.ok, true, formatReport(report));
});

/**
 * The provider-configured mode's own contract.
 *
 * `catalogGets` is the teeth on "configured": a HOME whose `endpoint_transport`
 * never reached the host fetches nothing, and this run would be the
 * credential-free one wearing the acceptance run's name.
 *
 * `scriptedToolCalls === 1` is the harness artifact the promotion measurement
 * turned up. After the `approval` segment's turn, its artifact name is in the
 * replayed history of every later turn, so a content-routed script with no
 * once-only guard hands the `cancel` segment a tool call too and parks it on an
 * approval nobody answers — `cancel` then fails on a 30s timeout. Serving the
 * script exactly once is what keeps `cancel` a cancel test.
 */
test("the provider-configured mode drives the host and scripts one tool call", { timeout: 600_000 }, async () => {
  const result = await configured();
  assert.ok(
    result.catalogGets >= 1,
    `the host never fetched the fake endpoint's model catalog, so no provider was configured:\n${formatReport(result.report)}`,
  );
  assert.equal(
    result.scriptedToolCalls,
    1,
    `the endpoint must serve the scripted tool call exactly once:\n${formatReport(result.report)}`,
  );
});
