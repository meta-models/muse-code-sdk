// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::AttentionFlag;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl AttentionFlag {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::ApprovalPending => "approvalPending",
            Self::InputPending => "inputPending",
            Self::AdmissionPending => "admissionPending",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for AttentionFlag {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for AttentionFlag {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "approvalPending" => Self::ApprovalPending,
            "inputPending" => Self::InputPending,
            "admissionPending" => Self::AdmissionPending,
            _ => Self::Unknown(word),
        })
    }
}
