// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// `subagentInput.inputPhase`: the record the item stands for. Open: a client
/// ignores an item whose phase it does not know.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SubagentInputPhase {
    /// The input entered the subagent's inbox (its queue record).
    Queued,
    /// A delivery-visible drain handed the input to the subagent.
    Delivered,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the item. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

impl SubagentInputPhase {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Queued => "queued",
            Self::Delivered => "delivered",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for SubagentInputPhase {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SubagentInputPhase {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "queued" => Self::Queued,
            "delivered" => Self::Delivered,
            _ => Self::Unknown(value),
        })
    }
}
