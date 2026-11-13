// @generated from the MSP stable schema and protocol sources; do not edit by hand.

pub use data::ErrorData;
pub use kind::ErrorKind;
pub use registry::ErrorCode;
use serde::Deserialize;
use serde::Serialize;

pub(crate) mod data;
pub(crate) mod definition;
pub(crate) mod kind;
pub(crate) mod registry;

/// Identifies one requirement of an approval: for a `shell` approval, one
/// stage. A client sends it back as `requirementId` in `approval/decide`, and a
/// stale-requirement error names the current one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequirementRef {
    /// The approval this requirement belongs to.
    pub approval_id: String,
    /// The requirement's index within the approval, counting from 0; an
    /// approval with a single requirement uses 0.
    pub source_index: usize,
}

/// Winning terminal returned to a losing `approval/decide` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalResolutionSummary {
    /// The winning decision, as an `approval/resolved` decision value such as
    /// `approved` or `abort`.
    pub decision: String,
    /// Who made the winning decision, such as `user`, `policy` or `llmJudge`.
    pub resolved_by: String,
    /// The view cursor of the winning `approval/resolved` event.
    pub view_cursor: String,
}

/// Winning terminal returned to a late user-input command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputSettlementSummary {
    /// How the prompt settled, as a `userInput/settled` outcome value such as
    /// `answered` or `timedOut`.
    pub outcome: String,
    /// The view cursor of the `userInput/settled` event that recorded the
    /// settlement.
    pub view_cursor: String,
}

/// Winning terminal returned to a losing `admission/decide` command:
/// `resolvedBy` is omitted on timeout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct AdmissionResolutionSummary {
    /// The winning decision, such as `allow_once` or `timedOut`.
    pub decision: String,
    /// Who made the winning decision; absent when no person decided, for
    /// example a timeout, an automatic allow, or a cancelled or retired
    /// request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    /// The view cursor of the winning `admission/resolved` event.
    pub view_cursor: String,
}

/// The `error` member of an error response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ErrorObject {
    /// Registry code. Typed as a plain integer on the wire; the value domain is
    /// the registry below.
    pub code: i64,
    /// Human-readable message. Never a branch point.
    pub message: String,
    /// Structured detail; carries `kind` when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Box<ErrorData>>,
}
