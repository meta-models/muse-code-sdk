// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// Who durably backgrounded a task. Open — runtime vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum BackgroundInitiator {
    /// The user backgrounded the task.
    User,
    /// The foreground-wait timeout backgrounded it.
    Timeout,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// Presentation state of a `toolCall` item that went to the background. Open —
/// new states are additive. Asserts presentation only, never durable
/// backgrounding (that claim stays `Item::background`, set only behind a
/// durable `TaskBackgrounded`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum BackgroundState {
    /// The call went to the background; draw its Backgrounded row from
    /// `detail`. Set on the flip emission of any backgrounded `toolCall` —
    /// auto-yield or an explicit user/timeout background, with or without
    /// `background`/`backgroundInitiator` — and, for a shell call, on every
    /// later emission of its item, its terminal and history snapshots included.
    Backgrounded,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// The backgrounded-row payload of a `toolCall` item that went to the
/// background: the presentation state plus the result text the row body
/// renders. Experimental — stable clients ignore the member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct BackgroundStatus {
    /// The item's background presentation state.
    pub state: BackgroundState,
    /// The result JSON text committed at the yield, which the backgrounded row
    /// body renders; a shell call's later emissions carry it verbatim. The flip
    /// gate requires non-empty detail (the fold always sets it); a state-only
    /// member leaves the row alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}
