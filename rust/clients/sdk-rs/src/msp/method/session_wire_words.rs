// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::session::RunningElsewhereOrigin;
use super::session::SessionKind;
use super::session_events::SessionClosedReason;
use super::session_events::SessionStatus;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

impl SessionKind {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Root => "root",
            Self::Subagent => "subagent",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for SessionKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SessionKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "root" => Self::Root,
            "subagent" => Self::Subagent,
            _ => Self::Unknown(value),
        })
    }
}

impl SessionStatus {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::NotLoaded => "notLoaded",
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for SessionStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SessionStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "notLoaded" => Self::NotLoaded,
            "idle" => Self::Idle,
            "running" => Self::Running,
            _ => Self::Unknown(value),
        })
    }
}

impl SessionClosedReason {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Idle => "idle",
            Self::HostShutdown => "hostShutdown",
            Self::Leave => "leave",
            Self::Vacated => "vacated",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for SessionClosedReason {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SessionClosedReason {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "idle" => Self::Idle,
            "hostShutdown" => Self::HostShutdown,
            "leave" => Self::Leave,
            "vacated" => Self::Vacated,
            _ => Self::Unknown(value),
        })
    }
}

impl RunningElsewhereOrigin {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Tui => "tui",
            Self::Exec => "exec",
            Self::Serve => "serve",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for RunningElsewhereOrigin {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RunningElsewhereOrigin {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "tui" => Self::Tui,
            "exec" => Self::Exec,
            "serve" => Self::Serve,
            _ => Self::Unknown(value),
        })
    }
}
