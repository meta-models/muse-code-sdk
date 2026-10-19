// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `view/gap` params: push delivery dropped events, and this names the hole.
///
/// The bracket is deferred: it flushes at the subscription's next ACCEPTED
/// delivery, never at enqueue time, so `next` always names an event whose own
/// delivery is proven. A run of consecutive undelivered events coalesces into
/// one bracket keeping the FIRST range's `after`. The gap rides the protected
/// reserved queue, so no wire-interleaving order against neighbouring
/// deliveries is promised — the cursors carry the semantics.
///
/// On receipt a client may take either sanctioned recovery: splice-fill —
/// buffer live events at cursors >= `next`, page `(after, next)` forward,
/// discard the overlap, splice — or re-anchor through the anchored read
/// surface. The server requires neither, cannot distinguish clients by their
/// choice, and holds no partial-fill state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ViewGapParams {
    /// The session whose subscription dropped events.
    pub session_id: String,
    /// The last cursor delivered before the hole — the exclusive lower bound of
    /// the undelivered range. An **opaque** view cursor: clients relay it,
    /// never parse it.
    pub after: String,
    /// The first cursor delivered after the hole — the exclusive upper bound of
    /// the undelivered range, and the position delivery continues from. An
    /// **opaque** view cursor: clients relay it, never parse it.
    pub next: String,
}
