// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::event::TurnError;
use crate::msp::view::event::TurnTerminal;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// A late-joiner pointer at an unsettled server-initiated request. The full
/// payloads arrive as re-issued server-to-client requests right after a
/// `session/resume` response; `session/read` never re-issues them.
///
/// The protocol defines two kind-discriminated entry shapes (`{kind:
/// "approval", approvalId, viewCursor}` / `{kind: "userInput", userInputId,
/// viewCursor}`). This type is one flat object with both ids optional, as for
/// `ApprovalSubject` and `TurnInputPart`, because the v1 model names no
/// object-variant union; the serialized JSON is the same, but the published
/// schema also accepts `{"kind":"approval","userInputId":…}` and an entry
/// carrying no id at all. Unlike `TurnInputPart.type`, `kind` here is an OPEN
/// enum.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PendingRequestPointer {
    /// The discriminator; v1 values `approval` and `userInput`.
    pub kind: PendingRequestKind,
    /// Present on an `approval` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    /// Present on a `userInput` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input_id: Option<String>,
    /// The cursor the request opened at.
    pub view_cursor: String,
}

/// The `pendingRequests` discriminator. Open enum, v1 values `approval` and
/// `userInput`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum PendingRequestKind {
    /// An unsettled approval.
    Approval,
    /// An unsettled user-input prompt.
    UserInput,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `abnormalEnd` on `session/resume`: the load found the session's latest serve
/// segment without a clean end and recorded (or had already recorded) the
/// `crash_inferred` backstop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct AbnormalEnd {
    /// RFC 3339 time of the session's latest serve activity (the time the
    /// gate-off notice shows); absent when the log has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
}

/// `cronQuarantine` on `session/resume`: this resume's own load opened the
/// session cron store and quarantined a corrupt database.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CronQuarantine {
    /// Host-local path the corrupt database was moved to; the path the
    /// gate-off warning shows.
    pub quarantine_path: String,
}

/// `missingPredecessor` on `session/resume`: this resume's own load found the
/// session's committed `SessionStarted` naming a predecessor whose retained log
/// is not in the session store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct MissingPredecessor {
    /// The missing predecessor's session id, the one the gate-off notice
    /// names.
    pub session_id: String,
}

/// `modelIdRefusal` on `session/resume`: the host refused this resume's
/// `modelId`, so the session opened on its recorded model.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelIdRefusal {
    /// The `modelId` the resume carried, verbatim.
    pub model_id: String,
    /// The host's reason, display text a client shows as is.
    pub reason: String,
}

/// `autoRecovery` on `session/resume` (amendment 26387/68619, owner decision
/// G-23): the outcome of this resume's own load when it ran with the
/// `resume_auto_recover` gate on and the session's effective `recoveryMode`
/// ON. Output only; no request member asks for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct AutoRecovery {
    /// What the load did.
    pub outcome: AutoRecoveryOutcome,
    /// Present only when `outcome` is `refused`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<AutoRecoveryReason>,
    /// The recovery turn's id (the `turnId` of its `turn/started`); present
    /// only when `outcome` is `continued`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

/// The `autoRecovery` outcome (the amendment's decision table). Open enum.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum AutoRecoveryOutcome {
    /// The recovery turn re-made the interrupted request.
    Continued,
    /// The previous run ended cleanly, or the session was live here.
    NotCrashed,
    /// Nothing was in flight and no Goal was Active; the hold is released.
    NothingToContinue,
    /// A Goal was Active between turns and continues.
    GoalResumed,
    /// An answerable question is pending and keeps waiting.
    AwaitingUser,
    /// Auto-recover could not proceed; the governing rules hold applies.
    Refused,
    /// A value introduced by a newer server, kept verbatim so an older
    /// client can report it without failing the parse.
    Unknown(String),
}

impl AutoRecoveryOutcome {
    /// The exact wire spelling, including a value this build does not know.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Continued => "continued",
            Self::NotCrashed => "notCrashed",
            Self::NothingToContinue => "nothingToContinue",
            Self::GoalResumed => "goalResumed",
            Self::AwaitingUser => "awaitingUser",
            Self::Refused => "refused",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for AutoRecoveryOutcome {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AutoRecoveryOutcome {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "continued" => Self::Continued,
            "notCrashed" => Self::NotCrashed,
            "nothingToContinue" => Self::NothingToContinue,
            "goalResumed" => Self::GoalResumed,
            "awaitingUser" => Self::AwaitingUser,
            "refused" => Self::Refused,
            _ => Self::Unknown(value),
        })
    }
}

/// Why `autoRecovery` was `refused`. Open enum.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum AutoRecoveryReason {
    /// A run was interrupted under an Active Goal whose crash pause this
    /// host could not hold back.
    ContinuationUnavailable,
    /// A Goal was Active between turns and this host could not hold back
    /// its crash pause.
    GoalResumeUnavailable,
    /// The Goal store could not be read.
    GoalUnavailable,
    /// The open reopened from a resume-fallback recovery checkpoint, whose
    /// history no longer holds the interrupted work.
    ResumeFallback,
    /// A recovery steer a crash left undelivered could not be withdrawn.
    StaleSteerNotWithdrawn,
    /// The recovery steer could not be saved.
    SteerNotSaved,
    /// A value introduced by a newer server, kept verbatim so an older
    /// client can report it without failing the parse.
    Unknown(String),
}

impl AutoRecoveryReason {
    /// The exact wire spelling, including a value this build does not know.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::ContinuationUnavailable => "continuationUnavailable",
            Self::GoalResumeUnavailable => "goalResumeUnavailable",
            Self::GoalUnavailable => "goalUnavailable",
            Self::ResumeFallback => "resumeFallback",
            Self::StaleSteerNotWithdrawn => "staleSteerNotWithdrawn",
            Self::SteerNotSaved => "steerNotSaved",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for AutoRecoveryReason {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AutoRecoveryReason {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "continuationUnavailable" => Self::ContinuationUnavailable,
            "goalResumeUnavailable" => Self::GoalResumeUnavailable,
            "goalUnavailable" => Self::GoalUnavailable,
            "resumeFallback" => Self::ResumeFallback,
            "staleSteerNotWithdrawn" => Self::StaleSteerNotWithdrawn,
            "steerNotSaved" => Self::SteerNotSaved,
            _ => Self::Unknown(value),
        })
    }
}

/// The cold recall seed on `session/resume` and `session/read` results: at most
/// one, the latest blocked Main prompt — exactly the host's mirror of
/// `prompt_recovery::replay::ReplayInput`'s choice.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct BlockedPrompt {
    /// The exact submitted prompt, verbatim — no truncation, no
    /// normalization; recall fidelity requires exactness.
    pub text: String,
}

/// The last `turn/completed` the session-view fold applied, restated on
/// `session/resume` and `session/read` so a reopened session can report a
/// failed last turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct LastTurn {
    /// The turn's id, as on its `turn/completed`; clients deduplicate a live
    /// `turn/completed` against this member by it.
    pub turn_id: String,
    /// The turn's terminal.
    pub terminal: TurnTerminal,
    /// Copied when the `turn/completed` carried it; a synthesized host-death
    /// `failed` terminal carries only this (`crash`, `crash_inferred`, or
    /// `incomplete`). Free display text: clients never branch on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Copied when the `turn/completed` carried it: runtime `failed` terminals
    /// do, host-death `failed` terminals do not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<TurnError>,
}
