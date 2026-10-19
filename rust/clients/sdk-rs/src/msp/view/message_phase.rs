// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `agentMessage.messagePhase`: the phase the model declared on the commit,
/// never inferred from position. Set on the completed item only; absent on
/// `item/started`, which opens before the phase is recorded. Open: a client
/// reads an absent or unknown value on a completed item as `"finalAnswer"` and
/// still decodes the item. Not a turn-done signal; `turn/completed` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum MessagePhase {
    /// Narration between tool calls.
    Commentary,
    /// The model's answer channel.
    FinalAnswer,
}

/// `messagePhase` is open: a value this build does not know decodes as absent,
/// which clients read as `"finalAnswer"`, instead of failing the whole item.
pub(crate) fn lenient_message_phase<'de, D>(
    deserializer: D,
) -> Result<Option<MessagePhase>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}
