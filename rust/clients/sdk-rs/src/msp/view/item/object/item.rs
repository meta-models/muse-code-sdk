// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::ReplayHint;
use super::ScheduledFireMembers;
use super::ToolCallMembers;
use crate::msp::method::hook::HookEventName;
use crate::msp::view::item_content::BackgroundTerminalCompletion;
use crate::msp::view::item_content::CompactionOutcome;
use crate::msp::view::item_content::CompactionTrigger;
use crate::msp::view::item_content::DamagedRange;
use crate::msp::view::item_content::EarlierHistory;
use crate::msp::view::item_content::HookRunStatus;
use crate::msp::view::item_content::ItemKind;
use crate::msp::view::item_content::ItemStatus;
use crate::msp::view::item_content::MessageAttachment;
use crate::msp::view::item_content::OutputRef;
use crate::msp::view::item_content::SubagentControlStatus;
use crate::msp::view::item_content::SubagentResult;
use crate::msp::view::item_content::WebSearchHit;
use crate::msp::view::item_content::WorkflowChild;
use crate::msp::view::item_content::WorkflowTokenBudget;
use crate::msp::view::message_phase::MessagePhase;
use crate::msp::view::message_phase::lenient_message_phase;
use crate::msp::view::state::TokenUsage;
use serde::Deserialize;
use serde::Serialize;

/// One transcript item at one revision. `item/started`, `item/updated`, and
/// `item/completed` carry the full object; `item/delta` appends to it by field
/// path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Item {
    /// Bare UUIDv7; the item's identity across its whole lifecycle. Identity
    /// rule: the task id for task-backed kinds (`toolCall`, `subagent`), the
    /// pre-minted commit `message_id` for delta-streamed kinds (`agentMessage`,
    /// `reasoning`), `EventId::derive` over the session id and the range's
    /// starting sequence number for `damagedRange`, the same over the boundary
    /// checkpoint's sequence number for `earlierHistory`, and the opening
    /// durable record's event id for everything else. Opaque to clients.
    pub item_id: String,
    /// The item kind (open enum): clients MUST render unknown kinds generically
    /// — kind name plus `status` plus `fallbackText`.
    pub kind: ItemKind,
    /// The owning turn. `null` for the kinds outside a turn: `userShell`
    /// always, `hookRun` for session-boundary runs, `monitorFeed` always,
    /// `sideChat` always, `damagedRange` always, `earlierHistory` always.
    pub turn_id: Option<String>,
    /// Integer >= 1, strictly monotonic per item; apply rule is
    /// replace-iff-higher. `item/delta` never bumps it.
    pub revision: u64,
    /// Open enum; terminal = anything other than `"inProgress"`. Unknown values
    /// MUST be treated as terminal-unknown and rendered generically.
    pub status: ItemStatus,
    /// RFC3339 timestamp of the item's driving durable record. Absent on
    /// ephemeral-opened items until first durable re-emission.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recorded_at: Option<String>,
    /// Server-provided one-line human summary any kind MAY carry, for generic
    /// rendering of kinds a client does not recognize; new kinds SHOULD carry
    /// it during their first release cycle.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_text: Option<String>,

    /// `userMessage`: the prompt text as submitted. `agentMessage`: the
    /// accumulated reply, streamed via `item/delta` field `"text"`.
    /// `reasoning`: raw committed reasoning text where the provider exposes it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// `userMessage`: presentation form; absent when the client sent none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    /// `userMessage`/`userShell`: the submitting command — multi-client UIs
    /// de-duplicate their local echo on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    /// `userMessage`: `true` when injected mid-turn via `turn/steer` or
    /// `ifBusy: "steer"`; absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steered: Option<bool>,
    /// `userMessage`: `true` after an accepted retract; re-emitted via
    /// `item/updated`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retracted: Option<bool>,
    /// `userMessage`: image attachment metadata only — base64 payloads are not
    /// echoed back on the view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<MessageAttachment>>,
    /// `true` when the server's per-surface text budget saturated a streamed
    /// surface (`agentMessage.text`, `reasoning.summary[*]`,
    /// `toolCall.visibleOutput`, `userShell.visibleOutput`), cut a `subagent`
    /// surface (`objective`, `fallbackText`, `result.summary`, `result.text`),
    /// or cut a `monitorFeed` surface (`text`, `fallbackText`,
    /// `monitorDescription`). On a `subagent` item the flag is item-level and
    /// never cleared: once any of those four is cut, every later update keeps
    /// it, even when `result.text` arrives whole. The durable full text remains
    /// in the log.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    /// `agentMessage`: the phase the model declared on the commit; see [`MessagePhase`].
    #[serde(default, deserialize_with = "lenient_message_phase")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_phase: Option<MessagePhase>,
    /// `agentMessage`: the Monitor source descriptions for the wake turn's
    /// first answer — stripped, bounded, one entry per arming drain in drain
    /// order. Absent (or empty) means untagged: the row renders the ordinary
    /// untagged shape. The client scrubs per part before joining.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake_source_descriptions: Option<Vec<String>>,
    /// `agentMessage`: `true` when the provider stream died mid-reply and the
    /// run failed with this partial text committed — the wire mark for the
    /// gate-off "incomplete response" rule. Absent otherwise; never cleared
    /// once set.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cut_off: Option<bool>,

    /// `reasoning`: one entry per summary part; part *n* streams via
    /// `item/delta` field `"summary.n"` (part boundary = index change).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<Vec<String>>,
    /// `reasoning`: provider reasoning item id (e.g. `rs_...`), for
    /// provider-side correlation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_item_id: Option<String>,

    /// `toolCall` members, flattened beside the other optional members.
    #[serde(flatten)]
    pub tool_call: ToolCallMembers,

    /// `userShell`: the command text as submitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_text: Option<String>,
    /// `userShell`: the process exit code, when it exited by code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    /// `userShell`: the terminating signal NUMBER, when signalled (e.g. 9) —
    /// the durable payload verbatim; nothing maps numbers to names, and the
    /// fold never invents one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_signal: Option<i64>,
    /// `userShell`/`subagent`: observed wall-clock duration. `workflow`: the
    /// run's wall time from launch to reconciliation, set only on the settling
    /// `item/completed` — never a sum of child durations. `toolCall`: the
    /// Backgrounded row's duration — the open→update record delta in whole ms,
    /// served on the `backgroundStatus` re-emission and frozen there; absent
    /// otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,

    /// `subagent`: durable child identity (`subagent_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subagent_id: Option<String>,
    /// `subagent`: agent definition path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_path: Option<String>,
    /// `subagent`: nesting depth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth: Option<u32>,
    /// `subagent`: role as spawned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// `subagent`: objective as spawned, bounded on the wire at the 64 KiB
    /// retained-text budget; a cut sets `truncated`. The durable record stays
    /// verbatim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub objective: Option<String>,
    /// `subagent`/`reminderChild`: the child's own session id, readable via
    /// `session/read`/`view/page` — child transcript drill-down without a
    /// second protocol.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_id: Option<String>,
    /// `subagent`: camelCased `SubagentControlStatus` (open enum); `status`
    /// stays the generic item vocabulary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control_status: Option<SubagentControlStatus>,
    /// `subagent`/`workflow`: the owning durable workflow run id (opaque
    /// string — not a UUID family).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_run_id: Option<String>,
    /// `subagent`: **transitive** observed usage — the child and its own
    /// descendants; updated in place, absent until first observation; never
    /// folded into `session/tokenUsage.cumulative`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// `subagent`: the result envelope from `ResultReady`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<SubagentResult>,
    /// `subagent`: the host could not read this live child's run records when
    /// the parent resumed; a client says so once. A resume-time observation:
    /// present only as `true`, absent otherwise, never `false`, and never
    /// carried by a live notification.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_unreadable: Option<bool>,

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

    /// `reminderChild`: the reminder agent's id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminder_agent_id: Option<String>,
    /// `reminderChild`: the reminder generation.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<u64>,
    /// `reminderChild`: the linked task id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// `reminderChild`: parent-session-dir-relative child log path; absent
    /// when no filesystem log.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child_session_log_path: Option<String>,
    /// `reminderChild`: `true` when this child is a blocking reminder (it holds
    /// the turn open until it settles); absent otherwise, never `false`. The
    /// status word stays off the wire; clients name the reminder from
    /// `reminderAgentId`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking: Option<bool>,

    /// `sideChat`: the side's own session id, readable via
    /// `session/read`/`view/page` — drill-down without a second protocol.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side_session_id: Option<String>,

    /// `skillRead`: the read skill's catalog selector (matches the `skill/list`
    /// row; the raw observed id when the read resolved to no catalog row). Set
    /// on every `skillRead` item; old clients render it beside the kind name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// `skillRead`: the catalog source (matches the `skill/list` row); empty
    /// when the host could not resolve the read to a catalog row (replay
    /// without the tool result, context-only evidence). Set on every
    /// `skillRead` item; each client composes the notice line from `selector` +
    /// `source`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,

    /// `compaction`: terminal only — folds installed/fallback status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<CompactionOutcome>,
    /// `compaction`: what initiated the compaction.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trigger: Option<CompactionTrigger>,
    /// `compaction`: summarizer strategy (installed only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy_id: Option<String>,
    /// `compaction`: opaque provenance string naming the compaction boundary.
    /// Also a compaction-anchored read anchor, accepted by `session/resume` and
    /// `view/page`. Still opaque — clients relay it, never parse it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summarized_through: Option<String>,
    /// `compaction`: token budget snapshot before, when measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_before: Option<u64>,
    /// `compaction`: token budget snapshot after, when measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_after: Option<u64>,
    /// `compaction`: noop/failure reason, verbatim (snake_case durable
    /// vocabulary, e.g. `"no_compactable_history"`). `hookRun`: terminal-only
    /// capped terminal reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// `hookRun`: the durable `hook_key`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hook_key: Option<String>,
    /// `hookRun`: the hook event in Q2 camelCase vocabulary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub event: Option<HookEventName>,
    /// `hookRun`: terminal-only durable outcome; stays `blocked` when the item
    /// settles `rejected`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_status: Option<HookRunStatus>,
    /// `hookRun`: capped display label.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// `webSearch`: the search action as an open-enum string — `search` |
    /// `openPage` | `findInPage`, else tolerated unknown. Absent while the call
    /// is open (the action is not final until the item completes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// `webSearch`: the search query, verbatim — present iff `action ==
    /// "search"` with a query to carry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// `webSearch`: the page URL, verbatim — present iff `action == "openPage"`
    /// or `"findInPage"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// `webSearch`: the in-page pattern, verbatim — present iff `action ==
    /// "findInPage"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// `webSearch`: the provider's terminal status, verbatim (`"completed"` |
    /// `"failed"` | `"cancelled"` | other) — present on the completed item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_status: Option<String>,
    /// `webSearch`: the typed result hits, verbatim, never truncated — clients
    /// read `results.length` for the count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<WebSearchHit>>,
    /// `webSearch`: the verbatim raw provider JSON frame under the 64 KiB
    /// per-surface budget; past-budget frames cut here and ride whole behind
    /// `outputRef`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_item: Option<String>,
    /// `monitorFeed`: the monitor task id — the same value as that monitor's
    /// `toolCall` `itemId`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitor_id: Option<String>,
    /// `monitorFeed`: the monitor's arm-time description with the durable
    /// `"Monitor event: "` summary prefix stripped; model- controlled tool
    /// input under the 64 KiB per-surface budget — sanitize before render.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub monitor_description: Option<String>,
    /// `damagedRange`: what the damaged range cost.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub damaged_range: Option<DamagedRange>,
    /// `backgroundTerminalCompletion`: the five facts the Finished cell
    /// renders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background_terminal_completion: Option<BackgroundTerminalCompletion>,
    /// `earlierHistory`: the boundary checkpoint's transcript tail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub earlier_history: Option<EarlierHistory>,
    /// `scheduledFire` members, flattened beside the other optional members.
    #[serde(flatten)]
    pub scheduled_fire: ScheduledFireMembers,

    /// Terminal `toolCall`: the item after whose rows the terminal row renders.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_row_after_item_id: Option<String>,
    /// Monitor `toolCall`: the hint verdict plus anchor (`ReplayHint`); absent
    /// means no hint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_hint: Option<ReplayHint>,
}
