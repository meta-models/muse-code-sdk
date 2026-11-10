// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::turn::CommandStatus;
use serde::Deserialize;
use serde::Serialize;

/// Who said one `model/complete` message. **Closed**: a client-produced
/// input the host validates, so an unknown role is `invalidParams`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModelCompleteRole {
    /// The caller's own text.
    User,
    /// An earlier model answer the caller sends back as context.
    Assistant,
}

/// One `model/complete` message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCompleteMessage {
    /// Who said it.
    pub role: ModelCompleteRole,
    /// What was said.
    pub text: String,
}

/// `model/complete` params: the retry id, 1 to 32 messages (the first and the
/// last `user`), an optional system text and the output bound. No session and
/// no model: the host picks the model. The host answers an unknown field with
/// `invalidParams`; the type itself accepts it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCompleteParams {
    /// The client-minted UUIDv7 retry id.
    pub command_id: String,
    /// What the model answers, oldest first.
    pub messages: Vec<ModelCompleteMessage>,
    /// The system text, when the caller sends one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// The most tokens the model may write.
    pub max_tokens: u32,
}

/// `model/complete` result: admission only — the ack is never the completion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelCompleteResult {
    /// The request's id, echoed.
    pub command_id: String,
    /// Always `accepted` on this path.
    pub status: CommandStatus,
}

/// `model/cancel` params: the `commandId` of the call to cancel, not a retry id
/// of its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCancelParams {
    /// The call to cancel.
    pub command_id: String,
}

/// `model/cancel` result: always empty, for a call in flight and for an id no
/// call holds alike; `model/completed` reports the outcome.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ModelCancelResult {}
