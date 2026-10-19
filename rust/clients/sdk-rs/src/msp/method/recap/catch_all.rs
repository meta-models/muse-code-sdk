// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{RecapFailureReason, RecapOutcome};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl RecapOutcome {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timedOut",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for RecapOutcome {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RecapOutcome {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "timedOut" => Self::TimedOut,
            _ => Self::Unknown(word),
        })
    }
}

impl RecapFailureReason {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::ProviderFailed => "providerFailed",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for RecapFailureReason {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RecapFailureReason {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "providerFailed" => Self::ProviderFailed,
            _ => Self::Unknown(word),
        })
    }
}
