// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `damagedRange`: what one damaged range of the session log cost. The reader
/// finds the range in the log bytes; no log record is written for it, so every
/// member is derived from the readable records around it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct DamagedRange {
    /// Physical log lines in the range that are not a readable record.
    pub unreadable_lines: u64,
    /// Records the log proves missing (session-stream sequence numbers no
    /// readable record or unreadable line accounts for).
    pub missing_records: u64,
    /// RFC3339 `recordedAt` of the last readable record before the range;
    /// absent when the range starts the log.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub readable_before_at: Option<String>,
    /// RFC3339 `recordedAt` of the first readable record after the range;
    /// always present, since a range is read past only when readable records
    /// follow it.
    pub readable_after_at: String,
    /// The last finished turn before the first damaged range, when one exists:
    /// the safe `session/fork` cut.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_good_turn_id: Option<String>,
}
