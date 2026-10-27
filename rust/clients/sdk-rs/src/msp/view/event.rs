// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::SourceRange;
use crate::msp::view::item::Item;
use crate::msp::view::state::TokenUsage;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `turn/started` params: a foreground turn began running — fresh submits
/// immediately, queued submits at their launch boundary, never steered submits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnStartedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The started turn.
    pub turn_id: String,
    /// The submitting command; `turnId == commandId` for fresh turns.
    pub command_id: String,
}

/// `turn/completed` params: the run's durable terminal record landed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnCompletedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The terminated turn.
    pub turn_id: String,
    /// The turn terminal (open enum).
    pub terminal: TurnTerminal,
    /// The runtime's free-text terminal reason, verbatim. Display and
    /// diagnostics only; never branch on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Turn duration; absent means unmeasured, never fabricated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Time to first token, when measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_to_first_token_ms: Option<u64>,
    /// The turn's aggregate token usage, summed across the turn's model
    /// completions (same shape as `session/tokenUsage.usage`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<TokenUsage>,
    /// Present when `terminal` is `"failed"`, except on a synthesized
    /// host-death terminal, which carries `reason` instead: mid-turn failures
    /// reach the client here — never as a JSON-RPC error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<TurnError>,
}

/// `turn/retracted` params: an interrupt-paired retract durably settled,
/// accepted or declined. On `"accepted"` the retracted user-message item is
/// re-emitted via `item/updated` with `retracted: true`; on `"declined"` the
/// client folds the legacy declined rollback instead and no item is re-emitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnRetractedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The turn whose submission was retracted.
    pub turn_id: String,
    /// The retracted submission's command id.
    pub command_id: String,
    /// The retract settlement outcome. Additive-optional: absent reads as
    /// `"accepted"` — pre-feature hosts emit the event only for accepted
    /// retracts — and so does an unrecognized value.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub outcome: Option<RetractOutcome>,
}

/// A `turn/retracted` settlement outcome. Open enum: decode is tolerant — a
/// value outside the list reads as `Accepted` (the event's historical meaning —
/// pre-feature hosts emit it only for accepted retracts), never fails. The
/// bundle keeps enumerating the known values for codegen and docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum RetractOutcome {
    /// The retract was durably accepted; the submission was retracted.
    Accepted,
    /// The retract settled rejected (the submission stood); the client
    /// folds the legacy declined rollback.
    Declined,
}

impl<'de> Deserialize<'de> for RetractOutcome {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::de::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "declined" => Self::Declined,
            _ => Self::Accepted,
        })
    }
}

/// `turn/retryScheduled` params: a durable turn retry-scheduled fact folded —
/// the failing model attempt's scheduled retry is observable BEFORE the turn
/// terminates, so a streaming client can render "attempt N/M · retrying in Ss ·
/// reason" instead of dead air. Non-terminal: it never resolves a turn-wait.
/// The delay is the recorded scheduled backoff, never an absolute fire time —
/// clients derive any countdown locally. `sourceRange` cites the session
/// stream's mirror of the task-lifecycle record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnRetryScheduledParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable record this event folded from (the session stream's
    /// mirror of the retry-scheduled task status; `first == last`).
    pub source_range: SourceRange,
    /// The running turn whose model attempt is being retried.
    pub turn_id: String,
    /// The attempt that failed (producer-normalized, >= 1).
    pub attempt: u32,
    /// The attempt about to run (producer contract: attempt < nextAttempt
    /// <= maxAttempts; not a schema constraint).
    pub next_attempt: u32,
    /// The turn's model-retry chain bound.
    pub max_attempts: u32,
    /// The scheduled backoff delay in milliseconds, verbatim from the
    /// durable fact.
    pub retry_delay_ms: u64,
    /// The recorded stopping reason through the shared task-detail
    /// normalization (non-empty; capped at 160 characters).
    pub reason: String,
    /// The failing model attempt's provider system, verbatim — e.g. `"meta"`.
    /// Absent when no model-attempt facet precedes the retry status on the task
    /// (old logs).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// The failing model attempt's durable kind, verbatim — a plain string: the
    /// durable vocabulary is open-ended.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    /// The failing model attempt's HTTP status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

/// `turn/modelRetryScheduled` params: a durable model-stream retry-scheduled
/// fact folded — the provider backoff behind one model attempt is observable
/// BEFORE the turn terminates, so a streaming client can render "system words ·
/// retrying in Ss · attempt N/M" instead of dead air. Non-terminal: it never
/// resolves a turn-wait. The sibling `turn/retryScheduled` shape at the model
/// layer: same member names and semantics (attempt/nextAttempt/maxAttempts/
/// retryDelayMs/system/errorKind/httpStatus), minus `reason` — the row's words
/// derive from `errorKind` through the shared gate-off mapping, and the
/// recorded machine message is not user text. The delay is the recorded
/// scheduled backoff, never an absolute fire time — clients derive any
/// countdown locally. `sourceRange` cites the session stream's mirror of the
/// task-lifecycle record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnModelRetryScheduledParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable record this event folded from (the session stream's
    /// mirror of the scheduled model task status; `first == last`).
    pub source_range: SourceRange,
    /// The running turn whose model attempt is being retried.
    pub turn_id: String,
    /// The failed model attempt (producer-normalized, >= 1).
    pub attempt: u32,
    /// The scheduled model attempt (producer contract: attempt <
    /// nextAttempt <= maxAttempts; not a schema constraint).
    pub next_attempt: u32,
    /// The model-retry chain bound.
    pub max_attempts: u32,
    /// The scheduled backoff delay in milliseconds, verbatim from the
    /// durable fact.
    pub retry_delay_ms: u64,
    /// The failing model attempt's provider system, verbatim — e.g. `"meta"`.
    /// Always present from this producer (the durable `system` is a required
    /// `String`); optional on the wire so a future omission folds absent
    /// instead of failing the frame.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system: Option<String>,
    /// The failing model attempt's durable kind, verbatim — a plain string: the
    /// durable vocabulary is open-ended.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    /// The failing model attempt's HTTP status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

/// `turn/unqueued` params: a queued submit's reclaim durably won; its
/// pre-minted turn never runs. Carries the reclaimed `turnId` and the
/// `commandId` of the `turn/start` that queued it, so a client can restore the
/// submission's text exactly as for `turn/retracted`. No
/// `turn/started`/`turn/completed` is ever emitted for this `turnId`.
/// `sourceRange` cites the SESSION stream's reclaim record — a reclaimed turn
/// never had a run stream.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnUnqueuedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from (the session stream's
    /// reclaim record).
    pub source_range: SourceRange,
    /// The reclaimed turn: pre-minted at admission, never launched.
    pub turn_id: String,
    /// The `commandId` of the `turn/start` that queued the reclaimed turn.
    pub command_id: String,
}

/// `turn/foregroundCompleted` params: the turn's foreground work is done and
/// named background reminder checks hold the turn open. Explicitly
/// non-terminal: the turn ends only at `turn/completed` / `turn/unqueued`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnForegroundCompletedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from, anchored at the first
    /// blocking link of the firing window.
    pub source_range: SourceRange,
    /// The turn whose foreground completed.
    pub turn_id: String,
    /// `reminderAgentId`s of the firing's blocking set, never empty; agent
    /// ids, never display names. Live-best-effort: reads, resume, and
    /// replay may narrow it to the linked subset.
    pub blocking_agents: Vec<String>,
}

/// Turn terminal vocabulary: exactly the runtime's `RunTerminalKind` — closed
/// in the runtime, wire-open for evolution.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TurnTerminal {
    /// The run finished normally.
    Completed,
    /// The run ended in a run-fatal error; `error` is present.
    Failed,
    /// The terminal for the interrupt, cancel, and host-shutdown lanes.
    Cancelled,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// The settled turn-failure object: `{kind, message, retryable}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnError {
    /// The failure class (open camelCase enum grounded in the runtime's
    /// terminal failure classification).
    pub kind: TurnErrorKind,
    /// Human-readable failure text.
    pub message: String,
    /// The server's judgment that resubmitting the same input may succeed.
    pub retryable: bool,
    /// Typed quota-exhaustion detail: present iff the stopping failure was the
    /// quota class. Clients branch on presence, never by parsing `message`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota: Option<QuotaDetail>,
    /// `true` when the provider refused this request. Present only on the live
    /// `turn/completed`: replayed, snapshot-served and `workflow/resume`
    /// terminals omit it, so absence does not mean the request was not denied.
    /// Never `false`.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub request_denied: bool,
}

/// Typed quota-exhaustion detail: the limit kind plus the provider's reset
/// instant.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct QuotaDetail {
    /// Which quota was exhausted (open enum; unknown values fall back).
    pub limit_kind: LimitKind,
    /// Epoch milliseconds at which the provider says usage resets.
    pub resets_at_ms: i64,
}

/// Quota limit kinds: open for evolution.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum LimitKind {
    /// Provider tier quota exhausted (durable `tier_limit`).
    TierLimit,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// Turn failure classes. Open.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TurnErrorKind {
    /// The run hit its step limit.
    StepLimit,
    /// Configuration failure.
    ConfigError,
    /// Projection failure.
    ProjectionError,
    /// Event-log failure.
    LogError,
    /// Workflow launch failure.
    WorkflowLaunchError,
    /// Environment failure.
    EnvironmentError,
    /// Model/provider failure.
    ModelError,
    /// A deferred (queued/replace) launch failed at the terminal boundary;
    /// retryable.
    LaunchError,
    /// The host has no usable credential, or the provider rejected the
    /// credential as expired/unauthorized. A plain stable additive open-enum
    /// value — never experimental-annotated: strip-arming would remove the
    /// required member.
    AuthRequired,
    /// The session's MCP first-run link could not be confirmed, so the run
    /// stopped before contacting the model. A plain stable additive open-enum
    /// value, like `AuthRequired`.
    McpLinkError,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// `item/started` params: a new item opened on the transcript. `sourceRange` is
/// absent when the item opens on an ephemeral record (the delta-streamed
/// kinds); the item's authoritative open is re-stated by its durable-sourced
/// `item/completed`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ItemStartedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from; absent on an
    /// ephemeral-sourced open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_range: Option<SourceRange>,
    /// The full item at revision 1.
    pub item: Item,
}

/// `item/updated` params: an open item changed non-terminally in a way deltas
/// cannot express — the full item re-emitted at a higher revision (apply rule:
/// replace iff higher).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ItemUpdatedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The full item at a higher revision.
    pub item: Item,
}

/// `item/completed` params: the item reached its terminal state — the
/// authoritative final object. Always cites a durable `sourceRange`. Clients
/// MUST accept `item/completed` for an `itemId` they never saw `item/started`
/// for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ItemCompletedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The full item at its terminal revision.
    pub item: Item,
}

/// `item/delta` params: a UTF-8-safe streaming append to an open item's field.
/// Ephemeral-sourced by definition: this params object has **no** `sourceRange`
/// member at all. Deltas never bump `revision`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ItemDeltaParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The open item being appended to.
    pub item_id: String,
    /// Dotted field path the append targets (`"summary.0"`, `"output"`,...);
    /// absent means `"text"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    /// The appended text; concatenation of a field path's deltas in cursor
    /// order equals that field's value on `item/completed` unless the surface
    /// saturated.
    pub delta: String,
}
