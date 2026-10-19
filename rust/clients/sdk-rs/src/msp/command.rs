// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// The ack-status vocabulary: `"accepted"` for every admitted command;
/// `session/compact` alone may answer `"noop"`. Closed: the protocol spec names
/// exactly these two values, so SDK clients get a discriminated type and
/// validation catches a wrong status — and a client that received a third value
/// would have been told nothing it can act on, unlike [`TurnStartDisposition`],
/// where "acked, not otherwise classified" is a usable reading.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CommandAckStatus {
    /// The command was admitted and durably recorded.
    Accepted,
    /// `session/compact`'s nothing-to-do SUCCESS arm — the one non-`accepted`
    /// value in v1.
    Noop,
}

impl CommandAckStatus {
    /// `COUNT` is an exhaustive match, so adding a variant fails THIS constant
    /// to compile until the count moves — a stale [`Self::ALL`] becomes a
    /// length mismatch instead of a silently incomplete hand-list.
    const COUNT: usize = match Self::Accepted {
        Self::Accepted | Self::Noop => 2,
    };

    /// Every status, for vocabulary-complete iteration.
    pub const ALL: [Self; Self::COUNT] = [Self::Accepted, Self::Noop];

    /// The wire spelling. Wildcard-free: a new status variant fails to compile
    /// until it is spelled here.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Noop => "noop",
        }
    }
}

/// The uniform command acknowledgement: admission only, never an outcome.
/// `session/compact` alone may answer `"noop"`; every other command answers
/// `"accepted"`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CommandAcceptedResult {
    /// Echo of the client-minted UUIDv7 `commandId`.
    pub command_id: String,
    /// `"accepted"` for every admitted command.
    pub status: CommandAckStatus,
}

/// Params for `subagent/interrupt`, `subagent/stop`, and `subagent/close`: a
/// child target plus an optional human-readable reason that is preserved on the
/// durable effect record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentOwnerReasonParams {
    /// Target session.
    pub session_id: String,
    /// Client-minted UUIDv7 command id.
    pub command_id: String,
    /// Durable child id.
    pub subagent_id: String,
    /// Optional reason, preserved on the durable owner-command record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Params for `subagent/resume`, `subagent/reopen`, and `subagent/readResult`:
/// the bare child target.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTargetParams {
    /// Target session.
    pub session_id: String,
    /// Client-minted UUIDv7 command id.
    pub command_id: String,
    /// Durable child id.
    pub subagent_id: String,
}

/// Params for `subagent/sendMessage` and `subagent/followupTask`: a child
/// target plus the input body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInputParams {
    /// Target session.
    pub session_id: String,
    /// Client-minted UUIDv7 command id.
    pub command_id: String,
    /// Durable child id.
    pub subagent_id: String,
    /// The note/task text: trimmed with Unicode-whitespace semantics, rejected
    /// when empty after trimming, delivered trimmed with multibyte content
    /// byte-for-byte intact.
    pub body: String,
}
