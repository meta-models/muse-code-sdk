// @generated from the MSP stable schema and protocol sources; do not edit by hand.

mod catch_all;

/// The eleven v1 item kinds plus post-v1 kinds. Open: a new kind is additive
/// evolution, and clients MUST render unknown kinds generically.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ItemKind {
    /// A submitted user prompt. Single-shot.
    UserMessage,
    /// A committed assistant message. Delta-streamed.
    AgentMessage,
    /// Reasoning summary/text. Delta-streamed.
    Reasoning,
    /// A committed tool call joined to its task lifecycle.
    ToolCall,
    /// The user shell escape hatch, item-ified; `turnId` is `null`.
    UserShell,
    /// A subagent child lifecycle.
    Subagent,
    /// A workflow run.
    Workflow,
    /// A reminder agent's child session: opened `inProgress` at the link
    /// record, settled with the child task's real terminal outcome.
    ReminderChild,
    /// A context compaction.
    Compaction,
    /// A hook run folding its started/terminal records.
    HookRun,
    /// A side-chat link on its main session's view: opened `inProgress` at the
    /// side creation, settled once (Accepted completes, Rejected rejects,
    /// Abandoned cancels) — a signpost, not a live fold.
    SideChat,
    /// A skill-read notice: single-shot only, status `completed` — a notice has
    /// no progress. Experimental: stripped per-connection for unopted callers.
    SkillRead,
    /// A provider-hosted web search call: a plain additive value of this open
    /// enum — never strip-armed, since `kind` is required (the `AuthRequired`
    /// precedent). Only the seven `webSearch` members are experimental-gated.
    WebSearch,
    /// One monitor feed line as one transcript cell: a plain additive value of
    /// this open enum, stable from day one. Single-shot only, status
    /// `completed`, `turnId` null — arrival is the transcript fact.
    MonitorFeed,
    /// One damaged range of the session log, at its position. Single-shot only,
    /// status `completed`, `turnId` null. No log record carries it: the fold
    /// that reads the damaged bytes derives it. A build that predates the kind
    /// decodes it only if its `ItemKind` has a catch-all; the protocol crate's
    /// does not yet.
    DamagedRange,
    /// A scheduled-task fire notice: a plain additive value of this open enum,
    /// stable from day one — never strip-armed, since `kind` is required (the
    /// `AuthRequired` precedent). Single-shot only, status `completed`,
    /// `revision` 1 — a notice has no progress.
    ScheduledFire,
    /// A background-terminal completion marker: a plain additive the protocol
    /// spec open-enum value, stable from day one — never strip-armed, since
    /// `kind` is required (the `AuthRequired` precedent). Single-shot only,
    /// status `completed`, `revision` 1 — a notice has no progress.
    BackgroundTerminalCompletion,
    /// One background-overdue drain as one transcript line: a plain additive
    /// value of this open enum, stable from day one. Single-shot only, status
    /// `completed` — a notice has no progress. `text` is the gate-off literal
    /// verbatim; `turnId` is the draining turn.
    OverdueNotice,
    /// The history before a session's boundary checkpoint, collapsed to the
    /// checkpoint's transcript tail: the served view's origin. Single-shot
    /// only, status `completed`, `turnId` null, never pushed live. No log
    /// record carries it. A build that predates the kind decodes it only if its
    /// `ItemKind` has a catch-all; the protocol crate's does not yet.
    EarlierHistory,
    /// A consumed peer message marker: a plain additive the protocol spec
    /// open-enum value, stable from day one — never strip-armed, since `kind`
    /// is required (the `AuthRequired` precedent). Single-shot only, status
    /// `completed`, `revision` 1 — a notice has no progress.
    PeerMessage,
    /// One parent-to-subagent input record on the parent session's view: a
    /// plain additive value of this open enum, single-shot only, status
    /// `completed`. `inputPhase` names the record (the queue or the
    /// delivery-visible drain); `subagentId`, `commandId` (the send's command),
    /// `text` (the queued summary) and `turnId` (the parent run) are its
    /// members.
    SubagentInput,
    /// One consumed subagent result on the parent session's view: a plain
    /// additive value of this open enum, single-shot only, status `completed`,
    /// one per drain of the result's inbox item (delivery-visible or
    /// claim-only). `subagentId`, `resultStatus` (the consumed attempt's
    /// outcome), `text` (the result summary) and `turnId` (the consuming run)
    /// are its members.
    SubagentResult,
    /// A system notice: a plain additive value of this open enum, stable from
    /// day one. Single-shot only, status `completed`, `revision` 1 — a notice
    /// has no progress. `turnId` is the enclosing turn or `null`. Served
    /// origin: `hook`. A client renders `text`, or `fallbackText` when it does
    /// not know the origin, and never synthesizes one.
    SystemNotice,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// Item status. Open; terminal = anything other than `"inProgress"`, and
/// unknown values are terminal-unknown, rendered generically.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ItemStatus {
    /// The item is open; a terminal is guaranteed.
    InProgress,
    /// Terminal: finished normally.
    Completed,
    /// Terminal: the item's own execution failed.
    Failed,
    /// Terminal: cancelled (interrupt, cancel, or host-shutdown drain).
    Cancelled,
    /// Terminal: denied by approval, or a rejected subagent spawn.
    Rejected,
    /// Terminal: the task timed out (`TaskTerminalKind` vocabulary).
    TimedOut,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `hookRun` durable outcome. Open: new outcomes are additive, and clients MUST
/// render unknown values generically.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HookRunStatus {
    /// The run finished normally.
    Completed,
    /// The run was blocked; the payload keeps `blocked`. The item settles
    /// `rejected`, except an unapplied `UserPromptSubmit` block, which settles
    /// `completed`.
    Blocked,
    /// The run failed.
    Failed,
    /// The run timed out.
    TimedOut,
    /// The run was cancelled.
    Cancelled,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}
