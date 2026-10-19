// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::session_mcp::SessionConfig;
use crate::msp::method::session::Session;
use crate::msp::method::snapshot::ViewSnapshot;
use crate::msp::view::event::TurnError;
use crate::msp::view::event::TurnTerminal;
use crate::msp::view::item::Item;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

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
    /// `summarizedThrough` compaction anchor. When present the server returns
    /// only the suffix and `history.mode` is `none`. Omitted and explicit
    /// `null` both mean "no cursor".
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
    /// already admits. Select, never create. Omitted means today's behavior:
    /// restore retained authority only, no override. The host restores first,
    /// then applies the pick in the same pre-marker step; a pick that fails
    /// admission refuses the resume `commandRejected` (-32030;
    /// `permission_profile_unknown` / `permission_profile_unavailable`) before
    /// any durable byte. Explicit `null` is invalid params (the same closed
    /// null-tolerant set as at start).
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub permission_profile: Option<String>,
    /// The same open construction-time extension object as `session/start`.
    #[serde(
        default,
        deserialize_with = "super::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub config: Option<SessionConfig>,
}

/// The `history` request preference of `session/resume`. The forced values
/// downgrade `anchored` → `inline` → `snapshot` → `none`; under `auto` the full
/// rung order is anchoredSnapshot → inline → snapshot → elided snapshot → none.
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
}

/// Why a result served `history.mode: "none"` — the owning spec typed
/// unavailability. Open on the client side: an absent (older server) or unknown
/// (newer server) value decodes conservatively as an unknown reason, and
/// `viewCursor` text never substitutes for it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HistoryNoneReason {
    /// The request's effective `excludeItems` was `true` (the
    /// `session/read` default; explicit on resume/fork).
    Excluded,
    /// A retained cursor was supplied; the streamed suffix carries the
    /// history.
    CursorSuffix,
    /// Every rung through the elided snapshot exceeded the history budget;
    /// page via `view/page` from the result's `viewCursor`.
    HistoryBudget,
    /// No trustworthy materialized projection exists; paging cannot recover it.
    ProjectionUnavailable,
    /// The projection exists but the aggregate materialized read exceeded
    /// its bounded read cap; page in bounded chunks.
    ProjectionReadLimit,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
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
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// A late-joiner pointer at an unsettled server-initiated request. The full
/// payloads arrive as re-issued server-to-client requests right after a
/// `session/resume` response; `session/read` never re-issues them.
///
/// **A second instance, RULED: the flat discriminated-object precedent is
/// accepted for this type too, on the `ApprovalSubject` precedent, with the
/// serialized JSON unchanged. A strict union node kind may be funded later; if
/// it is, it must cover both this type and `TurnInputPart`.** the protocol spec
/// ratifies two kind-discriminated entry shapes (`{kind: "approval",
/// approvalId, viewCursor}` / `{kind: "userInput", userInputId, viewCursor}`);
/// this is one flat object with both ids optional, so the published schema
/// accepts `{"kind":"approval","userInputId":…}` and an entry carrying no id at
/// all. The v1 model names no object-variant union (the `ApprovalSubject`
/// precedent, followed for `TurnInputPart`), and this instance differs from
/// that one in a way the ruling should see: `kind` here is an OPEN enum, where
/// `TurnInputPart.type` is closed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PendingRequestPointer {
    /// The discriminator; v1 values `approval` and `userInput`.
    pub kind: PendingRequestKind,
    /// Present on an `approval` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    /// Present on a `userInput` entry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input_id: Option<String>,
    /// The cursor the request opened at.
    pub view_cursor: String,
}

/// The `pendingRequests` discriminator. Open enum, v1 values `approval` and
/// `userInput`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum PendingRequestKind {
    /// An unsettled approval.
    Approval,
    /// An unsettled user-input prompt.
    UserInput,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
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
}

/// The last `turn/completed` the session-view fold applied, restated on
/// `session/resume` and `session/read` so a reopened session can report a
/// failed last turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct LastTurn {
    /// The turn's id, as on its `turn/completed`; clients deduplicate a live
    /// `turn/completed` against this member by it.
    pub turn_id: String,
    /// The turn's terminal.
    pub terminal: TurnTerminal,
    /// Copied when the `turn/completed` carried it; a synthesized host-death
    /// `failed` terminal carries only this (`crash`, `crash_inferred`, or
    /// `incomplete`). Free display text: clients never branch on it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Copied when the `turn/completed` carried it: runtime `failed` terminals
    /// do, host-death `failed` terminals do not.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<TurnError>,
}
