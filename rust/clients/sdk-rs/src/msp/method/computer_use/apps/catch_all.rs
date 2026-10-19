// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{ComputerUseAppChoice, ComputerUseAppLock};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl ComputerUseAppChoice {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Ask => "ask",
            Self::AlwaysAllow => "alwaysAllow",
            Self::Blocked => "blocked",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ComputerUseAppChoice {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ComputerUseAppChoice {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "ask" => Self::Ask,
            "alwaysAllow" => Self::AlwaysAllow,
            "blocked" => Self::Blocked,
            _ => Self::Unknown(word),
        })
    }
}

impl ComputerUseAppLock {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::BuiltIn => "builtIn",
            Self::File => "file",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ComputerUseAppLock {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ComputerUseAppLock {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "builtIn" => Self::BuiltIn,
            "file" => Self::File,
            _ => Self::Unknown(word),
        })
    }
}
