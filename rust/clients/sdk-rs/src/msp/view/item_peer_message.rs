// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `peerMessage`: the four facts the consumed card renders. The fold reads them
/// from the drained inbox record's delivery snapshot; `senderLabel` already ran
/// the gate-off label rule host-side, so the client renders it verbatim. Stable
/// from day one (the `scheduledFire` precedent): no `x-msp-stability` marker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PeerMessage {
    /// The peer label gate-off shows: the sender name when the
    /// durable record names one, else the sender id shortened as
    /// gate-off shortens it, else `unknown session` — and `remote
    /// session` verbatim for a remote sender.
    pub sender_label: String,
    /// The local sender's session id; absent for remote senders and
    /// when the record names none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sender_session_id: Option<String>,
    /// True for mailbox/remote senders, false for local session
    /// senders.
    pub remote: bool,
    /// The message text verbatim — never cut (an over-budget event
    /// answers the typed `pageEventTooLarge` arm).
    pub body: String,
}
