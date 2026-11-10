// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// The runtime-owned git worktree a child session runs in, mirrored from the
/// `subagent.worktree.*` records on its parent's log. The four enums are open:
/// clients treat an unknown value as unknown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RuntimeWorktree {
    /// The recorded worktree root, verbatim (recorded history; serving it
    /// never probes the path).
    pub worktree_root: String,
    /// The commit the worktree was created from.
    pub base_commit: String,
    /// The head commit the active lease recorded.
    pub head_commit: String,
    /// Who owns the worktree.
    pub ownership: RuntimeWorktreeOwnership,
    /// How the worktree is cleaned up.
    pub cleanup_policy: RuntimeWorktreeCleanupPolicy,
    /// Where the worktree's cleanup stands.
    pub cleanup_state: RuntimeWorktreeCleanupState,
    /// True exactly when the parent's uncommitted changes were recorded as
    /// excluded from the checkout.
    pub parent_dirty_excluded: bool,
    /// Why cleanup kept the worktree or failed, as the cleanup outcome recorded
    /// it; absent when the outcome records no reason.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup_reason: Option<RuntimeWorktreeCleanupReason>,
    /// The cleanup outcome's recorded diagnostic, verbatim; absent when the
    /// outcome records none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup_diagnostic: Option<String>,
}

/// Who owns a session's worktree. The set is open, so newer hosts may send
/// other values.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RuntimeWorktreeOwnership {
    /// `runtimeOwned`: the runtime created the worktree and owns its cleanup.
    RuntimeOwned,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// How a session's worktree is cleaned up. The set is open, so newer hosts
/// may send other values.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RuntimeWorktreeCleanupPolicy {
    /// `removeIfClean`: the runtime removes the worktree when it has no
    /// uncommitted changes, and keeps it otherwise.
    RemoveIfClean,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// Where a session's worktree cleanup stands. The set is open, so newer
/// hosts may send other values.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RuntimeWorktreeCleanupState {
    /// `active`: no cleanup outcome is recorded yet.
    Active,
    /// `cleaned`: the runtime removed the worktree.
    Cleaned,
    /// `retained`: the runtime kept the worktree.
    Retained,
    /// `cleanupFailed`: the runtime tried to remove the worktree and failed.
    CleanupFailed,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// Why a session's worktree cleanup kept the worktree or failed. The set is
/// open, so newer hosts may send other values.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RuntimeWorktreeCleanupReason {
    /// `dirtyWorktree`: the worktree had uncommitted changes, so cleanup kept
    /// it.
    DirtyWorktree,
    /// `headChanged`: the worktree's head moved off the recorded head, so
    /// cleanup kept it.
    HeadChanged,
    /// `pathEscape`: the recorded worktree path's identity changed, so
    /// cleanup kept it.
    PathEscape,
    /// `cleanupFailed`: removing the worktree failed.
    CleanupFailed,
    /// `uncertainLeaseState`: reconciliation could not prove the lease
    /// state, so cleanup failed.
    UncertainLeaseState,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}
