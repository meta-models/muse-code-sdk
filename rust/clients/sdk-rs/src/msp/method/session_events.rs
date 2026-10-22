// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::session::AttentionFlag;
use super::session::EffectivePermissionState;
use super::session::Session;
use serde::Deserialize;
use serde::Serialize;

/// `session/statusChanged` params: a loaded session's projected `(status,
/// attention)` value flipped. A command-plane broadcast — delivered to every
/// connection regardless of its view subscription set, never gated, no
/// `sourceRange`; the same facts live on the Session object, which is how a
/// client seeds its table (no initial burst on connect).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionStatusChangedParams {
    /// The owning session.
    pub session_id: String,
    /// Load state after the transition.
    pub status: SessionStatus,
    /// Attention flags after the transition; present only when at least one
    /// flag is set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<Vec<AttentionFlag>>,
    /// The folded effective permission state — the same object the `Session`
    /// carries as `permissionState`. **Additive- optional**: a loaded session
    /// carries it; a `"notLoaded"` unload frame and an older host omit it (the
    /// `attention` precedent), and absence is unknown, never active. A
    /// projection of the ONE stored attach face `session/read` and the
    /// `session/list` rows serve, never a restatement. Part of the change gate:
    /// a change in ONLY this answer — with `(status, attention)` unchanged — is
    /// a publishable change, deduped only when value-identical, carried on the
    /// next `session/statusChanged` frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_state: Option<EffectivePermissionState>,
    /// The causing record's view cursor. Required-nullable: `null` exactly when
    /// the paired `session/closed`'s cursor is `null` (the unload fold-failure
    /// arm); a definite cursor everywhere else.
    pub view_cursor: Option<String>,
}

/// A session's load state.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionStatus {
    /// A durable log exists and no host has it loaded.
    NotLoaded,
    /// Loaded, no active run.
    Idle,
    /// Loaded, a run in flight.
    Running,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// `session/started` params: a session became newly loaded on this host via
/// `session/start`, `session/fork`, or `session/sideChat`, broadcast to every
/// initialized connection.
///
/// The one member is the same `$defs/Session` object the
/// `session/start`/`session/fork` results carry, so the broadcast and the
/// result describe one fact through one type — the host builds the broadcast
/// payload as a `$defs/Session` — the fresh-start arm reuses the result's
/// `session` member, the start-replay arm builds the live attach snapshot —
/// and the emission is
/// parity-gated against this type at the producer
/// (`session-server` prod-assembly capture) and over the committed
/// transcript corpus (conformance `session_lifecycle_enrollment`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionStartedParams {
    /// The newly loaded session, as of the start/fork fold.
    pub session: Session,
}

/// `session/closed` params: a loaded session was unloaded from this host,
/// broadcast to every initialized connection. After it, the session is
/// `notLoaded`; the log remains on disk and `session/resume` reloads it. A
/// crash emits nothing — only the orderly unload paths do (idle unload, host
/// shutdown and a released `session/leave`), and each writes the durable
/// `SessionEnd` record first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionClosedParams {
    /// The unloaded session.
    pub session_id: String,
    /// Which orderly unload path fired.
    pub reason: SessionClosedReason,
    /// The final view head; a client that stores it can later `session/resume
    /// {cursor}` and receive exactly the (empty) suffix. An **opaque** view
    /// cursor: clients relay it, never parse it.
    ///
    /// **Required-nullable**: the producers always write the member and write
    /// `null` when the final fold failed at unload — the host defines no cursor
    /// values of its own and never invents one, and the subscriber still learns
    /// the session closed.
    pub view_cursor: Option<String>,
}

/// The closed-reason vocabulary. Server-produced and published OPEN by owner
/// ruling — the menu-B pick, which settles that this notification reason enum
/// publishes open rather than resting on the result-vocabulary rule by analogy.
/// A crash is deliberately not a reason, because a crash emits no notification
/// at all.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionClosedReason {
    /// The idle unload policy fired.
    Idle,
    /// Orderly daemon or stdio-EOF drain, including the SIGTERM/SIGINT
    /// wind-down.
    HostShutdown,
    /// A `session/leave` released this session after proven physical release.
    /// Emitted before its paired `session/statusChanged` and the
    /// `session/leaveCompleted` terminal.
    Leave,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}
