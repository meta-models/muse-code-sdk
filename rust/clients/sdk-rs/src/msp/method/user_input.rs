// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::turn::CommandStatus;
use crate::msp::view::user_input::UserInputAnswer;
use crate::msp::view::user_input::UserInputClarification;
use serde::Deserialize;
use serde::Serialize;

/// `userInput/answer` params: answer every question.
///
/// Each answer carries `questionId` then exactly one of `selectedLabel` (single
/// mode), `selectedLabels` (multiple mode, within min/max bounds), or
/// `freeText` (<=500 chars); plus an optional `note` (<=500). Answers that do
/// not match the prompt fail -32057 `userInputAnswerInvalid`. Image
/// `attachments` are a **reserved** field in v1, rejected if sent, because the
/// blob-upload path they reference is reserved in the protocol spec.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputAnswerParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The prompt being answered.
    pub user_input_id: String,
    /// One entry per question.
    pub answers: Vec<UserInputAnswer>,
}

/// `userInput/answer` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputAnswerResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The prompt this answer settled.
    pub user_input_id: String,
}

/// `userInput/cancel` params: decline to answer; the tool call resolves with a
/// cancelled result the model sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputCancelParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The prompt being declined.
    pub user_input_id: String,
    /// Why the prompt was declined.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `userInput/cancel` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputCancelResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The prompt this cancellation settled.
    pub user_input_id: String,
}

/// `userInput/clarify` params: answer with a free-form clarification instead of
/// the structured options — the "let me explain" path; the model receives the
/// clarification text and re-decides.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputClarifyParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The prompt being clarified.
    pub user_input_id: String,
    /// `format` is `"text"` in v1 (open); `content` is <=500 chars.
    pub clarification: UserInputClarification,
}

/// `userInput/clarify` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputClarifyResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The prompt this clarification settled.
    pub user_input_id: String,
}

/// `userInput/interrupt` params: interrupt the named prompt carrying confirmed
/// partial answers, then stop the turn.
///
/// `answers` is optional and, when present, follows exactly the
/// `userInput/answer` shape and limits (same `questionId` + one-of + `note`
/// rules, same -32057 `userInputAnswerInvalid` on mismatch); absent or
/// empty means interrupt with no confirmed answers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputInterruptParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The prompt being interrupted.
    pub user_input_id: String,
    /// Confirmed partial answers the named settlement carries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answers: Option<Vec<UserInputAnswer>>,
}

/// `userInput/interrupt` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputInterruptResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The prompt this interruption settled.
    pub user_input_id: String,
}

/// `userInput/engaged` params: a fire-and-forget engagement note — the user
/// started interacting with a timed prompt, so the host disarms that prompt's
/// auto-resolution countdown. No result, no errors, no `commandId`, no ledger
/// row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputEngagedParams {
    /// The target session.
    pub session_id: String,
    /// The prompt being engaged.
    pub user_input_id: String,
}
