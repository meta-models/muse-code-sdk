// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// What holds a tool call before it is admitted to execute. Open: a client
/// reads an unknown value as held by something it does not know, never as
/// released.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HeldFor {
    /// An approval prompt holds the call.
    Approval,
    /// A pre-tool hook holds the call.
    Hook,
    /// A value from a newer host, kept verbatim so the call still reads as
    /// held. Excluded from the generated schema; never construct it with a
    /// known word.
    Unknown(String),
}

impl HeldFor {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Approval => "approval",
            Self::Hook => "hook",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for HeldFor {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HeldFor {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "approval" => Self::Approval,
            "hook" => Self::Hook,
            _ => Self::Unknown(value),
        })
    }
}
