// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{SessionClosedReason, SessionStatus};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl SessionStatus {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::NotLoaded => "notLoaded",
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for SessionStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SessionStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "notLoaded" => Self::NotLoaded,
            "idle" => Self::Idle,
            "running" => Self::Running,
            _ => Self::Unknown(word),
        })
    }
}

impl SessionClosedReason {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Idle => "idle",
            Self::HostShutdown => "hostShutdown",
            Self::Leave => "leave",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for SessionClosedReason {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SessionClosedReason {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "idle" => Self::Idle,
            "hostShutdown" => Self::HostShutdown,
            "leave" => Self::Leave,
            _ => Self::Unknown(word),
        })
    }
}
