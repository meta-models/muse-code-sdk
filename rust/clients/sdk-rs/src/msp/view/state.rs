// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::SourceRange;
pub use permission_profile::PermissionApprovalAxis;
pub use permission_profile::PermissionAxes;
pub use permission_profile::PermissionFilesystemAxis;
pub use permission_profile::PermissionNetworkAxis;
pub use permission_profile::ReviewerAuthority;
use serde::Deserialize;
use serde::Serialize;
pub use session_name::SessionNameOrigin;
pub use usage::ContextUsage;
pub use usage::CumulativeTokenUsage;
pub use usage::TokenUsage;

mod catch_all;
pub(crate) mod permission_profile;
pub(crate) mod session_name;
pub(crate) mod usage;

/// `session/modelChanged` params: a durable model-selection record landed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionModelChangedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The selected model.
    pub model_id: String,
    /// The selected provider; `null` when the selection names none.
    pub provider_id: Option<String>,
    /// What drove the selection.
    pub source: ModelChangeSource,
}

/// What drove a model selection. Open.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ModelChangeSource {
    /// The user selected the model.
    User,
    /// The host's configured default.
    Default,
    /// Policy selected the model.
    Policy,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `session/reasoningEffortChanged` params: a durable reasoning-effort
/// reconfigure record landed. Replace wholesale, latest wins; the snapshot
/// carries the latest value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionReasoningEffortChangedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The new session default: the closed eight-string tier vocabulary of the
    /// protocol spec, spelled identically.
    pub reasoning_effort: crate::msp::method::turn::ReasoningEffort,
    /// What drove the change.
    pub source: ReasoningEffortChangeSource,
}

/// What drove a reasoning-effort default change. Open; v1's only producer is
/// `user` (an accepted `session/setReasoningEffort`).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ReasoningEffortChangeSource {
    /// The user set the default.
    User,
    /// The host's configured default.
    Default,
    /// Policy set the default.
    Policy,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `session/goalChanged` params: the projected goal block's value changed —
/// identical adoptions emit nothing (the change gate), and an explicit `null`
/// clears. Replace wholesale; `null` never means unchanged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionGoalChangedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The full current goal block, or `null` to clear.
    pub goal: Option<Goal>,
}

/// The session goal block. `status` and `percentComplete` are carried
/// **verbatim** — out-of-contract status strings and >100 percents pass
/// through; display clamping is the renderer's job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Goal {
    /// The goal objective text.
    pub objective: String,
    /// Goal status, verbatim from the durable goal state (free string by
    /// design: out-of-contract values pass through).
    pub status: String,
    /// Percent complete, verbatim (>100 passes through).
    pub percent_complete: u64,
    /// Current work description, when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_work: Option<String>,
    /// Next work description, when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_work: Option<String>,
    /// the governing rules (pick-4): goal creation time, epoch milliseconds,
    /// verbatim from the durable row. Absent on blocks whose producer never
    /// carried it (tool-result adoptions, pre-pick-4 logs); absence must never
    /// render as a fabricated zero.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<i64>,
    /// the governing rules (pick-4): last goal mutation time, epoch
    /// milliseconds, verbatim from the durable row. Same absence rule as
    /// `createdAtMs`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<i64>,
}

/// `session/todoListChanged` params: a `TodoSnapshotUpdated` record landed.
/// Replace the whole list on every event; an empty `items` array is a cleared
/// list, not a no-op.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionTodoListChangedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The snapshot revision. Diagnostics only, never an ordering guard —
    /// `viewCursor` orders.
    pub revision: u64,
    /// The tool that produced the snapshot, verbatim.
    pub source_tool: String,
    /// The full todo list, replaced wholesale.
    pub items: Vec<TodoItem>,
}

/// One todo entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TodoItem {
    /// The todo text.
    pub text: String,
    /// The todo status (camelCased runtime `TodoStatus`).
    pub status: TodoStatus,
    /// Present-tense active form, when the tool supplied one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_form: Option<String>,
}

/// Todo status: closed in the runtime, wire-open.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TodoStatus {
    /// Not started.
    Pending,
    /// In progress.
    InProgress,
    /// Done.
    Completed,
    /// Cancelled.
    Cancelled,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `session/branchChanged` params: a durable workspace-branch observation
/// landed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionBranchChangedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The observed workspace root.
    pub workspace_root: String,
    /// The observed branch; `null` on a detached-HEAD observation — a fact, not
    /// "unchanged".
    pub branch: Option<String>,
    /// The detected version-control system; absent when no repository was
    /// detected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vcs: Option<Vcs>,
}

/// Version-control system of a branch observation. Open.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum Vcs {
    /// Git.
    Git,
    /// Sapling.
    Sapling,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `session/approvalModeChanged` params: the fold of the durable approval-mode
/// reconfigure audit fact — every accepted change writes one; a mode flip
/// without an audit fact is a runtime bug by design.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionApprovalModeChangedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The mode now in effect.
    pub mode: ApprovalMode,
    /// How the mode took effect.
    pub source: ApprovalModeSource,
    /// The command that changed it.
    pub command_id: String,
    /// The requesting client's `clientInfo.name`, recorded on the audit fact.
    pub client_name: String,
}

/// `session/modelRouteUnserved` params: an accepted `login.credential_update`
/// installed a provider that cannot serve the session's STANDING model route.
/// Disclosure only — the standing selection is unchanged (no
/// `session/modelChanged` fires) and the repair path is a routable
/// `session/setModel`. Folded from the durable
/// `runtime.provider_reconfigure.standing_route_unserved` record; additive —
/// clients that predate it skip the unknown method.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionModelRouteUnservedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The command whose accepted swap installed the provider.
    pub command_id: String,
    /// The provider id the swap installed.
    pub installed_provider_id: String,
    /// The standing (still bound, now unroutable) model.
    pub model_id: String,
    /// The standing model's provider; `null` when the selection names none.
    pub provider_id: Option<String>,
}

/// The approval enforcement modes. **Closed** by design: a client selects a
/// preconfigured mode and can never construct one; widening this enum is a
/// deliberate, gate-visible protocol change.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ApprovalMode {
    /// No prompts; everything runs.
    AllowAll,
    /// Prompt for anything no rule matches (the interactive default).
    PromptUnmatched,
    /// Tools run sandboxed; prompt only on explicit permission requests.
    OnRequest,
    /// Anything no rule matches is denied with a typed denial — the
    /// default-deny mode automation should use.
    DenyUnmatched,
}

/// How an approval mode took effect. Open.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalModeSource {
    /// The sealed startup snapshot.
    Startup,
    /// Replayed from the durable log on load.
    Replay,
    /// An accepted `session/setApprovalMode` reconfigure.
    ApprovalReconfigure,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}
