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
    /// The leave command's id.
    pub command_id: String,
    /// The admission status, `accepted` once the leave is admitted. The final
    /// result arrives later as `session/leaveCompleted`. Sending the same leave
    /// command again returns `accepted` and re-pushes the recorded result if
    /// there is one, from the host that ran the leave (for as long as it runs,
    /// even after the release) or from a host that has the session loaded
    /// (after a host crash, `abandoned` among them). Any other host treats it
    /// as a fresh leave: a durable host that has not loaded the session refuses
    /// it with `sessionNotLoaded` until it is resumed there.
    pub status: CommandAckStatus,
}

/// Current producer outcomes for `session/leaveCompleted`; receiver-open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
#[non_exhaustive]
pub struct SessionLeaveOutcome(pub String);

impl SessionLeaveOutcome {
    /// `released`: the host released the session; `viewCursor` is set.
    pub const RELEASED: &'static str = "released";
    /// `failed`: the leave did not end in a release this host can report;
    /// `reason` says why.
    pub const FAILED: &'static str = "failed";
}

/// Current producer failure reasons for `session/leaveCompleted`;
/// receiver-open for additive future reasons.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
#[non_exhaustive]
pub struct SessionLeaveFailureReason(pub String);

impl SessionLeaveFailureReason {
    /// `timeout`: the session did not finish shutting down within the leave's
    /// window. The host keeps the session.
    pub const TIMEOUT: &'static str = "timeout";
    /// `responseUndelivered`: the leave's acceptance could not be delivered to
    /// the client. The host keeps the session.
    pub const RESPONSE_UNDELIVERED: &'static str = "responseUndelivered";
    /// `persistenceFailed`: saving the session or releasing its writer lease
    /// failed. The host keeps the session.
    pub const PERSISTENCE_FAILED: &'static str = "persistenceFailed";
    /// `runtimeFailed`: the session's runtime failed while shutting down. The
    /// host keeps the session.
    pub const RUNTIME_FAILED: &'static str = "runtimeFailed";
    /// `abandoned`: no host owns this leave's result. A host that later took
    /// the session's writer recorded it because no result was recorded and
    /// either the leave had reached its release point or the host that ran it
    /// was proven dead; it never means the release failed. Recording it pushes
    /// nothing; a client sees it only as the `session/leaveCompleted`
    /// re-pushed after it sends the same leave command again.
    pub const ABANDONED: &'static str = "abandoned";
}

/// Params of the protected, non-view leave terminal notification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionLeaveCompletedParams {
    /// The session the leave was for.
    pub session_id: String,
    /// The leave command's id, matching the `session/leave` request.
    pub command_id: String,
    /// How the leave ended: `released` or `failed`. The set is open, so newer
    /// hosts may add outcomes.
    pub outcome: SessionLeaveOutcome,
    /// Why the leave failed. Present when `outcome` is `failed`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<SessionLeaveFailureReason>,
    /// The session's view cursor at release: everything up to it was folded
    /// before the host let go. Present when `outcome` is `released`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_cursor: Option<String>,
}
