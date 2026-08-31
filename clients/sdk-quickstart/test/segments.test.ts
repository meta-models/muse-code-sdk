/**
 * The expect-block contract, proven without a binary.
 *
 * These are the deterministic half of the journey's own can-it-fail proof:
 * they drive every arm of `classify` directly, including the two that must
 * never be reachable by accident — a blocked segment that starts passing, and
 * a blocked segment failing for a reason its block does not name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { classify, formatReport, runSegment, summarize } from "../src/segments.js";
import type { ExpectBlock, Segment } from "../src/segments.js";

const BLOCK: ExpectBlock = {
  issues: [19535],
  because: "the serve host cannot run a turn",
  signature: /not logged in/,
};

test("an unblocked segment passes when it asserts clean and fails when it throws", () => {
  assert.equal(classify(undefined, undefined), "passed");
  assert.equal(classify(undefined, "boom"), "failed");
});

test("a block excuses only the failure it names", () => {
  assert.equal(classify(BLOCK, "turn failed: not logged in: run /login"), "expectBlocked");
  assert.equal(classify(BLOCK, "connection reset by peer"), "failed");
});

test("a blocked segment that starts passing is fatal, not silently green", () => {
  assert.equal(classify(BLOCK, undefined), "unblocked");
  const report = summarize([
    {
      id: "turn",
      title: "t",
      outcome: classify(BLOCK, undefined),
      durationMs: 1,
      expectBlock: BLOCK,
      failure: undefined,
    },
  ]);
  assert.equal(report.ok, false, "an unblocked segment must red the journey");
  assert.match(formatReport(report), /EXPECT-BLOCK IS STALE/);
  assert.match(formatReport(report), /#19535/);
});

test("an expect-blocked journey is green and names its blockers", () => {
  const report = summarize([
    {
      id: "spawn",
      title: "spawn",
      outcome: "passed",
      durationMs: 1,
      expectBlock: undefined,
      failure: undefined,
    },
    {
      id: "turn",
      title: "turn",
      outcome: "expectBlocked",
      durationMs: 2,
      expectBlock: BLOCK,
      failure: "not logged in: run /login",
    },
  ]);
  assert.equal(report.ok, true);
  const text = formatReport(report);
  assert.match(text, /expect-blocked on #19535/);
  assert.match(text, /observed: not logged in/, "the real failure text is never discarded");
  assert.match(text, /journey OK \(passed=1 expectBlocked=1 unblocked=0 failed=0\)/);
});

test("an off-signature failure inside a blocked segment says so out loud", () => {
  const report = summarize([
    {
      id: "turn",
      title: "turn",
      outcome: classify(BLOCK, "EACCES: permission denied"),
      durationMs: 3,
      expectBlock: BLOCK,
      failure: "EACCES: permission denied",
    },
  ]);
  assert.equal(report.ok, false);
  assert.match(formatReport(report), /does NOT match the expect-block signature/);
});

test("runSegment keeps the thrown message and its cause", async () => {
  const segment: Segment<null> = {
    id: "probe",
    title: "probe",
    run: () =>
      Promise.reject(new Error("outer", { cause: new Error("inner detail") })),
  };
  let clock = 0;
  const result = await runSegment(segment, null, () => (clock += 5));
  assert.equal(result.outcome, "failed");
  assert.equal(result.durationMs, 5);
  assert.match(result.failure ?? "", /outer/);
  assert.match(result.failure ?? "", /inner detail/);
});

/**
 * FR-21932-4's refusal arm, exercised for real.
 *
 * Nothing ran it before: CI always sets `MUSE_BIN`, and the acceptance file
 * cannot test its own module-load failure. So an edit softening that throw into
 * a skip — the exact violation FR-21932-4 exists to stop — stayed green everywhere.
 * This spawns the acceptance file in a child with `MUSE_BIN` removed and
 * requires a nonzero exit that names the build command (review round, #22835).
 */
test("the acceptance run refuses to skip itself when MUSE_BIN is absent", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");

  const here = dirname(fileURLToPath(import.meta.url));
  const acceptance = join(here, "journey.test.js");
  const env = { ...process.env };
  delete env["MUSE_BIN"];
  // Node's test runner marks its children with NODE_TEST_CONTEXT, and a child
  // that sees it reports over the runner protocol instead of through its exit
  // code — it exits 0 even when the file fails. Strip it so this measures what
  // a person at a shell actually gets. (Verified: with it set, exit 0; without,
  // exit 1.)
  delete env["NODE_TEST_CONTEXT"];

  // Pin the reporter. A piped child picks its own by default, so the summary
  // shape this asserts on would otherwise depend on whether stdout is a TTY.
  const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", acceptance], {
    env,
    encoding: "utf8",
    timeout: 120_000,
  });

  assert.notEqual(run.status, 0, "a missing MUSE_BIN must fail, never skip");
  const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.match(output, /MUSE_BIN is required/);
  assert.match(output, /cargo build --release -p tbh-cli --bin tbh/);
  // The printed rerun command must be the one that actually runs the journey.
  assert.match(output, /npm run journey:test --workspace @muse-code\/sdk-quickstart/);
  // Assert the COUNT, not the substring `# skip`: TAP always prints a
  // `# skipped N` summary line, so a substring test matches the healthy
  // `# skipped 0` and reds a run that failed for exactly the right reason.
  assert.match(output, /^# skipped 0$/m, `the acceptance run skipped instead of failing:\n${output}`);
});

/**
 * FR-21932-5's drift guard, in both directions (review round #22835; the
 * conditional contract is #25591).
 *
 * The README discloses blocked steps IF AND ONLY IF the journey carries an
 * `expectBlock`. With none there is nothing to disclose and the section must be
 * ABSENT: a heading that promises a list of gaps and delivers the word
 * "nothing" is scaffolding, not disclosure. With one or more, the section must
 * be present and its table must mirror them exactly.
 *
 * Both directions rot on their happiest day, which is why both are asserted.
 * The one edit a landing fix requires is deleting the segment's `expectBlock`,
 * after which every test is green and the README still calls the step broken.
 * A block that RETURNS leaves the journey green — expect-blocked is a pass —
 * while the README says nothing is wrong. Nothing else reads the README.
 */
const BLOCKED_HEADING = "## What does not work yet";

interface Block {
  readonly id: string;
  readonly issues: readonly number[];
}

/**
 * Hold `doc` to the conditional contract for `blocks`, throwing on violation.
 *
 * Split out from the arms below so both directions run against synthetic
 * documents. Today's journey carries no block, so the mirroring direction is
 * unreachable from the real README alone — asserting it only there would ship
 * an arm that cannot fail.
 */
function assertBlockedDisclosure(doc: string, blocks: readonly Block[]): void {
  const parts = doc.split(BLOCKED_HEADING);
  assert.ok(parts.length <= 2, `"${BLOCKED_HEADING}" appears more than once`);
  const present = parts.length === 2;

  if (blocks.length === 0) {
    assert.equal(
      present,
      false,
      `no step carries an expectBlock, so "${BLOCKED_HEADING}" must be absent — an essentially ` +
        `empty section is scaffolding, not disclosure. Delete it.`,
    );
    return;
  }

  assert.ok(
    present,
    `${blocks.map((block) => block.id).join(", ")} carry an expectBlock, so the README must have ` +
      `a "${BLOCKED_HEADING}" section with one row per block`,
  );
  // Stop at the next heading: later sections carry their own tables (the file
  // layout one), and an unbounded split swallows their rows too.
  const section = (parts[1] as string).split(/^## /m)[0] as string;

  // Rows look like: | `step-id` | #123, #456 | prose |
  const rows = section
    .split("\n")
    .map((line) => /^\|\s*`([^`]+)`\s*\|([^|]*)\|/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      id: match[1] as string,
      issues: [...(match[2] as string).matchAll(/#(\d+)/g)].map((hit) => Number(hit[1])),
    }));

  assert.deepEqual(
    rows,
    blocks.map((block) => ({ id: block.id, issues: [...block.issues] })),
    "README table and journey expect-blocks disagree — a block was added, removed, or re-issued " +
      "without updating the other side",
  );
}

test("with nothing expect-blocked the README must not carry the section at all", () => {
  assert.throws(
    () => assertBlockedDisclosure(`# doc\n\n${BLOCKED_HEADING}\n\nNothing.\n\n## Next\n`, []),
    /must be absent/,
  );
  assertBlockedDisclosure("# doc\n\n## Next\n", []);
});

test("with a step expect-blocked the README must carry a row that mirrors it", () => {
  const block: Block = { id: "turn", issues: [19535, 18945] };
  assert.throws(() => assertBlockedDisclosure("# doc\n\n## Next\n", [block]), /must have/);

  const mirrored =
    `# doc\n\n${BLOCKED_HEADING}\n\n` +
    "| step | issues | why |\n| --- | --- | --- |\n" +
    "| `turn` | #19535, #18945 | the host cannot run a turn |\n\n" +
    // A later section's table must not be read as a blocked row.
    "## Where things live\n\n| `src/journey.ts` | #1 | not a block |\n";
  assertBlockedDisclosure(mirrored, [block]);

  assert.throws(
    () => assertBlockedDisclosure(mirrored.replace("#18945", "#18946"), [block]),
    /disagree/,
  );
});

test("the README's blocked disclosure matches the journey's expect-blocks", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { dirname, join } = await import("node:path");
  const { EXPECT_BLOCKED } = await import("../src/journey.js");

  const here = dirname(fileURLToPath(import.meta.url));
  const readme = await readFile(join(here, "..", "..", "README.md"), "utf8");

  assertBlockedDisclosure(readme, EXPECT_BLOCKED);
});
