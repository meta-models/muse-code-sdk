// @generated from the MSP stable schema and protocol sources; do not edit by hand.

pub use super::session_events::SessionStatus;
pub use super::session_satellites::AttentionFlag;
pub use super::session_satellites::EffectiveApprovalModeState;
pub use super::session_satellites::EffectivePermissionState;
pub use super::session_satellites::ForkProvenance;
pub use super::session_satellites::SessionSpawnedBy;
pub use super::session_satellites::SideProvenance;
use crate::msp::method::worktree::SessionWorktree;
use crate::msp::view::state::SessionNameOrigin;
use serde::Deserialize;
use serde::Serialize;

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
    /// The handshake `ClientInfo` of the connection whose wire `session/resume`
    /// most recently loaded this session: stamped on the durable
    /// `session.resumed` marker, folded into the session index, and served from
    /// that column by every carrier; while the session is loaded, the stamp the
    /// loading resume wrote replaces the column on every carrier (the ack,
    /// `session/read`, `session/list`, `session/listChanged`), and after the
    /// next fold the column serves it. **Additive-optional** and **provenance
    /// only**; a resume with no admitting handshake (TUI, exec) stamps nothing,
    /// a warm attach to an already-loaded session writes no marker, and a half
    /// stamp serves nothing, so absence asserts nothing. `createdByClient`
    /// never follows a resume.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resumed_by_client: Option<crate::msp::handshake::ClientInfo>,
    /// The session that opened this one, recorded once in this session's
    /// creation record and served from the session index. Its `parentSessionId`
    /// is the exact spawner, unlike the containing session `parentSessionId`
    /// names above; `project` and `thread` are opaque labels the spawner may
    /// name beside it. **Additive-optional** and **provenance only**: never a
    /// visibility or authority gate. Absence asserts nothing — no recorded
    /// spawner, a later session of the spawned process, a row folded before the
    /// member existed, or a session the index has not folded yet.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawned_by: Option<SessionSpawnedBy>,
    /// The handshake `ClientInfo` of the connection that currently holds this
    /// session's drive grant, served on `session/read` only, as `name` and
    /// `version` (the handshake's display `title` is never served, the
    /// `createdByClient` rule). **Additive-optional, loaded-only, live**:
    /// present exactly when a live connection holds the grant and its handshake
    /// is known; absent on `notLoaded` rows, once the holder's connection drops
    /// (its orphaned turn included), and for a holder with no handshake stamp.
    /// Provenance only: whether a client may drive is answered by
    /// `session/resume` / `turn/start` (`sessionInUse`), never by this member.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drive_holder: Option<crate::msp::handshake::ClientInfo>,
    /// The worktree this session runs in — path and origin only (the branch
    /// stays in `branch`). **Experimental** (`Session.worktree`; stripped
    /// per-connection for unopted callers). Omitted when the session runs in no
    /// worktree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<SessionWorktree>,
    /// This session's effective limits: the clamp output — the sandbox axes
    /// read the live ceiling, the trust axis clamps the session's durable
    /// stored choice (the clamp input) to it. `workspaceTrusted` is the trust
    /// the session runs with. **Experimental, same-user socket only**
    /// (`Session.currentLimits`; stripped per-connection for unopted callers).
    /// Loaded sessions only (`notLoaded` rows and hosts with no limits regime
    /// omit it) — absent is never fabricated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_limits: Option<super::limits::SessionLimits>,
    /// That another live process on this machine runs this session, and which
    /// kind of process when the host can tell. **Experimental**
    /// (`Session.runningElsewhere`; stripped per-connection for unopted
    /// callers), on `session/list` rows and the `session/listChanged` frames
    /// built from the same row. No frame is pushed when only this member
    /// changes; a client sees the change on its next `session/list` or on a
    /// frame sent for another reason. Present exactly when the answering host
    /// does not hold the session loaded and another live process on this
    /// machine does (it holds the session's writer lease, or a live local
    /// session registry record names the session), so only `notLoaded` rows
    /// carry it. Absence asserts only that the host saw no other holder when it
    /// built the row. Provenance only: whether a client may drive is answered
    /// by `session/resume` / `turn/start` (`sessionInUse`), never by this
    /// member.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub running_elsewhere: Option<RunningElsewhere>,
    /// The published head's ordinal (kt-dvw5): the head reference's own
    /// ordinal — the count of head slots in its sequence, including any
    /// reserved ones — as of the probe that served this row. A sizing
    /// hint for a first `view/page`, so the Console can size its page
    /// without folding the log. **Additive-optional**, present only on
    /// metadata reads (`session/read` with `excludeItems`), where the
    /// client has no items to count; full reads carry the items
    /// themselves and omit it. Absent when no head is published (unknown),
    /// never fabricated. May lag a live log: the head is a snapshot, and
    /// appends after its publication are not counted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_count: Option<u64>,
    /// The durable log's byte length at read time (kt-dvw5): the size hint
    /// paired with `itemCount`, so the Console can size its first page
    /// without folding the log. **Additive-optional**, present only on
    /// metadata reads (`session/read` with `excludeItems`); full reads omit
    /// it. Absent when the log's length is not known (unknown), never
    /// fabricated. A live log grows after the read; the value is a snapshot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub log_bytes: Option<u64>,
}

/// The `runningElsewhere` member of a `Session`: another live process on this
/// machine runs the session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RunningElsewhere {
    /// Which kind of process runs it, taken only from facts the host already
    /// reads; omitted when unknown, never guessed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<RunningElsewhereOrigin>,
}

/// Which kind of process runs a session elsewhere on this machine.
///
/// **Open**: a new origin is additive evolution, and a client MUST treat an
/// unknown value as an unknown-but-present origin rather than rejecting the
/// row.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RunningElsewhereOrigin {
    /// A TUI runs it.
    Tui,
    /// `muse exec` runs it.
    Exec,
    /// Another `muse serve` host runs it.
    Serve,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}
