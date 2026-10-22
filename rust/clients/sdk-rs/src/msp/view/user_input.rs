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
    /// The session that owns the prompt.
    pub session_id: String,
    /// The prompt's stable id. Pass it to `userInput/answer`,
    /// `userInput/cancel`, `userInput/clarify` and `userInput/interrupt`, and
    /// use it to match the later `userInput/settled`.
    pub user_input_id: String,
    /// The turn whose tool call is waiting on this prompt.
    pub turn_id: String,
    /// The `toolCall` view item of the tool call waiting on this prompt.
    pub item_id: String,
    /// The provider's id for the tool call that opened the prompt.
    pub tool_call_id: String,
    /// The name of the tool that opened the prompt.
    pub tool_name: String,
    /// The cursor of the `userInput/requested` event for this prompt. A client
    /// that missed the request can read the same payload at this cursor with
    /// `view/page`.
    pub view_cursor: String,
    /// The stored records this prompt was folded from, when sent: an opaque
    /// token clients must not interpret.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_range: Option<SourceRange>,
    /// The questions to ask, one to three, in order.
    pub questions: Vec<UserInputQuestion>,
    /// The auto-resolution time per question, in milliseconds: a prompt nobody
    /// engages with settles as `timedOut` after this value times the number of
    /// questions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_resolution_ms: Option<u64>,
}

/// `userInput/settled` params: the first durable prompt settlement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputSettledParams {
    /// The session that owns the prompt.
    pub session_id: String,
    /// This event's view cursor: opaque, and strictly increasing within the
    /// session.
    pub view_cursor: String,
    /// The stored records this event was folded from: an opaque token clients
    /// must not interpret.
    pub source_range: SourceRange,
    /// The prompt that settled. Accept a settlement even for a prompt whose
    /// request you never saw.
    pub user_input_id: String,
    /// How the prompt ended.
    pub outcome: UserInputOutcome,
    /// The recorded answers: one per question for `answered`, any confirmed
    /// partial answers for `interrupted`, and empty for every other outcome.
    pub answers: Vec<UserInputAnswer>,
    /// The user's free-form clarification when the outcome is `clarified`;
    /// `null` otherwise.
    pub clarification: Option<UserInputClarification>,
    /// The reason, when one applies: the optional reason given with a cancel,
    /// or why an `aborted` prompt was closed; `null` otherwise.
    pub reason: Option<String>,
    /// The `commandId` of the client command that settled the prompt; `null`
    /// when no command did, for example after a timeout or an abort.
    pub decided_by_command_id: Option<String>,
    /// The decision time as RFC3339, projected from the durable settlement
    /// record's own stamp: always present on the wire (schema-required,
    /// `null`-able); decoders still tolerate its absence, and current hosts
    /// always populate it.
    #[serde(default)]
    pub decided_at: Option<String>,
}

/// One question in a user-input prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputQuestion {
    /// The question's id, unique within the prompt and at most 64 characters.
    /// An answer names it in `questionId`.
    pub id: String,
    /// A short title for the question, at most 12 characters.
    pub header: String,
    /// The full question text to show the user.
    pub question: String,
    /// Whether the user picks one option or several.
    pub selection: UserInputSelection,
    /// The options offered, two or three, in order.
    pub options: Vec<UserInputOption>,
}

/// How many options the user may pick for a question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputSelection {
    /// `single` or `multiple`: whether an answer selects one option or several.
    pub mode: UserInputSelectionMode,
    /// The minimum selection count for a `multiple` answer. Sent only in
    /// `multiple` mode; when absent the minimum is 1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_selections: Option<usize>,
    /// The most options the user may pick. Sent only in `multiple` mode; when
    /// absent the maximum is the number of options.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_selections: Option<usize>,
}

/// Whether a question takes one option or several.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UserInputSelectionMode {
    /// `single`: the user picks one option, answered with `selectedLabel`, or
    /// gives a free-text answer instead.
    Single,
    /// `multiple`: an answer may select several options, within the
    /// question's bounds. Options never carry a preview in this mode.
    Multiple,
}

/// One option offered for a question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputOption {
    /// The option's text, at most 80 characters and unique within its question;
    /// an answer selects the option by this exact label.
    pub label: String,
    /// An optional longer explanation of the option, at most 240 characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// An optional rich preview of the option, present only on single-select
    /// questions.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<UserInputOptionPreview>,
}

/// Rich content a client can show for an option. Only single-select questions
/// carry previews.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputOptionPreview {
    /// The content format, for example `markdown`.
    pub format: String,
    /// The preview content in that format, at most 2000 characters.
    pub content: String,
}

/// One question's answer, as sent in `userInput/answer` or
/// `userInput/interrupt` and as recorded in `userInput/settled`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputAnswer {
    /// The `id` of the question this answers.
    pub question_id: String,
    /// The label of the chosen option, for a `single` question.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_label: Option<String>,
    /// The labels of the chosen options for a `multiple` question, within its
    /// selection bounds; omitted when empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub selected_labels: Vec<String>,
    /// A free-form answer, at most 500 characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub free_text: Option<String>,
    /// An optional comment the user adds to the answer, at most 500 characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A free-form reply the user gives instead of choosing from the options; the
/// model reads it and decides again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInputClarification {
    /// The content format. `text` is the only value today, and more may be
    /// added.
    pub format: String,
    /// The clarification text, at most 500 characters.
    pub content: String,
}

/// How a user-input prompt settled. More values may be added, so handle values
/// you do not recognize.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum UserInputOutcome {
    /// `answered`: the user answered every question.
    Answered,
    /// `cancelled`: the user declined to answer.
    Cancelled,
    /// `interrupted`: the turn was interrupted while the prompt was open. If a
    /// `userInput/interrupt` named this prompt, its confirmed answers are in
    /// `answers`.
    Interrupted,
    /// `clarified`: the user replied with a free-form clarification instead of
    /// choosing options.
    Clarified,
    /// `timedOut`: the prompt's auto-resolution countdown ran out before anyone
    /// answered.
    TimedOut,
    /// `aborted`: the host closed the prompt without an answer, for example
    /// when the run was torn down; `reason` says why.
    Aborted,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}
