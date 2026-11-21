// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::session::Session;
pub use recovery::RecoveryMode;
pub use recovery::RecoveryObservation;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
pub use session_config_mt_providers::SessionEndpointProviders;
pub use session_mcp::SessionConfig;
pub use session_read::PrunedSubagent;
pub use session_resume::HistoryNoneReason;
pub use session_resume::SessionHistory;
pub use session_resume_input_assets::ClientRef;
pub use session_resume_input_assets::MissingInputAssets;
pub use session_resume_input_assets::UnavailableInputAsset;
pub use session_resume_members::ModelIdRefusal;
pub use session_resume_members::PendingRequestPointer;
pub use session_start::SessionLoadWarning;

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
    /// The new session's model: the same member and rule as
    /// `session/resume.modelId`, applied by the load that creates the fork.
    /// Nothing is recorded when the fork already runs that model; a model the
    /// host refuses, a blank one included, leaves the fork on the model it
    /// inherited and the result names it in `modelIdRefusal`. A retry of the
    /// same `commandId` reattaches the fork it created and ignores this member.
    /// Omitted keeps the inherited model. Explicit `null` is invalid params.
    /// **Experimental** (`session/fork.modelId`).
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub model_id: Option<String>,
    /// The same open construction-time extension object as `session/start` and
    /// `session/resume`, checked by the same door and applied to the load that
    /// creates the fork. It replaces what the fork would otherwise compose from
    /// its source (on a multi-tenant host, the source's endpoint and settings
    /// overrides). A retry of the same `commandId` reattaches the fork it
    /// created and ignores this member. Explicit `null` is invalid params.
    /// **Experimental** (`session/fork.config`).
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub config: Option<SessionConfig>,
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
    /// The `modelId` this fork carried and the host refused: the fork opened
    /// on the model it inherited, which `session` reports. **Experimental**
    /// (`session/fork.modelIdRefusal`); absent when the fork carried no
    /// `modelId` or the host recorded or kept it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id_refusal: Option<ModelIdRefusal>,
    /// What the host did not apply of this fork's `config`. **Experimental**
    /// (`session/fork.warnings`). Absent when there is nothing to warn about,
    /// never an empty array.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<SessionLoadWarning>>,
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
    /// The served history: inline, with empty items, since the side opens
    /// empty.
    pub history: SessionHistory,
    /// The late-joiner pointer set.
    pub pending_requests: Vec<PendingRequestPointer>,
}
