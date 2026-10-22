// @generated from the MSP stable schema and protocol sources; do not edit by hand.

pub use super::item_background::BackgroundInitiator;
pub use super::item_background_terminal_completion::BackgroundTerminalCompletion;
pub use super::item_damaged_range::DamagedRange;
use crate::msp::view::state::TokenUsage;
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

/// Subagent control status. Open; the generic item `status` is the terminal
/// authority.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SubagentControlStatus {
    /// Spawn accepted.
    Accepted,
    /// Child starting.
    Starting,
    /// Child running.
    Running,
    /// Result envelope ready.
    ResultReady,
    /// Child closing.
    Closing,
    /// Child closed.
    Closed,
    /// Recovery pending after a restart.
    RecoveryPending,
    /// Parked for manual reconciliation.
    ManualReconciliation,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// A subagent's result envelope.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SubagentResult {
    /// Result summary, bounded on the wire at the 64 KiB retained-text budget;
    /// a cut sets the item's `truncated`. The durable record stays verbatim.
    pub summary: String,
    /// Result text, when present, bounded on the wire at the same 64 KiB
    /// budget; a cut sets the item's `truncated`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Error kind, verbatim durable vocabulary, when the child failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    /// Evidence references, verbatim.
    pub evidence_refs: Vec<String>,
    /// Artifact references, verbatim.
    pub artifact_refs: Vec<String>,
    /// Structured result data, verbatim, when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structured_data: Option<serde_json::Map<String, serde_json::Value>>,
    /// `true` once the parent consumed the result. Absent otherwise; never
    /// cleared once set. Clients mint the `Finished` marker off this flag
    /// instead of re-deriving the join.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drained: Option<bool>,
}

/// One workflow child's folded state, keyed by `(childId, attempt)`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct WorkflowChild {
    /// The child's id within the run.
    pub child_id: String,
    /// The attempt number.
    pub attempt: u32,
    /// camelCased `WorkflowChildLifecycleStatus`, verbatim (durable runtime
    /// vocabulary).
    pub status: String,
    /// The child's phase, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    /// The child's display label, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The child's observed usage, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// The child's observed duration, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// The child's terminal, turn vocabulary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal: Option<crate::msp::view::event::TurnTerminal>,
    /// The child's recorded result reference, verbatim, when present — an
    /// opaque string, matching the durable owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_ref: Option<String>,
    /// The attempt's machine failure class, verbatim when recorded. The
    /// attempt's outcome (`terminal`, else `status`) stays authoritative,
    /// except that `"completed"` with `failureKind` present means it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<String>,
    /// The attempt's failure reason text, verbatim when recorded except cut
    /// to at most 2,048 UTF-8 bytes ending in U+2026 when longer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

/// `workflow`: the run's launch token budget.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct WorkflowTokenBudget {
    /// The effective launch budget in tokens, verbatim from the launch fact.
    pub total: u64,
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

/// The eleven v1 item kinds plus post-v1 kinds. Open: a new kind is additive
/// evolution, and clients MUST render unknown kinds generically.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ItemKind {
    /// A submitted user prompt. Single-shot.
    UserMessage,
    /// A committed assistant message. Delta-streamed.
    AgentMessage,
    /// Reasoning summary/text. Delta-streamed.
    Reasoning,
    /// A committed tool call joined to its task lifecycle.
    ToolCall,
    /// The user shell escape hatch, item-ified; `turnId` is `null`.
    UserShell,
    /// A subagent child lifecycle.
    Subagent,
    /// A workflow run.
    Workflow,
    /// A reminder agent's child session: opened `inProgress` at the link
    /// record, settled with the child task's real terminal outcome.
    ReminderChild,
    /// A context compaction.
    Compaction,
    /// A hook run folding its started/terminal records.
    HookRun,
    /// A side-chat link on its main session's view: opened `inProgress` at the
    /// side creation, settled once (Accepted completes, Rejected rejects,
    /// Abandoned cancels) — a signpost, not a live fold.
    SideChat,
    /// A skill-read notice: single-shot only, status `completed` — a notice has
    /// no progress. Experimental: stripped per-connection for unopted callers.
    SkillRead,
    /// A provider-hosted web search call: a plain additive value of this open
    /// enum — never strip-armed, since `kind` is required (the `AuthRequired`
    /// precedent). Only the seven `webSearch` members are experimental-gated.
    WebSearch,
    /// One monitor feed line as one transcript cell: a plain additive value of
    /// this open enum, stable from day one. Single-shot only, status
    /// `completed`, `turnId` null — arrival is the transcript fact.
    MonitorFeed,
    /// One damaged range of the session log, at its position. Single-shot only,
    /// status `completed`, `turnId` null. No log record carries it: the fold
    /// that reads the damaged bytes derives it. A build that predates the kind
    /// decodes it only if its `ItemKind` has a catch-all; the protocol crate's
    /// does not yet.
    DamagedRange,
    /// A scheduled-task fire notice: a plain additive value of this open enum,
    /// stable from day one — never strip-armed, since `kind` is required (the
    /// `AuthRequired` precedent). Single-shot only, status `completed`,
    /// `revision` 1 — a notice has no progress.
    ScheduledFire,
    /// A background-terminal completion marker: a plain additive the protocol
    /// spec open-enum value, stable from day one — never strip-armed, since
    /// `kind` is required (the `AuthRequired` precedent). Single-shot only,
    /// status `completed`, `revision` 1 — a notice has no progress.
    BackgroundTerminalCompletion,
    /// One background-overdue drain as one transcript line: a plain additive
    /// value of this open enum, stable from day one. Single-shot only, status
    /// `completed` — a notice has no progress. `text` is the gate-off literal
    /// verbatim; `turnId` is the draining turn.
    OverdueNotice,
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

/// Item status. Open; terminal = anything other than `"inProgress"`, and
/// unknown values are terminal-unknown, rendered generically.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ItemStatus {
    /// The item is open; a terminal is guaranteed.
    InProgress,
    /// Terminal: finished normally.
    Completed,
    /// Terminal: the item's own execution failed.
    Failed,
    /// Terminal: cancelled (interrupt, cancel, or host-shutdown drain).
    Cancelled,
    /// Terminal: denied by approval, or a rejected subagent spawn.
    Rejected,
    /// Terminal: the task timed out (`TaskTerminalKind` vocabulary).
    TimedOut,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `hookRun` durable outcome. Open: new outcomes are additive, and clients MUST
/// render unknown values generically.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HookRunStatus {
    /// The run finished normally.
    Completed,
    /// The run was blocked; the item settles `rejected` while the payload
    /// keeps `blocked`.
    Blocked,
    /// The run failed.
    Failed,
    /// The run timed out.
    TimedOut,
    /// The run was cancelled.
    Cancelled,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}
