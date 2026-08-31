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
