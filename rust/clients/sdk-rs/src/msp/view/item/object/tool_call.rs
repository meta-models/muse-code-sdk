// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::item_background::BackgroundInitiator;
use crate::msp::view::item_background::BackgroundStatus;
use crate::msp::view::item_content::ModelVisibleContent;
use crate::msp::view::item_content::OutputRef;
use crate::msp::view::item_content::PatchSummary;
use crate::msp::view::item_status::StatusAttempt;
use crate::msp::view::item_status::StatusChildren;
use crate::msp::view::item_status::StatusHealth;
use crate::msp::view::item_status::StatusProgress;
use crate::msp::view::item_status::StatusStep;
use crate::msp::view::tool_receipt::ToolReceipt;
use serde::Deserialize;
use serde::Serialize;

/// `toolCall` members, flattened into the item row.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ToolCallMembers {
    /// `toolCall`: tool name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    /// `toolCall`: the provider call id (`call_...`), opaque.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    /// `toolCall`: the model-authored argument JSON, **verbatim**; clients
    /// parse. Verbatim keeps the fold byte-deterministic and survives
    /// model-emitted almost-JSON.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    /// `toolCall`/`subagent`: `Failed`/`Rejected`/`Cancelled` reason text,
    /// verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
    /// `toolCall`: machine-readable failure class.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<String>,
    /// `toolCall`/`userShell`: bounded transcript-visible result text; streams
    /// via `item/delta` field `"output"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible_output: Option<String>,
    /// `toolCall`/`userShell`: stored-output reference; fetch the full bytes
    /// via `item/readOutput`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_ref: Option<OutputRef>,
    /// `toolCall`: the shared semantic receipt — what the operation did, as
    /// machine-readable fact. Optional and additive: absence is always valid
    /// and is never an error. When present, a server serves the **same**
    /// receipt on every item path — `item/completed`, `view/page`, seeded
    /// snapshots and resume. Observation only; carries no control authority,
    /// and no field in it enters model-visible content.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_receipt: Option<Box<ToolReceipt>>,
    /// `toolCall`: server-authored edit-family diff summary — always beside
    /// `patchRef`; absent = no diff available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_summary: Option<PatchSummary>,
    /// `toolCall`: stored structured-patch reference (`kind: "tool_patch"`,
    /// `mediaType: "application/json"`); the body is fetched via
    /// `item/readOutput` with `patchRef.id`, and the ref survives the
    /// elided-snapshot rung exactly like `outputRef` without ever being an
    /// elision trigger.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub patch_ref: Option<OutputRef>,
    /// `toolCall`: rich content the model saw beyond text; base64 is not
    /// inlined on the view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_visible_content: Option<Vec<ModelVisibleContent>>,
    /// `toolCall`: the approval that gated this call; join key for the approval
    /// view events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    /// `toolCall`: `true` once the task was durably backgrounded; delivered
    /// via `item/updated`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    /// `toolCall`: who backgrounded the task; absent on pre-split records —
    /// never inferred.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_initiator: Option<BackgroundInitiator>,
    /// `toolCall`: the backgrounded-row payload for a running backgrounded item
    /// — auto-yield or an explicit user/timeout background; may appear with or
    /// without `background`/`backgroundInitiator`. Experimental, delivered via
    /// `item/updated`. Presentation only — never a durability claim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_status: Option<BackgroundStatus>,
    /// `toolCall`: the task's visible latest-status line — the latest `Status`
    /// message through the shared detail normalization; absent when no status
    /// folded or nothing displayable remains.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_line: Option<String>,
    /// `toolCall`: the latest detail's phase row, verbatim; absent when the
    /// latest detail carries none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_phase: Option<String>,
    /// `toolCall`: the latest progress facet, field-for-field; absent when the
    /// latest detail carries none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_progress: Option<StatusProgress>,
    /// `toolCall`: the latest active-step facet, field-for-field; absent when
    /// the latest detail carries none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_step: Option<StatusStep>,
    /// `toolCall`: the latest external-attempt facet, field-for-field —
    /// countdown inputs the client renders the tick from; absent when the
    /// latest detail carries none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_attempt: Option<StatusAttempt>,
    /// `toolCall`: the latest health facet, field-for-field; absent when the
    /// latest detail carries none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_health: Option<StatusHealth>,
    /// `toolCall`: the latest child-summary facet, field-for-field; absent when
    /// the latest detail carries none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_children: Option<StatusChildren>,
    /// `toolCall`: the tool's own words for this call; absent = none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_label: Option<Box<crate::msp::view::tool_label::ToolDisplayLabel>>,
    /// `toolCall`: the task's registered Work ID, verbatim
    /// (`work.v2.managed_bash.sha256.…`); present only when the task registered
    /// a ManagedBash id, absent otherwise. Stable from day one: no
    /// `x-msp-stability` marker. The host serves it at the later of the task
    /// terminal and the inbox admission; absence keeps the client's v1
    /// derivation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
}
