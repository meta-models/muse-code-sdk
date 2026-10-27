// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::runtime_worktree::RuntimeWorktreeCleanupPolicy;
use super::runtime_worktree::RuntimeWorktreeCleanupState;
use super::runtime_worktree::RuntimeWorktreeOwnership;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

impl RuntimeWorktreeOwnership {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::RuntimeOwned => "runtimeOwned",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for RuntimeWorktreeOwnership {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RuntimeWorktreeOwnership {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "runtimeOwned" => Self::RuntimeOwned,
            _ => Self::Unknown(value),
        })
    }
}

impl RuntimeWorktreeCleanupPolicy {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::RemoveIfClean => "removeIfClean",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for RuntimeWorktreeCleanupPolicy {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RuntimeWorktreeCleanupPolicy {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "removeIfClean" => Self::RemoveIfClean,
            _ => Self::Unknown(value),
        })
    }
}

impl RuntimeWorktreeCleanupState {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Active => "active",
            Self::Cleaned => "cleaned",
            Self::Retained => "retained",
            Self::CleanupFailed => "cleanupFailed",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for RuntimeWorktreeCleanupState {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for RuntimeWorktreeCleanupState {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "active" => Self::Active,
            "cleaned" => Self::Cleaned,
            "retained" => Self::Retained,
            "cleanupFailed" => Self::CleanupFailed,
            _ => Self::Unknown(value),
        })
    }
}
