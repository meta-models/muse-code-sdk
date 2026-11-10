// @generated from the MSP stable schema and protocol sources; do not edit by hand.

pub use input_part::TurnInputPart;
use serde::Deserialize;
use serde::Serialize;

pub(crate) mod input_part;

/// The ack `status`: `accepted` for every admitted command. `session/compact`
/// is the one method that may additionally answer `noop`
/// ([`crate::msp::method::runtime::CompactStatus`]); no other command uses
/// another status.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CommandStatus {
    /// The command was admitted.
    Accepted,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// The reasoning-effort tier sampled at submission. The **same closed tier
/// vocabulary** on both the fresh-turn and steer lanes, spelled identically;
/// invalid tiers are invalid params. `none` is a tier of the vocabulary (ask
/// for no reasoning), not a way to say "unset".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReasoningEffort {
    /// Ask for no reasoning.
    None,
    /// Minimal reasoning.
    Minimal,
    /// Low reasoning.
    Low,
    /// Medium reasoning.
    Medium,
    /// High reasoning.
    High,
    /// Extra-high reasoning.
    Xhigh,
    /// Max reasoning.
    Max,
    /// Ultra reasoning.
    Ultra,
}

/// Disposition when a turn is already running. The wire default is `queue`: an
/// SDK caller who has not looked at session state should not silently mutate an
/// in-flight turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IfBusy {
    /// Deliver the input as the next turn after the current one finishes.
    Queue,
    /// Inject the input into the running turn.
    Steer,
    /// Interrupt the running turn and start a fresh turn with this input.
    Replace,
}

/// The queued `!` shell action a `turn/start` carries: the `!cmd` typed while a
/// turn runs. The shell's command id derives from the carrying turn's
/// `commandId`, exactly as the app's own queued submit does; the params'
/// sibling `displayText` carries the `!…` presentation form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUserShell {
    /// The shell command text, without the leading `!`.
    pub command_text: String,
}

/// `turn/start` params.
///
/// `turn/start.providerRequestOptions` is deliberately absent: **RULED to stay
/// off the published schema.** The schema is the contract, and a
/// free-form-object node kind is revisited only if the experimental field
/// graduates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnStartParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7). The fresh turn's `turnId` derives from
    /// it.
    pub command_id: String,
    /// Ordered content parts; required and non-empty.
    pub input: Vec<TurnInputPart>,
    /// Disposition when a turn is already running; default `queue`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_busy: Option<IfBusy>,
    /// Presentation form of the prompt for transcripts. Durable; carried on the
    /// resulting user-message view item. Never model-visible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_text: Option<String>,
    /// Reasoning tier sampled at submission for this turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    /// This turn's token budget in tokens: an integer floor of 1, riding to
    /// workflow-launch admission and inert when no workflow launches. Omitted
    /// means no budget; 0 or a non-integer is invalid params, as is explicit
    /// `null`. No wire upper bound beyond the integer type. Experimental: only
    /// the name and shape are settled, not v1 membership, so the member ships
    /// off the stable bundle until it graduates.
    #[serde(
        default,
        deserialize_with = "crate::msp::method::lifecycle::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub token_budget: Option<u64>,
    /// A sticky REPLACEMENT of the session's runtime workspace-root set,
    /// binding at this turn's launch and persisting for subsequent turns until
    /// replaced again — unlike `reasoningEffort`, which is this-turn-only. Same
    /// shape and validation as `session/start.workspaceRoots`; invalid params
    /// on an explicit `ifBusy: "steer"` submit and so is explicit `null`;
    /// omitted means "unchanged", never "reset".
    #[serde(
        default,
        deserialize_with = "crate::msp::method::lifecycle::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_roots: Option<Vec<String>>,
    /// A queued `!` shell action riding this turn: the `!cmd` typed while a
    /// turn runs, executed at the next model-call boundary before any later
    /// steer. Exclusive with `text` and `skill` input; `input` may be empty
    /// only when this member is present. Capability-gated on `userShell`: a
    /// carrying turn on a connection without the grant fails `-32010
    /// capabilityRequired`. Explicit `null` is invalid params (the
    /// null-tolerant set is closed). A v1 stable member.
    #[serde(
        default,
        deserialize_with = "crate::msp::method::lifecycle::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub user_shell: Option<TurnUserShell>,
}

/// What `turn/start` did with the input. Resolves OQ-H in v1: since `queue` is
/// the default `ifBusy`, clients need to distinguish these without folding
/// history.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum TurnStartDisposition {
    /// A fresh foreground turn began.
    Started,
    /// Input parked; its turn — the ack's `turnId` — launches at the current
    /// turn's terminal boundary.
    Queued,
    /// Absorbed by the running turn.
    Steered,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// `turn/start` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnStartResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The turn that will carry (or absorbed) this input. Authoritative: always
    /// take it from the ack rather than deriving it.
    pub turn_id: String,
    /// `true` iff `disposition` is `started`; retained as the boolean shorthand
    /// — `disposition` is authoritative.
    pub started_new_turn: bool,
    /// What happened to the input.
    pub disposition: TurnStartDisposition,
    /// `queued` and `steered`: the queued input record's `recorded_at` in Unix
    /// microseconds — the host clock the client's optimistic row must sort by,
    /// so the row lands where the host's queue holds it. Present on a fresh
    /// queued or steered admission via the enqueue arm (both append an inbox
    /// record); absent on `started`, on hosts that predate the member, on
    /// post-restart recovery replays, on the replace and park arms' Queued
    /// acks, and on unopted connections. A client that sees no member falls
    /// back to its wall clock (today's behavior).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub queued_at_us: Option<u64>,
}

/// `turn/steer` params: exact-target steering into the currently running turn.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSteerParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The turn you believe is running. Closes the race where the turn
    /// completes or is replaced between your read and your steer: input meant
    /// for turn A can never leak into turn B. Any syntactically valid UUID: a
    /// turn from an older session may carry a v4 or v5 id. A malformed id is
    /// `invalidParams`; an id that is not the running turn is refused.
    pub expected_turn_id: String,
    /// Same content parts as `turn/start`.
    pub input: Vec<TurnInputPart>,
    /// Reasoning tier for the model calls this steer's input reaches. Applies
    /// forward, never backward; absent means unspecified, not "reset".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<ReasoningEffort>,
    /// This steer's token budget in tokens. Same vocabulary as the `turn/start`
    /// member: an integer floor of 1, omitted means unspecified (never a reset
    /// of the running turn's budget), 0 or a non-integer is invalid params, as
    /// is explicit `null`. Experimental like its twin: v1 membership stays
    /// open, so the member ships off the stable bundle until a v1 ruling
    /// graduates it.
    #[serde(
        default,
        deserialize_with = "crate::msp::method::lifecycle::deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub token_budget: Option<u64>,
}

/// `turn/steer` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnSteerResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The running turn that absorbed the input.
    pub turn_id: String,
}

/// `turn/interrupt` params: the "user pressed stop" gesture, on the runtime's
/// priority lane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInterruptParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The exact turn to interrupt. Omit to target the session's current
    /// foreground turn, resolved at admission; prefer passing the explicit id
    /// when you have one. Any syntactically valid UUID: a turn from an older
    /// session may carry a v4 or v5 id. A malformed id is `invalidParams`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    /// Pair a retract intent with the interrupt: if the turn is cancelled
    /// before any assistant output committed, the submission is durably
    /// retracted (view event `turn/retracted`) so the client may restore the
    /// prompt text. A rejected retract does not undo the interrupt. Default
    /// `false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retract: Option<bool>,
}

/// `turn/interrupt` result. Acceptance means the interrupt was admitted,
/// **not** that the turn is already stopped: the turn is over when you fold its
/// `turn/completed` with terminal `cancelled`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnInterruptResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The interrupted turn.
    pub turn_id: String,
}

/// `turn/cancel` params: plain cancellation on the normal command lane. Same
/// shape as `turn/interrupt`, **without** `retract` — pairing a retract with a
/// plain cancel is durably rejected `not_paired_interrupt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCancelParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The exact turn to cancel; omit to target the current foreground turn.
    /// Any syntactically valid UUID: a turn from an older session may carry a
    /// v4 or v5 id. A malformed id is `invalidParams`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
}

/// `turn/cancel` result: identical envelope to `turn/interrupt`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnCancelResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The cancelled turn.
    pub turn_id: String,
}

/// `turn/unqueue` params: reclaim a queued submit before it launches. It is
/// **not** a stop — a reclaim that arrives after its target launched is durably
/// rejected, never silently upgraded into a cancel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUnqueueParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// The queued turn to reclaim, exactly as the queueing `turn/start`'s ack
    /// minted it and as snapshot `queuedTurns` lists it. Required, and never
    /// "whichever is newest". Any syntactically valid UUID: a turn from an
    /// older session may carry a v4 or v5 id. A malformed id is
    /// `invalidParams`.
    pub turn_id: String,
}

/// `turn/unqueue` result. Admission only — but for this command admission *is*
/// the race: an admitted reclaim implies the turn will not launch. The
/// authoritative removal is the `turn/unqueued` view event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TurnUnqueueResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// The reclaimed turn.
    pub turn_id: String,
}
