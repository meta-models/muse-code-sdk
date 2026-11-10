// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `agentMessage.messagePhase`: the phase the model declared, never inferred
/// from position. Set on every completed item, and on `item/started` when the
/// host knows the phase: absent or unknown there means not yet known, and the
/// completed value wins. A failed item carries none, and its missing value does
/// not read as `"finalAnswer"`. Open: a client reads an absent or unknown value
/// on a completed item as `"finalAnswer"` and still decodes the item. Not a
/// turn-done signal; `turn/completed` is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum MessagePhase {
    /// Narration between tool calls.
    Commentary,
    /// The model's answer channel.
    FinalAnswer,
}

/// `messagePhase` is open: a value this build does not know decodes as absent
/// instead of failing the whole item. Clients read that as `"finalAnswer"` on a
/// completed item and as not yet known on a started one.
pub(crate) fn lenient_message_phase<'de, D>(
    deserializer: D,
) -> Result<Option<MessagePhase>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(value.and_then(|value| serde_json::from_value(value).ok()))
}
