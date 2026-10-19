// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{HistoryMode, HistoryNoneReason, PendingRequestKind};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl HistoryNoneReason {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Excluded => "excluded",
            Self::CursorSuffix => "cursorSuffix",
            Self::HistoryBudget => "historyBudget",
            Self::ProjectionUnavailable => "projectionUnavailable",
            Self::ProjectionReadLimit => "projectionReadLimit",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for HistoryNoneReason {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HistoryNoneReason {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "excluded" => Self::Excluded,
            "cursorSuffix" => Self::CursorSuffix,
            "historyBudget" => Self::HistoryBudget,
            "projectionUnavailable" => Self::ProjectionUnavailable,
            "projectionReadLimit" => Self::ProjectionReadLimit,
            _ => Self::Unknown(word),
        })
    }
}

impl HistoryMode {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::AnchoredSnapshot => "anchoredSnapshot",
            Self::Inline => "inline",
            Self::Snapshot => "snapshot",
            Self::None => "none",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for HistoryMode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HistoryMode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "anchoredSnapshot" => Self::AnchoredSnapshot,
            "inline" => Self::Inline,
            "snapshot" => Self::Snapshot,
            "none" => Self::None,
            _ => Self::Unknown(word),
        })
    }
}

impl PendingRequestKind {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Approval => "approval",
            Self::UserInput => "userInput",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for PendingRequestKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PendingRequestKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "approval" => Self::Approval,
            "userInput" => Self::UserInput,
            _ => Self::Unknown(word),
        })
    }
}
