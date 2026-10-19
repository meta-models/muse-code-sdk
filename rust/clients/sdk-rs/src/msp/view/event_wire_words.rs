// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::event::TurnErrorKind;
use super::event::TurnTerminal;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

impl TurnTerminal {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for TurnTerminal {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for TurnTerminal {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            _ => Self::Unknown(value),
        })
    }
}

impl TurnErrorKind {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::StepLimit => "stepLimit",
            Self::ConfigError => "configError",
            Self::ProjectionError => "projectionError",
            Self::LogError => "logError",
            Self::WorkflowLaunchError => "workflowLaunchError",
            Self::EnvironmentError => "environmentError",
            Self::ModelError => "modelError",
            Self::LaunchError => "launchError",
            Self::AuthRequired => "authRequired",
            Self::McpLinkError => "mcpLinkError",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for TurnErrorKind {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for TurnErrorKind {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "stepLimit" => Self::StepLimit,
            "configError" => Self::ConfigError,
            "projectionError" => Self::ProjectionError,
            "logError" => Self::LogError,
            "workflowLaunchError" => Self::WorkflowLaunchError,
            "environmentError" => Self::EnvironmentError,
            "modelError" => Self::ModelError,
            "launchError" => Self::LaunchError,
            "authRequired" => Self::AuthRequired,
            "mcpLinkError" => Self::McpLinkError,
            _ => Self::Unknown(value),
        })
    }
}
