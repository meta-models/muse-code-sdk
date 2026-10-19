// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::ApprovalStageResolution;
use crate::msp::error::ApprovalRequirementRef;
use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalChoice {
    pub choice_id: String,
    pub label: String,
    pub decision: ApprovalDecision,
    pub scope: ApprovalChoiceScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_preview: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub accepts_feedback: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalDecision {
    Approved,
    ApprovedForSession,
    ApprovedPolicyAmendment,
    Denied,
    DeniedPolicyAmendment,
    TimedOut,
    Abort,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalChoiceScope {
    Once,
    Session,
    LocalPersistent,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalChange {
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<ApprovalRequirementRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choice_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<ApprovalDecision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ApprovalPersistenceStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reparsed: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalPersistenceStatus {
    Succeeded,
    Failed,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalPolicyResult {
    Allow,
    Deny,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalAmendment {
    pub durability: ApprovalAmendmentDurability,
    pub rule_preview: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalAmendmentDurability {
    Session,
    LocalPersistent,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalResolvedBy {
    User,
    Policy,
    LlmJudge,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalStageEvidence {
    pub requirement_id: ApprovalRequirementRef,
    pub position: usize,
    pub total_stages: usize,
    pub argv: Vec<String>,
    pub resolution: ApprovalStageResolution,
}
