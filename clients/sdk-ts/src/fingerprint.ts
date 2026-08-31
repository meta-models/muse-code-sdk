/**
 * The schema-bundle staleness anchor (spec 14990 FR-006).
 *
 * `EXPECTED_SCHEMA_FINGERPRINT` pins the stable protocol-schema fingerprint
 * this SDK was written against. Two consumers:
 *
 *  - Build time: a test asserts this equals `schema/msp/stable/manifest.json`,
 *    so a schema advance that forgets the SDK reds the SDK lane instead of
 *    shipping a silently-stale facade. This is the same manifest-pin pattern
 *    the #210 transcripts use.
 *  - Runtime: the connection machine compares `InitializeResult.schema
 *    .fingerprint` against this pin. A mismatch is a WARNING, never an error
 *    (tdd SS1.4.1) — additive-optional evolution means an older SDK keeps
 *    working against a newer host.
 */
export const EXPECTED_SCHEMA_FINGERPRINT =
  "sha256:2ca24d36e08f2f2abac430a0637de723efa378f7396c5ada881f9094065b1a99";

/**
 * What a build-time mismatch MEANS, in the words a human needs at 2am.
 *
 * A mismatch is the normal, expected consequence of the protocol schema
 * advancing — it is NOT evidence that the SDK is broken. The remedy is to
 * re-pin and adapt whatever actually changed. Several lanes have burned time
 * reading a red fingerprint as an SDK defect, so the message says it plainly.
 */
export function fingerprintMismatchMessage(
  pinned: string,
  actual: string,
): string {
  return [
    "MSP schema fingerprint moved: re-pin after a schema advance.",
    `  pinned by @muse/sdk: ${pinned}`,
    `  schema/msp/stable/manifest.json: ${actual}`,
    "",
    "This does NOT mean the SDK is broken. The stable schema bundle advanced",
    "(a #206 enrollment or renderer change). Fix it by running",
    "scripts/regen-msp-pins.sh, which re-pins EXPECTED_SCHEMA_FINGERPRINT and",
    "every other derived copy from the committed stable manifest, then adapt",
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
      `SDK pins (${pinned}); proceeding under additive-optional evolution ` +
      `(SS1.5.4). Re-pin after a schema advance.`,
  };
}
