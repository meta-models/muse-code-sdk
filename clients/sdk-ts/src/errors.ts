/**
 * Typed errors shared by the stores and the facade.
 *
 * They live here rather than in `facade/` because the stores throw them too,
 * and a store importing from the facade would invert the layering. Typed
 * rather than bare `Error` because each names a STATE an embedder must branch
 * on; the only alternative is matching message text, which silently turns
 * those strings into the package's contract.
 */

/**
 * The session was discarded after an ephemeral host's abnormal death, and the
 * operation attempted would either resurrect it or replay against a new host
 * (tdd SS2.13.3b, SS3.1.3).
 */
export class MuseSessionDiscardedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MuseSessionDiscardedError";
  }
}

/** An event whose `sessionId` names a different session than the one folding it. */
export class MuseForeignSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MuseForeignSessionError";
  }
}

/**
 * An image part whose bytes provably match a different well-known media
 * type than the one declared (#117). Thrown locally by `sendUserTurn`
 * before anything is submitted; only PNG/JPEG/GIF/WebP signatures are
 * judged, anything else passes through for the host to judge.
 */
export class MuseImageMediaTypeError extends Error {
  readonly declared: string;
  readonly detected: string;
  readonly partIndex: number;

  constructor(declared: string, detected: string, partIndex: number) {
    super(
      `image part ${partIndex} media type mismatch: declared "${declared}" but the image bytes match "${detected}"; refusing to submit`,
    );
    this.name = "MuseImageMediaTypeError";
    this.declared = declared;
    this.detected = detected;
    this.partIndex = partIndex;
  }
}

/**
 * Why one SS4.8 splice-fill did not complete. Each arm names a different owner
 * (this SDK's own composition, the transport, the host), because the repair
 * differs:
 *
 *  - `noConnection` — the `Session` was built fold-only, so it has no seam to
 *    page through. Composition, not a runtime fault.
 *  - `pageFailed` — a `view/page` round trip failed, or answered with a frame
 *    this session may not fold. `cause` carries it.
 *  - `pageStalled` — the walk made no progress: a page that neither carried
 *    events nor ended the view, or a `nextCursor` that did not advance. The
 *    wire is an external boundary and this is the only bound on the walk;
 *    an attempt cap would silently truncate a legitimate long fill.
 */
export type GapFillFailureReason = "noConnection" | "pageFailed" | "pageStalled";

/**
 * A gap the client could not fill (spec 14990 FR-020, tdd SS4.8).
 *
 * REPORTED to `Session.onGapError`, never thrown: the fill is driven from a
 * notification, so a throw would escape into the consumer's pump with nothing
 * to catch it. Typed rather than a bare `Error` because the hole it names is a
 * STATE a consumer must branch on — the fold stays not-current until a later
 * recovery, and `(after, next)` names exactly what is missing. Reporting it is
 * what makes the hole loud instead of silent, which is the half of FR-020 the
 * fill itself cannot deliver.
 */
export class MuseGapFillError extends Error {
  readonly reason: GapFillFailureReason;
  /** The gap's own bounds, verbatim and opaque (tdd SS4.1). */
  readonly after: string;
  readonly next: string;

  constructor(reason: GapFillFailureReason, after: string, next: string, cause?: unknown) {
    super(`view/gap (${after}, ${next}) could not be filled: ${reason}`, { cause });
    this.name = "MuseGapFillError";
    this.reason = reason;
    this.after = after;
    this.next = next;
  }
}

/**
 * A required session-start permission-profile selection the client could not
 * prove applied (TEST-42624-10, amendment 42624 § Compatibility): the start
 * result carried no `permissionState`, and the `session/read` read-back
 * served a different profile — or none at all. Never a silent default: the
 * session stays open and the caller decides (set/retry or close) via
 * `sessionId`, with no auto-close and no auto-set.
 */
export class PermissionProfileNotApplied extends Error {
  /** The profile id the caller required. */
  readonly requested: string;
  /** The committed profile id the read-back served, or null when unknown. */
  readonly served: string | null;
  /** The open session, so the caller can set, retry, or close it. */
  readonly sessionId: string;

  constructor(requested: string, served: string | null, sessionId: string) {
    super(
      `required permissionProfile ${JSON.stringify(requested)} was not applied:` +
        ` the committed selection is ${served === null ? "unknown" : JSON.stringify(served)}` +
        ` (session ${sessionId})`,
    );
    this.name = "PermissionProfileNotApplied";
    this.requested = requested;
    this.served = served;
    this.sessionId = sessionId;
  }
}
