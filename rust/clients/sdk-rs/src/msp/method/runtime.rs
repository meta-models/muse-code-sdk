// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::turn::CommandStatus;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;
pub(crate) mod model_catalog;

/// `session/compact` params: manually compact the session's conversation
/// context — the `/compact` gesture. Compaction runs asynchronously; the ack is
/// admission only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCompactParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The run whose context to compact. Omit and the server resolves the
    /// session's current/latest run; a session with no resolvable run rejects
    /// with `commandRejected` reason `missing_run`. Any syntactically valid
    /// UUID: a turn from an older session may carry a v4 or v5 id. A malformed
    /// id is `invalidParams`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

/// `session/compact`'s ack status: the one method that may answer `noop` in
/// addition to the `accepted`. A noop is a success, not an error, and it is
/// durably settled like any other outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CompactStatus {
    /// The compaction was admitted.
    Accepted,
    /// The command was accepted but there was nothing to compact.
    Noop,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `session/compact` result. Failures *after* admission (`summarizer_failed`,
/// `install_rejected`, `cancelled`) are not wire errors — they arrive as the
/// compaction's terminal view event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionCompactResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status, or `noop`.
    pub status: CompactStatus,
    /// Why the command was a noop, e.g. `no_compactable_history`. Present on a
    /// `noop` status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `session/setModel` params: the model-picker gesture. The selection is
/// durable and applies to subsequent model calls.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetModelParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The selection.
    pub model: ModelSelection,
}

/// A model selection. Empty strings are normalized to absent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    /// Catalog model id. Required.
    pub model_id: String,
    /// Provider routing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    /// Provider profile. Omitted and explicit `null` both mean "no profile".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_id: Option<String>,
    /// Presentation label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_label: Option<String>,
}

/// `session/setModel` result. If a turn is running the selection is admitted
/// now and applied at the next model-call boundary; the ack does not wait for
/// that boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionSetModelResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
}

/// `session/rename` params: set or change the durable allocated session name
/// through the runtime `session_name` command. One writer; withheld under the
/// ephemeral profile.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRenameParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The requested name; the runtime's normalization and validation apply.
    pub name: String,
}

/// `session/rename` result: `name` is the canonical (normalized) name the
/// durable record settled.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionRenameResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The settled canonical name. Omitted on the `RecoveryPending` arm, which
    /// answers `{commandId, status: "accepted"}` and delivers the name via
    /// `session/nameChanged` / `Session.name`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// `session/setReasoningEffort` params: set the session's standing
/// reasoning-effort default. A turn carrying its own `reasoningEffort`
/// overrides it for that turn only; the default overrides the host's configured
/// default. Same accept/reject and `commandId` idempotency shape as
/// `session/setModel`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSetReasoningEffortParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The new session default: the closed eight-string tier vocabulary
    /// `turn/start` carries, spelled identically. Invalid tiers are invalid
    /// params. A default of `max` rides provider requests verbatim, never
    /// clamped.
    pub reasoning_effort: crate::msp::method::turn::ReasoningEffort,
}

/// `session/setReasoningEffort` result. The default is durable on ack and
/// applies to turns launched after admission; a running turn keeps the request
/// options it already resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionSetReasoningEffortResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
}

/// `session/userShell` params: run a user-initiated shell command in the
/// session's workspace — the TUI's `!` escape hatch. **Capability-gated**: the
/// connection must negotiate `userShell` at `initialize`, and the whole
/// justification is the spawn boundary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUserShellParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The shell command to run.
    pub command_text: String,
}

/// `session/userShell` result: immediate. The shell runs off the command worker
/// so a long command cannot stall the command plane; the output arrives as the
/// `userShell` item's terminal view event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionUserShellResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
}
