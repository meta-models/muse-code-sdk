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
import {
  STAMPED_SCHEMA_COMPATIBILITY_EPOCH,
  STAMPED_SCHEMA_FINGERPRINT,
} from "./fingerprint.stamped.js";

export const EXPECTED_SCHEMA_FINGERPRINT: string = STAMPED_SCHEMA_FINGERPRINT;

/**
 * The compatibility epoch this SDK was built against (ADR 22936 D3): the
 * stable bundle's declared count of non-additive advances of the stable
 * surface, stamped by the same `prebuild` step from the same bundle bytes
 * as the fingerprint (the bundle records it at its root, ADR 22936 D5).
 * Never a committed literal, for the same reasons as the fingerprint.
 */
export const EXPECTED_SCHEMA_COMPATIBILITY_EPOCH: number = STAMPED_SCHEMA_COMPATIBILITY_EPOCH;

/** The pair an SDK build pins: the stable fingerprint and the epoch it was generated against. */
interface SchemaIdentityPin {
  readonly fingerprint: string;
  readonly compatibilityEpoch: number;
}

/** What a host advertises in `InitializeResult.schema`: the epoch is absent on a host that predates it. */
export interface ServedSchemaIdentity {
  readonly fingerprint: string;
  readonly compatibilityEpoch?: number | undefined;
}

/**
 * The default pin of `classifyServedSchema`: module-private, because the two
 * members are already the package's public pins and a third root export
 * would bind the sibling SDKs to mirror it.
 */
const EXPECTED_SCHEMA_IDENTITY: SchemaIdentityPin = {
  fingerprint: EXPECTED_SCHEMA_FINGERPRINT,
  compatibilityEpoch: EXPECTED_SCHEMA_COMPATIBILITY_EPOCH,
};

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

/**
 * The runtime arm (tdd SS1.4.1, ADR 22936 D3): a surfaced mismatch with its
 * tier. The additive tier is advisory only; the declared-breaking tier is a
 * warning by default and a connect-time refusal behind
 * `refuseDeclaredBreakingSchema`. The tier reads `additive` when the served
 * epoch equals the pin or the host omits it (every difference is additive,
 * SS1.5.4) and `declaredBreaking` when the epochs differ (a declared
 * non-additive advance lies between). A union on `tier`: the
 * declared-breaking member always knows the served epoch, so a caller that
 * narrows on the tier needs no second check.
 */
interface FingerprintWarningBase {
  readonly kind: "schemaFingerprintMismatch";
  readonly pinned: string;
  readonly served: string;
  readonly pinnedEpoch: number;
  readonly message: string;
}

/** The additive tier: an equal or absent served epoch; today's warning. */
export interface AdditiveFingerprintWarning extends FingerprintWarningBase {
  readonly tier: "additive";
  /** `undefined` when the host omits the member: unknown, never a substituted value. */
  readonly servedEpoch: number | undefined;
}

/** The declared-breaking tier: a served epoch that differs from the pin. */
export interface DeclaredBreakingFingerprintWarning extends FingerprintWarningBase {
  readonly tier: "declaredBreaking";
  readonly servedEpoch: number;
}

export type FingerprintWarning = AdditiveFingerprintWarning | DeclaredBreakingFingerprintWarning;

/**
 * FR-22936-8's one reading of a served `compatibilityEpoch`, shared by the
 * handshake and the classifier so the two cannot drift apart: absent, or a
 * non-negative integer. Package-internal: not exported from the root.
 */
export function isWellFormedEpoch(raw: unknown): raw is number | undefined {
  return raw === undefined || (typeof raw === "number" && Number.isInteger(raw) && raw >= 0);
}

/**
 * Classify a host's advertised schema identity against the pin (ADR 22936
 * D3). Equal fingerprints: no check at all, whatever the epochs. A served
 * epoch that is not a non-negative integer reads as absent (FR-22936-8), so
 * this call on `initializeResult.schema` reports the tier the handshake
 * reported. Returns `undefined` when there is nothing to say — a mismatch is
 * surfaced, not thrown; the refusal is the connection's decision, not this
 * function's.
 */
export function classifyServedSchema(served: ServedSchemaIdentity): FingerprintWarning | undefined {
  return classify(served, EXPECTED_SCHEMA_IDENTITY);
}

/**
 * The classifier's body, with the pin as an argument. Module-private: the
 * pin is the SDK's own (FR-22936-6), never a public parameter; the one
 * other caller is `checkServedFingerprint`.
 */
function classify(served: ServedSchemaIdentity, pinned: SchemaIdentityPin): FingerprintWarning | undefined {
  if (served.fingerprint === pinned.fingerprint) return undefined;
  // A present member that is not a non-negative integer is read as absent
  // (FR-22936-8), here as in the handshake, and nothing is substituted for
  // the value; the handshake alone decides whether to refuse it.
  const raw: unknown = served.compatibilityEpoch;
  const servedEpoch = isWellFormedEpoch(raw) ? raw : undefined;
  const base = {
    kind: "schemaFingerprintMismatch" as const,
    pinned: pinned.fingerprint,
    served: served.fingerprint,
    pinnedEpoch: pinned.compatibilityEpoch,
  };
  if (servedEpoch === undefined || servedEpoch === pinned.compatibilityEpoch) {
    return {
      ...base,
      tier: "additive",
      servedEpoch,
      message:
        `host schema fingerprint ${served.fingerprint} differs from the fingerprint this ` +
        `SDK was built against (${pinned.fingerprint}); proceeding under additive-optional ` +
        `evolution (SS1.5.4). Rebuild after a schema advance.`,
    };
  }
  return {
    ...base,
    tier: "declaredBreaking",
    servedEpoch,
    message:
      `host schema fingerprint ${served.fingerprint} at compatibility epoch ${String(servedEpoch)} ` +
      `differs from the fingerprint this SDK was built against (${pinned.fingerprint}, epoch ` +
      `${String(pinned.compatibilityEpoch)}) across a declared non-additive advance (ADR 22936 D3). ` +
      `Rebuild the SDK against the served bundle.`,
  };
}

/**
 * Compare a host's advertised fingerprint against the pin, with no epoch:
 * the pre-#22936 reading, kept for callers that have only the fingerprint.
 * `pinned` overrides the fingerprint only: the pin's epoch is always this
 * build's `EXPECTED_SCHEMA_COMPATIBILITY_EPOCH`, so the warning's
 * `pinnedEpoch` names this build whatever `pinned` names. Returns
 * `undefined` when they agree — a mismatch is surfaced, not thrown.
 */
export function checkServedFingerprint(
  served: string,
  pinned: string = EXPECTED_SCHEMA_FINGERPRINT,
): FingerprintWarning | undefined {
  return classify(
    { fingerprint: served },
    { fingerprint: pinned, compatibilityEpoch: EXPECTED_SCHEMA_COMPATIBILITY_EPOCH },
  );
}

/**
 * The connect-time refusal of the declared-breaking tier (ADR 22936 D3):
 * one error naming the served fingerprint and epoch as the bundle to rebuild
 * against, and the SDK's own pin. Thrown only when the caller opted in with
 * `refuseDeclaredBreakingSchema`; the SDK has already closed the host it
 * spawned when this reaches the caller, so a refusal orphans nothing. Its
 * fields are the warning's flat fields (`served`, `servedEpoch`, `pinned`,
 * `pinnedEpoch`), so code that handles both sees one shape.
 */
export class SchemaCompatibilityError extends Error {
  readonly kind = "schemaCompatibilityRefused" as const;
  readonly tier = "declaredBreaking" as const;
  readonly served: string;
  readonly servedEpoch: number;
  readonly pinned: string;
  readonly pinnedEpoch: number;

  constructor(warning: DeclaredBreakingFingerprintWarning) {
    super(
      `refused at connect: the host serves stable schema ${warning.served} at compatibility ` +
        `epoch ${String(warning.servedEpoch)}, a declared non-additive advance from the bundle this ` +
        `SDK was built against (${warning.pinned}, epoch ${String(warning.pinnedEpoch)}). Rebuild the ` +
        `SDK against the served bundle (ADR 22936 D3). The spawned host was closed.`,
    );
    this.name = "SchemaCompatibilityError";
    this.served = warning.served;
    this.servedEpoch = warning.servedEpoch;
    this.pinned = warning.pinned;
    this.pinnedEpoch = warning.pinnedEpoch;
  }
}
