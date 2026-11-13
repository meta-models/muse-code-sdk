// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::session::Session;
pub use recovery::RecoveryMode;
pub use recovery::RecoveryObservation;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
pub use session_config_mt_providers::SessionEndpointProviders;
pub use session_read::PrunedSubagent;
pub use session_resume::HistoryNoneReason;
pub use session_resume::SessionHistory;
pub use session_resume_input_assets::ClientRef;
pub use session_resume_input_assets::MissingInputAssets;
pub use session_resume_input_assets::UnavailableInputAsset;
pub use session_resume_members::PendingRequestPointer;

pub(crate) mod recovery;
pub(crate) mod runtime_worktree;
pub(crate) mod runtime_worktree_wire_words;
pub(crate) mod session_config_mt;
pub(crate) mod session_config_mt_providers;
pub(crate) mod session_leave;
pub(crate) mod session_list;
pub(crate) mod session_mcp;
pub(crate) mod session_mcp_server;
pub(crate) mod session_read;
pub(crate) mod session_resume;
pub(crate) mod session_resume_input_assets;
pub(crate) mod session_resume_members;
pub(crate) mod session_resume_wire_words;
pub(crate) mod session_start;
pub(crate) mod session_start_nodes;
pub(crate) mod session_start_switch_policy;

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
    /// Client-supplied shell prefix allow-rules override: omitted inherits the
    /// source session's rules, present replaces with that set (an explicit
    /// empty array clears). Explicit `null` is invalid params. Until the
    /// served-handler slice, a host refuses any spelled `approvalRules` on
    /// `session/start`/`fork`/`resume` with `-32602`; clients omit it.
    /// **Experimental** (`session/fork.approvalRules`).
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub approval_rules: Option<Vec<super::approval::ClientApprovalRule>>,
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
