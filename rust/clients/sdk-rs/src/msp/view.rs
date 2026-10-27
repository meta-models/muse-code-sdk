// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

pub(crate) mod approval;
pub(crate) mod approval_card_facts;
pub(crate) mod approval_wire_words;
pub(crate) mod event;
pub(crate) mod event_wire_words;
pub(crate) mod gap;
pub(crate) mod health;
pub(crate) mod health_wire_words;
pub(crate) mod item;
pub(crate) mod item_background;
pub(crate) mod item_background_terminal_completion;
pub(crate) mod item_content;
pub(crate) mod item_damaged_range;
pub(crate) mod item_earlier_history;
pub(crate) mod item_hold;
pub(crate) mod item_status;
pub(crate) mod message_phase;
pub(crate) mod monitor_inbox;
pub(crate) mod state;
pub(crate) mod state_wire_words;
pub(crate) mod tool_label;
pub(crate) mod tool_receipt;
pub(crate) mod user_input;

/// The inclusive raw-record range a durable-sourced view event folded from —
/// the reconciliation token: re-folding the cited records from the canonical
/// fold state immediately before `first` — appended host-death terminals seed
/// from the end-of-records state — reproduces the event. In v1 it is an
/// **opaque provenance token**: no wire method reads what it points at.
///
/// Ephemeral-sourced events (`item/delta`, and an `item/started` that opens on
/// an ephemeral record) carry no `sourceRange` — ephemeral records may be
/// evicted by retention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SourceRange {
    /// The stream the folded records live on.
    pub stream: StreamRef,
    /// The first record of the inclusive range.
    pub first: RecordPosition,
    /// The last record of the inclusive range; equal to `first` for an event
    /// folded from one record.
    pub last: RecordPosition,
}

/// One raw stream named by a [`SourceRange`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct StreamRef {
    /// The stream kind, verbatim raw-log vocabulary (e.g. `"run"`,
    /// `"session"`). A free string, not an enum: `sourceRange` is an opaque
    /// provenance token in v1 and the raw stream vocabulary is the deferred
    /// altitude's to freeze.
    pub kind: String,
    /// The stream id.
    pub id: String,
}

/// One end of a [`SourceRange`]: a record's event id and its sequence number
/// within the stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RecordPosition {
    /// The record's event id.
    pub id: String,
    /// The record's sequence number within its stream.
    pub sequence: u64,
}
