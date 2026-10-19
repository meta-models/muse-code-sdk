// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::StatusHealthLevel;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl StatusHealthLevel {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Ok => "ok",
            Self::Waiting => "waiting",
            Self::Degraded => "degraded",
            Self::Retrying => "retrying",
            Self::Blocked => "blocked",
            Self::Failed => "failed",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for StatusHealthLevel {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for StatusHealthLevel {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "ok" => Self::Ok,
            "waiting" => Self::Waiting,
            "degraded" => Self::Degraded,
            "retrying" => Self::Retrying,
            "blocked" => Self::Blocked,
            "failed" => Self::Failed,
            _ => Self::Unknown(word),
        })
    }
}
