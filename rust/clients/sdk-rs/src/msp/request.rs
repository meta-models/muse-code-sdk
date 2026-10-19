// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// The presentation receipt — the client's response to a server-initiated
/// request (`approval/request`, `userInput/request`).
///
/// The response acknowledges presentation only ("a surface showed or will show
/// this"): it changes no state, the server uses it for diagnostics alone, and
/// the decision/answer travels as a command (`approval/decide`,
/// `userInput/answer`). An error response or a dropped connection means this
/// connection could not present the request; the approval or prompt stays
/// pending and the request is re-issued on the next subscribe. There is no
/// dismiss-without-deciding on the wire.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RequestReceipt {}
