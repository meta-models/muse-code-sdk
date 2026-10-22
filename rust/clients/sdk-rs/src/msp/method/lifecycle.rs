// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::session::Session;
use crate::msp::method::worktree::WorktreeStartRequest;
use crate::msp::view::state::ApprovalMode;
pub use recovery::RecoveryMode;
pub use recovery::RecoveryObservation;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
pub use session_mcp::SessionConfig;
pub use session_resume::BlockedPrompt;
pub use session_resume::HistoryNoneReason;
pub use session_resume::LastTurn;
pub use session_resume::PendingRequestPointer;
pub use session_resume::SessionHistory;

pub(crate) mod recovery;
pub(crate) mod session_leave;
pub(crate) mod session_list;
pub(crate) mod session_mcp;
pub(crate) mod session_resume;
pub(crate) mod session_resume_wire_words;

/// `session/start` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartParams {
    /// The idempotency handle (UUIDv7). Required; the server never mints one.
    pub command_id: String,
    /// Recovery choice for this construction; omission keeps legacy behavior.
    /// Explicit null is invalid.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub recovery_mode: Option<RecoveryMode>,
    /// Exact identity for this new root session. When omitted the server mints
    /// a UUIDv7. This field never selects an existing session: a retained or
    /// reserved id is rejected `commandRejected` with reason
    /// `session_id_conflict`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Absolute path, folded into the first metadata record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// The session's initial runtime workspace-root set: ordered absolute
    /// canonical existing directory paths; the first root is the CWD and plays
    /// the primary-root role; every root receives the `:workspace_roots` rules;
    /// extra roots grant no Project Trust. When `workspaceRoot` is also present
    /// the two must name the same folder, compared on canonical forms, or the
    /// request is invalid params, and so is explicit `null`. Omitted preserves
    /// single-root behavior.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_roots: Option<Vec<String>>,
    /// Initial model; server default when omitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Initial provider routing; server default when omitted or explicit `null`
    /// — both spellings select the default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// The session's starting approval mode; server default when omitted or
    /// explicit `null` — both spellings select the default. Select, never
    /// create — the value names a mode the host's configuration already
    /// defines. This is the only surface that declares a non-interactive run's
    /// policy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<ApprovalMode>,
    /// The new session's initial permission profile: a profile id the host
    /// catalog already admits — the rows `permissionProfile/list` serves
    /// without `sessionId`. Select, never create. Omitted means today's
    /// behavior: the host's configured default under native admission,
    /// unchanged. An id the catalog does not carry, or one it serves
    /// unavailable, refuses the start `commandRejected` (-32030;
    /// `permission_profile_unknown` / `permission_profile_unavailable`) before
    /// any durable byte, and an ephemeral host refuses any id
    /// (`permission_profile_ephemeral_fixed`). `session/fork` does not admit
    /// the member; `session/resume` admits it as the launch pick. Explicit
    /// `null` is invalid params: the set of members that tolerate `null` is
    /// closed and excludes this one, exactly as it excludes `workspaceRoots`.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_profile: Option<String>,
    /// Reserved for future per-session overrides; only its `mcpServers` member
    /// is admitted.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub config: Option<SessionConfig>,
    /// Ask for a created worktree or attach an existing one. **Experimental**
    /// (`session/start.worktree`; unopted callers are refused `-32602`). Absent
    /// means no worktree — the start proceeds exactly as today.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeStartRequest>,
    /// The per-session restriction: the axes this session chooses, each at or
    /// below the host ceiling. **Experimental, socket-only**
    /// (`session/start.limits`; unopted callers are refused `-32602`, as are
    /// opted callers on hosts with no limits regime). Absent means the default
    /// on every axis — the daemon default for trust, the ceiling for the
    /// sandbox axes. A choice wider than the ceiling on any axis refuses the
    /// start `-32028 limitsAboveMax` naming every too-wide axis.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<super::limits::SessionLimitsChoice>,
}

pub(crate) fn deserialize_non_null_optional<'de, D, T>(
    deserializer: D,
) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

pub(crate) fn deserialize_optional_recovery_observation<'de, D>(
    deserializer: D,
) -> Result<Option<RecoveryObservation>, D::Error>
where
    D: Deserializer<'de>,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    if !value.is_object() {
        return Ok(None);
    }
    Ok(serde_json::from_value(value).ok())
}

/// `session/start` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionStartResult {
    /// The new session.
    pub session: Session,
    /// The session view head after the start fold; the connection is subscribed
    /// and receives every view event after this cursor. A deduplicated retry
    /// returns this same result.
    pub view_cursor: String,
}

/// `session/fork` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionForkParams {
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The source session.
    pub session_id: String,
    /// Copy history through a completed turn, inclusive. Omitted means "all
    /// completed turns".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cut_point: Option<ForkCutPoint>,
    /// Skip inline history in the result and page it later — same as
    /// `session/resume`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_items: Option<bool>,
}

/// Where a fork cuts the source history. Turn ids are used instead of counts
/// because ids stay stable across compaction and concurrent appends while
/// indices do not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkCutPoint {
    /// The last completed turn to copy, inclusive. Naming an in-progress or
    /// unknown turn fails `forkBoundaryInvalid`.
    pub last_turn_id: String,
}

/// `session/fork` result: the `session/resume` envelope for the **new**
/// session, whose `session.forkedFrom` carries the provenance.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionForkResult {
    /// The new fork session, carrying `forkedFrom` provenance.
    pub session: Session,
    /// The new session's view head.
    pub view_cursor: String,
    /// The served history.
    pub history: SessionHistory,
    /// The late-joiner pointer set.
    pub pending_requests: Vec<PendingRequestPointer>,
}

/// `session/sideChat` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSideChatParams {
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The source main session.
    pub session_id: String,
}

/// `session/sideChat` result: the `session/resume` envelope for the **new**
/// side session, whose `session.sideFrom` carries the provenance. The side
/// opens empty.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionSideChatResult {
    /// The new side session, carrying `sideFrom` provenance.
    pub session: Session,
    /// The new side session's view head.
    pub view_cursor: String,
    /// The served history.
    pub history: SessionHistory,
    /// The late-joiner pointer set.
    pub pending_requests: Vec<PendingRequestPointer>,
}

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
        deserialize_with = "deserialize_optional_recovery_observation",
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
}
