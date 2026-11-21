// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::item_content::OutputRef;
use crate::msp::view::item_content::WorkflowChild;
use crate::msp::view::item_content::WorkflowPhasePlanEntry;
use crate::msp::view::item_content::WorkflowPhasePlanUnreadable;
use crate::msp::view::item_content::WorkflowTokenBudget;
use serde::Deserialize;
use serde::Serialize;

/// `workflow` members, flattened into [`Item`](super::Item).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct WorkflowMembers {
    /// `workflow`: launched entry identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry_id: Option<String>,
    /// `workflow`: launched script identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub script_id: Option<String>,
    /// `workflow`: camelCased `WorkflowLaunchTriggerSource`, verbatim
    /// (durable runtime vocabulary, e.g. `"modelProposal"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger_source: Option<String>,
    /// `workflow`: set on resumed launches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_from_run_id: Option<String>,
    /// `workflow`: `true` only while a durable pause fact is in force for the
    /// run's generation; absent otherwise, never `false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paused: Option<bool>,
    /// `workflow`: folded per-child state, keyed by `(childId, attempt)`,
    /// re-emitted whole on every change — the item `revision` is the ordering
    /// guard.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub children: Option<Vec<WorkflowChild>>,
    /// `workflow`: the reconciled terminal message, set on completion.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// `workflow`: the run's launch token budget, set from the launch fact;
    /// absent when the launch carried none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<WorkflowTokenBudget>,
    /// `workflow`: the run-level declared-phase label — the last `Phase`
    /// detail-row label of the reconciled projection; terminal-only, absent
    /// while live.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub declared_phase: Option<String>,
    /// `workflow`: the human terminal summary projected from the reconciled
    /// Launch envelope, bounded at the 64 KiB surface budget; terminal-only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_summary: Option<String>,
    /// `workflow`: display-only stop affordance — `true` while the run is open,
    /// `false` once settled; stopping rides `workflow/cancel`. Authorizes
    /// nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_available: Option<bool>,
    /// `workflow`: one `outputRef`-shaped link per recorded child spawn with an
    /// objective (`kind: "workflow_child_prompt"`), fetched via
    /// `item/readOutput`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_prompt_refs: Option<Vec<OutputRef>>,
    /// `workflow`: the run's declared phase plan, whole and in declared
    /// order, re-sent on every emission. `[]` is a declared plan with no
    /// phases; absent means the run declared no plan, or the host has not
    /// read it yet. Never present together with `phasePlanUnreadable`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_plan: Option<Vec<WorkflowPhasePlanEntry>>,
    /// `workflow`: served instead of `phasePlan` when the host cannot read
    /// the run's declared phase plan; once set, it stays for the run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase_plan_unreadable: Option<WorkflowPhasePlanUnreadable>,
}
