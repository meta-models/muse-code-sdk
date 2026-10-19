// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{BackgroundInitiator, BackgroundState};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl BackgroundInitiator {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::User => "user",
            Self::Timeout => "timeout",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for BackgroundInitiator {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for BackgroundInitiator {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "user" => Self::User,
            "timeout" => Self::Timeout,
            _ => Self::Unknown(word),
        })
    }
}

impl BackgroundState {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Backgrounded => "backgrounded",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for BackgroundState {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for BackgroundState {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "backgrounded" => Self::Backgrounded,
            _ => Self::Unknown(word),
        })
    }
}
