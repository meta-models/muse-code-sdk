// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `backgroundTerminalCompletion`: the five facts the Finished cell renders.
/// The fold reads them from the inbox terminal record and the backgrounded call
/// it names; every member is required (empty output serializes as `""`, never
/// absent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct BackgroundTerminalCompletion {
    /// The backgrounded call's call id: the live/history correlation key behind
    /// the skip-when-minted rule.
    pub tool_call_id: String,
    /// The title text gate-off shows for the backgrounded command.
    pub command: String,
    /// One of `completed`, `failed`, `cancelled`, `timedOut`, `rejected`.
    pub terminal_status: String,
    /// The completion text; empty when the terminal carries none.
    pub output: String,
    /// True when `output` is a prefix of the terminal text.
    pub output_truncated: bool,
}
