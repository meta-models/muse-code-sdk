// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `hook/list` params. Per-session because hook scope follows the session's
/// workspace and plugin state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookListParams {
    /// The target session.
    pub session_id: String,
}

/// `hook/list` result: one row per installed handler per event — a
/// `ResolvedHookHandler` carries one event, and grouping would lose
/// matcher/command identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct HookListResult {
    /// The session's installed hook rows.
    pub hooks: Vec<HookCatalogEntry>,
}

/// One installed handler.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct HookCatalogEntry {
    /// The handler key (config key or plugin hook id).
    pub key: String,
    /// The event the handler runs on.
    pub event: HookEventName,
    /// Where the handler comes from.
    pub handler_kind: HookHandlerKind,
    /// The row's own switch. Non-enabled rows are included as `false`, never
    /// dropped.
    pub enabled: bool,
}

/// A hook row's origin: the config `HookSourceKind` values plus
/// plugin-contributed. Open: a future origin is additive.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HookHandlerKind {
    /// A managed (fleet-composed) config hook.
    Managed,
    /// A user-settings config hook.
    User,
    /// A workspace-project config hook.
    Project,
    /// Contributed by an installed plugin.
    Plugin,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// Hook event names: the lowercase-first-letter spelling of every
/// `HookEventKind::all()` variant. Open: a future event value is additive.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HookEventName {
    SessionStart,
    UserPromptSubmit,
    PreToolUse,
    PermissionRequest,
    PostToolUse,
    /// Explicit rename: the governing rules rules lowercase-first-letter
    /// (`preLLMCall`), preserving the acronym.
    PreLLMCall,
    /// Explicit rename: the governing rules rules `postLLMCall`.
    PostLLMCall,
    PreCompact,
    PostCompact,
    SubagentStart,
    SubagentStop,
    Stop,
    SessionEnd,
    Notification,
    PostToolUseFailure,
    StopFailure,
    PostToolBatch,
    Interrupt,
    SessionFork,
    ToolUseStart,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}
