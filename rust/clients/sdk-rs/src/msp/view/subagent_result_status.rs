// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// `subagentResult.resultStatus`: the consumed attempt's outcome. Absent when
/// the host had not seen that attempt's result envelope at the drain; a client
/// then shows the child's current outcome. Open: a client treats a value it
/// does not know as an absent member.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SubagentResultStatus {
    /// The attempt finished normally (its envelope names no error, or the
    /// generated child's model-step cap).
    Completed,
    /// The attempt failed (any other error the envelope names).
    Failed,
    /// The attempt was cancelled, for example by a redirect.
    Cancelled,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the item. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

impl SubagentResultStatus {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for SubagentResultStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SubagentResultStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Unknown(value),
        })
    }
}
