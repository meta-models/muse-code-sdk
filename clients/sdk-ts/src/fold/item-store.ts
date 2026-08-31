/**
 * The item half of the SS4 client fold: upsert-by-revision plus delta
 * accumulation (spec 14990 FR-007, INV-003/INV-004).
 *
 * WHY THIS IS GENERIC. The concrete wire item type (`Item`, `ItemDeltaParams`,
 * …) is rendered by `crates/protocol` and is not yet in the committed
 * declarations — the session-view plane is enrolled by #14953. INV-001
 * forbids hand-writing a protocol type to fill the gap, so this module states
 * only the *algebraic precondition* its rules need — an item has an identity
 * and a revision — and takes the payload as a type parameter. When #14953
 * lands, `SessionFold` binds `T` to `@muse-code/msp`'s `Item` with no change here
 * and no protocol shape ever restated locally.
 */

import { MuseSessionDiscardedError } from "../errors.js";

/** The minimum an upsert needs: identity plus the monotonic ordering guard. */
export interface RevisionedItem {
  readonly itemId: string;
  readonly revision: number;
}

/** What an apply did — enough for a consumer to render without re-diffing. */
export type ItemApplyOutcome =
  | { readonly kind: "inserted"; readonly itemId: string }
  | { readonly kind: "replaced"; readonly itemId: string; readonly from: number; readonly to: number }
  /** A stale or replayed re-emission. The store did not change (INV-003). */
  | { readonly kind: "ignoredStaleRevision"; readonly itemId: string; readonly held: number; readonly offered: number };

/** What a delta did. Deltas bump no revision (tdd SS4.4.1). */
export type DeltaApplyOutcome =
  | { readonly kind: "appended"; readonly itemId: string; readonly field: string; readonly length: number }
  /**
   * A delta for an item the store does not hold. Deltas are a streaming
   * optimization and are never a fold's only source of a fact (tdd SS4.7.3),
   * so this is buffered against the item's arrival rather than dropped or
   * treated as an error.
   */
  | { readonly kind: "bufferedForAbsentItem"; readonly itemId: string; readonly field: string };

/** Client-only annotation required when an ephemeral host dies abnormally. */
export interface TerminalUnknownItemAnnotation {
  readonly kind: "terminalUnknown";
  readonly itemId: string;
}

/**
 * Items in first-opened order (the order tdd SS4.9.1 requires of a snapshot),
 * each held at its latest revision, with per-field delta accumulators.
 */
export class ItemStore<T extends RevisionedItem> {
  readonly #items = new Map<string, T>();
  /** itemId -> field path -> accumulated text. */
  readonly #deltas = new Map<string, Map<string, string>>();
  /** First-opened order; an itemId appears exactly once. */
  readonly #order: string[] = [];
  readonly #terminalUnknown = new Set<string>();
  #ephemeralSessionDiscarded = false;

  /**
   * Apply an `item/started` | `item/updated` | `item/completed` payload.
   * Replace iff the incoming revision is strictly higher (INV-003).
   */
  apply(item: T): ItemApplyOutcome {
    this.#assertSessionActive();
    const held = this.#items.get(item.itemId);
    if (held === undefined) {
      this.#items.set(item.itemId, item);
      this.#order.push(item.itemId);
      return { kind: "inserted", itemId: item.itemId };
    }
    if (item.revision <= held.revision) {
      return {
        kind: "ignoredStaleRevision",
        itemId: item.itemId,
        held: held.revision,
        offered: item.revision,
      };
    }
    this.#items.set(item.itemId, item);
    return {
      kind: "replaced",
      itemId: item.itemId,
      from: held.revision,
      to: item.revision,
    };
  }

  /**
   * Apply an `item/delta`: a UTF-8-safe append to the open item's field named
   * by `field` (default `"text"`), contiguous and lossless in cursor order.
   * The concatenation of all deltas for a field path equals that field's
   * value on the final `item/completed` object (INV-004, tdd SS4.3.1).
   */
  applyDelta(itemId: string, delta: string, field = "text"): DeltaApplyOutcome {
    this.#assertSessionActive();
    let fields = this.#deltas.get(itemId);
    if (fields === undefined) {
      fields = new Map<string, string>();
      this.#deltas.set(itemId, fields);
    }
    fields.set(field, (fields.get(field) ?? "") + delta);
    if (!this.#items.has(itemId)) {
      return { kind: "bufferedForAbsentItem", itemId, field };
    }
    return {
      kind: "appended",
      itemId,
      field,
      length: (fields.get(field) ?? "").length,
    };
  }

  /** The accumulated delta text for a field path, or `undefined` if none. */
  accumulated(itemId: string, field = "text"): string | undefined {
    return this.#deltas.get(itemId)?.get(field);
  }

  /** Every field path that has accumulated deltas for this item. */
  accumulatedFields(itemId: string): readonly string[] {
    const fields = this.#deltas.get(itemId);
    return fields === undefined ? [] : [...fields.keys()].sort();
  }

  get(itemId: string): T | undefined {
    return this.#items.get(itemId);
  }

  has(itemId: string): boolean {
    return this.#items.has(itemId);
  }

  /** Items in first-opened order (tdd SS4.9.1). */
  list(): readonly T[] {
    const out: T[] = [];
    for (const id of this.#order) {
      const item = this.#items.get(id);
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  /** The id of the most recently opened item, or `undefined` when empty. */
  lastOpenedItemId(): string | undefined {
    return this.#order.at(-1);
  }

  get size(): number {
    return this.#items.size;
  }

  /**
   * Seed from a snapshot's `state.items` (tdd SS4.9.1): every item at its
   * latest revision at the snapshot cursor, in first-opened order. Seeding
   * REPLACES the store — a snapshot is authoritative (tdd SS4.9), never
   * merged into stale local state.
   *
   * Delta accumulators are intentionally NOT seeded: a snapshot carries
   * streamed fields at their accumulated-so-far values on the item itself,
   * and `view/page` never replays ephemeral-sourced deltas (tdd SS4.7.3).
   */
  seed(items: Iterable<T>): void {
    this.#assertSessionActive();
    this.#items.clear();
    this.#deltas.clear();
    this.#terminalUnknown.clear();
    this.#order.length = 0;
    for (const item of items) {
      if (!this.#items.has(item.itemId)) this.#order.push(item.itemId);
      this.#items.set(item.itemId, item);
    }
  }

  /**
   * Permanently discard an ephemeral session after abnormal host death.
   *
   * The last wire item remains byte-for-byte intact: terminal-unknown is a
   * client display annotation, never a fabricated `item/completed` or wire
   * status (SS2.13.3b / SS4.4.3). Further events and snapshot seeding are
   * refused because this session has no resume surface.
   */
  markEphemeralHostDeath(
    // The store never knows wire shapes (INV-001), so the caller supplies the
    // in-progress probe — the slice-3 `SessionFold` binding passes
    // `(item) => item.status === "inProgress"` against the generated `Item`
    // type, where the compiler checks the field (review round 2026-08-15).
    isInProgress: (item: T) => boolean,
  ): readonly TerminalUnknownItemAnnotation[] {
    if (!this.#ephemeralSessionDiscarded) {
      for (const item of this.#items.values()) {
        if (isInProgress(item)) this.#terminalUnknown.add(item.itemId);
      }
      this.#ephemeralSessionDiscarded = true;
    }
    return this.#order
      .filter((itemId) => this.#terminalUnknown.has(itemId))
      .map((itemId) => ({ kind: "terminalUnknown" as const, itemId }));
  }

  isTerminalUnknown(itemId: string): boolean {
    return this.#terminalUnknown.has(itemId);
  }

  get ephemeralSessionDiscarded(): boolean {
    return this.#ephemeralSessionDiscarded;
  }

  #assertSessionActive(): void {
    if (this.#ephemeralSessionDiscarded) {
      throw new MuseSessionDiscardedError(
        "ephemeral session was discarded after abnormal host death",
      );
    }
  }
}
