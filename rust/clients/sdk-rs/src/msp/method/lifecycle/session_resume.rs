// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::session_mcp::SessionConfig;
use super::session_resume_members::AbnormalEnd;
use super::session_resume_members::AutoRecovery;
use super::session_resume_members::BlockedPrompt;
use super::session_resume_members::CronQuarantine;
use super::session_resume_members::LastTurn;
use super::session_resume_members::MissingPredecessor;
use super::session_resume_members::ModelIdRefusal;
use super::session_resume_members::PendingRequestPointer;
use crate::msp::method::session::Session;
use crate::msp::method::snapshot::ViewSnapshot;
use crate::msp::view::item::Item;
pub use attachments::RestartReceipt;
use serde::Deserialize;
use serde::Serialize;

pub(crate) mod attachments;

/// `session/resume` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResumeParams {
    /// The idempotency handle (UUIDv7). A resume that loads a session writes a
    /// durable `SessionResumed` record.
    pub command_id: String,
    /// Cold-resume replacement choice; omission preserves the retained choice.
    /// A warm attach rejects a different or unestablished choice as invalidParams.
    /// Explicit null is invalid.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub recovery_mode: Option<super::RecoveryMode>,
    /// The session to load.
    pub session_id: String,
    /// A view cursor previously observed by this client — or an observed
    /// `summarizedThrough` compaction anchor. When it names an event the server
    /// still holds, the server returns only the suffix and `history.mode` is
    /// `none`. A cursor the server minted that names no event yet, such as the
    /// empty start cursor of a session that had no events, is treated as no
    /// cursor: the server serves what a resume without a cursor would. A cursor
    /// older than the earliest event the server still holds gets a snapshot, or
    /// `-32040` `viewTruncated` when none fits. A cursor this session's view
    /// never minted is refused with `-32011` `notFound`, reason
    /// `missingAnchor`, and a compaction anchor naming a boundary the server
    /// has pruned is refused with `-32042` `boundaryPruned`. Omitted and
    /// explicit `null` both mean "no cursor".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Return only session metadata and live resume state; page history
    /// separately with `view/page`. Default `false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_items: Option<bool>,
    /// History mode preference, default `auto`. A PREFERENCE, not a budget
    /// override: when the requested mode does not fit the history budget the
    /// server downgrades it and `history.mode` reports what was actually
    /// served. Ignored when `cursor` or `excludeItems` makes it moot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<HistoryPreference>,
    /// The launch permission-profile pick: a profile id the host catalog
    /// already admits. Select, never create. Omitted restores retained
    /// authority only, with no override. The host restores first, then applies
    /// the pick in the same pre-marker step; over a declared lost record the
    /// restore is the never-wider reset, committed before the pick, and where
    /// the reset cannot commit the pick is committed alone as that reset. A
    /// pick that fails admission refuses the resume `commandRejected` (-32030;
    /// `permission_profile_unknown` / `permission_profile_unavailable`) before
    /// any durable byte. Explicit `null` is invalid params (the same closed
    /// null-tolerant set as at start).
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_profile: Option<String>,
    /// The explicit MSP model override: a model string the caller supplies at
    /// resume time. When present it wins over the retained binding's recorded
    /// origin — over a stamped label and over a stamped pin — and it recovers
    /// an otherwise-unresolved label binding by sending the override as the
    /// wire model instead of the unresolved refusal. Omitted preserves arm (2):
    /// the retained binding resolves by recorded origin exactly as without this
    /// member. Explicit `null` is invalid params (the same closed null-tolerant
    /// set as at start). The override changes the model within the retained
    /// provider; it never names a provider. A resume that loads the session
    /// records it as a resume `--model` records: nothing when it already is the
    /// session's model, else one durable selection with the provider's profile
    /// for that model. A resume that attaches to a loaded session switches the
    /// model live. A model the host refuses, a blank one included, leaves the
    /// session on its recorded model, which `session.modelId` reports; a
    /// connection that opted into `experimentalApi` also gets the reason in
    /// `modelIdRefusal`.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub model_id: Option<String>,
    /// The same open construction-time extension object as `session/start`.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub config: Option<SessionConfig>,
    /// the governing rules optional actor-bound explicit continuation object:
    /// the explicit user Resume action supplies it for a loaded paused source;
    /// absent or null keeps current resume behavior and does not release this
    /// feature's loaded-source hold. Nullable. Standalone DTO (T-50280-074):
    /// the real effect is T-50280-084's.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub continue_paused_source: Option<ContinuePausedSource>,
    /// Client-supplied shell prefix allow-rules override: omitted reinstalls
    /// the session's rules from the audit fact, present replaces with that set
    /// (an explicit empty array clears). Explicit `null` is invalid params.
    /// Until the served-handler slice, a host refuses any spelled
    /// `approvalRules` on `session/start`/`fork`/`resume` with `-32602`;
    /// clients omit it. **Experimental** (`session/resume.approvalRules`).
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub approval_rules: Option<Vec<super::super::approval::ClientApprovalRule>>,
    /// What a cold load does with a retained input image whose file is missing
    /// or corrupt. Omitted means `fail`; explicit `null` is invalid params.
    /// Only the resume that loads the session reads it; an attach ignores it.
    /// **Experimental** (`session/resume.missingInputAssets`).
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub missing_input_assets: Option<super::MissingInputAssets>,
    /// The trust ask for the session this resume loads:
    /// `session/start.limits`'s shape, of which a resume names only
    /// `workspaceTrusted`. Naming another axis is invalid params: a resumed
    /// session keeps its stored sandbox, write and shell limits. The ask takes
    /// the place of the session's stored trust choice, made or not, and the
    /// load records it as the session's choice; the host's ceiling bounds it as
    /// it bounds a stored one (`tightenedAxes` names a clamp). Only the resume
    /// that loads the session reads it; an attach ignores it. **Experimental,
    /// served only by the per-run host a TUI run starts**
    /// (`session/resume.limits`; unopted callers are refused `-32602`, as are
    /// opted callers on every other host, where a session resumes with its
    /// saved trust choice, which an earlier ask on a TUI run's host may have
    /// replaced, a fork or side-chat child included). Explicit `null` is
    /// invalid params.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub limits: Option<crate::msp::method::limits::SessionLimitsChoice>,
}

/// the governing rules explicit continuation object on `session/resume`:
/// requests explicit continuation of the named loaded actor, subject to
/// ordinary drive authorization and actual successful acceptance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContinuePausedSource {
    /// The loaded source actor to continue.
    pub source_instance_id: String,
}

/// The `history` request preference of `session/resume`. The forced values
/// downgrade `anchored` → `inline` → `snapshot` → `none`; under `auto` the full
/// rung order is anchoredSnapshot → anchored pending cut → inline → snapshot →
/// pending cut → elided snapshot → elided pending cut → none, a pending cut
/// being the snapshot with its `monitorInbox` cut to the entries still awaiting
/// delivery.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HistoryPreference {
    /// Serve the best rung that fits, anchored first.
    Auto,
    /// Prefer the full folded item array.
    Inline,
    /// Prefer a folded view state plus suffix.
    Snapshot,
    /// Prefer a snapshot anchored at the latest installed compaction boundary.
    Anchored,
}

/// The `history` envelope shared by `session/resume`, `session/fork`, and
/// `session/read`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionHistory {
    /// What was actually served — never what was asked for.
    pub mode: HistoryMode,
    /// The full folded item array when `mode` is `inline`; `null` otherwise.
    pub items: Option<Vec<Item>>,
    /// The folded view state when `mode` is `snapshot` or `anchoredSnapshot`;
    /// `null` otherwise.
    pub snapshot: Option<ViewSnapshot>,
    /// Why no history was served — sent exactly when `mode` is `"none"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub none_reason: Option<HistoryNoneReason>,
    /// The checkpoint-prune boundary: rows for served items at-or-before
    /// `through_item_id` in served order predate the selected checkpoint.
    /// Additive-optional; absence is a non-assertion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_boundary: Option<CheckpointBoundary>,
}

/// A served checkpoint-prune boundary: `through_item_id` names the last
/// first-opened item that opened strictly before the boundary checkpoint event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CheckpointBoundary {
    /// The last pre-boundary item's id, in served (first-opened) order.
    pub through_item_id: String,
}

/// Why a result served `history.mode: "none"` — the server's typed reason for
/// serving no history, with one push-only exception: `projectionRebuildFailed`
/// rides only a `session/viewHealthChanged` notification; no resume or read
/// result carries it (see its variant doc). Open on the client side: an
/// absent (older server) or unknown (newer server) value decodes
/// conservatively as an unknown reason, and `viewCursor` text never
/// substitutes for it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HistoryNoneReason {
    /// The request's effective `excludeItems` was `true` (the
    /// `session/read` default; explicit on resume/fork).
    Excluded,
    /// A retained cursor was supplied; the streamed suffix carries the
    /// history.
    CursorSuffix,
    /// Every rung through the elided pending cut exceeded the history budget;
    /// page via `view/page` from the result's `viewCursor`.
    HistoryBudget,
    /// No trustworthy materialized projection exists; paging cannot recover it.
    ProjectionUnavailable,
    /// The projection exists but the aggregate materialized read exceeded
    /// its bounded read cap; page in bounded chunks.
    ProjectionReadLimit,
    /// One value is push-only: `projectionRebuildFailed` rides only a
    /// `session/viewHealthChanged` notification, after the host's one re-load
    /// of a failed live view fails or right after a fork child's live
    /// fail-close; no resume or read result carries it. The view stays
    /// unavailable for this load; never followed by `healthy`.
    ProjectionRebuildFailed,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// What history a lifecycle result actually served. Open on the client side:
/// report-what-was-served means a client treats an unknown mode as "page it
/// yourself".
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HistoryMode {
    /// `snapshot` holds a folded view state anchored at the latest installed
    /// compaction boundary; `snapshot.anchor` names it.
    AnchoredSnapshot,
    /// `items` is the full folded item array.
    Inline,
    /// `snapshot` holds a folded view state at `snapshot.viewCursor`.
    Snapshot,
    /// No history was served — page it via `view/page` from the result's
    /// `viewCursor`.
    None,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// `session/resume` result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionResumeResult {
    /// The loaded session.
    pub session: Session,
    /// The session view head; the connection is subscribed after it. A
    /// still-loaded session a prior `view/unsubscribe` detached is RE-ATTACHED
    /// by this resume: live delivery resumes from this head. Explicit-cursor
    /// re-attach with `(after, head]` engine replay stays `view/subscribe`.
    pub view_cursor: String,
    /// The served history.
    pub history: SessionHistory,
    /// The late-joiner pointer set; empty when nothing is pending.
    pub pending_requests: Vec<PendingRequestPointer>,
    /// How the last folded turn ended. **Additive-optional**; absence is a
    /// non-assertion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_turn: Option<LastTurn>,
    /// The axes this resume tightened: when the stored choice exceeds the
    /// restarted host's narrower ceiling, the resume clamps to fit, carries the
    /// tightened `currentLimits` on the session, and names each tightened axis
    /// here. **Experimental, same-user socket only**
    /// (`session/resume.tightenedAxes`; stripped per-connection for unopted
    /// callers). Absent when nothing tightened — never an empty array.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tightened_axes: Option<Vec<String>>,
    /// The recallable blocked prompt's refill text. **Additive-optional**;
    /// absence means no blocked prompt to recall (an unblocked session, or a
    /// pre-feature host). Data only, never a rendered row: clients seed cold
    /// recall from it (C-p refills `text`) and MUST NOT display it as history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked_prompt: Option<BlockedPrompt>,
    /// The previous run's abnormal end this resume's own load adopted.
    /// **Experimental** (`session/resume.abnormalEnd`; stripped for unopted
    /// connections); absence asserts nothing (an attach to a loaded session, a
    /// clean prior end, or an older host). Clients may show a one-time notice
    /// from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub abnormal_end: Option<AbnormalEnd>,
    /// One short record per child session the checkpoint boundary pruned.
    /// **Additive-optional**, like `queuedInputs` on the read:
    /// absent-when-empty, never stripped.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pruned_subagents: Option<Vec<super::PrunedSubagent>>,
    /// The cron quarantine this resume's own load adopted. **Experimental**
    /// (`session/resume.cronQuarantine`; stripped for unopted connections);
    /// absence asserts nothing (an attach to a loaded session, a healthy or
    /// missing store, or an older host). Clients show the gate-off warning row
    /// once from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cron_quarantine: Option<CronQuarantine>,
    /// The manual-compaction restart receipts this resume's own load scanned.
    /// **Experimental** (`session/resume.restartReceipts`); absence asserts
    /// nothing (an attach to a loaded session, no unserved restart arm, or an
    /// older host). Absent when the scan found none — never an empty array.
    /// Each entry mirrors the runtime `ManualCompactionReceipt`; clients apply
    /// them through the shared receipt path.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_receipts: Option<Vec<RestartReceipt>>,
    /// The retained input images this resume's own `report` load replaced with
    /// a marker, one entry per distinct digest (a provisional owner ruling) at
    /// its first occurrence: runs in the log position of their accepted User
    /// Intent record (a run with none at its first run record), then images by
    /// position in the run. **Experimental**
    /// (`session/resume.unavailableInputAssets`; stripped for unopted
    /// connections); absent when nothing was replaced, never an empty array.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_input_assets: Option<Vec<super::UnavailableInputAsset>>,
    /// The declared predecessor whose retained log this resume's own load found
    /// missing. **Experimental** (`session/resume.missingPredecessor`; stripped
    /// for unopted connections); absence asserts nothing (an attach to a loaded
    /// session, a root session, a present predecessor, or an older host).
    /// Clients show the gate-off missing-predecessor notice once from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_predecessor: Option<MissingPredecessor>,
    /// The `modelId` this resume carried and the host refused: the session
    /// opened on its recorded model, which `session` reports. **Experimental**
    /// (`session/resume.modelIdRefusal`; stripped for unopted connections);
    /// absent when the resume carried no `modelId` or the host recorded or kept
    /// it. Clients show the model kept and the reason once from it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id_refusal: Option<ModelIdRefusal>,
    /// The auto-recover outcome of this resume's own load (amendment
    /// 26387/68619, G-23). **Experimental** (`session/resume.autoRecovery`;
    /// stripped for unopted connections); absent unless the load ran with
    /// the `resume_auto_recover` gate on and an effective `recoveryMode` of
    /// ON, so a gate-off host's result is unchanged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_recovery: Option<AutoRecovery>,
}
