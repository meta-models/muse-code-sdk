// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::session::Session;
use crate::msp::view::state::ApprovalMode;
use crate::msp::view::state::ApprovalModeSource;
use crate::msp::view::state::PermissionAxes;
use crate::msp::view::state::ReviewerAuthority;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `session/listChanged` params: one changed row of the `session/list` shape —
/// the full Session object as the answering host's list face serves it at
/// emission, a replace, never a delta. Emitted only on connections that
/// negotiated the `sessionListStream` capability at `initialize`; row birth
/// stays on `session/started`, unload pairs with `session/closed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionListChangedParams {
    /// The served list row for the changed session.
    pub session: Session,
}

/// One attention flag: a pending server-initiated request class parked on the
/// session. Open on the wire — clients MUST ignore unknown values; future
/// attention kinds are additive.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
#[non_exhaustive]
pub enum AttentionFlag {
    /// At least one approval request is open and unresolved.
    ApprovalPending,
    /// At least one user-input request is open.
    InputPending,
    /// At least one peer-admission request is open. Experimental: stripped
    /// per-connection for unopted callers.
    AdmissionPending,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// The effective approval-mode projection: the same object
/// `session/setApprovalMode` returns as `effectiveMode` and the `Session`
/// object carries as `approvalMode`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct EffectiveApprovalModeState {
    /// The mode in effect.
    pub mode: ApprovalMode,
    /// How the mode took effect.
    pub source: ApprovalModeSource,
    /// The command that last set it; `null` when no command did.
    pub last_command_id: Option<String>,
}

/// The effective permission-state projection: the committed native permission
/// snapshot (profile identity, reviewer authority) plus the live per-session
/// runtime's attachment evidence. The same object
/// `session/setPermissionProfile` returns and the `Session` object carries as
/// `permissionState`. Served values must be coherent: a read never combines an
/// old profile with a newer runtime's attachment claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct EffectivePermissionState {
    /// The committed profile id; `null` when the committed source is a launch
    /// override (`LaunchOverrides` pins `id: None`); every catalog row and
    /// configured/default commit carries a non-null id.
    pub profile_id: Option<String>,
    /// The committed profile's reviewer authority.
    pub reviewer_authority: ReviewerAuthority,
    /// Whether an executable reviewer is currently installed for this loaded
    /// session (live runtime evidence).
    pub reviewer_attached: bool,
    /// The committed profile's effective four axis values: the resolved
    /// filesystem, network, approval, and reviewer the YOLO predicate reads.
    /// Omitted when unknown — an older host, the no-profile state, or the
    /// commit-receipt fallback arm that reports without a re-inspect — and a
    /// client MUST fall back to the served id there, never infer equivalence it
    /// cannot see.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub axes: Option<PermissionAxes>,
}

/// Who opened a session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSpawnedBy {
    /// The exact session that opened this one.
    pub parent_session_id: String,
    /// An opaque project label the spawner named, when it named one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// An opaque thread label the spawner named, when it named one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread: Option<String>,
}

/// Fork provenance folded from the durable `session.fork.created` record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ForkProvenance {
    /// The source session this fork was cut from.
    pub session_id: String,
    /// An **opaque provenance string** preserved verbatim from the durable
    /// record. Display-only — not one of the cursor families: clients MUST NOT
    /// parse it and no method accepts it.
    pub cut_cursor: String,
    /// Whether the fork named an explicit cut point.
    pub cut_explicit: bool,
    /// The `commandId` of the `session/fork` that created it.
    pub command_id: String,
}

/// Side provenance folded from the durable side provenance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SideProvenance {
    /// The source main session this side was opened from.
    pub session_id: String,
    /// An **opaque provenance string** preserved verbatim from the durable side
    /// provenance (`source_cut_cursor`). Display-only — not one of the cursor
    /// families: clients MUST NOT parse it and no method accepts it.
    pub cut_cursor: String,
    /// The `commandId` of the `session/sideChat` that created it.
    pub command_id: String,
}
