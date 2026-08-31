/**
 * The `--area sdk` scenario set.
 *
 * Three groups, all driving the REAL `tbh serve`:
 *  - `scenarios/conformance.ts` — handshake and lifecycle. These conform
 *    fully today, so the group is deliberately small: re-proving a green
 *    surface is not QA.
 *  - `scenarios/defect-classes.ts` — the confirmed defect classes from the
 *    stdio auto-qa pass, re-driven through the SDK. Each one classifies
 *    facade-vs-binary by raw-frame replay before it is reportable.
 *  - `scenarios/turn-blocked.ts` — the turn-dependent surface, encoded and
 *    EXPECT-BLOCKED behind its named blocker. Not skipped, not deleted, and
 *    never weakened to pass: each flips to `block-lifted` the moment its
 *    blocker stops biting.
 */

import { CONFORMANCE_SCENARIOS } from "./scenarios/conformance.js";
import { DEFECT_CLASS_SCENARIOS } from "./scenarios/defect-classes.js";
import { TURN_BLOCKED_SCENARIOS } from "./scenarios/turn-blocked.js";
import type { QaScenario } from "./scenario-kit.js";

export { CONFORMANCE_SCENARIOS, DEFECT_CLASS_SCENARIOS, TURN_BLOCKED_SCENARIOS };

export const SDK_QA_SCENARIOS: readonly QaScenario[] = [
  ...CONFORMANCE_SCENARIOS,
  ...DEFECT_CLASS_SCENARIOS,
  ...TURN_BLOCKED_SCENARIOS,
];
