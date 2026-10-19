// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{ComputerUsePermission, ComputerUseSetupPhase};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl ComputerUseSetupPhase {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Dormant => "dormant",
            Self::InProgress => "inProgress",
            Self::RestartRequired => "restartRequired",
            Self::ReadyForTarget => "readyForTarget",
            Self::Stopped => "stopped",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ComputerUseSetupPhase {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ComputerUseSetupPhase {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "dormant" => Self::Dormant,
            "inProgress" => Self::InProgress,
            "restartRequired" => Self::RestartRequired,
            "readyForTarget" => Self::ReadyForTarget,
            "stopped" => Self::Stopped,
            _ => Self::Unknown(word),
        })
    }
}

impl ComputerUsePermission {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Granted => "granted",
            Self::Missing => "missing",
            Self::Unknown => "unknown",
            Self::Unrecognized(word) => word,
        }
    }
}

impl Serialize for ComputerUsePermission {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ComputerUsePermission {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "granted" => Self::Granted,
            "missing" => Self::Missing,
            "unknown" => Self::Unknown,
            _ => Self::Unrecognized(word),
        })
    }
}
