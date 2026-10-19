// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::UserInputOutcome;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl UserInputOutcome {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Answered => "answered",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
            Self::Clarified => "clarified",
            Self::TimedOut => "timedOut",
            Self::Aborted => "aborted",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for UserInputOutcome {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for UserInputOutcome {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "answered" => Self::Answered,
            "cancelled" => Self::Cancelled,
            "interrupted" => Self::Interrupted,
            "clarified" => Self::Clarified,
            "timedOut" => Self::TimedOut,
            "aborted" => Self::Aborted,
            _ => Self::Unknown(word),
        })
    }
}
