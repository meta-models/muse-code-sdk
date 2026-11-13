/**
 * The one fold extension hook (FR-97527-3): a neutral, method-name-keyed
 * registration consulted for BOTH connection-level state and the
 * per-session fold.
 *
 * An extension runs INSIDE the single apply path — never a second pump —
 * so gap buffering, twin-claiming and resume behave exactly as today. The
 * hook names no experimental feature: it matches on the method string, and
 * the extension keeps its own state in its own instance.
 *
 * A throw never escapes: both loops catch an extension's throw and report
 * it to that extension's `onError` (the `ApprovalFailure` "reported, not
 * thrown" rule — the call site is a notification pump with nothing to
 * catch it). Without an `onError` the failure is swallowed, deliberately:
 * one bad add-on must not drop every session. An `onError` that itself
 * throws is swallowed too, for the same reason the approval observer's is.
 */

export interface FoldExtension {
  /** The exact notification method this extension handles. */
  readonly method: string;
  /**
   * Fold one frame's params. Called in registration order with the other
   * extensions for the same method, before the fold's own arm for that
   * method runs.
   */
  apply(params: unknown): void;
  /** Receives this extension's throws; absent means swallow. */
  readonly onError?: (error: unknown) => void;
}

/**
 * Run every extension registered for `method`, in registration order.
 *
 * The ONE call-and-report loop both planes share (fold + client `#route`),
 * so guard and reporting changes land once. Objects only — a frame without
 * usable params has nothing to fold. A throw is reported to that
 * extension's `onError` (absent means swallow); an `onError` that itself
 * throws is swallowed too. Returns how many extensions fired.
 */
export function fireExtensions(
  extensions: readonly FoldExtension[],
  method: string,
  params: unknown,
): number {
  if (params === null || typeof params !== "object" || Array.isArray(params)) return 0;
  let fired = 0;
  for (const extension of extensions) {
    if (extension.method !== method) continue;
    fired += 1;
    try {
      extension.apply(params);
    } catch (error) {
      try {
        extension.onError?.(error);
      } catch {
        // The failure observer threw. Swallowed, deliberately — same rule
        // as the approval observer: there is no one left to tell.
      }
    }
  }
  return fired;
}
