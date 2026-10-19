// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::WorktreeOrigin;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl WorktreeOrigin {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Created => "created",
            Self::Attached => "attached",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for WorktreeOrigin {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for WorktreeOrigin {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "created" => Self::Created,
            "attached" => Self::Attached,
            _ => Self::Unknown(word),
        })
    }
}
