/**
 * The expect-block contract now lives in the shared cookbook kit
 * (`clients/sdk-cookbook/src/kit/segments.ts`, issue #24225) so the
 * quickstart journey and every cookbook recipe classify outcomes with the
 * same code. This module re-exports it unchanged: the journey's import
 * surface, semantics, and report format are exactly what they were when the
 * contract lived in this file.
 */

export {
  classify,
  formatReport,
  runJourney,
  runSegment,
  summarize,
} from "@muse-code/sdk-cookbook/kit";
export type {
  ExpectBlock,
  JourneyReport,
  Segment,
  SegmentOutcome,
  SegmentResult,
} from "@muse-code/sdk-cookbook/kit";
