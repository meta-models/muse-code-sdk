// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::SourceRange;
use crate::msp::view::StreamRef;
use serde::Deserialize;
use serde::Serialize;

/// `monitor/inboxItemAdmitted` params: one monitor inbox admission — the fold
/// keys gate-off consumes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct MonitorInboxItemAdmittedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The inbox item id (dedupe key).
    pub item_id: String,
    /// The owning monitor task id (per-task set key).
    pub task_id: String,
    /// Per-task event order key (with `line_index`).
    pub event_index: u64,
    /// Monitor event kind, snake_case, open vocabulary — clients
    /// ignore unknown kinds.
    pub event_kind: String,
    /// Line order key; absent when the event has no line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_index: Option<u64>,
    /// Whether the event carries displayable lines.
    pub show_lines: bool,
    /// The model-facing delivery text.
    pub body: String,
    /// The producer-recorded pre-augmentation content; absent on earlier
    /// records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_body: Option<String>,
    /// The notice-text summary.
    pub summary: String,
    /// Admission stamp (RFC3339); consumed by the pending sort.
    pub queued_at: String,
}

/// One snapshot `monitorInbox` entry: a retained admission in the
/// `monitor/inboxItemAdmitted` shape, envelope-stripped, plus the newest drain
/// and void stamps folded for it. The entry is still awaiting delivery when
/// `drainedAt` is absent, or when `voidedAt` is strictly newer than it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct MonitorInboxSnapshotEntry {
    /// The inbox item id (dedupe key).
    pub item_id: String,
    /// The owning monitor task id (per-task set key).
    pub task_id: String,
    /// Per-task event order key (with `line_index`).
    pub event_index: u64,
    /// Monitor event kind, snake_case, open vocabulary.
    pub event_kind: String,
    /// Line order key; absent when the event has no line.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_index: Option<u64>,
    /// Whether the event carries displayable lines.
    pub show_lines: bool,
    /// The model-facing delivery text.
    pub body: String,
    /// The producer-recorded pre-augmentation content; absent on earlier
    /// records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_body: Option<String>,
    /// The notice-text summary.
    pub summary: String,
    /// Admission stamp (RFC3339).
    pub queued_at: String,
    /// The newest drain stamp (RFC3339); absent while never drained.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drained_at: Option<String>,
    /// The newest wake-missed void stamp (RFC3339); absent while never voided.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voided_at: Option<String>,
}

/// `monitor/inboxItemDrained` params: one monitor inbox drain — a consumption
/// marker with its recorded stamp.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct MonitorInboxItemDrainedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The drained inbox item id.
    pub item_id: String,
    /// The draining run stream (`StreamRef`), absent means the current
    /// draining run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub drain_target_run_stream: Option<StreamRef>,
    /// False is a local claim-only recall: no delivery row or recovery
    /// consequence, but the drain still stamps the awaiting verdict.
    pub delivery_visible: bool,
    /// The drain record's recorded stamp (RFC3339), the drain-side
    /// operand of drain-vs-void latest-wins.
    pub drained_at: String,
}

/// `monitor/inboxItemVoided` params: one wake-missed void — count-only, no
/// transcript row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct MonitorInboxItemVoidedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The voided inbox item id.
    pub item_id: String,
    /// The anomaly's recorded stamp (RFC3339), the void-side operand
    /// of drain-vs-void latest-wins.
    pub voided_at: String,
}
