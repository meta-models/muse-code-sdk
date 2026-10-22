// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::health::SessionViewHealth;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

impl SessionViewHealth {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for SessionViewHealth {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SessionViewHealth {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "unavailable" => Self::Unavailable,
            _ => Self::Unknown(value),
        })
    }
}
