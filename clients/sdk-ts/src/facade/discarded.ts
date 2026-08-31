/**
 * What an ephemeral host death discarded, remembered ACROSS the sessions one
 * client opened (spec 14990 T030 obligation (c); tdd SS2.13.3b).
 *
 * SS2.13.3b's five-clause MUST includes "do not attempt to reattach" and "do
 * not replay the session's `commandId`s". Both are statements about what the
 * CLIENT does next, and "next" outlives the session object that died:
 *
 *  - `PendingCommandSet` already refuses a replay of an id IT discarded, but
 *    its memory is per-instance, so a FRESH `Session` — the natural thing to
 *    build after a host dies — knew nothing and would replay those ids at the
 *    new host. That is the exactly-once violation the clause exists to prevent,
 *    and it is why T030b's own arm could only name the gap;
 *  - nothing at all held the discarded `sessionId`, so `resumeSession` had no
 *    fact to withhold on.
 *
 * This is client state, never a wire shape and never durable (INV-007): it
 * lives exactly as long as the `MuseClient` that owns it. It is deliberately
 * NOT a module-global — two clients in one process are two independent trust
 * boundaries, and a process-wide set would let one client's dead host silence
 * another's live one.
 */

/**
 * The two sets, exposed directly rather than behind add/has pairs.
 *
 * `PendingCommandSet` takes the `commandIds` set BY REFERENCE and writes to it
 * from `discardEphemeral()`, so a wrapper would have to re-expose a mutable
 * seam anyway; a `Set<string>` is the honest shape for one, and it is already
 * the shape that class used internally.
 */
export class DiscardedSessions {
  /** `commandId`s an ephemeral discharge retired. Never replayed again. */
  readonly commandIds = new Set<string>();
  /** `sessionId`s whose ephemeral host died. Never reattached. */
  readonly sessionIds = new Set<string>();
}
