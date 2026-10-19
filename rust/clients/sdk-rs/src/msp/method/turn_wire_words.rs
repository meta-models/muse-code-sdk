// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::turn::CommandStatus;
use super::turn::TurnStartDisposition;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

impl CommandStatus {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Accepted => "accepted",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for CommandStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CommandStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "accepted" => Self::Accepted,
            _ => Self::Unknown(value),
        })
    }
}

impl TurnStartDisposition {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Started => "started",
            Self::Queued => "queued",
            Self::Steered => "steered",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for TurnStartDisposition {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for TurnStartDisposition {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "started" => Self::Started,
            "queued" => Self::Queued,
            "steered" => Self::Steered,
            _ => Self::Unknown(value),
        })
    }
}
