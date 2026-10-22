// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::error::ApprovalRequirementRef;
use crate::msp::method::session::EffectiveApprovalModeState;
use crate::msp::method::turn::CommandStatus;
use crate::msp::view::approval::ApprovalRequestParams;
use crate::msp::view::state::ApprovalMode;
use crate::msp::view::user_input::UserInputRequestParams;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `approval/decide` params: the decision. A standard command — requires the
/// session loaded on this host, requires `commandId`, durable intake before
/// ack, value-identical replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDecideParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The approval being decided.
    pub approval_id: String,
    /// Must equal the approval's `currentRequirementId`. The multi-stage race
    /// guard: a decision aimed at stage 1 can never accidentally satisfy stage
    /// 2, and a stale value is -32053.
    pub requirement_id: ApprovalRequirementRef,
    /// One of the current `availableChoices`; else -32052.
    pub choice_id: String,
    /// Free-text guidance delivered to the model with the denial. Only valid on
    /// choices with `acceptsFeedback`. Never persisted in the durable audit
    /// record (live steer only), so it is absent from `approval/resolved`.
    /// Omitted and explicit `null` both mean "no feedback".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub feedback: Option<String>,
}

/// `approval/decide` result. Admission-ack rules still apply: the authoritative
/// outcome is `approval/resolved` / `approval/updated` on the view stream.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalDecideResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The approval this decision was applied to.
    pub approval_id: String,
    /// `false` when the choice satisfied a stage but further requirements
    /// remain (the approval stays pending and an updated `approval/request`
    /// follows); `true` when this decision produced the terminal
    /// `DecisionApplied`.
    pub terminal: bool,
}

/// `approval/listPending` params: the pull dual of the re-issued requests. A
/// log-fold read — no lease, works on loaded and unloaded sessions, never
/// subscribes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalListPendingParams {
    /// The session to read.
    pub session_id: String,
}

/// `approval/listPending` result. Ordering is by opening `viewCursor`; empty
/// arrays when nothing is pending. The result is point-in-time — to act on it
/// race-safely, `approval/decide` carries the `requirementId` guard regardless
/// of how the client learned the state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalListPendingResult {
    /// Exactly the `approval/request` params, one per pending approval.
    pub approvals: Vec<ApprovalRequestParams>,
    /// Exactly the `userInput/request` params, one per pending prompt.
    pub user_inputs: Vec<UserInputRequestParams>,
}

/// `session/setApprovalMode` params: switch the session's approval enforcement
/// mode mid-session. A standard command.
///
/// **Select, never create.** A client may *select* a mode the host's
/// configuration already defines; it may not construct one, supply inline
/// rules, or otherwise describe a policy on the wire — which is why
/// [`ApprovalMode`] is closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetApprovalModeParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The preconfigured mode to select. The requesting actor is recorded from
    /// the connection's `clientInfo.name`.
    pub mode: ApprovalMode,
}

/// Whether a mode change did anything, mirroring
/// `ApprovalReconfigureApplyOutcome`. Apply failures are `commandRejected`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalModeApplyOutcome {
    /// The mode changed.
    Completed,
    /// Already in that mode; a success that writes no relaxation audit fact.
    Noop,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `session/setApprovalMode` result. Applies next-action — an in-flight tool
/// action's pending approval is not retroactively decided by a mode change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionSetApprovalModeResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// Whether the change did anything.
    pub apply_outcome: ApprovalModeApplyOutcome,
    /// The folded effective-mode projection — the same object the `Session`
    /// carries as `approvalMode`.
    pub effective_mode: EffectiveApprovalModeState,
}
