// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// Whether the origin call join held at delivery.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum BodyCompletionCorrelation {
    /// The origin call joined: the row names the call and its result.
    Resolved,
    /// The join did not hold (compaction): the row renders the
    /// bounded missing-correlation diagnostic, never a guess.
    Unresolved,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

impl BodyCompletionCorrelation {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Resolved => "resolved",
            Self::Unresolved => "unresolved",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for BodyCompletionCorrelation {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for BodyCompletionCorrelation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "resolved" => Self::Resolved,
            "unresolved" => Self::Unresolved,
            _ => Self::Unknown(value),
        })
    }
}

/// `bodyCompletion`: the facts one receipt row renders. The fold reads them
/// from the inbox terminal record and the backgrounded call it names. `status`,
/// `result_summary`, and `correlation` are required; `origin_call_id` is absent
/// exactly when the join is unresolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct BodyCompletionMembers {
    /// The originating call's provider call id, opaque — the join
    /// key back to the original row. Absent when the join is
    /// unresolved (compaction).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin_call_id: Option<String>,
    /// One fixed wire word per Task terminal (`completed`,
    /// `failed`, `cancelled`, `timedOut`, `rejected`) — never
    /// display text; gate-off display words derive client-side.
    pub status: String,
    /// Bounded transcript-visible result text; empty when the
    /// terminal carries none. Full bytes stay behind outputRef.
    pub result_summary: String,
    /// Whether the origin call join held at delivery.
    pub correlation: BodyCompletionCorrelation,
    /// True for the Manual semantic receipt (`◆`); false for the
    /// ordinary completion row.
    pub receipt: bool,
}
