// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `toolCall.displayLabel`: the call's words in three forms, each one line of
/// plain text, always present together. The item's `status` picks the form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ToolDisplayLabel {
    /// Shown while the call runs (`inProgress`), e.g. "Setting up Computer Use".
    pub active: String,
    /// Shown after the call succeeds (`completed`), e.g. "Set up Computer Use".
    pub done: String,
    /// Shown for every other status (failed, rejected, timed out, cancelled),
    /// beside that status; never implies success.
    pub neutral: String,
}
