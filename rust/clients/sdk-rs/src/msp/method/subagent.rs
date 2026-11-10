// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::item::SubagentControlStatus;
use serde::Deserialize;
use serde::Serialize;

/// `subagent/list` params: the session whose subagent roster to read. A
/// read-only query in the `skill/list` mold: no `commandId`, no durable
/// record, no view event. Served by the loaded parent's runtime control
/// records, so its refusals (`-32020`/`-32021`/`-32022`/`-32024`, plus a retryable
/// `-32603` when the runtime source declines) are the `task/list` split.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentListParams {
    /// The target session (the parent whose children to list).
    pub session_id: String,
}

/// `subagent/list` result: the session's roster rows. Empty only when the
/// parent's control records name no durable child; a declined source
/// refuses typed instead of answering empty.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SubagentListResult {
    /// The session's roster rows, ordered by `(agentPath, subagentId)`.
    pub subagents: Vec<SubagentRosterEntry>,
}

/// One roster row: a durable child's identity, place, and state, projected
/// from its control records. Rows carry no result content — the transcript
/// stays on the child session / `subagent/readResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SubagentRosterEntry {
    /// The durable child identity (`subagent_id`). Rows without one are not
    /// roster rows: a rejected spawn names no child.
    pub subagent_id: String,
    /// The child's own session id, readable via `session/read`/`view/page`.
    /// **Additive-optional**: absent until the child's start is attested.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<String>,
    /// The agent definition path (`agent_path`), verbatim from the spawn.
    pub agent_path: String,
    /// The child's display name: the spawn `description`, falling back to
    /// the spawn `role`. **Additive-optional**: absent when neither carries
    /// one; never parsed from `agentPath`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The granted definition's name (`definition_grant_audit`
    /// `definition_name`). **Additive-optional**: absent on spawns without
    /// a grant audit (historical records). The resolved definition id is
    /// not persisted on the spawn record, so the name is what the roster
    /// can truthfully carry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub definition_name: Option<String>,
    /// The parent row's `agentPath`. **Additive-optional**: absent whenever
    /// `parentSubagentId` is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_path: Option<String>,
    /// The parent's `subagentId`: the roster row whose child session issued
    /// this child's spawn. **Additive-optional**: absent when the parent is
    /// the root session, or when the parent row is not in the roster or not
    /// yet attested — never guessed, never derived from `agentPath`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_subagent_id: Option<String>,
    /// The spawn depth (1 = a root-session child).
    pub depth: u32,
    /// The spawn role. **Additive-optional**: absent when the spawn
    /// carried none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// The spawn objective. **Additive-optional**: absent when the spawn
    /// carried none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    /// The owning dynamic workflow run id, when the child was
    /// workflow-admitted. **Additive-optional**: absent for native spawns.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_run_id: Option<String>,
    /// The child's control status: `Accepted` at spawn, then the latest
    /// `StatusUpdated` / `Closed` / `ResultReady` / `RecoveryAvailable` /
    /// `RecoveryDecision` (`Accepted | Starting | Running | ResultReady |
    /// Closing | Closed | RecoveryPending | ManualReconciliation`).
    pub control_status: SubagentControlStatus,
    /// Whether the child's latest attempt's result is ready (a
    /// `ResultReady` for the latest admitted attempt seen).
    pub result_ready: bool,
    /// The terminal reason: the result envelope's `errorKind` when present,
    /// else the cancel outcome's `reason`. **Additive-optional**: absent on
    /// live rows and on terminals that carry no reason — never fabricated
    /// from the close outcome's status word.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_reason: Option<String>,
    /// The child's observed wall-clock duration in ms, when the runtime
    /// observed one. **Additive-optional**: absent until first observation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}
