// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// What happens to the `previousSessionId` predecessor's unfinished
/// background work. **Closed**: the client selects one of the two policies
/// the host applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SwitchPolicy {
    /// Leave the predecessor's background work running; only its
    /// persistent monitors end.
    Keep,
    /// Cancel the predecessor's unfinished background work, as the TUI's
    /// `/new` and `/clear` do.
    Kill,
}
