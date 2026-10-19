// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::SourceRange;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// Full params shared by `userInput/request` and `userInput/requested`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputRequestParams {
    pub session_id: String,
    pub user_input_id: String,
    pub turn_id: String,
    pub item_id: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub view_cursor: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_range: Option<SourceRange>,
    pub questions: Vec<UserInputQuestion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_resolution_ms: Option<u64>,
}

/// `userInput/settled` params: the first durable prompt settlement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputSettledParams {
    pub session_id: String,
    pub view_cursor: String,
    pub source_range: SourceRange,
    pub user_input_id: String,
    pub outcome: UserInputOutcome,
    pub answers: Vec<UserInputAnswer>,
    pub clarification: Option<UserInputClarification>,
    pub reason: Option<String>,
    pub decided_by_command_id: Option<String>,
    /// The decision time as RFC3339, projected from the durable settlement
    /// record's own stamp: always present on the wire (schema-required,
    /// `null`-able); decoders still tolerate its absence, and current hosts
    /// always populate it.
    #[serde(default)]
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputQuestion {
    pub id: String,
    pub header: String,
    pub question: String,
    pub selection: UserInputSelection,
    pub options: Vec<UserInputOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputSelection {
    pub mode: UserInputSelectionMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_selections: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_selections: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserInputSelectionMode {
    Single,
    Multiple,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<UserInputOptionPreview>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputOptionPreview {
    pub format: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputAnswer {
    pub question_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_label: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputClarification {
    pub format: String,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum UserInputOutcome {
    Answered,
    Cancelled,
    Interrupted,
    Clarified,
    TimedOut,
    Aborted,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}
