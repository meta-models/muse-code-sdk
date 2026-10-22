// @generated from the MSP stable schema and protocol sources; do not edit by hand.

pub use super::session_events::SessionStatus;
use crate::msp::method::worktree::SessionWorktree;
use crate::msp::view::state::ApprovalMode;
use crate::msp::view::state::ApprovalModeSource;
use crate::msp::view::state::PermissionAxes;
use crate::msp::view::state::ReviewerAuthority;
use crate::msp::view::state::SessionNameOrigin;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// What kind of session this is.
///
/// **Open**: a new kind is additive evolution, and a client MUST render an
/// unknown value as an unknown-but-present kind rather than rejecting the
/// row. Both v1 values are terms the tree already uses — the child log
/// directory is `subagent` and `ItemKind` already carries a `subagent`
/// variant — so no new vocabulary is minted.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionKind {
    /// A canonical or legacy root home.
    Root,
    /// A child home under `<parent-session-dir>/subagent/<child-id>/`.
    Subagent,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// The session object every lifecycle method returns or lists.
///
/// Additive-optional evolution applies: clients must ignore unknown fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Session {
    /// The session identity.
    pub session_id: String,
    /// Absolute path of the session's durable log; non-nullable. Under the
    /// ephemeral session profile it is the **empty string**, meaning "no
    /// durable log exists" — the one value a client must not hand to a
    /// filesystem call.
    pub path: String,
    /// Load state as this host knows it; `session/list` reports `notLoaded` for
    /// sessions loaded by *other* hosts.
    pub status: SessionStatus,
    /// The `turnId` of the current foreground turn when `status` is `running`,
    /// and `null` when the session is idle.
    ///
    /// **Required-nullable.** Every served `Session` carries the member: `null`
    /// when the session is idle or not loaded, the turn id when it is running.
    /// An optional-absent shape would publish it as plain `string` and reject
    /// every idle `Session` frame the host sends.
    pub active_turn_id: Option<String>,
    /// RFC3339. For a fork this is the fork session id's UUIDv7 mint instant.
    pub created_at: String,
    /// RFC3339; never precedes `createdAt`.
    pub updated_at: String,
    /// The winning metadata fold's workspace root; `null` when that record
    /// omits it — absent is never fabricated.
    pub workspace_root: Option<String>,
    /// The winning metadata fold's provider; `null` when that record omits it.
    pub provider_id: Option<String>,
    /// The winning metadata fold's model; `null` when that record omits it.
    pub model_id: Option<String>,
    /// The folded effective approval mode. **Additive-optional**: a Session
    /// object that omits it means the host has not folded a mode, which is why
    /// the index-derived `session/list` entry may legitimately omit it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<EffectiveApprovalModeState>,
    /// The folded effective permission state. **Additive-optional**: a
    /// `"notLoaded"` row omits it (no live evidence, matching the `attention`
    /// precedent) and an older host omits it everywhere; absent is unknown,
    /// never active. `approvalMode` stays the effective-mode answer; this never
    /// restates it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_state: Option<EffectivePermissionState>,
    /// Attention flags. **Additive-optional**, present only when at least one
    /// flag is set; absence is a NON-assertion (nothing pending, or the loaded
    /// session's pending source declined to answer). Loaded sessions only: a
    /// `notLoaded` row omits it even while its durable pending set is
    /// non-empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attention: Option<Vec<AttentionFlag>>,
    /// Content-activity recency, RFC3339. **Additive-optional**: omitted when
    /// no content record exists. Never advanced by lifecycle bookkeeping (the
    /// resume marker, re-stamps) or a fork's copied seed-replay records, and
    /// never precedes `createdAt`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<String>,
    /// Completed-turn count from the session view fold.
    pub turn_count: u64,
    /// `null` for root sessions; fork provenance otherwise.
    pub forked_from: Option<ForkProvenance>,
    /// `null` for root sessions and forks; side provenance otherwise. A session
    /// carries at most one of `forkedFrom` and `sideFrom`.
    pub side_from: Option<SideProvenance>,
    /// The durable allocated session name. **Additive-optional**: present when
    /// the serving path holds an allocated name, omitted otherwise — absent is
    /// never fabricated. Authoritative and renameable via `session/rename`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// How the served `name` was set. **Additive-optional**, **fold-only**: the
    /// snapshot fold (`session/read`, the resume/start/fork-ack snapshot)
    /// derives and carries it from the log; `session/list` rows never carry it.
    /// Absent — and any value the client does not recognize — reads as unknown,
    /// never fabricated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_origin: Option<SessionNameOrigin>,
    /// The served generated short title. **Additive-optional**, **fold-only**:
    /// the snapshot fold derives the latest retained generated pair's short
    /// title from the log; `session/list` rows never carry it. Omitted when no
    /// pair was ever published — absent reads as unpublished, never fabricated,
    /// never inferred from the name text. `name` stays the canonical name it
    /// always was.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_name: Option<String>,
    /// Derived display title: a heuristic that may evolve — its carriage, not
    /// its derivation, is the contract. **Additive-optional**, omitted when
    /// underivable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Derived first-user-prompt preview. **Additive-optional**, omitted when
    /// underivable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_user_prompt: Option<String>,
    /// Derived workspace branch — the index's last derived value; the
    /// live-change signal stays `session/branchChanged`. **Additive-optional**,
    /// omitted when underivable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    /// What kind of session this is. **Open enum**, v1 values `"root"` and
    /// `"subagent"`; a client treats an unknown value as an unknown-but-present
    /// kind and renders it, never rejecting the row. **Additive-optional**:
    /// absence asserts nothing — the host could not determine the home shape,
    /// or the value is not yet available to serve.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<SessionKind>,
    /// The containing session's id when `kind` is `"subagent"` — the id of the
    /// TOP-LEVEL session whose home holds this child, which is **not
    /// necessarily the session that spawned it**: native-child homes are
    /// physical siblings under the outer session's `subagent/` directory, so a
    /// subagent spawned by another subagent resolves to the outer session, not
    /// to its spawner. A client building a tree from this field gets one level,
    /// not a chain. Flat rather than nested: there is exactly one fact to
    /// carry, unlike `forkedFrom`'s four-field `ForkProvenance`.
    /// **Additive-optional**; a root carries none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    /// The handshake `ClientInfo` recorded when the session was opened, echoed
    /// verbatim — provenance, never an interpretation, and never a visibility
    /// gate. **Additive-optional**; absence has four indistinguishable causes:
    /// an in-process open; an earlier record; a half stamp where only one of
    /// name/version was recorded and `ClientInfo` requires both; and a session
    /// with no admitting handshake of its own — a fork child or a subagent —
    /// which never carries a stamp to begin with.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by_client: Option<crate::msp::handshake::ClientInfo>,
    /// The worktree this session runs in — path and origin only (the branch
    /// stays in `branch`). **Experimental** (`Session.worktree`; stripped
    /// per-connection for unopted callers). Omitted when the session runs in no
    /// worktree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<SessionWorktree>,
    /// This session's effective limits: the clamp output — the sandbox axes
    /// read the live ceiling, the trust axis clamps the session's durable
    /// stored choice (the clamp input) to it. Until a tracked change lands,
    /// `workspaceTrusted` reports the recorded choice. **Experimental,
    /// same-user socket only** (`Session.currentLimits`; stripped
    /// per-connection for unopted callers). Loaded sessions only (`notLoaded`
    /// rows and hosts with no limits regime omit it) — absent is never
    /// fabricated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_limits: Option<super::limits::SessionLimits>,
}

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
