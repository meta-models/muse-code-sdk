// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::ApprovalStageResolution;
use crate::msp::error::ApprovalRequirementRef;
use serde::Deserialize;
use serde::Serialize;

/// One option the server offers for deciding an approval. Clients pick one and
/// send its `choiceId` in `approval/decide`; they never build their own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalChoice {
    /// The id to send as `choiceId` in `approval/decide`. The set of ids is
    /// open, so show `label` and do not base behavior on specific ids.
    pub choice_id: String,
    /// The human-readable label to show for this choice.
    pub label: String,
    /// The decision this choice applies, so a client can act on approve or
    /// reject without knowing choice ids.
    pub decision: ApprovalDecision,
    /// The grant duration this choice declares: `once` (this request only),
    /// `session` (the rest of the session) or `localPersistent` (saved in the
    /// local policy store).
    pub scope: ApprovalChoiceScope,
    /// A human-readable preview of what this choice grants, such as the policy
    /// rule it would create; show it exactly as given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_preview: Option<String>,
    /// `true` when this choice takes optional `feedback` text in
    /// `approval/decide`, which reaches the model as guidance. Omitted when
    /// `false`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub accepts_feedback: bool,
}

/// The kind of decision a choice applies or an approval received. The set is
/// open, so newer hosts may send values this version does not list.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalDecision {
    /// `approved`: the action may run this once; nothing is remembered.
    Approved,
    /// `approvedForSession`: the action is approved, and matching requests are
    /// approved automatically for the rest of the session.
    ApprovedForSession,
    /// `approvedPolicyAmendment`: the action is approved and an allow rule is
    /// added to policy; the choice's `scope`, or the resolution's `amendment`,
    /// says how long the rule lasts.
    ApprovedPolicyAmendment,
    /// `denied`: the action is denied and does not run; no rule is saved.
    Denied,
    /// `deniedPolicyAmendment`: the action is denied and a deny rule is added
    /// to policy.
    DeniedPolicyAmendment,
    /// `timedOut`: no decision arrived in time, and the action does not run.
    TimedOut,
    /// `abort`: the action was rejected and does not run. It is the decision
    /// behind the reject choice, a turn interrupt, and cleanup after a host
    /// restart.
    Abort,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// How long a grant made by a choice lasts. The set is open, so newer hosts may
/// send other values.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalChoiceScope {
    /// `once`: the choice applies to this request only.
    Once,
    /// `session`: the choice creates a rule that applies for the rest of the
    /// session.
    Session,
    /// `localPersistent`: the choice creates a rule saved in the local policy
    /// store, which lasts beyond this session.
    LocalPersistent,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// The change an `approval/updated` event reports. `kind` says what happened,
/// and only the fields for that kind are present.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalChange {
    /// What happened: for example `stageResolved` (a shell stage was
    /// satisfied), `policyPersistence` (saving a rule succeeded or failed),
    /// `reviewStarted` or `reviewCompleted` (the automated LLM judge started or
    /// finished reviewing), `restartRecovered` (a host restart recovered this
    /// approval: either the host first resolves it `abort` and a re-ask comes
    /// as a new approval with a new `approvalId`, or it stays pending under
    /// the same `approvalId` with refreshed choices) or `alreadyTerminal`
    /// (recovery found it already decided). The set is open, so newer hosts
    /// may add kinds.
    pub kind: String,
    /// The stage requirement that was satisfied. Present only when `kind` is
    /// `stageResolved`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requirement_id: Option<ApprovalRequirementRef>,
    /// The `choiceId` that satisfied the stage. Present only when `kind` is
    /// `stageResolved`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choice_id: Option<String>,
    /// The decision the chosen option applied to the stage. Present only when
    /// `kind` is `stageResolved`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision: Option<ApprovalDecision>,
    /// Whether saving the policy rule succeeded or failed; present only when
    /// `kind` is `policyPersistence`. A failure does not undo the decision;
    /// only the saved rule is missing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<ApprovalPersistenceStatus>,
    /// Why saving the policy rule failed, as human-readable text. Present only
    /// when `kind` is `policyPersistence` and `status` is `failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// A recovery detail: whether the command was re-parsed during recovery.
    /// Present only when `kind` is `restartRecovered`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reparsed: Option<bool>,
    /// A recovery detail: whether the action could run without a new decision.
    /// Present only when `kind` is `restartRecovered`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub executable: Option<bool>,
}

/// The result of saving a granted rule to the local policy store. The set is
/// open, so newer hosts may send other values.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalPersistenceStatus {
    /// `succeeded`: the rule was saved.
    Succeeded,
    /// `failed`: the rule could not be saved, though the decision still stands.
    /// See `reason`.
    Failed,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// Whether an approval's final decision lets the action run. The set is open,
/// so newer hosts may send other values.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalPolicyResult {
    /// `allow`: the action may run.
    Allow,
    /// `deny`: the action is blocked.
    Deny,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// The policy rule a decision created, in display form; the full rule is not
/// included.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalAmendment {
    /// How long the rule lasts: `session` or `localPersistent`.
    pub durability: ApprovalAmendmentDurability,
    /// A human-readable preview of the rule, for display.
    pub rule_preview: String,
}

/// How long a rule created by an approval decision lasts. The set is open, so
/// newer hosts may send other values.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalAmendmentDurability {
    /// `session`: the rule applies for the rest of this session.
    Session,
    /// `localPersistent`: the rule is saved in the local policy store and lasts
    /// beyond this session.
    LocalPersistent,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// Who or what made an approval's final decision. The set is open, so newer
/// hosts may send other values.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalResolvedBy {
    /// `user`: decided neither by policy nor by the LLM judge: a person's
    /// `approval/decide` or turn interrupt, or cleanup after a host restart.
    User,
    /// `policy`: policy decided automatically, for example by denying the
    /// action when no one can be asked.
    Policy,
    /// `llmJudge`: the automated LLM judge decided.
    LlmJudge,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// How one stage of a `shell` approval was resolved when the decision became
/// final.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalStageEvidence {
    /// The stage's requirement id.
    pub requirement_id: ApprovalRequirementRef,
    /// The stage's 1-based position in the command.
    pub position: usize,
    /// The total number of stages in the command.
    pub total_stages: usize,
    /// The stage's command words as parsed.
    pub argv: Vec<String>,
    /// How the stage was resolved at the final decision.
    pub resolution: ApprovalStageResolution,
}
