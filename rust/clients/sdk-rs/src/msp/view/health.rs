// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::lifecycle::HistoryNoneReason;
use serde::Deserialize;
use serde::Serialize;

/// `session/viewHealthChanged` params: the named session's live view stream
/// became unavailable, and why.
///
/// Best-effort: ordered after already-queued view frames and may be dropped
/// (for example when the connection is closing), so a client MUST NOT assume a
/// guaranteed push and still reads `history.noneReason` on its next
/// resume/read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionViewHealthChangedParams {
    /// The session whose live view health changed.
    pub session_id: String,
    /// The new view-health state. In v1 the host emits only `Unavailable`.
    pub health: SessionViewHealth,
    /// Why the view is unavailable — the SAME typed `HistoryNoneReason`
    /// vocabulary the pull path stamps on `history.noneReason`, so a client
    /// reuses one handler for push and pull. `projectionUnavailable` in v1;
    /// present only when `health` is `Unavailable`. Open on the client side: an
    /// unknown reason decodes conservatively and renders generically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub none_reason: Option<HistoryNoneReason>,
}

/// The view-health state. Open enum (`x-msp-openness: open`): a client MUST
/// ignore an unrecognized value. v1 emits only `Unavailable`; openness itself
/// reserves additive room for a future re-arm and for the durable-degraded
/// axis, so no never-emitted token is baked onto the stable surface now.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionViewHealth {
    /// The live view stream is unavailable — see `noneReason`.
    Unavailable,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}
