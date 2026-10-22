// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::session_resume::HistoryMode;
use super::session_resume::HistoryNoneReason;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

impl HistoryMode {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::AnchoredSnapshot => "anchoredSnapshot",
            Self::Inline => "inline",
            Self::Snapshot => "snapshot",
            Self::None => "none",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for HistoryMode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HistoryMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "anchoredSnapshot" => Self::AnchoredSnapshot,
            "inline" => Self::Inline,
            "snapshot" => Self::Snapshot,
            "none" => Self::None,
            _ => Self::Unknown(value),
        })
    }
}

impl HistoryNoneReason {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Excluded => "excluded",
            Self::CursorSuffix => "cursorSuffix",
            Self::HistoryBudget => "historyBudget",
            Self::ProjectionUnavailable => "projectionUnavailable",
            Self::ProjectionReadLimit => "projectionReadLimit",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for HistoryNoneReason {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HistoryNoneReason {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "excluded" => Self::Excluded,
            "cursorSuffix" => Self::CursorSuffix,
            "historyBudget" => Self::HistoryBudget,
            "projectionUnavailable" => Self::ProjectionUnavailable,
            "projectionReadLimit" => Self::ProjectionReadLimit,
            _ => Self::Unknown(value),
        })
    }
}
