/**
 * Segment results and the expect-block contract.
 *
 * The journey runs every segment for real. A segment that today cannot pass
 * because of a named open issue carries an `expectBlock`. The block never
 * weakens the assertion and never stubs the segment out: the segment still
 * runs, still asserts the spec-correct behavior, and its real failure text is
 * kept in the report.
 *
 * The contract has two directions, and the second one is the point:
 *
 *  - assertion fails with the SIGNATURE the named issues cause ->
 *    `expectBlocked`. The journey stays green and prints the issue numbers.
 *  - assertion fails with anything else -> `failed`. A block excuses exactly
 *    the defect it names and nothing else, so an unrelated regression in a
 *    blocked segment still reds the journey.
 *  - assertion PASSES while an expect-block is declared -> `unblocked`.
 *    The journey FAILS. The fix landed, so the segment must be promoted to
 *    required by deleting its `expectBlock`. A stale block cannot rot
 *    silently, and the promotion happens the first time CI runs after the
 *    fix — that is the automatic light-up.
 */

/** What actually happened when a segment ran. */
export type SegmentOutcome =
  /** Ran and asserted clean. Required for the journey to be green. */
  | "passed"
  /** Failed exactly as its named open issues predict. Not fatal. */
  | "expectBlocked"
  /** Passed while expect-blocked: the block is stale. FATAL. */
  | "unblocked"
  /** Failed with no expect-block, or in a way no block predicted. FATAL. */
  | "failed";

/** Why a segment cannot pass yet, in the issue tracker's own numbers. */
export interface ExpectBlock {
  /** Open issue numbers. Empty is never valid. */
  readonly issues: readonly number[];
  /** One plain sentence: what those issues do to this segment. */
  readonly because: string;
  /**
   * The failure text those issues produce. The block excuses ONLY a failure
   * matching this; anything else is a real failure. Without it a block would
   * quietly absorb every future regression in its segment.
   */
  readonly signature: RegExp;
}

/** One named step of the journey. */
export interface Segment<Context> {
  readonly id: string;
  /** Plain-words title, used verbatim in the printed report. */
  readonly title: string;
  /** Present only while a named open issue stops this segment passing. */
  readonly expectBlock?: ExpectBlock;
  /** Runs the real work and throws on any failed assertion. */
  run(context: Context): Promise<void>;
}

export interface SegmentResult {
  readonly id: string;
  readonly title: string;
  readonly outcome: SegmentOutcome;
  readonly durationMs: number;
  readonly expectBlock: ExpectBlock | undefined;
  /** The real failure text, kept whether or not the failure was expected. */
  readonly failure: string | undefined;
}

export interface JourneyReport {
  readonly segments: readonly SegmentResult[];
  /** True only when no segment is `failed` or `unblocked`. */
  readonly ok: boolean;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? "" : `\n  caused by: ${String(error.cause)}`;
    return `${error.message}${cause}`;
  }
  return String(error);
}

export function classify(
  expectBlock: ExpectBlock | undefined,
  failure: string | undefined,
): SegmentOutcome {
  if (expectBlock === undefined) return failure === undefined ? "passed" : "failed";
  if (failure === undefined) return "unblocked";
  return expectBlock.signature.test(failure) ? "expectBlocked" : "failed";
}

/**
 * Runs one segment and classifies it. `now` is injected so the deterministic
 * unit tests can drive duration without a clock.
 */
export async function runSegment<Context>(
  segment: Segment<Context>,
  context: Context,
  now: () => number = () => performance.now(),
): Promise<SegmentResult> {
  const started = now();
  let failure: string | undefined;
  try {
    await segment.run(context);
  } catch (error) {
    failure = describe(error);
  }
  return {
    id: segment.id,
    title: segment.title,
    outcome: classify(segment.expectBlock, failure),
    durationMs: Math.round(now() - started),
    expectBlock: segment.expectBlock,
    failure,
  };
}

/**
 * Run a journey's segments in order, ALWAYS run `teardown`, then summarize.
 *
 * This is the loop every recipe would otherwise hand-copy, and the copy's
 * risky part is the `finally`: the SDK has no kill path (#15943), so a
 * recipe that forgets it leaks a spawned host child on the first failing
 * segment (PR #24319 review). Teardown is a callback because the kit does
 * not know what a journey's context owns.
 */
export async function runJourney<Context>(
  segments: ReadonlyArray<Segment<Context>>,
  context: Context,
  teardown: (context: Context) => Promise<void>,
): Promise<JourneyReport> {
  const results: SegmentResult[] = [];
  try {
    for (const segment of segments) {
      results.push(await runSegment(segment, context));
    }
  } finally {
    await teardown(context);
  }
  return summarize(results);
}

export function summarize(segments: readonly SegmentResult[]): JourneyReport {
  return {
    segments,
    ok: !segments.some(
      (segment) => segment.outcome === "failed" || segment.outcome === "unblocked",
    ),
  };
}

const MARK: Record<SegmentOutcome, string> = {
  passed: "PASS ",
  expectBlocked: "BLOCK",
  unblocked: "STALE",
  failed: "FAIL ",
};

function issueList(block: ExpectBlock): string {
  return block.issues.map((issue) => `#${String(issue)}`).join(", ");
}

/** The human-facing report. Every expect-block states its issue numbers. */
export function formatReport(report: JourneyReport): string {
  const lines: string[] = [];
  for (const segment of report.segments) {
    lines.push(
      `${MARK[segment.outcome]} ${segment.id.padEnd(26)} ${String(segment.durationMs).padStart(6)}ms  ${segment.title}`,
    );
    const block = segment.expectBlock;
    if (block !== undefined && segment.outcome === "expectBlocked") {
      lines.push(`        expect-blocked on ${issueList(block)}: ${block.because}`);
      lines.push(`        observed: ${indent(segment.failure ?? "(no detail)")}`);
    }
    if (block !== undefined && segment.outcome === "unblocked") {
      lines.push(
        `        EXPECT-BLOCK IS STALE. This segment now passes, so ${issueList(block)} looks fixed.`,
      );
      lines.push(
        `        Promote it: delete this segment's expectBlock so the journey requires it from now on.`,
      );
    }
    if (segment.outcome === "failed") {
      if (block !== undefined) {
        lines.push(
          `        This failure does NOT match the expect-block signature for ${issueList(block)}` +
            ` (${String(block.signature)}), so it is a real failure.`,
        );
      }
      lines.push(`        ${indent(segment.failure ?? "(no detail)")}`);
    }
  }
  const counts = new Map<SegmentOutcome, number>();
  for (const segment of report.segments) {
    counts.set(segment.outcome, (counts.get(segment.outcome) ?? 0) + 1);
  }
  const tally = (["passed", "expectBlocked", "unblocked", "failed"] as const)
    .map((outcome) => `${outcome}=${String(counts.get(outcome) ?? 0)}`)
    .join(" ");
  lines.push(`journey ${report.ok ? "OK" : "NOT OK"} (${tally})`);
  return lines.join("\n");
}

function indent(text: string): string {
  return text.split("\n").join("\n        ");
}
