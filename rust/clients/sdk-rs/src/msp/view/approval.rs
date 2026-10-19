// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::error::ApprovalRequirementRef;
use crate::msp::view::SourceRange;
pub use decision::ApprovalAmendment;
pub use decision::ApprovalAmendmentDurability;
pub use decision::ApprovalChange;
pub use decision::ApprovalChoice;
pub use decision::ApprovalChoiceScope;
pub use decision::ApprovalDecision;
pub use decision::ApprovalPersistenceStatus;
pub use decision::ApprovalPolicyResult;
pub use decision::ApprovalResolvedBy;
pub use decision::ApprovalStageEvidence;
use serde::Deserialize;
use serde::Serialize;

pub(crate) mod decision;

/// Full params shared by `approval/request` and `approval/requested`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalRequestParams {
    pub session_id: String,
    pub approval_id: String,
    pub turn_id: String,
    pub task_id: String,
    pub item_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub raw_args: String,
    pub view_cursor: String,
    pub source_range: SourceRange,
    pub subject: ApprovalSubject,
    pub current_requirement_id: ApprovalRequirementRef,
    pub available_choices: Vec<ApprovalChoice>,
    pub protected_write: bool,
    pub judge_escalated: bool,
    /// Present only for a child (native subagent) approval projected onto the
    /// parent session's plane; parent-own approvals omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_origin: Option<ApprovalSubagentOrigin>,
}

/// `approval/updated` params: the refreshed pending view plus one change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalUpdatedParams {
    pub session_id: String,
    pub view_cursor: String,
    pub source_range: SourceRange,
    pub approval_id: String,
    pub current_requirement_id: ApprovalRequirementRef,
    pub subject: ApprovalSubject,
    pub available_choices: Vec<ApprovalChoice>,
    pub change: ApprovalChange,
    /// Present only for a child (native subagent) approval projected onto the
    /// parent session's plane; parent-own approvals omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_origin: Option<ApprovalSubagentOrigin>,
}

/// `approval/resolved` params: the first durable terminal decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalResolvedParams {
    pub session_id: String,
    pub view_cursor: String,
    pub source_range: SourceRange,
    pub approval_id: String,
    pub item_id: String,
    pub turn_id: String,
    pub decision: ApprovalDecision,
    pub policy_result: ApprovalPolicyResult,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amendment: Option<ApprovalAmendment>,
    pub resolved_by: ApprovalResolvedBy,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by_command_id: Option<String>,
    /// The decision time as RFC3339, projected from the durable
    /// `DecisionApplied` record's own stamp: optional on the wire so decoders
    /// tolerate its absence, always populated by current hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    pub stage_evidence: Vec<ApprovalStageEvidence>,
    /// Present only for a child (native subagent) approval projected onto the
    /// parent session's plane; parent-own approvals omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_origin: Option<ApprovalSubagentOrigin>,
}

/// Child (native subagent) provenance for an approval projected onto the PARENT
/// session's approval plane: identifies the originating child run/agent so a
/// client can attribute the prompt. Omitted (`skip_serializing_if`) on the
/// parent's own approvals, so pre-existing parent frames stay byte-identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalSubagentOrigin {
    /// The originating child's subagent id, from the parent session's
    /// durable subagent control records.
    pub subagent_id: String,
    /// The child session stream id whose records carry this approval.
    pub child_session_id: String,
    /// The child run that parked on this approval.
    pub child_run_id: String,
}

/// Open approval subject union. Unknown kinds are rendered generically and
/// never auto-approved by clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalSubject {
    /// Open discriminator: `shell | fileAccess | network | unixSocket | process | tool`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stages: Option<Vec<ApprovalStage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<ApprovalOrigin>,
}

/// The `ApprovalSubject.kind` wire words — one source for the session-view fold
/// that writes them and every client that inverts them.
impl ApprovalSubject {
    pub const KIND_SHELL: &'static str = "shell";
    pub const KIND_FILE_ACCESS: &'static str = "fileAccess";
    pub const KIND_NETWORK: &'static str = "network";
    pub const KIND_UNIX_SOCKET: &'static str = "unixSocket";
    pub const KIND_PROCESS: &'static str = "process";
    pub const KIND_TOOL: &'static str = "tool";
    /// `access` wire words (`fileAccess` reads/writes; `process` control).
    pub const ACCESS_READ: &'static str = "read";
    pub const ACCESS_WRITE: &'static str = "write";
    pub const ACCESS_CONTROL: &'static str = "control";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalOrigin {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalStage {
    pub requirement_id: ApprovalRequirementRef,
    pub position: usize,
    pub total_stages: usize,
    pub argv: Vec<String>,
    pub argv_complete: bool,
    pub resolution: ApprovalStageResolution,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_prefix: Option<ApprovalSuggestedPrefix>,
}

/// The `ApprovalOrigin.kind` wire words (same single-source rule).
impl ApprovalOrigin {
    pub const KIND_SHELL_COMMAND: &'static str = "shellCommand";
    pub const KIND_URL: &'static str = "url";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalStageResolution {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argv_prefix: Option<Vec<String>>,
}

/// The `ApprovalStageResolution.kind` wire words (same single-source rule).
impl ApprovalStageResolution {
    pub const KIND_UNRESOLVED: &'static str = "unresolved";
    pub const KIND_KNOWN_SAFE: &'static str = "knownSafe";
    pub const KIND_POLICY_ALLOW: &'static str = "policyAllow";
    pub const KIND_ALLOW_ONCE: &'static str = "allowOnce";
    pub const KIND_POLICY_AMENDMENT: &'static str = "policyAmendment";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalSuggestedPrefix {
    pub argv_prefix: Vec<String>,
    pub label: String,
}
