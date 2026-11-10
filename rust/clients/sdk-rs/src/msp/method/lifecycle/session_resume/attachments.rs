// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::StreamRef;
use serde::Deserialize;
use serde::Serialize;

/// One `restartReceipts` entry on `session/resume`: a copy of the runtime
/// `ManualCompactionReceipt` in its own serde vocabulary — display event ids,
/// `StreamRef` streams, and the runtime's snake-case status/reason/outcome
/// words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RestartReceipt {
    /// The compaction command's event id, display form.
    pub command_id: String,
    /// The session stream the command was accepted on.
    pub session_stream: StreamRef,
    /// The compaction target run; absent on target-less receipts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_stream: Option<StreamRef>,
    /// The runtime status word (e.g. `failed_before_start`).
    pub status: String,
    /// The runtime reason word, when the receipt carries one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The summary candidate id, when the receipt carries one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub candidate_id: Option<String>,
    /// The runtime terminal-outcome word (e.g. `failed`).
    pub terminal_outcome: String,
}
