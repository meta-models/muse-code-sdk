// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::SubagentControlStatus;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl SubagentControlStatus {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Accepted => "accepted",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::ResultReady => "resultReady",
            Self::Closing => "closing",
            Self::Closed => "closed",
            Self::RecoveryPending => "recoveryPending",
            Self::ManualReconciliation => "manualReconciliation",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for SubagentControlStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SubagentControlStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "accepted" => Self::Accepted,
            "starting" => Self::Starting,
            "running" => Self::Running,
            "resultReady" => Self::ResultReady,
            "closing" => Self::Closing,
            "closed" => Self::Closed,
            "recoveryPending" => Self::RecoveryPending,
            "manualReconciliation" => Self::ManualReconciliation,
            _ => Self::Unknown(word),
        })
    }
}
