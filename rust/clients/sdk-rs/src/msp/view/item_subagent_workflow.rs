// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::state::TokenUsage;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

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

/// A subagent child's workspace placement: `shared` when the spawn requested no
/// worktree isolation, `isolated` when it did. Open; unknown values read as
/// unknown. Experimental.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum WorkspacePlacement {
    /// The child shares its parent's workspace.
    Shared,
    /// The child runs in its own worktree.
    Isolated,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
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
    /// instead of re-deriving the join; a client that knows `subagentResult`
    /// draws one `Finished` member per consumed result instead, and keeps
    /// drawing from this flag for a child with no such item, as on a host
    /// before the kind.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drained: Option<bool>,
    /// `true` once a newer attempt of the child started after this result: the
    /// result stays, and a client takes the child's status from
    /// `controlStatus`. Absent, it asserts nothing (a host before this member,
    /// or a fold state saved before it, never sets it); a newer result replaces
    /// the whole result, so it carries no mark.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded: Option<bool>,
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
