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
    /// `sessionStart`: a session starts, resumes, is cleared, is forked, or
    /// continues after compaction.
    SessionStart,
    /// `userPromptSubmit`: the user submits a prompt, before the model sees it.
    UserPromptSubmit,
    /// `preToolUse`: a tool call has been validated and is about to run.
    PreToolUse,
    /// `permissionRequest`: a tool call is waiting for approval.
    PermissionRequest,
    /// `postToolUse`: a tool call finished successfully.
    PostToolUse,
    /// `preLLMCall`: a model request is about to be sent.
    PreLLMCall,
    /// `postLLMCall`: a model response was received.
    PostLLMCall,
    /// `preCompact`: context compaction is about to run.
    PreCompact,
    /// `postCompact`: context compaction finished.
    PostCompact,
    /// `subagentStart`: a child agent session starts during a turn.
    SubagentStart,
    /// `subagentStop`: a child agent session is about to stop.
    SubagentStop,
    /// `stop`: the model is about to end the turn.
    Stop,
    /// `sessionEnd`: the session shuts down. Observation only.
    SessionEnd,
    /// `notification`: the session is waiting on the user, for example on a
    /// pending approval or a new question. Observation only.
    Notification,
    /// `postToolUseFailure`: a tool call failed.
    PostToolUseFailure,
    /// `stopFailure`: the turn ended because the model call failed. Observation
    /// only.
    StopFailure,
    /// `postToolBatch`: one batch of tool results was committed.
    PostToolBatch,
    /// `interrupt`: a top-level turn was cancelled. Observation only, and never
    /// sent for a child agent's turn.
    Interrupt,
    /// `sessionFork`: a fork of the session has completed. The host waits for
    /// the handler's verdict, which decides how the fork is presented (such
    /// as its tab label) but cannot block the fork.
    SessionFork,
    /// `toolUseStart`: an approved tool call is about to start running.
    /// Observation only.
    ToolUseStart,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}
