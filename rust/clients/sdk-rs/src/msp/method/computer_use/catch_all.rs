// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::ComputerUseChoice;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl ComputerUseChoice {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Ask => "ask",
            Self::AlwaysAllow => "alwaysAllow",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ComputerUseChoice {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ComputerUseChoice {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "ask" => Self::Ask,
            "alwaysAllow" => Self::AlwaysAllow,
            _ => Self::Unknown(word),
        })
    }
}
