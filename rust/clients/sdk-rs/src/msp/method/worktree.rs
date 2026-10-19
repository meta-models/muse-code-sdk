// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `session/start` `worktree` param: absent means no worktree — the start
/// proceeds exactly as today. Adjacently tagged on `mode`: a create carries an
/// optional `baseRef`, an existing carries a required `path` (omitted `path`
/// fails decode — the pre-existing invalid-params class, never a new message).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase")]
pub enum WorktreeStartRequest {
    /// The host allocates the worktree.
    #[serde(rename_all = "camelCase")]
    Create {
        /// The base to create from; omitted means `HEAD`.
        #[serde(skip_serializing_if = "Option::is_none")]
        base_ref: Option<String>,
    },
    /// The host validates and binds the given path.
    Existing {
        /// The caller-provided worktree path to validate.
        path: String,
    },
}

/// Where a session's worktree came from: `created` means the host
/// allocated it for the session, `attached` means the host bound a
/// caller-provided worktree.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum WorktreeOrigin {
    /// The host allocated this worktree for the session.
    Created,
    /// The host validated and bound a caller-provided worktree.
    Attached,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// The Session `worktree` member: path and origin only — the branch stays in
/// the existing `branch` member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionWorktree {
    /// Canonical worktree path the session runs in.
    pub path: String,
    /// Whether the host created or attached it.
    pub origin: WorktreeOrigin,
}
