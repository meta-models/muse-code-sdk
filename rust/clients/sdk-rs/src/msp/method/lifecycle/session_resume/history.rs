// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::snapshot::ViewSnapshot;
use crate::msp::view::item::Item;
use serde::Deserialize;
use serde::Serialize;

/// The `history` request preference of `session/resume`. The forced values
/// downgrade `anchored` → `inline` → `snapshot` → `none`; under `auto` the full
/// rung order is anchoredSnapshot → anchored pending cut → inline → snapshot →
/// pending cut → elided snapshot → elided pending cut → none, a pending cut
/// being the snapshot with its `monitorInbox` cut to the entries still awaiting
/// delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryPreference {
    /// Serve the best rung that fits, anchored first.
    Auto,
    /// Prefer the full folded item array.
    Inline,
    /// Prefer a folded view state plus suffix.
    Snapshot,
    /// Prefer a snapshot anchored at the latest installed compaction boundary.
    Anchored,
}

/// The `history` envelope shared by `session/resume`, `session/fork`, and
/// `session/read`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionHistory {
    /// What was actually served — never what was asked for.
    pub mode: HistoryMode,
    /// The full folded item array when `mode` is `inline`; `null` otherwise.
    pub items: Option<Vec<Item>>,
    /// The folded view state when `mode` is `snapshot` or `anchoredSnapshot`;
    /// `null` otherwise.
    pub snapshot: Option<ViewSnapshot>,
    /// Why no history was served — sent exactly when `mode` is `"none"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub none_reason: Option<HistoryNoneReason>,
    /// The checkpoint-prune boundary: rows for served items at-or-before
    /// `through_item_id` in served order predate the selected checkpoint.
    /// Additive-optional; absence is a non-assertion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_boundary: Option<CheckpointBoundary>,
}

/// A served checkpoint-prune boundary: `through_item_id` names the last
/// first-opened item that opened strictly before the boundary checkpoint event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CheckpointBoundary {
    /// The last pre-boundary item's id, in served (first-opened) order.
    pub through_item_id: String,
}

/// Why a result served `history.mode: "none"` — the server's typed reason for
/// serving no history, with one push-only exception: `projectionRebuildFailed`
/// rides only a `session/viewHealthChanged` notification; no resume or read
/// result carries it (see its variant doc). Open on the client side: an
/// absent (older server) or unknown (newer server) value decodes
/// conservatively as an unknown reason, and `viewCursor` text never
/// substitutes for it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HistoryNoneReason {
    /// The request's effective `excludeItems` was `true` (the
    /// `session/read` default; explicit on resume/fork).
    Excluded,
    /// A retained cursor was supplied; the streamed suffix carries the
    /// history.
    CursorSuffix,
    /// Every rung through the elided pending cut exceeded the history budget;
    /// page via `view/page` from the result's `viewCursor`.
    HistoryBudget,
    /// No trustworthy materialized projection exists; paging cannot recover it.
    ProjectionUnavailable,
    /// The projection exists but the aggregate materialized read exceeded
    /// its bounded read cap; page in bounded chunks.
    ProjectionReadLimit,
    /// One value is push-only: `projectionRebuildFailed` rides only a
    /// `session/viewHealthChanged` notification, after the host's one re-load
    /// of a failed live view fails or right after a fork child's live
    /// fail-close; no resume or read result carries it. The view stays
    /// unavailable for this load; never followed by `healthy`.
    ProjectionRebuildFailed,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// What history a lifecycle result actually served. Open on the client side:
/// report-what-was-served means a client treats an unknown mode as "page it
/// yourself".
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HistoryMode {
    /// `snapshot` holds a folded view state anchored at the latest installed
    /// compaction boundary; `snapshot.anchor` names it.
    AnchoredSnapshot,
    /// `items` is the full folded item array.
    Inline,
    /// `snapshot` holds a folded view state at `snapshot.viewCursor`.
    Snapshot,
    /// No history was served — page it via `view/page` from the result's
    /// `viewCursor`.
    None,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}
