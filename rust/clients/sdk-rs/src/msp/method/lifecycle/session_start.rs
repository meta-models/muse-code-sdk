// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::RecoveryMode;
use super::session_mcp::SessionConfig;
use super::session_start_switch_policy::SwitchPolicy;
use crate::msp::method::approval::ClientApprovalRule;
use crate::msp::method::limits::SessionLimitsChoice;
use crate::msp::method::session::Session;
use crate::msp::method::session::SessionSpawnedBy;
use crate::msp::method::worktree::WorktreeStartRequest;
use crate::msp::view::state::ApprovalMode;
use serde::Deserialize;
use serde::Serialize;

/// `session/start` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartParams {
    /// The idempotency handle (UUIDv7). Required; the server never mints one.
    pub command_id: String,
    /// Recovery choice for this construction; omission keeps legacy behavior.
    /// Explicit null is invalid.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub recovery_mode: Option<RecoveryMode>,
    /// Exact identity for this new root session. When omitted the server mints
    /// a UUIDv7. This field never selects an existing session: a retained or
    /// reserved id is rejected `commandRejected` with reason
    /// `session_id_conflict`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Absolute path, folded into the first metadata record.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// The session's initial runtime workspace-root set: ordered absolute
    /// canonical existing directory paths; the first root is the CWD and plays
    /// the primary-root role; every root receives the `:workspace_roots` rules;
    /// extra roots grant no Project Trust. When `workspaceRoot` is also present
    /// the two must name the same folder, compared on canonical forms, or the
    /// request is invalid params, and so is explicit `null`. Omitted preserves
    /// single-root behavior.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_roots: Option<Vec<String>>,
    /// Initial model; server default when omitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// Initial provider routing; server default when omitted or explicit `null`
    /// — both spellings select the default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// The session's starting approval mode; server default when omitted or
    /// explicit `null` — both spellings select the default. Select, never
    /// create — the value names a mode the host's configuration already
    /// defines. This is the only surface that declares a non-interactive run's
    /// policy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_mode: Option<ApprovalMode>,
    /// The new session's initial permission profile: a profile id the host
    /// catalog already admits — the rows `permissionProfile/list` serves
    /// without `sessionId`. Select, never create. Omitted means today's
    /// behavior: the host's configured default under native admission,
    /// unchanged. An id the catalog does not carry, or one it serves
    /// unavailable, refuses the start `commandRejected` (-32030;
    /// `permission_profile_unknown` / `permission_profile_unavailable`) before
    /// any durable byte, and an ephemeral host refuses any id
    /// (`permission_profile_ephemeral_fixed`). `session/fork` does not admit
    /// the member; `session/resume` admits it as the launch pick. Explicit
    /// `null` is invalid params: the set of members that tolerate `null` is
    /// closed and excludes this one, exactly as it excludes `workspaceRoots`.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_profile: Option<String>,
    /// The session's client-supplied shell prefix allow-rules: `{argvPrefix}`
    /// objects in the `ShellPrefixSuggestion.argv_prefix` shape. Omitted means
    /// no client rules. Explicit `null` is invalid params; an empty array is an
    /// explicit empty set. Until the served-handler slice, a host refuses any
    /// spelled `approvalRules` on `session/start`/`fork`/`resume` with
    /// `-32602`; clients omit it. **Experimental**
    /// (`session/start.approvalRules`).
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub approval_rules: Option<Vec<ClientApprovalRule>>,
    /// Reserved for future per-session overrides; only its `mcpServers` member
    /// is admitted.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub config: Option<SessionConfig>,
    /// The session that opens this one, in the `Session.spawnedBy` shape: a
    /// spawner that starts a worker session over MSP names its own session
    /// here. The host writes it once into the new session's creation record, as
    /// a worker process records its environment hand-over, and `session/list` /
    /// `session/read` serve it back as `Session.spawnedBy`; `session/resume`
    /// never takes it. **Additive-optional** and **provenance only**. A value
    /// the host cannot use (a `parentSessionId` that is not a session id, a
    /// malformed member) records nothing and never refuses the start; an
    /// unusable `project` or `thread` is dropped on its own. Hosts that predate
    /// the member ignore it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawned_by: Option<SessionSpawnedBy>,
    /// Ask for a created worktree or attach an existing one. **Experimental**
    /// (`session/start.worktree`; unopted callers are refused `-32602`). Absent
    /// means no worktree — the start proceeds exactly as today.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub worktree: Option<WorktreeStartRequest>,
    /// The per-session restriction: the axes this session chooses, each at or
    /// below the host ceiling. **Experimental, socket-only**
    /// (`session/start.limits`; unopted callers are refused `-32602`, as are
    /// opted callers on hosts with no limits regime). Absent means the default
    /// on every axis — the daemon default for trust, the daemon's own posture
    /// for the sandbox axes (the ceiling, unless `--allow-session-posture`
    /// widens the ceiling above it). A choice wider than the ceiling on any
    /// axis refuses the start `-32028 limitsAboveMax` naming every too-wide
    /// axis. An equal or tighter choice is what the session runs and reports,
    /// with two exceptions refused `-32602`: on a daemon whose default sandbox
    /// is off, a start naming `sandboxEnabled: true` without `sandboxNetwork`,
    /// or a network restriction (`restricted` or `proxy-only`) without naming
    /// `sandboxEnabled`, until a tracked change settles how a session turns the
    /// sandbox on there, and a network restriction beside an explicit
    /// `sandboxEnabled: false`, which never turns it on and stays refused while
    /// a tracked change is open: drop the restriction, since a sandbox-off
    /// session has no network to restrict (`data.reason:
    /// "tighterSandboxUnserved"` for all three); and under `--trust-workspace
    /// --listen` without `--allow-session-posture`, an explicit
    /// `workspaceTrusted: false`, naming the axis. Elsewhere a network
    /// restriction beside `sandboxEnabled: false` restricts nothing: with the
    /// sandbox off the network is not sandboxed (`sandboxNetwork` reports
    /// `enabled`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limits: Option<SessionLimitsChoice>,
    /// The `/new` predecessor link: the outgoing session this start succeeds.
    /// Any syntactically valid session UUID; there is no existence check, so a
    /// link to a session that is gone still commits. Omitted means a true root.
    /// Explicit `null` is invalid params.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub previous_session_id: Option<String>,
    /// What happens to the `previousSessionId` predecessor's unfinished
    /// background work. **Experimental** (`session/start.switchPolicy`; unopted
    /// callers are refused `-32602`). `kill` cancels the predecessor's
    /// unfinished work once the new start is durable, as the gate-off `/new`
    /// does; `keep` ends its persistent monitors only. A policy without the
    /// link is invalid params, and so is explicit `null`. Omitted means no
    /// policy: the start records `keep`, exactly as today.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub switch_policy: Option<SwitchPolicy>,
}

/// `session/start` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionStartResult {
    /// The new session.
    pub session: Session,
    /// The session view head after the start fold; the connection is subscribed
    /// and receives every view event after this cursor. A deduplicated retry
    /// returns this same result.
    pub view_cursor: String,
}
