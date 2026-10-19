// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{ModelChangeSource, ReasoningEffortChangeSource, TodoStatus, Vcs};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl ModelChangeSource {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::User => "user",
            Self::Default => "default",
            Self::Policy => "policy",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ModelChangeSource {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ModelChangeSource {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "user" => Self::User,
            "default" => Self::Default,
            "policy" => Self::Policy,
            _ => Self::Unknown(word),
        })
    }
}

impl ReasoningEffortChangeSource {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::User => "user",
            Self::Default => "default",
            Self::Policy => "policy",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ReasoningEffortChangeSource {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ReasoningEffortChangeSource {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "user" => Self::User,
            "default" => Self::Default,
            "policy" => Self::Policy,
            _ => Self::Unknown(word),
        })
    }
}

impl TodoStatus {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "inProgress",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for TodoStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for TodoStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "pending" => Self::Pending,
            "inProgress" => Self::InProgress,
            "completed" => Self::Completed,
            "cancelled" => Self::Cancelled,
            _ => Self::Unknown(word),
        })
    }
}

impl Vcs {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Git => "git",
            Self::Sapling => "sapling",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for Vcs {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for Vcs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "git" => Self::Git,
            "sapling" => Self::Sapling,
            _ => Self::Unknown(word),
        })
    }
}
