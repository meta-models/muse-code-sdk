/**
 * The cookbook manifest: every recipe the `cookbook-journeys` CI job runs,
 * in the order it runs them. One entry per docs page under the site's
 * Cookbook group; the recipe IS the page's evidence, so adding a page means
 * adding its recipe here.
 */

import { answerUserInput } from "./recipes/answer-user-input.js";
import { approveOrDeny } from "./recipes/approve-or-deny.js";
import { cancelMidTurn } from "./recipes/cancel-mid-turn.js";
import { classifyServeExits } from "./recipes/classify-serve-exits.js";
import { fingerprintMismatch } from "./recipes/fingerprint-mismatch.js";
import { listModelsAndSwitchMidSession } from "./recipes/list-models-and-switch-mid-session.js";
import { queueSteerReclaim } from "./recipes/queue-steer-reclaim.js";
import { retryWithoutDoubleSubmitting } from "./recipes/retry-without-double-submitting.js";
import { streamATurn } from "./recipes/stream-a-turn.js";
import { surviveTheHostDying } from "./recipes/survive-the-host-dying.js";
import type { Recipe } from "./runner.js";

// Ratified numeric order (#24225 proposal comment), not landing order.
export const RECIPES: readonly Recipe[] = [
  streamATurn,
  approveOrDeny,
  cancelMidTurn,
  surviveTheHostDying,
  fingerprintMismatch,
  classifyServeExits,
  listModelsAndSwitchMidSession,
  retryWithoutDoubleSubmitting,
  answerUserInput,
  queueSteerReclaim,
];
