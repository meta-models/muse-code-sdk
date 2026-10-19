// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::command::CommandAckStatus;
use serde::Deserialize;
use serde::Serialize;

/// `session/leave` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLeaveParams {
    /// Client-minted UUIDv7 command identity.
    pub command_id: String,
    /// The exact loaded session whose ownership is to be released.
    pub session_id: String,
    /// Explicitly cancel unfinished work before leaving. Omitted is `false`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop: Option<bool>,
}

/// The admission-only `session/leave` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionLeaveResult {
    pub command_id: String,
    pub status: CommandAckStatus,
}

/// Current producer outcomes for `session/leaveCompleted`; receiver-open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
#[non_exhaustive]
pub struct SessionLeaveOutcome(pub String);

impl SessionLeaveOutcome {
    pub const RELEASED: &'static str = "released";
    pub const FAILED: &'static str = "failed";
}

/// Current producer failure reasons for `session/leaveCompleted`;
/// receiver-open for additive future reasons.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
#[non_exhaustive]
pub struct SessionLeaveFailureReason(pub String);

impl SessionLeaveFailureReason {
    pub const TIMEOUT: &'static str = "timeout";
    pub const RESPONSE_UNDELIVERED: &'static str = "responseUndelivered";
    pub const PERSISTENCE_FAILED: &'static str = "persistenceFailed";
    pub const RUNTIME_FAILED: &'static str = "runtimeFailed";
    pub const ABANDONED: &'static str = "abandoned";
}

/// Params of the protected, non-view leave terminal notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionLeaveCompletedParams {
    pub session_id: String,
    pub command_id: String,
    pub outcome: SessionLeaveOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<SessionLeaveFailureReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_cursor: Option<String>,
}
