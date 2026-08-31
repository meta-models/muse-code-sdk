/**
 * The session-state half of the SS4 client fold (spec 14990 FR-007, INV-005).
 *
 * State events are NOT items: they carry replace-wholesale session facts,
 * cursor-ordered, latest-wins (tdd SS4.6). An explicit `null` is a fact — it
 * clears the family — never "unchanged" (the `session/goalChanged` and
 * `session/branchChanged` rules). `session/tokenUsage` is the one
 * accumulate-only family; its running totals arrive server-computed in
 * `cumulative`, so the client stores rather than sums (tdd SS4.6.5).
 *
 * Generic for the same reason `ItemStore` is: the concrete params types are
 * enrolled by #14953 and INV-001 forbids restating them locally. The family
 * KEY is the notification method name, which is protocol vocabulary the
 * generated layer already owns as `MspNotification`; this store treats it as
 * an opaque string so a family added additively (tdd SS1.5.4) folds without
 * a code change.
 */

/** A stored family value. `null` is a real value: the family was cleared. */
export type StateValue<V> = V | null;

/**
 * What one state event changed: the family it targeted, the value it
 * replaced, the value now stored, and whether it was applied or refused as
 * a replay.
 */
export interface StateApplyOutcome<V> {
  readonly family: string;
  readonly previous: StateValue<V> | undefined;
  readonly current: StateValue<V>;
  /** False when the incoming value was refused as an exact-cursor replay. */
  readonly applied: boolean;
}

/**
 * Last-write-wins per family, in arrival order.
 *
 * Cursors are opaque strings and MUST NOT be parsed or ordered (tdd SS4.1),
 * so ordering here is by arrival: the server emits view events in cursor
 * order on every connection, and a page's events are ascending. The one
 * cursor use is EXACT-EQUALITY replay de-duplication, and it remembers only
 * the family's LATEST cursor — it refuses only a back-to-back replay of the
 * family's most recent event. The SS4.8 splice caller must skip
 * already-applied page events itself, which it does by construction: the
 * splice pages forward from `after` (the last delivered cursor) and
 * discards paged events at cursors >= `next` as duplicates of the live
 * buffer, so no sanctioned path re-delivers an older event. No relational
 * comparison exists: string order diverges from cursor order at every digit
 * rollover ("v:s:10" < "v:s:9" as strings), which would drop genuinely
 * newer events.
 */
export class SessionStateStore<V = unknown> {
  readonly #values = new Map<string, StateValue<V>>();
  readonly #cursors = new Map<string, string>();

  /**
   * Apply a state event. `cursor` is the event's `viewCursor`; when omitted
   * (a snapshot seed, which carries one cursor for the whole state) the value
   * is taken unconditionally.
   */
  apply(family: string, value: StateValue<V>, cursor?: string): StateApplyOutcome<V> {
    const previous = this.#values.get(family);
    if (cursor !== undefined) {
      const seen = this.#cursors.get(family);
      // An equal cursor is a replay of the same event (idempotent): refuse.
      // That is the ONLY cursor comparison — cursors are opaque (SS4.1) and
      // any relational order (string order included) mis-sorts at a digit
      // rollover; arrival order carries the LWW truth.
      if (seen !== undefined && cursor === seen) {
        return {
          family,
          previous,
          current: previous ?? null,
          applied: false,
        };
      }
      this.#cursors.set(family, cursor);
    }
    this.#values.set(family, value);
    return { family, previous, current: value, applied: true };
  }

  /**
   * Read a family. `undefined` means no fact has ever landed — distinct from
   * `null`, which means a fact cleared it. Absent is never fabricated
   * (tdd SS4.9.1).
   */
  get(family: string): StateValue<V> | undefined {
    return this.#values.get(family);
  }

  has(family: string): boolean {
    return this.#values.has(family);
  }

  /** Every family that holds a value, in insertion order. */
  families(): readonly string[] {
    return [...this.#values.keys()];
  }

  /** Seed from a snapshot's state block: authoritative, replaces wholesale. */
  seed(entries: Iterable<readonly [string, StateValue<V>]>, cursor?: string): void {
    this.#values.clear();
    this.#cursors.clear();
    for (const [family, value] of entries) {
      this.#values.set(family, value);
      if (cursor !== undefined) this.#cursors.set(family, cursor);
    }
  }
}
