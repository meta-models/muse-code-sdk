// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::error::ApprovalRequirementRef;
use crate::msp::view::SourceRange;
pub use decision::ApprovalAmendment;
pub use decision::ApprovalAmendmentDurability;
pub use decision::ApprovalChange;
pub use decision::ApprovalChoice;
pub use decision::ApprovalChoiceScope;
pub use decision::ApprovalDecision;
pub use decision::ApprovalPersistenceStatus;
pub use decision::ApprovalPolicyResult;
pub use decision::ApprovalResolvedBy;
pub use decision::ApprovalStageEvidence;
use serde::Deserialize;
use serde::Serialize;

pub(crate) mod decision;

/// Full params shared by `approval/request` and `approval/requested`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalRequestParams {
    /// The owning session. For a subagent's approval shown on the parent, this
    /// is the parent session.
    pub session_id: String,
    /// The approval's stable id. Match `approval/decide`, `approval/updated`
    /// and `approval/resolved` by it, never by the JSON-RPC request id, which
    /// belongs to one connection.
    pub approval_id: String,
    /// The turn whose tool call is waiting on this approval.
    pub turn_id: String,
    /// The id of the task running the tool call.
    pub task_id: String,
    /// The `toolCall` view item waiting on this approval.
    pub item_id: String,
    /// The model provider's id for this tool call.
    pub tool_call_id: String,
    /// The name of the tool being called.
    pub tool_name: String,
    /// The tool call's arguments as a string, usually JSON. With `toolName`, it
    /// lets a client show a subject whose `kind` it does not recognize.
    pub raw_args: String,
    /// The cursor of the `approval/requested` event that opened this request.
    /// A re-send for a later stage keeps this cursor, so `view/page` at it
    /// returns the opening stage, which may be older than this payload.
    pub view_cursor: String,
    /// The stored records this event was folded from: an opaque token clients
    /// must not interpret.
    pub source_range: SourceRange,
    /// What the approval is for. Show a `kind` you do not recognize
    /// generically, and never auto-approve it.
    pub subject: ApprovalSubject,
    /// The requirement the next decision must target; send it unchanged as
    /// `requirementId` in `approval/decide`. For `shell` it names the first
    /// stage still needing a decision; for other kinds its `sourceIndex` is 0.
    pub current_requirement_id: ApprovalRequirementRef,
    /// The choices the server offers for the current requirement. Send the
    /// chosen one's `choiceId` in `approval/decide`; clients never build their
    /// own.
    pub available_choices: Vec<ApprovalChoice>,
    /// `true` when this approval guards a write to a protected file. Only
    /// allow-once and reject choices are offered, and a decision is accepted
    /// only while at least one client is subscribed to the session.
    pub protected_write: bool,
    /// `true` when the automated LLM judge saw this request first and handed it
    /// to a person without deciding. A display hint only. The host sends it
    /// as `false` when it re-issues the request after a restart or on
    /// `session/resume`; a re-send for a later stage keeps it.
    pub judge_escalated: bool,
    /// Present only for a child (native subagent) approval projected onto the
    /// parent session's plane; parent-own approvals omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_origin: Option<ApprovalSubagentOrigin>,
    /// A Computer Use card's facts: the page, the window and each step that
    /// may have an effect, in the host's words; absent on every other
    /// approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cua_card_facts: Option<crate::msp::view::approval_card_facts::ApprovalCuaCardFacts>,
}

/// `approval/updated` params: the refreshed pending view plus one change.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalUpdatedParams {
    /// The owning session.
    pub session_id: String,
    /// This event's view cursor: opaque, and strictly increasing within the
    /// session.
    pub view_cursor: String,
    /// The stored records this event was folded from: an opaque token clients
    /// must not interpret.
    pub source_range: SourceRange,
    /// The approval that changed.
    pub approval_id: String,
    /// The requirement the next decision must target after this change; send it
    /// as `requirementId` in `approval/decide`.
    pub current_requirement_id: ApprovalRequirementRef,
    /// The approval's subject, with `stages` refreshed for this change.
    pub subject: ApprovalSubject,
    /// The refreshed choices for the current requirement.
    pub available_choices: Vec<ApprovalChoice>,
    /// What changed; `change.kind` names the kind of change.
    pub change: ApprovalChange,
    /// Present only for a child (native subagent) approval projected onto the
    /// parent session's plane; parent-own approvals omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_origin: Option<ApprovalSubagentOrigin>,
}

/// `approval/resolved` params: the first durable terminal decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalResolvedParams {
    /// The owning session.
    pub session_id: String,
    /// This event's view cursor: opaque, and strictly increasing within the
    /// session.
    pub view_cursor: String,
    /// The stored records this event was folded from: an opaque token clients
    /// must not interpret.
    pub source_range: SourceRange,
    /// The approval that was decided.
    pub approval_id: String,
    /// The `toolCall` view item this approval was holding.
    pub item_id: String,
    /// The turn whose tool call this approval was holding.
    pub turn_id: String,
    /// The final decision.
    pub decision: ApprovalDecision,
    /// Whether the final decision lets the action run (`allow`) or blocks it
    /// (`deny`).
    pub policy_result: ApprovalPolicyResult,
    /// The policy rule the decision created. Present only when the decision
    /// created one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amendment: Option<ApprovalAmendment>,
    /// Who or what made the decision: `user`, `policy` or `llmJudge`.
    pub resolved_by: ApprovalResolvedBy,
    /// The `commandId` of the `approval/decide` command that won. Absent when
    /// no such command made the decision, for example a policy or LLM judge
    /// decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decided_by_command_id: Option<String>,
    /// The decision time as RFC3339, projected from the durable
    /// `DecisionApplied` record's own stamp: optional on the wire so decoders
    /// tolerate its absence, always populated by current hosts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub decided_at: Option<String>,
    /// For a `shell` approval, how each stage was resolved when the decision
    /// became final. Empty for other subject kinds, and it can be empty for
    /// `shell` too.
    pub stage_evidence: Vec<ApprovalStageEvidence>,
    /// Present only for a child (native subagent) approval projected onto the
    /// parent session's plane; parent-own approvals omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagent_origin: Option<ApprovalSubagentOrigin>,
}

/// Child (native subagent) provenance for an approval projected onto the PARENT
/// session's approval plane: identifies the originating child run/agent so a
/// client can attribute the prompt. Omitted (`skip_serializing_if`) on the
/// parent's own approvals, so pre-existing parent frames stay byte-identical.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalSubagentOrigin {
    /// The originating child's subagent id, from the parent session's
    /// durable subagent control records.
    pub subagent_id: String,
    /// The child session stream id whose records carry this approval.
    pub child_session_id: String,
    /// The child run that parked on this approval.
    pub child_run_id: String,
}

/// Open approval subject union. Unknown kinds are rendered generically and
/// never auto-approved by clients.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalSubject {
    /// Open discriminator: `shell | fileAccess | network | unixSocket | process | tool`.
    pub kind: String,
    /// The full raw shell command. Present when `kind` is `shell`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The canonical workspace root the shell command runs in, present on
    /// `shell` subjects when the host knows it. Saved command-prefix rules
    /// apply only within this root.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// The shell command split into stages that are approved separately (the
    /// commands of a pipeline or command list), in order. Present on `shell`
    /// subjects; it may be empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stages: Option<Vec<ApprovalStage>>,
    /// The tool asking for the action. Present for every kind except `shell`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_name: Option<String>,
    /// For `fileAccess`, the path the tool asked to access, normalized by the
    /// host (workspace-relative inside the workspace); for
    /// `unixSocket`, the exact resolved socket path, sent unescaped, so escape
    /// it before display.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The access asked for: `read` or `write` for `fileAccess`, `control` for
    /// `process`. Absent for other kinds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub access: Option<String>,
    /// The network host the tool wants to reach. Present when `kind` is
    /// `network`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The network port, present only on `network` subjects that name one. A
    /// session grant made from a subject without a port covers every port.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// The network protocol, for example `https`. Present only on `network`
    /// subjects that name one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// Display text naming the process the tool wants to control. Present when
    /// `kind` is `process`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    /// What triggered the action (a shell command or a URL), for display only
    /// and untrusted. It is not sent on `shell` subjects, and policy rules
    /// never match on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub origin: Option<ApprovalOrigin>,
}

/// The `ApprovalSubject.kind` wire words — one source for the session-view fold
/// that writes them and every client that inverts them.
impl ApprovalSubject {
    /// `shell`: run a shell command. See `command`, `workspaceRoot` and
    /// `stages`.
    pub const KIND_SHELL: &'static str = "shell";
    /// `fileAccess`: a tool wants to read or write a path. This grants access
    /// to the path; it is not a review of file contents. See `path` and
    /// `access`.
    pub const KIND_FILE_ACCESS: &'static str = "fileAccess";
    /// `network`: a tool wants network access. See `host`, `port` and
    /// `protocol`.
    pub const KIND_NETWORK: &'static str = "network";
    /// `unixSocket`: a command wants to connect to the local Unix socket at
    /// `path`. Only one-time choices are offered, and no rule is ever saved.
    pub const KIND_UNIX_SOCKET: &'static str = "unixSocket";
    /// `process`: a tool wants to control another process. See `target` and
    /// `access`.
    pub const KIND_PROCESS: &'static str = "process";
    /// `tool`: any other tool action, such as an MCP tool call. Show it using
    /// `toolName` and the request's `rawArgs`.
    pub const KIND_TOOL: &'static str = "tool";
    /// `read`: read access to a `fileAccess` path.
    pub const ACCESS_READ: &'static str = "read";
    /// `write`: write access to a `fileAccess` path. It does not include read
    /// access.
    pub const ACCESS_WRITE: &'static str = "write";
    /// `control`: control of a `process` target.
    pub const ACCESS_CONTROL: &'static str = "control";
}

/// What triggered a tool action, shown so the user can judge it. It is
/// display-only and untrusted, and policy rules never match on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalOrigin {
    /// Which kind of origin this is: `shellCommand` or `url`.
    pub kind: String,
    /// The shell command whose process asked for the action. Present when
    /// `kind` is `shellCommand`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// The full URL a fetch tool is requesting. Present when `kind` is `url`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// One stage of a `shell` approval: a single command from the pipeline or
/// command list, approved separately from the others.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalStage {
    /// This stage's requirement id. When it equals the approval's
    /// `currentRequirementId`, send it as `requirementId` in `approval/decide`.
    pub requirement_id: ApprovalRequirementRef,
    /// This stage's 1-based position in the command; it equals
    /// `requirementId.sourceIndex + 1`.
    pub position: usize,
    /// The total number of stages in the command.
    pub total_stages: usize,
    /// The stage's command words as parsed. When `argvComplete` is `false`,
    /// this can be a single unparsed piece of the command.
    pub argv: Vec<String>,
    /// `true` when `argv` is the stage's complete command, known before it
    /// runs; `false` when part of it cannot be resolved ahead of time (for
    /// example a command substitution). A stage with `false` never has a
    /// `suggestedPrefix`.
    pub argv_complete: bool,
    /// Whether this stage still needs a decision or, if not, how it was
    /// satisfied.
    pub resolution: ApprovalStageResolution,
    /// A command prefix the host suggests always allowing in this workspace,
    /// present only when one can be taken from a fully parsed stage.
    /// `availableChoices` shows whether that grant is offered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_prefix: Option<ApprovalSuggestedPrefix>,
}

/// The `ApprovalOrigin.kind` wire words (same single-source rule).
impl ApprovalOrigin {
    /// `shellCommand`: the action came from a shell command's process. See
    /// `command`.
    pub const KIND_SHELL_COMMAND: &'static str = "shellCommand";
    /// `url`: the action fetches a URL. See `url`.
    pub const KIND_URL: &'static str = "url";
}

/// Whether a shell stage still needs a decision, or how it was satisfied.
/// Satisfied stages are included so a client can show progress.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalStageResolution {
    /// One of `unresolved`, `knownSafe`, `policyAllow`, `allowOnce` or
    /// `policyAmendment`. The set is open, so newer hosts may add values.
    pub kind: String,
    /// Free-form text naming the rule or mode that allowed the stage, for
    /// display or troubleshooting. Present only when `kind` is `policyAllow`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
    /// The command prefix saved as an always-allow rule when this stage was
    /// approved. Present only when `kind` is `policyAmendment`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argv_prefix: Option<Vec<String>>,
}

/// The `ApprovalStageResolution.kind` wire words (same single-source rule).
impl ApprovalStageResolution {
    /// `unresolved`: the stage still needs a decision.
    pub const KIND_UNRESOLVED: &'static str = "unresolved";
    /// `knownSafe`: the stage's command is recognized as safe to run without
    /// asking.
    pub const KIND_KNOWN_SAFE: &'static str = "knownSafe";
    /// `policyAllow`: an existing rule or the session's approval mode already
    /// allows the stage. See `diagnostic`.
    pub const KIND_POLICY_ALLOW: &'static str = "policyAllow";
    /// `allowOnce`: a decision allowed this stage for this request only,
    /// without saving a rule.
    pub const KIND_ALLOW_ONCE: &'static str = "allowOnce";
    /// `policyAmendment`: a decision allowed this stage and saved a
    /// command-prefix rule. See `argvPrefix`.
    pub const KIND_POLICY_AMENDMENT: &'static str = "policyAmendment";
}

/// A suggested always-allow rule for a shell stage: commands starting with
/// `argvPrefix` would run in this workspace without asking.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalSuggestedPrefix {
    /// The leading command words the rule would allow, for example `["cargo",
    /// "test"]`.
    pub argv_prefix: Vec<String>,
    /// A human-readable label for the suggestion, ready to show as is.
    pub label: String,
}
