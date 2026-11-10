// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::lifecycle::HistoryNoneReason;
use serde::Deserialize;
use serde::Serialize;

/// `session/viewHealthChanged` params: the named session's live view stream
/// became unavailable, and why, or it is back after the host re-loaded the
/// view, so the client re-reads and re-subscribes.
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
    /// The new view-health state: `Unavailable`, or `Healthy` once the host
    /// re-loaded a failed view.
    pub health: SessionViewHealth,
    /// Why the view is unavailable — the SAME typed `HistoryNoneReason`
    /// vocabulary the pull path stamps on `history.noneReason`, so a client
    /// reuses one handler for push and pull. `projectionUnavailable` when the
    /// view fails, then `projectionRebuildFailed`, which the pull path never
    /// stamps: it rides only a `session/viewHealthChanged` notification, after
    /// the host's one re-load of a failed live view fails or right after a fork
    /// child's live fail-close; present only when `health` is `Unavailable`.
    /// Open on the client side: an unknown reason decodes conservatively and
    /// renders generically.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub none_reason: Option<HistoryNoneReason>,
}

/// The view-health state. Open enum (`x-msp-openness: open`): a client MUST
/// ignore an unrecognized value. `Healthy` is the re-arm value reserved by the
/// governing rules, emitted after a host re-load; openness still reserves
/// additive room for the durable-degraded axis.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionViewHealth {
    /// The live view stream is unavailable — see `noneReason`.
    Unavailable,
    /// The live view stream is back: the host re-loaded the view, whose
    /// numbering may differ from the cursors the client holds, so the client
    /// re-reads (`session/read`, `view/page`) and re-subscribes. Carries no
    /// `noneReason`.
    Healthy,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}
