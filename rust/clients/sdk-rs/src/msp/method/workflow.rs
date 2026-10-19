// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::turn::CommandStatus;
use serde::Deserialize;
use serde::Serialize;

/// `workflow/cancel` params: cancel a live workflow run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowCancelParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The run to cancel, exactly as the `workflow` item names it; required,
    /// non-empty.
    pub workflow_run_id: String,
}

/// Which control to apply to the child's current attempt. Closed on the wire:
/// an unknown value is `-32602 invalidParams`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkflowChildAction {
    /// Cancel the child's current live attempt and move on.
    Skip,
    /// Cancel it and durably admit a replacement attempt under the same
    /// child owner.
    Retry,
}

/// `workflow/childControl` params: skip or retry one workflow child, keyed by
/// the `(childId, attempt)` pair the `workflow` item's `children[]` carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowChildControlParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The run owning the child; required, non-empty.
    pub workflow_run_id: String,
    /// The child, from the item's `children[]`; required, non-empty.
    pub child_id: String,
    /// The child's CURRENT attempt (integer >= 1). A stale value rejects
    /// `"stale_attempt"`; re-read the item and re-key — never guess.
    pub attempt: u64,
    /// The control to apply.
    pub action: WorkflowChildAction,
}

/// `workflow/pause` params: pause a live workflow run, shaped exactly like
/// `workflow/cancel`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowPauseParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The run to pause, exactly as the `workflow` item names it; required,
    /// non-empty.
    pub workflow_run_id: String,
}

/// The shared admission-only ack: deliberately bare `{commandId, status}` —
/// settlement arrives as the workflow item's view events, never through the
/// ack.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct WorkflowControlResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
}

/// `workflow/resume` params: resume a paused workflow run, host-driven.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowResumeParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The paused run to resume, exactly as the `workflow` item names it;
    /// required, non-empty.
    pub workflow_run_id: String,
}

/// `workflow/resume` result: admission-only plus the driven turn — always
/// present, since resume always drives (idle fresh turn or busy steer).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct WorkflowResumeResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The turn the host drove: the fresh resume turn on an idle session, the
    /// admission-time active turn on a busy session.
    pub turn_id: String,
}
