// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `earlierHistory`: the boundary checkpoint's transcript tail, served in place
/// of every item that opened in its pruned prefix. No log record carries it;
/// the host derives it from the checkpoint.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct EarlierHistory {
    /// The tail entries whose source record is in the pruned prefix, in tail
    /// order. May be empty.
    pub messages: Vec<EarlierHistoryMessage>,
}

/// One transcript-tail message of an [`EarlierHistory`] item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct EarlierHistoryMessage {
    /// Open string enum: `"user"` or `"assistant"`, the only roles a host
    /// serves; a client skips any other value.
    pub role: String,
    /// The stored tail text verbatim (at most 1,000 characters); clients
    /// apply their own assistant display rules.
    pub text: String,
}
