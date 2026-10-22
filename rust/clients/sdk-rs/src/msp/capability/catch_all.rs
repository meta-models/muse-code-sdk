// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::CapabilityName;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl CapabilityName {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::UserShell => "userShell",
            Self::SessionMcp => "sessionMcp",
            Self::SessionListStream => "sessionListStream",
            Self::Feedback => "feedback",
            Self::ComputerUseSetup => "computerUseSetup",
            Self::ComputerUseHostSetup => "computerUseHostSetup",
            Self::SessionRename => "sessionRename",
            Self::PeerMessaging => "peerMessaging",
            Self::RawLog => "rawLog",
            Self::RawLogPhysical => "rawLogPhysical",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for CapabilityName {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CapabilityName {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "userShell" => Self::UserShell,
            "sessionMcp" => Self::SessionMcp,
            "sessionListStream" => Self::SessionListStream,
            "feedback" => Self::Feedback,
            "computerUseSetup" => Self::ComputerUseSetup,
            "computerUseHostSetup" => Self::ComputerUseHostSetup,
            "sessionRename" => Self::SessionRename,
            "peerMessaging" => Self::PeerMessaging,
            "rawLog" => Self::RawLog,
            "rawLogPhysical" => Self::RawLogPhysical,
            _ => Self::Unknown(word),
        })
    }
}
