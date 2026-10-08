/**
 * The typed failure of `MuseClient.spawn` when the host is lost before the
 * SS1.4 handshake completes (#49791).
 *
 * Without it the rejection is whatever the transport saw first — `write
 * EPIPE` on the first frame, or `connection reached EOF` — while the evidence
 * that explains it (Node's spawn error, or the SS2.11 exit row with its
 * bounded stderr tail) sits unread on the child the facade already owns.
 * Spec 14990 Scenario 4 attaches that evidence to every process-exit error;
 * this module is the handshake-failure arm of that rule.
 */

import type { ExitClassification, MuseServeChild } from "../connection/spawn.js";

/**
 * How the host was lost. Two arms because the repair differs: `spawnFailed`
 * means no process ever ran (`error` is Node's own spawn error — `code`
 * `ENOENT`, `EACCES`, … — so fix the path or its permissions); `hostExited`
 * means a process ran and ended before the handshake completed, and `exit` is
 * its SS2.11 row — any row, the clean one included: a host that wrote its
 * complaint to stderr and exited 0 before its first frame is still a lost
 * host, and the row says only how it ended. `answeredInitialize` says whether
 * it got as far as a usable `initialize` answer before dying (then the loss
 * came while the SDK was completing the handshake, not at startup).
 */
export type HostStartFailure =
  | { readonly kind: "spawnFailed"; readonly error: NodeJS.ErrnoException }
  | {
      readonly kind: "hostExited";
      readonly exit: ExitClassification;
      readonly answeredInitialize: boolean;
    };

/** How many tail lines the message quotes; `stderrTail` carries them all. */
const MESSAGE_TAIL_LINES = 5;

/**
 * `MuseClient.spawn` lost its host before the handshake completed.
 *
 * Typed rather than a bare `Error` because the two arms of `failure` name
 * STATES an embedder branches on (retry after fixing the path, versus act on
 * an SS2.11 retry posture). The transport error that first surfaced the loss
 * rides as `cause`, so nothing the old rejection carried is dropped.
 */
export class MuseHostStartError extends Error {
  readonly failure: HostStartFailure;
  /**
   * The SDK's bounded stderr tail when the host was lost, one accessor
   * regardless of arm: empty when no process ran, and the only place the
   * evidence lives when the row is `cleanShutdown` (SS2.11 keeps no tail on
   * the clean row; a logger wants the lines either way).
   */
  readonly stderrTail: readonly string[];

  constructor(failure: HostStartFailure, stderrTail: readonly string[], cause: unknown) {
    super(describeHostStartFailure(failure, stderrTail), { cause });
    this.name = "MuseHostStartError";
    this.failure = failure;
    this.stderrTail = stderrTail;
  }
}

function describeHostStartFailure(
  failure: HostStartFailure,
  tail: readonly string[],
): string {
  if (failure.kind === "spawnFailed") {
    return `muse host could not be spawned: ${failure.error.message}`;
  }
  const exit = failure.exit;
  const how =
    exit.kind === "cleanShutdown"
      ? "exit code 0"
      : exit.kind === "crash"
        ? exit.exitSignal !== null
          ? `signal ${exit.exitSignal}`
          : `exit code ${String(exit.exitCode)}`
        : `exit code ${String(exit.exitCode)}${"retry" in exit ? `, retry: ${exit.retry}` : ""}`;
  const quoted = tail.slice(-MESSAGE_TAIL_LINES);
  const evidence =
    tail.length === 0
      ? "stderr tail: (empty)"
      : `stderr tail${
          quoted.length < tail.length ? ` (last ${quoted.length} of ${tail.length} lines)` : ""
        }:\n  ${quoted.join("\n  ")}`;
  const when = failure.answeredInitialize
    ? "after answering initialize, before the handshake completed"
    : "before answering initialize";
  return `muse host exited ${when}: ${exit.kind} (${how}); ${evidence}`;
}

/**
 * Read a lost host's evidence into the typed error. "Lost" is decided by
 * whether the host ANSWERED — whether a response frame came back — never by
 * how it ended: the caller keeps an answer's own error (`MspError`, or a
 * `ProtocolError` carrying the refused frame) and routes only frameless
 * failures here, where the row says how the unanswering host ended.
 *
 * Call only after the handshake's `close()` has settled: the close ladder
 * ends at the child's observed exit (or at its spawn failure), so
 * `child.exit` is already settled here and this never waits on a live host.
 */
export async function hostStartFailure(
  child: MuseServeChild,
  cause: unknown,
  answeredInitialize: boolean,
): Promise<MuseHostStartError> {
  let exit: ExitClassification;
  try {
    exit = await child.exit;
  } catch (spawnError) {
    // `exit` rejects only with the ChildProcess 'error' payload: Node's own
    // spawn errno (`code` ENOENT, EACCES, …). No other producer reaches it.
    return new MuseHostStartError(
      { kind: "spawnFailed", error: spawnError as NodeJS.ErrnoException },
      child.stderrTail,
      cause,
    );
  }
  return new MuseHostStartError(
    { kind: "hostExited", exit, answeredInitialize },
    child.stderrTail,
    cause,
  );
}
