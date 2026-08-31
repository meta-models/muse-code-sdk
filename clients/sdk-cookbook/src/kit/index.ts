/**
 * The shared journey kit, importable as `@muse-code/sdk-cookbook/kit` — the
 * package's ONLY export. There is deliberately no root export: nothing
 * consumes one (recipes and tests use relative paths, CI runs
 * `dist/src/main.js` by path), and a root barrel would both drift as a
 * second hand-maintained export list and make every recipe module a
 * load-time dependency of the quickstart journey (PR #24319 review,
 * Constitution XI). The kit is just the expect-block contract and the
 * owned-host recorder.
 */

export {
  classify,
  formatReport,
  runJourney,
  runSegment,
  summarize,
} from "./segments.js";
export type {
  ExpectBlock,
  JourneyReport,
  Segment,
  SegmentOutcome,
  SegmentResult,
} from "./segments.js";

export {
  Host,
  SDK_GATE_ENV,
  STUB_VIEW_CURSOR,
  TimeoutError,
  arrayAt,
  equals,
  isolatedHostEnv,
  objectAt,
  requireHost,
  stringAt,
  within,
} from "./host.js";
export type { HostOptions, HostSpawnSpec, RecordedNotification } from "./host.js";
