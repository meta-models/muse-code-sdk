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

/** The developer-docs compatibility page the host-discovery error cites. */
export const COMPATIBILITY_PAGE_URL = "https://meta-models.github.io/muse-code-sdk/compatibility/";

/**
 * No host binary was given and no executable `muse` is on `PATH` (FR-79107-1).
 * Raised by `MuseClient.spawn` before any process is started. The package does
 * not bundle a host; install Muse Code or pass `museBin`.
 */
export class MuseHostDiscoveryError extends Error {
  /** The spawn option that names an explicit host path. */
  readonly parameter = "museBin";
  /** The page listing the host versions this SDK supports. */
  readonly compatibilityUrl = COMPATIBILITY_PAGE_URL;

  constructor() {
    super(
      "no muse host found: pass museBin=<path to a muse binary> or put `muse` on PATH. " +
        "The package does not bundle a host; supported host versions are listed on the " +
        `compatibility page's TypeScript row: ${COMPATIBILITY_PAGE_URL}`,
    );
    this.name = "MuseHostDiscoveryError";
  }
}

/**
 * `MuseClient.command` was asked to send a method whose state the facade owns
 * (FR-79107-2). Sending it raw would bypass that state, so it is refused
 * before anything is written; use the facade verb instead.
 */
export class MuseFacadeOwnedMethodError extends Error {
  /** The refused wire method. */
  readonly method: string;

  constructor(method: string) {
    super(
      `${method} is sent by the facade itself and cannot go through MuseClient.command; ` +
        "use the facade verb that owns it",
    );
    this.name = "MuseFacadeOwnedMethodError";
    this.method = method;
  }
}

/**
 * A session open asked for something the host did not grant on this
 * connection (FR-79107-3): today, per-session MCP servers (`config.mcpServers`)
 * without the `sessionMcp` capability. Refused before anything is sent; the
 * client stays usable, and an open without that request still goes through.
 */
export class MuseCapabilityNotGrantedError extends Error {
  /** The capability the request needs. */
  readonly capability: string;
  /** The wire method that was refused. */
  readonly method: string;

  constructor(capability: string, method: string, reason: string) {
    super(`${method} was not sent: ${reason}`);
    this.name = "MuseCapabilityNotGrantedError";
    this.capability = capability;
    this.method = method;
  }
}
