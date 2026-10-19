// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{AttentionFlag, SessionKind};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl SessionKind {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Root => "root",
            Self::Subagent => "subagent",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for SessionKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SessionKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "root" => Self::Root,
            "subagent" => Self::Subagent,
            _ => Self::Unknown(word),
        })
    }
}

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
