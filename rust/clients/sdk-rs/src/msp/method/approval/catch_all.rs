// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::ApprovalModeApplyOutcome;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl ApprovalModeApplyOutcome {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Completed => "completed",
            Self::Noop => "noop",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ApprovalModeApplyOutcome {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ApprovalModeApplyOutcome {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "completed" => Self::Completed,
            "noop" => Self::Noop,
            _ => Self::Unknown(word),
        })
    }
}
