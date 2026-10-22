// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::turn::CommandStatus;
use crate::msp::view::item_content::BackgroundInitiator;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

mod catch_all;

/// `task/background` params: durably send a running foreground tool task to the
/// background.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskBackgroundParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The task to background, exactly as the view names it: the `toolCall`
    /// item's `itemId` IS the task id.
    pub task_id: String,
}

/// `task/stop` params: stop one named background task. Required target, never
/// "whichever is loudest" — is the blanket verb.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStopParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The task to stop, the `toolCall` item's `itemId`.
    pub task_id: String,
}

/// `task/stopAll` params: stop every stoppable background workload live at
/// admission.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStopAllParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
}

/// The `task/background` / `task/stop` ack: admission-only, echoing the
/// targeted task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TaskCommandResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// Echoes the targeted task id.
    pub task_id: String,
}

/// The `task/stopAll` ack: always `accepted`, including over an empty set — a
/// blanket stop over nothing is a satisfied gesture. The ack deliberately
/// carries no stopped-task list; count the kills from the view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TaskStopAllResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
}

/// `task/list` params: the session whose background-task inventory to read. A
/// read-only query in the `skill/list` mold: no `commandId`, no durable record,
/// no view event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskListParams {
    /// The target session.
    pub session_id: String,
}

/// `task/list` result: one row per live workload, background and foreground,
/// oldest first; empty when nothing is running.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TaskListResult {
    /// The session's live task rows.
    pub tasks: Vec<TaskListEntry>,
}

/// One task inventory row. The row is the stable contract: `kind` and `status`
/// stay open so a future state extends them without breaking clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TaskListEntry {
    /// The `toolCall` item's `itemId` for item rows; the runtime registry
    /// id for registry-only rows.
    pub task_id: String,
    /// What the workload is: `"tool"` or `"tool.*"` for item rows (the
    /// recorded kind when the registry records one, else `"tool"`); the
    /// recorded registry kind string verbatim for registry-only rows.
    /// Open vocabulary — clients MUST ignore unknown kinds. A `String`,
    /// not an enum: registry kind strings are unbounded.
    pub kind: String,
    /// `"inProgress"` — the only value at this increment, since every
    /// listed row is non-terminal by construction.
    pub status: TaskListStatus,
    /// The short tool name on item-visible tool rows only; never a label,
    /// never arguments. **Additive-optional**: absent elsewhere.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// The host-known task start, RFC3339. **Additive-optional**: omitted,
    /// never guessed, when the host does not know it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// Who backgrounded the task, mirroring the item field.
    /// **Additive-optional**: absent on pre-split records and
    /// registry-only rows, never inferred.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_initiator: Option<BackgroundInitiator>,
    /// `"foreground" | "background"`. **Additive-optional**: absent means
    /// `"background"` (only pre-change hosts omit it, and those list background
    /// rows only); never guessed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<TaskExecutionMode>,
    /// The raw command text: the joined `toolCall` item's `command` argument
    /// verbatim. **Additive-optional**: omitted when the row has no item or the
    /// item carries no command. Monitors join raw — clients redact.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
}

/// A task row's status. Open: a future state is additive, and clients MUST
/// ignore unknown statuses.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TaskListStatus {
    /// The workload is live; every listed row carries this today.
    InProgress,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// A task row's execution mode. Open: clients MUST ignore unknown modes.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TaskExecutionMode {
    /// The task holds the turn (a census counts it; the stop sweep skips it).
    Foreground,
    /// The task runs detached (census and sweep both cover it).
    Background,
    /// A mode introduced by a newer server. Preserved verbatim so an older
    /// client keeps the unknown word instead of failing the parse. Not a v1
    /// server-emission value, so it is excluded from the generated known-value
    /// schema while the enum remains declared open (the `AdmissionDecision`
    /// precedent).
    Unknown(String),
}

impl TaskExecutionMode {
    /// The exact wire spelling, including a future value an older
    /// client does not understand.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Foreground => "foreground",
            Self::Background => "background",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for TaskExecutionMode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for TaskExecutionMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "foreground" => Self::Foreground,
            "background" => Self::Background,
            _ => Self::Unknown(value),
        })
    }
}
