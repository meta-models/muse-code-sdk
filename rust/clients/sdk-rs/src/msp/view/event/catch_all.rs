// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::LimitKind;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl LimitKind {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::TierLimit => "tierLimit",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for LimitKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for LimitKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "tierLimit" => Self::TierLimit,
            _ => Self::Unknown(word),
        })
    }
}
