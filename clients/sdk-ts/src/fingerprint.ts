/**
 * The schema-bundle staleness anchor (spec 14990 FR-006).
 *
 * `EXPECTED_SCHEMA_FINGERPRINT` is the stable protocol-schema fingerprint
 * this SDK was built against. It derives at build: the `prebuild` step
 * (`node scripts/msp-fingerprint.mjs --stamp`) computes it from the
 * committed schema bytes and stamps the generated module this file imports
 * (ADR 77546 D4). No literal is committed here — a schema advance moves
 * the value at the next build, and two PRs that change different schema
 * regions never conflict on this file.
 *
 * Two consumers:
 *
 *  - Build time: the receipt-pins gate proves this file carries the
 *    derivation hook and no committed copy, and the sdk-ts suite proves
 *    the stamped value equals the port's derivation over the live schema
 *    bytes — so a schema advance that the build somehow misses reds
 *    instead of shipping a silently-stale facade.
 *  - Runtime: the connection machine compares `InitializeResult.schema
 *    .fingerprint` against this value. A mismatch is a WARNING, never an
 *    error (tdd SS1.4.1) — additive-optional evolution means an older SDK
 *    keeps working against a newer host.
 */
import { STAMPED_SCHEMA_FINGERPRINT } from "./fingerprint.stamped.js";

export const EXPECTED_SCHEMA_FINGERPRINT: string = STAMPED_SCHEMA_FINGERPRINT;

/**
 * What a build-time mismatch MEANS, in the words a human needs at 2am.
 *
 * A mismatch is the normal, expected consequence of the protocol schema
 * advancing — it is NOT evidence that the SDK is broken. The remedy is to
 * rebuild and adapt whatever actually changed. Several lanes have burned
 * time reading a red fingerprint as an SDK defect, so the message says it
 * plainly.
 */
export function fingerprintMismatchMessage(
  pinned: string,
  actual: string,
): string {
  return [
    "MSP schema fingerprint moved: rebuild after a schema advance.",
    `  built by @muse-code/sdk: ${pinned}`,
    `  derived stable schema fingerprint: ${actual}`,
    "",
    "This does NOT mean the SDK is broken. The stable schema bundle advanced",
    "(a #206 enrollment or renderer change). Fix it by rebuilding",
    "(`npm run build` re-stamps EXPECTED_SCHEMA_FINGERPRINT from the",
    "committed schema bytes), then adapt",
    "the facade to whatever the advance actually changed. Never hand-edit",
    "schema/msp/** to match the SDK.",
  ].join("\n");
}

/** The runtime arm (tdd SS1.4.1): advisory only, never a connection failure. */
export interface FingerprintWarning {
  readonly kind: "schemaFingerprintMismatch";
  readonly pinned: string;
  readonly served: string;
  readonly message: string;
}

/**
 * Compare a host's advertised fingerprint against the pin.
 * Returns `undefined` when they agree — a mismatch is surfaced, not thrown.
 */
export function checkServedFingerprint(
  served: string,
  pinned: string = EXPECTED_SCHEMA_FINGERPRINT,
): FingerprintWarning | undefined {
  if (served === pinned) return undefined;
  return {
    kind: "schemaFingerprintMismatch",
    pinned,
    served,
    message:
      `host schema fingerprint ${served} differs from the fingerprint this ` +
      `SDK was built against (${pinned}); proceeding under additive-optional ` +
      `evolution (SS1.5.4). Rebuild after a schema advance.`,
  };
}
