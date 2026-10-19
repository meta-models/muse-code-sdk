// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::ContextPressureLevel;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl ContextPressureLevel {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Normal => "normal",
            Self::Warning => "warning",
            Self::Blocked => "blocked",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ContextPressureLevel {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ContextPressureLevel {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "normal" => Self::Normal,
            "warning" => Self::Warning,
            "blocked" => Self::Blocked,
            _ => Self::Unknown(word),
        })
    }
}
