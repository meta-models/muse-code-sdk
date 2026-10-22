// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::session::EffectiveApprovalModeState;
use crate::msp::method::turn::ReasoningEffort;
use crate::msp::view::item::Item;
use crate::msp::view::state::ContextUsage;
use crate::msp::view::state::CumulativeTokenUsage;
use crate::msp::view::state::Goal;
use crate::msp::view::state::ModelChangeSource;
use crate::msp::view::state::ReasoningEffortChangeSource;
use crate::msp::view::state::TodoItem;
use crate::msp::view::state::Vcs;
use serde::Deserialize;
use serde::Serialize;

/// The `snapshot` object returned by `session/resume` / `session/read`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ViewSnapshot {
    /// Snapshot schema version. A client whose generated types are older than
    /// this must fall back to inline/paged history.
    pub schema_version: u64,
    /// The cursor the state is folded at; every event after it streams as the
    /// suffix.
    pub view_cursor: String,
    /// Present exactly when `history.mode` is `anchoredSnapshot`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<SnapshotAnchor>,
    /// The complete folded view at `viewCursor`.
    pub state: SnapshotState,
}

/// The compaction boundary an anchored snapshot is anchored at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SnapshotAnchor {
    /// The view cursor of the boundary's `compaction` event.
    pub boundary_cursor: String,
    /// The boundary's opaque compaction anchor.
    pub summarized_through: String,
}

/// The complete folded view at the snapshot cursor.
///
/// Additive-optional evolution applies exactly as everywhere else; unknown
/// members MUST be ignored, and preserved if re-serialized.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SnapshotState {
    /// Every item, in first-opened order, each at its latest revision at the
    /// snapshot cursor. One schema per kind, shared with the notification item
    /// object — which is what makes snapshot+suffix a pure splice.
    pub items: Vec<Item>,
    /// The running foreground turn; `null` when none is running.
    pub active_turn: Option<TurnRef>,
    /// Admitted-but-not-launched submits, in launch order.
    pub queued_turns: Vec<TurnRef>,
    /// The pending-approval half of the pending set.
    pub pending_approvals: Vec<PendingApprovalPointer>,
    /// The pending-user-input half of the pending set.
    pub pending_user_inputs: Vec<PendingUserInputPointer>,
    /// The effective approval mode at this cursor — the same object the
    /// `Session` carries.
    pub approval_mode: EffectiveApprovalModeState,
    /// Latest effective model; `null` when no fact has landed.
    pub effective_model: Option<EffectiveModel>,
    /// Latest goal block; `null` when no fact has landed.
    pub goal: Option<Goal>,
    /// Latest todo list; `null` when no fact has landed.
    pub todo_list: Option<TodoListState>,
    /// Latest branch observation; `null` when no fact has landed.
    pub branch: Option<BranchState>,
    /// The settled canonical session name; `null` when the session was never
    /// named. Folds the same durable `session/nameChanged` record
    /// `Session.name` reports.
    pub name: Option<String>,
    /// The `cumulative` block of the last `session/tokenUsage` event; zeroes
    /// when none.
    pub token_usage: CumulativeTokenUsage,
    /// The latest `(windowTokens, usedTokens, pressure)` triple. The protocol
    /// allows "`null`/absent" and its worked example OMITS the member; the
    /// binary omits it too, so this is the absent arm — the four siblings above
    /// are present-null in the same frame. A member is published as one or the
    /// other, never both.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<ContextUsage>,
    /// The latest session-default reasoning effort with its source; ABSENT
    /// until a set lands.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffortState>,
    /// Completed-turn count at this cursor.
    pub turn_count: u64,
}

/// The snapshot's standing session-default reasoning effort: the fold of the
/// latest completed `runtime.reasoning_effort_reconfigure` fact — the same pair
/// `session/reasoningEffortChanged` carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ReasoningEffortState {
    /// The standing default tier — the closed vocabulary, spelled identically
    /// to `turn/start.reasoningEffort`.
    pub reasoning_effort: ReasoningEffort,
    /// Which actor class set the default.
    pub source: ReasoningEffortChangeSource,
}

/// A turn named by the snapshot's active/queued lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnRef {
    /// The turn's id, minted at admission.
    pub turn_id: String,
    /// The `commandId` of the submit that minted it.
    pub command_id: String,
    /// `queuedTurns[]` only: the queued submit's presentation text, so a late
    /// joiner can render it without waiting for launch. A current host sets it
    /// on every entry it admits; absent means an older host (or a pre-feature
    /// restored entry). Never set on `activeTurn`: the running turn's text is
    /// its `userMessage` item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    /// `queuedTurns[]` only: set when `displayText` was cut to the
    /// committed-surface budget, mirroring `userMessage.truncated`. Absent
    /// unless `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

/// A pending approval in the snapshot: the pointer shape plus the gated
/// `itemId` when one exists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PendingApprovalPointer {
    /// The pending approval's id.
    pub approval_id: String,
    /// The parked item, when one exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// The cursor the approval opened at.
    pub view_cursor: String,
}

/// A pending user-input prompt in the snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PendingUserInputPointer {
    /// The pending prompt's id.
    pub user_input_id: String,
    /// The parked item, when one exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// The cursor the prompt opened at.
    pub view_cursor: String,
}

/// The latest effective-model fact in the snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct EffectiveModel {
    /// The selected model.
    pub model_id: String,
    /// The selected provider; `null` when the selection names none.
    pub provider_id: Option<String>,
    /// What drove the selection.
    pub source: ModelChangeSource,
}

/// The latest todo-list fact in the snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TodoListState {
    /// The snapshot revision. Diagnostics only, never an ordering guard.
    pub revision: u64,
    /// The tool that produced the snapshot, verbatim.
    pub source_tool: String,
    /// The full todo list.
    pub items: Vec<TodoItem>,
}

/// The latest branch observation in the snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct BranchState {
    /// The observed workspace root.
    pub workspace_root: String,
    /// The observed branch; `null` on a detached-HEAD observation.
    pub branch: Option<String>,
    /// The detected version-control system; absent when none was detected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vcs: Option<Vcs>,
}
