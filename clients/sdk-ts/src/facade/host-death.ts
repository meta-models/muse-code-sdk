/**
 * The ephemeral-profile host-death discard obligation, client side
 * (spec 14990 FM-002 / Scenario 4.3, tasks.md T030b; tdd SS2.13, SS4.4.3).
 *
 * Slice 2b landed the two STORE-LEVEL primitives with no production callers:
 * `PendingCommandSet.discardEphemeral()` and
 * `ItemStore.markEphemeralHostDeath()`. This module holds the two facts the
 * stores deliberately do not know — which durability profile the handshake
 * declared, and whether a given process exit was abnormal — and `Session`
 * composes them into the discharge.
 *
 * The stores stay wire-shape-blind (INV-001): the `Item` probe lives here,
 * where it is checked against the GENERATED type.
 */

import type { InitializeResult, Item, ItemStatus, SessionDurability } from "@muse/msp";

import type { ExitClassification } from "../connection/spawn.js";
import type { TerminalUnknownItemAnnotation } from "../fold/item-store.js";
import type { PendingRetirement } from "../pending/pending-command-set.js";

/**
 * Bound to the CLOSED extraction of the generated vocabularies so a
 * misspelling fails `tsc`. Comparing a bare literal against the open
 * `SessionDurability`/`ItemStatus` unions typechecks either way — the same
 * invisibility that cost INV-001 its interim exception in the pending set.
 */
const DURABLE: Extract<SessionDurability, "durable"> = "durable";
const EPHEMERAL: Extract<SessionDurability, "ephemeral"> = "ephemeral";
const IN_PROGRESS: Extract<ItemStatus, "inProgress"> = "inProgress";

/**
 * Which durability profile the host declared at the handshake (SS2.13.1).
 *
 * Absent and declared-`"durable"` collapse to ONE reading on purpose: nothing
 * downstream needs to tell them apart, and a `source` discriminator would be a
 * field carried for a future that has not arrived. Adding it later is
 * additive; removing it from a barrel-exported type would not be.
 */
export type SessionDurabilityProfile =
  | { readonly kind: "durable" }
  | { readonly kind: "ephemeral" }
  /** An open-enum value this SDK predates. Guarantees nothing (SS2.13.1). */
  | { readonly kind: "unrecognized"; readonly value: string };

/**
 * Read `sessionDurability` off the handshake result (SS2.13.1).
 *
 * Two readings are easy to conflate and must not be:
 *
 *  - ABSENT is `"durable"`, and that is decidable rather than fabricated: the
 *    member is optional only so the addition was additive (SS1.5.4), and no
 *    server that omits it has the ephemeral profile.
 *  - An UNRECOGNIZED value is NOT durable. SS2.13.1: a client that does not
 *    know the value "MUST NOT infer any durability guarantee from it, and MUST
 *    NOT fall through to the absent-means-durable rule — that rule keys on the
 *    member being missing, not on its value being unfamiliar." The enum is open
 *    for a reason (#14401's degraded state is a candidate third value), so the
 *    conservative read is "assume nothing survives this host".
 */
export function readSessionDurability(result: InitializeResult): SessionDurabilityProfile {
  const declared = result.sessionDurability;
  if (declared === undefined || declared === DURABLE) return { kind: "durable" };
  if (declared === EPHEMERAL) return { kind: "ephemeral" };
  return { kind: "unrecognized", value: declared };
}

/** Does a session on this profile survive its host? Only a durable one does. */
export function survivesHostDeath(profile: SessionDurabilityProfile): boolean {
  return profile.kind === DURABLE;
}

/**
 * The transport reached EOF with no orderly SS2.1.2 close (T030 obligation b).
 *
 * SS2.13.3b names TWO notifications of a host death — "process exit **or
 * transport EOF**" — and only the exit half was implementable while nothing in
 * this SDK owned the close. A host that closes stdout while still hung emits no
 * exit on the timescale that matters, so without this arm its session never
 * discharged: every pending command sat in the set as the durable-looking echo
 * SS4.13 forbids, and every turn wait hung.
 *
 * It carries no evidence fields, and that is the honest shape rather than a
 * gap: EOF IS the whole observation. The stderr tail and the SS2.11 row belong
 * to the process boundary, which has not reported yet — and when it does,
 * `Session.hostExited` latches the FIRST discharge, so a later exit replays the
 * EOF's report rather than overwriting it with a richer one. Whoever owns the
 * process still has `MuseServeChild.stderrTail` and its `exit` promise.
 *
 * ORDERLINESS IS NOT DECIDABLE HERE. `Connection` is duplex-generic and a
 * transport cannot tell a peer's hang-up from its own shutdown, so the layer
 * that KNOWS whether the close was its own is the one that builds this:
 * `MuseClient`, which owns both `close()` and the connection.
 */
export interface TransportEof {
  readonly kind: "transportEof";
}

/** How a client learns its host is gone: the process exit, or transport EOF. */
export type HostDeathNotification = ExitClassification | TransportEof;

/**
 * Was this notification an abnormal death (SS2.13.3b)?
 *
 * Exit 0 is the ONLY SS2.11 row where the run was cancelled, the drain
 * completed, and the durable `SessionEnd` records were written. Every other
 * row — including the ones with a tidy-looking name like `configError` —
 * left no `SessionEnd`, which is exactly what "abnormal" means here. A
 * transport EOF the client did not cause left no `SessionEnd` either, so it
 * joins the same predicate rather than getting a parallel one that could drift.
 */
export function isAbnormalHostDeath(
  notification: HostDeathNotification,
): notification is AbnormalExit {
  return notification.kind !== "cleanShutdown";
}

/**
 * The in-progress probe the store asks its caller for. `Item.status` is an
 * open enum whose terminal rule is "anything other than `inProgress`", so this
 * is a positive test on the one non-terminal value rather than a negative test
 * against a list that a schema advance would silently widen.
 */
export function isItemInProgress(item: Item): boolean {
  return item.status === IN_PROGRESS;
}

/**
 * Every death notification except the orderly exit row. An orderly close is
 * not a death, and neither is the EOF that follows one — which is why
 * `TransportEof` is only ever constructed by the layer that can tell.
 */
export type AbnormalExit = Exclude<HostDeathNotification, { kind: "cleanShutdown" }>;

/** A durable host died abnormally: its terminals arrive on resume (FM-001). */
export class MuseHostDiedError extends Error {
  readonly exit: AbnormalExit;

  // The parameter is narrowed rather than checked: `cleanShutdown` is not a
  // death, so the type refuses to build this error for one instead of a
  // ternary papering over a state no caller can reach.
  constructor(exit: AbnormalExit) {
    super(`MSP host died: ${exit.kind} (${MuseHostDiedError.#cause(exit)})`);
    this.name = "MuseHostDiedError";
    this.exit = exit;
  }

  static #cause(exit: AbnormalExit): string {
    // EOF has no exit code to render, and "exit code undefined" would read as
    // a missing datum rather than the fact that the process has not reported.
    if (exit.kind === "transportEof") return "transport EOF with no orderly close";
    // A signal kill has a null exit code, and the signal is its ONLY
    // diagnostic — rendering "exit code null" throws that away.
    if (exit.kind === "crash" && exit.exitCode === null) {
      return `signal ${String(exit.exitSignal)}`;
    }
    return `exit code ${String(exit.exitCode)}`;
  }
}

// `MuseSessionDiscardedError` and `MuseForeignSessionError` live in
// `../errors.js`: the stores throw the first one too, and a store importing
// from the facade would invert the layering.

/**
 * What one `Session.hostExited` call did.
 *
 * Discriminated because the three outcomes leave the session in three
 * different states, and a bare `discharged: boolean` collapsed the two false
 * arms into one: after `notADeath` the session is still usable, after
 * `durableDeath` it is dead until resume with every live wait already
 * rejected. An embedder should not have to re-derive that from the profile
 * and the exit row the method already read.
 */
export type HostDeathDischarge<I> =
  | {
      readonly kind: "notADeath";
      readonly profile: SessionDurabilityProfile;
      readonly exit: HostDeathNotification;
    }
  | {
      readonly kind: "durableDeath";
      readonly profile: SessionDurabilityProfile;
      readonly exit: AbnormalExit;
    }
  | {
      readonly kind: "discharged";
      readonly profile: SessionDurabilityProfile;
      readonly exit: AbnormalExit;
      /** Items still `inProgress` at death, annotated — never a synthesized event. */
      readonly terminalUnknownItems: readonly TerminalUnknownItemAnnotation[];
      readonly retiredCommands: readonly PendingRetirement<I>[];
    };
