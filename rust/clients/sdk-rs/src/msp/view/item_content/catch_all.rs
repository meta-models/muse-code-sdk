// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{CompactionOutcome, CompactionTrigger, OutputRefAvailability};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl OutputRefAvailability {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Available => "available",
            Self::Missing => "missing",
            Self::Unsupported => "unsupported",
            Self::AccessFailed => "accessFailed",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for OutputRefAvailability {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for OutputRefAvailability {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "available" => Self::Available,
            "missing" => Self::Missing,
            "unsupported" => Self::Unsupported,
            "accessFailed" => Self::AccessFailed,
            _ => Self::Unknown(word),
        })
    }
}

impl CompactionOutcome {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Compacted => "compacted",
            Self::Noop => "noop",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for CompactionOutcome {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CompactionOutcome {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "compacted" => Self::Compacted,
            "noop" => Self::Noop,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Unknown(word),
        })
    }
}

impl CompactionTrigger {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Manual => "manual",
            Self::Auto => "auto",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for CompactionTrigger {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CompactionTrigger {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "manual" => Self::Manual,
            "auto" => Self::Auto,
            _ => Self::Unknown(word),
        })
    }
}
