// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::recovery::RecoveryObservation;
use super::runtime_worktree::RuntimeWorktree;
use super::session_resume::SessionHistory;
use super::session_resume_members::BlockedPrompt;
use super::session_resume_members::LastTurn;
use super::session_resume_members::PendingRequestPointer;
use crate::msp::method::session::Session;
use serde::Deserialize;
use serde::Serialize;

/// `session/read` params: read one stored session **without attaching** — no
/// writer lease, no load, no subscription, no `SessionResumed` record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReadParams {
    /// The session to read.
    pub session_id: String,
    /// Metadata-only unless you ask: `false` carries the folded item history.
    /// Same name and polarity as `session/resume`/`session/fork`; only the
    /// default differs — here it is `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_items: Option<bool>,
}

/// `session/read` result. The `viewCursor` is the fold head at read time — a
/// point-in-time read, immediately stale if a foreign host is appending.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionReadResult {
    /// The session as folded point-in-time.
    pub session: Session,
    /// Current local construction only; never inferred from retained history.
    /// Absence establishes neither a choice nor supported recovery.
    #[serde(
        default,
        deserialize_with = "crate::msp::method::lifecycle::deserialize_optional_recovery_observation",
        skip_serializing_if = "Option::is_none"
    )]
    pub recovery_observation: Option<RecoveryObservation>,
    /// The fold head at read time.
    pub view_cursor: String,
    /// The served history.
    pub history: SessionHistory,
    /// The same pointer shape as `session/resume`. Because `session/read` never
    /// subscribes this is a point-in-time log read only: no requests are
    /// re-issued after it.
    pub pending_requests: Vec<PendingRequestPointer>,
    /// Same member as `session/resume`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn: Option<LastTurn>,
    /// Same member as `session/resume`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_prompt: Option<BlockedPrompt>,
    /// The inputs still queued for delivery to the read session.
    /// Absent-when-empty: a missing member means nothing queued, never an
    /// error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_inputs: Option<Vec<QueuedInput>>,
    /// The inputs the read session's log delivered to its subagents.
    /// Absent-when-empty: a missing member means nothing delivered, never an
    /// error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivered_inputs: Option<Vec<DeliveredInput>>,
    /// The facts of the runtime-owned worktree a child read session's subagent
    /// runs in. A root read serves it absent; absent means no worktree facts,
    /// never an error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<RuntimeWorktree>,
    /// One short record per child session the checkpoint boundary pruned.
    /// Absent-when-empty: a missing member means the view is uncompacted or
    /// nothing pruned, never an error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pruned_subagents: Option<Vec<PrunedSubagent>>,
}

/// One child session pruned below a checkpoint boundary: the restored row's
/// key, text, and stoppability — never pruned transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PrunedSubagent {
    /// The child session id — the trace key for `session/read` on the
    /// child, exactly as for a live child row.
    pub session_id: String,
    /// The served display label (the spawn's role, agent path as
    /// fallback); absent when the spawn records carry neither.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `running`, `completed`, or `failed`; absent reads as `running`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

/// One input still queued for delivery to a session: the full message body plus
/// its log record sequence, the delivery-order and re-read dedupe key, plus the
/// run-log record id clients join served entries against record-seeded rows by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct QueuedInput {
    /// The full message body, verbatim (never truncated, never a summary).
    pub text: String,
    /// The queued record's log sequence: delivery order, and the key
    /// clients deduplicate re-reads by.
    pub sequence: u64,
    /// The run-log record id the served mirror was taken from: the key
    /// clients join served entries against record-seeded rows by, so an
    /// already-rendered input never mints a second row under diverged
    /// sequences. Absent when the host's record carries no mirror
    /// metadata (a pre-feature host), which falls back to sequence-key
    /// dedup only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_run_record_id: Option<String>,
    /// The `SubagentInput` record's model-authored command id: the key
    /// wire-twin rows join by in either order (the twin reads the same
    /// string from the verbatim wire args). Absent for root own-queue
    /// members, which are never `SubagentInput`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_command_id: Option<String>,
}

/// One input the read session's log delivered to a subagent: the queue-note
/// summary (never the body) plus the queue and drain record sequences, the
/// order and re-read dedupe keys, plus the join ids clients adopt
/// already-rendered rows by.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct DeliveredInput {
    /// The subagent the input was delivered to (parent-scope id).
    pub subagent_id: String,
    /// The stored queue-note summary (never the body).
    pub summary: String,
    /// The queued record's log sequence: entry order, and half of the
    /// sequence-pair join key.
    pub sequence: u64,
    /// The matching drain record's log sequence: the Delivered row's
    /// position key.
    pub delivered_sequence: u64,
    /// The queue record's run-log id: the record-row join key. Absent
    /// when the host's record carries no mirror metadata (a pre-feature
    /// host), which falls back to the command id, then the
    /// sequence-pair join.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_run_record_id: Option<String>,
    /// The `SubagentInput` record's command id: the key wire-twin rows
    /// join by in either order. Absent when the record carries none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_command_id: Option<String>,
}
