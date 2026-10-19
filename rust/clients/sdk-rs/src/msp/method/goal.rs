// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::turn::CommandStatus;
use serde::Deserialize;
use serde::Serialize;

/// `goal/set` params: set the session's goal objective.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSetParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The objective text; required, non-empty after Unicode-whitespace trim
    /// (the trimmed text is the payload). Empty-after-trim is `-32602
    /// invalidParams`.
    pub objective: String,
}

/// `goal/edit` params: replace the current goal's objective. Same shape as
/// `goal/set`; the verbs differ in their `missing_goal` precondition, not their
/// payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalEditParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The replacement objective; same trim/non-empty rule as `goal/set`.
    pub objective: String,
}

/// `goal/clear` params. An `objective` here is an unknown field and rejects
/// `-32602 invalidParams` — the bare verbs carry exactly this pair.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalClearParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
}

/// `goal/pause` params; shape as `goal/clear`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalPauseParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
}

/// `goal/resume` params; shape as `goal/clear`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalResumeParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
}

/// The shared goal ack, admission-only: all five verbs answer this one shape,
/// differing only in when `turnId` is present.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct GoalCommandResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// Present by exactly the four result cases: an idle wake carries the fresh
    /// goal turn's id; a busy `set`/`edit`/`resume` carries the admission-time
    /// active turn's id (a routing fact, not a delivery promise);
    /// `pause`/`clear` never carry it; an idle admission whose resulting goal
    /// is not unfinished parks the notification and carries none.
    /// **Additive-optional**: absent means "no turn named", never fabricated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}
