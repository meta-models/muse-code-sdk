// @generated from the MSP stable schema and protocol sources; do not edit by hand.

pub use super::item_background::BackgroundInitiator;
pub use super::item_background_terminal_completion::BackgroundTerminalCompletion;
pub use super::item_damaged_range::DamagedRange;
pub use super::item_earlier_history::EarlierHistory;
pub use super::item_kind::HookRunStatus;
pub use super::item_kind::ItemKind;
pub use super::item_kind::ItemStatus;
pub use super::item_peer_message::PeerMessage;
pub use super::item_subagent_workflow::SubagentControlStatus;
pub use super::item_subagent_workflow::SubagentResult;
pub use super::item_subagent_workflow::WorkflowChild;
pub use super::item_subagent_workflow::WorkflowTokenBudget;
pub use super::item_subagent_workflow::WorkspacePlacement;
pub use crate::msp::view::subagent_input_phase::SubagentInputPhase;
pub use crate::msp::view::subagent_result_status::SubagentResultStatus;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `userMessage` image attachment metadata: metadata only — the durable bytes
/// live in the log and are reachable on the raw altitude.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct MessageAttachment {
    /// Attachment type, `"image"` in v1 (free string: attachment vocabulary
    /// grows additively with the runtime's intake surface).
    #[serde(rename = "type")]
    pub attachment_type: String,
    /// The image media type (e.g. `"image/png"`).
    pub media_type: String,
    /// Pixel width, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Pixel height, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// This attachment's name, `<itemId>/<n>` — the item's id plus this entry's
    /// 1-based position in its `attachments` array. Name only: no link form and
    /// no byte read by id.
    ///
    /// Set by the server on every attachment entry it emits, and identical on
    /// live, paging, snapshot and rebuild paths. Optional in the schema so
    /// older servers stay valid; clients compare and store the whole string and
    /// MUST NOT parse it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachment_id: Option<String>,
}

/// Stored-output reference: the camelCased fold of the durable `ToolOutputRef`.
/// The fetch path is `item/readOutput`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct OutputRef {
    /// The stored output's durable id.
    pub id: String,
    /// The stored output's kind, verbatim durable vocabulary.
    pub kind: String,
    /// The stored output's URI.
    pub uri: String,
    /// Media type, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// Stored byte length.
    pub byte_len: u64,
    /// Content digest (e.g. `"sha256:..."`), when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    /// Stored path, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Whether the bytes are servable.
    pub availability: OutputRefAvailability,
}

/// Server-authored edit-family diff summary: `files` counts the stored patch
/// document's file entries; `added` and `removed` are the total `+`/`-`
/// prefixed LINE counts summed over the stored patch's hunks across all files —
/// line counts, never hunk or byte counts. Rides the `toolCall` item beside
/// `patchRef`; the body is fetched via `item/readOutput` with `patchRef.id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PatchSummary {
    /// File entries in the stored patch document.
    pub files: u64,
    /// Total `+`-prefixed line count across all files' hunks.
    pub added: u64,
    /// Total `-`-prefixed line count across all files' hunks.
    pub removed: u64,
}

/// Whether a stored output's bytes are servable. Open — durable runtime
/// vocabulary may grow additively.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum OutputRefAvailability {
    /// The bytes are stored and servable.
    Available,
    /// The stored bytes are gone.
    Missing,
    /// The store does not serve this kind.
    Unsupported,
    /// The last access attempt failed.
    AccessFailed,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// Rich content the model saw beyond text: metadata only — fetch bytes via
/// `item/readOutput` when an `outputRef` exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelVisibleContent {
    /// Content type, `"image"` in v1 (free string, grows with the durable
    /// vocabulary).
    #[serde(rename = "type")]
    pub content_type: String,
    /// The tool that produced the content.
    pub source_tool_name: String,
    /// The recorded content path.
    pub path: String,
    /// The content media type.
    pub media_type: String,
    /// Pixel width, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Pixel height, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

/// Compaction outcome. Open.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompactionOutcome {
    /// A summary was installed.
    Compacted,
    /// Nothing compactable; a noop is a success.
    Noop,
    /// The summarizer failed; fallback recorded.
    Failed,
    /// The compaction was cancelled.
    Cancelled,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// What initiated a compaction. Open.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompactionTrigger {
    /// The `session/compact` command.
    Manual,
    /// Automatic pressure-triggered compaction.
    Auto,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `webSearch`: one typed result hit — result schema v1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct WebSearchHit {
    /// The hit title, verbatim (empty when the provider omits it).
    pub title: String,
    /// The hit URL, verbatim (empty when the provider omits it).
    pub url: String,
}
