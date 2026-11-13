// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::item_subagent_workflow::WorkspacePlacement;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

impl WorkspacePlacement {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Shared => "shared",
            Self::Isolated => "isolated",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for WorkspacePlacement {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for WorkspacePlacement {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "shared" => Self::Shared,
            "isolated" => Self::Isolated,
            _ => Self::Unknown(value),
        })
    }
}
