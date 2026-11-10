// @generated from the MSP stable schema and protocol sources; do not edit by hand.

//! Stable Muse Session Protocol (MSP) wire types.
//!
//! Serde names equal the stable schema names; use these types and never
//! rename an MSP field or variant by hand.

// Copied doc comments can name schema-only helpers or private items the
// copy omits; those links render as plain text.
#![allow(rustdoc::broken_intra_doc_links, rustdoc::private_intra_doc_links)]

/// Fingerprint of the stable schema these types were generated from, derived
/// from its bytes at build time; the byte-equality gate keeps the committed
/// copy honest.
pub const GENERATED_FINGERPRINT: &str =
    include_str!(concat!(env!("OUT_DIR"), "/msp-stable-fingerprint.txt"));

pub(crate) mod capability;
pub(crate) mod command;
pub(crate) mod envelope;
pub(crate) mod error;
pub(crate) mod handshake;
pub(crate) mod method;
pub(crate) mod request;
pub(crate) mod view;

pub use self::capability::CapabilityName;

pub use self::command::{
    CommandAcceptedResult, CommandAckStatus, SubagentInputParams, SubagentOwnerReasonParams,
    SubagentTargetParams,
};

pub use self::envelope::{
    ErrorResponse, JsonRpcVersion, Notification, Request, RequestId, SuccessResponse, TraceContext,
};

pub use self::error::{
    AdmissionResolutionSummary, ApprovalRequirementRef, ApprovalResolutionSummary, ErrorData,
    ErrorObject, UserInputSettlementSummary,
};

pub use self::error::kind::ErrorKind;

pub use self::handshake::{
    ClientCapabilities, ClientInfo, InitializeParams, InitializeResult, LaunchContext,
    PlatformFamily, PlatformOs, SandboxAvailability, SandboxUnavailableReason, SchemaInfo,
    ServerInfo, SessionDurability,
};

pub use self::method::approval::{
    ApprovalDecideParams, ApprovalDecideResult, ApprovalListPendingParams,
    ApprovalListPendingResult, ApprovalModeApplyOutcome, ClientApprovalRule,
    ClientApprovalRuleState, PolicyRuleOrigin, SessionSetApprovalModeParams,
    SessionSetApprovalModeResult,
};

pub use self::method::computer_use::{
    ComputerUseBlockedApp, ComputerUseChoice, ComputerUseSettings, ComputerUseSettingsReadParams,
    ComputerUseSettingsUpdateParams,
};

pub use self::method::computer_use::apps::{
    ComputerUseApp, ComputerUseAppChoice, ComputerUseAppLock, ComputerUseAppPatch,
    ComputerUseInstalledApp,
};

pub use self::method::computer_use_setup::{
    ComputerUsePermission, ComputerUseSetupChanged, ComputerUseSetupPhase,
    ComputerUseSetupReadParams, ComputerUseSetupStartParams, ComputerUseSetupState,
};

pub use self::method::feedback::{
    FeedbackClassification, FeedbackSubmitOutcome, FeedbackSubmitParams, FeedbackSubmitResult,
};

pub use self::method::goal::{
    GoalClearParams, GoalCommandResult, GoalEditParams, GoalPauseParams, GoalResumeParams,
    GoalSetParams,
};

pub use self::method::hook::{
    HookCatalogEntry, HookEventName, HookHandlerKind, HookListParams, HookListResult,
};

pub use self::method::lifecycle::{
    ForkCutPoint, SessionForkParams, SessionForkResult, SessionSideChatParams,
    SessionSideChatResult,
};

pub use self::method::lifecycle::recovery::{
    RecoveryEffectiveSource, RecoveryMode, RecoveryObservation, RecoveryObservedMode,
    RecoveryQualification,
};

pub use self::method::lifecycle::runtime_worktree::{
    RuntimeWorktree, RuntimeWorktreeCleanupPolicy, RuntimeWorktreeCleanupReason,
    RuntimeWorktreeCleanupState, RuntimeWorktreeOwnership,
};

pub use self::method::lifecycle::session_config_mt::{
    SessionEndpointTransportAuthMode, SessionModelEndpointTransportOverride,
    SessionSettingsOverrideValue, SessionSettingsOverrides,
};

pub use self::method::lifecycle::session_leave::{
    SessionLeaveCompletedParams, SessionLeaveFailureReason, SessionLeaveOutcome,
    SessionLeaveParams, SessionLeaveResult,
};

pub use self::method::lifecycle::session_list::{
    SessionListBranchFilter, SessionListFilter, SessionListParams, SessionListResult,
    SessionListSessionIdFilter, SessionListTextField, SessionListTextFilter,
};

pub use self::method::lifecycle::session_mcp::{
    SessionConfig, SessionMcpServerConfig, SessionMcpServerMode, SessionMcpStdioFraming,
};

pub use self::method::lifecycle::session_read::{
    DeliveredInput, PrunedSubagent, QueuedInput, SessionReadParams, SessionReadResult,
};

pub use self::method::lifecycle::session_resume::{
    CheckpointBoundary, ContinuePausedSource, HistoryMode, HistoryNoneReason, HistoryPreference,
    SessionHistory, SessionResumeParams, SessionResumeResult,
};

pub use self::method::lifecycle::session_resume::attachments::RestartReceipt;

pub use self::method::lifecycle::session_resume_input_assets::{
    ClientRef, MissingInputAssets, UnavailableInputAsset, UnavailableInputAssetReason,
};

pub use self::method::lifecycle::session_resume_members::{
    AbnormalEnd, AutoRecovery, AutoRecoveryOutcome, AutoRecoveryReason, BlockedPrompt,
    CronQuarantine, LastTurn, MissingPredecessor, ModelIdRefusal, PendingRequestKind,
    PendingRequestPointer,
};

pub use self::method::lifecycle::session_start::{SessionStartParams, SessionStartResult};

pub use self::method::lifecycle::session_start_switch_policy::SwitchPolicy;

pub use self::method::limits::{
    LimitsAboveMaxAxis, LimitsAxisValue, LimitsNetworkMode, SessionLimits, SessionLimitsChoice,
};

pub use self::method::media::{MediaUploadParams, MediaUploadResult};

pub use self::method::model_complete::{
    ModelCancelParams, ModelCancelResult, ModelCompleteMessage, ModelCompleteParams,
    ModelCompleteResult, ModelCompleteRole,
};

pub use self::method::model_completed::{
    ModelCompleteOutcome, ModelCompleteStopReason, ModelCompleteUsage, ModelCompletedParams,
};

pub use self::method::plugin::{
    PluginCatalogEntry, PluginChangedParams, PluginInstallLocalPathTarget,
    PluginInstallMarketplaceTarget, PluginInstallParams, PluginInstallResult, PluginInstallScope,
    PluginInstallTarget, PluginListParams, PluginListResult, PluginMarketplaceAddParams,
    PluginMarketplaceChange, PluginMarketplaceChangedParams, PluginMarketplaceRecordResult,
    PluginMarketplaceRemoveParams, PluginMarketplaceRemoveResult, PluginMarketplaceSkippedEntry,
    PluginMarketplaceSourceShape, PluginMarketplaceUpdateParams, PluginSource,
};

pub use self::method::recap::{
    RecapCancelParams, RecapCancelResult, RecapCompletedParams, RecapFailureReason, RecapOutcome,
    RecapRequestParams, RecapRequestResult,
};

pub use self::method::runtime::{
    CompactStatus, ModelSelection, SessionCompactParams, SessionCompactResult, SessionRenameParams,
    SessionRenameResult, SessionSetModelParams, SessionSetModelResult,
    SessionSetReasoningEffortParams, SessionSetReasoningEffortResult, SessionUserShellParams,
    SessionUserShellResult,
};

pub use self::method::runtime::model_catalog::{
    ModelCatalogEntry, ModelCatalogSource, ModelCost, ModelDescribedReasoningEffort,
    ModelListParams, ModelListResult, ModelReasoningEffortVariants,
    UnknownModelReasoningEffortVariants,
};

pub use self::method::session::{RunningElsewhere, RunningElsewhereOrigin, Session, SessionKind};

pub use self::method::session::members::ProbeDegradedReason;

pub use self::method::session_events::{
    SessionClosedParams, SessionClosedReason, SessionStartedParams, SessionStatus,
    SessionStatusChangedParams,
};

pub use self::method::session_external_wait::{
    ExternalWaitView, SessionClearExternalWaitParams, SessionClearExternalWaitResult,
    SessionDeclareExternalWaitParams, SessionDeclareExternalWaitResult,
};

pub use self::method::session_satellites::{
    AttentionFlag, EffectiveApprovalModeState, EffectivePermissionState, ForkProvenance,
    SessionListChangedParams, SessionSpawnedBy, SideProvenance,
};

pub use self::method::skill::{
    SkillActivationScope, SkillActivationState, SkillCatalogEntry, SkillChangedParams,
    SkillImportCounts, SkillImportFailure, SkillImportParams, SkillImportQuarantine,
    SkillImportResult, SkillImportSource, SkillInvocationSource, SkillListParams, SkillListResult,
    SkillSetActivationParams, SkillSetActivationResult, SkillSource,
};

pub use self::method::snapshot::{
    BranchState, EffectiveModel, PendingApprovalPointer, PendingUserInputPointer,
    ReasoningEffortState, SnapshotAnchor, SnapshotState, TodoListState, TurnRef, ViewSnapshot,
};

pub use self::method::subagent::{SubagentListParams, SubagentListResult, SubagentRosterEntry};

pub use self::method::task::{
    TaskBackgroundParams, TaskCommandResult, TaskExecutionMode, TaskListEntry, TaskListParams,
    TaskListResult, TaskListStatus, TaskStopAllParams, TaskStopAllResult, TaskStopParams,
};

pub use self::method::turn::{
    CommandStatus, IfBusy, ReasoningEffort, TurnCancelParams, TurnCancelResult,
    TurnInterruptParams, TurnInterruptResult, TurnStartDisposition, TurnStartParams,
    TurnStartResult, TurnSteerParams, TurnSteerResult, TurnUnqueueParams, TurnUnqueueResult,
    TurnUserShell,
};

pub use self::method::turn::input_part::{TurnInputPart, TurnInputPartType};

pub use self::method::usage::{
    SubscriptionUsage, SubscriptionUsageWeekly, SubscriptionUsageWindow, UsageReadResult,
};

pub use self::method::user_input::{
    UserInputAnswerParams, UserInputAnswerResult, UserInputCancelParams, UserInputCancelResult,
    UserInputClarifyParams, UserInputClarifyResult, UserInputEngagedParams,
    UserInputInterruptParams, UserInputInterruptResult,
};

pub use self::method::view::{
    ItemReadOutputEncoding, ItemReadOutputParams, ItemReadOutputResult, UnframedViewNotification,
    UnframedViewNotificationParams, ViewPageAnchor, ViewPageDirection, ViewPageParams,
    ViewPageResolvedAnchor, ViewPageResult, ViewSubscribeParams, ViewSubscribeResult,
    ViewUnsubscribeParams, ViewUnsubscribeResult,
};

pub use self::method::workflow::{
    WorkflowCancelParams, WorkflowChildAction, WorkflowChildControlParams, WorkflowControlResult,
    WorkflowPauseParams, WorkflowResumeParams, WorkflowResumeResult,
};

pub use self::method::worktree::{SessionWorktree, WorktreeOrigin, WorktreeStartRequest};

pub use self::request::RequestReceipt;

pub use self::view::{RecordPosition, SourceRange, StreamRef};

pub use self::view::approval::{
    ApprovalOrigin, ApprovalRequestParams, ApprovalResolvedParams, ApprovalStage,
    ApprovalStageResolution, ApprovalSubagentOrigin, ApprovalSubject, ApprovalSuggestedPrefix,
    ApprovalUpdatedParams, ComputerUseLockHolder,
};

pub use self::view::approval::decision::{
    ApprovalAmendment, ApprovalAmendmentDurability, ApprovalChange, ApprovalChoice,
    ApprovalChoiceScope, ApprovalDecision, ApprovalPersistenceStatus, ApprovalPolicyResult,
    ApprovalResolvedBy, ApprovalStageEvidence,
};

pub use self::view::approval_card_facts::{
    ApprovalCuaCardFacts, ApprovalCuaDataFact, ApprovalCuaMask, ApprovalCuaPage, ApprovalCuaPoint,
    ApprovalCuaStep,
};

pub use self::view::event::{
    ItemCompletedParams, ItemDeltaParams, ItemStartedParams, ItemUpdatedParams, LimitKind,
    QuotaDetail, RetractOutcome, TurnCompletedParams, TurnError, TurnErrorKind,
    TurnForegroundCompletedParams, TurnModelAttemptStartedParams, TurnModelRetryScheduledParams,
    TurnRetractedParams, TurnRetryScheduledParams, TurnStartedParams, TurnTerminal,
    TurnUnqueuedParams,
};

pub use self::view::gap::ViewGapParams;

pub use self::view::health::{SessionViewHealth, SessionViewHealthChangedParams};

pub use self::view::item::object::item::Item;

pub use self::view::item::object::notice::{NoticeOrigin, NoticeSeverity, NoticeSubject};

pub use self::view::item::object::replay_hint::ReplayHint;

pub use self::view::item::object::scheduled_fire::ScheduledFireMembers;

pub use self::view::item::object::tool_call::{BackgroundTarget, ToolCallMembers};

pub use self::view::item_background::{BackgroundInitiator, BackgroundState, BackgroundStatus};

pub use self::view::item_background_terminal_completion::BackgroundTerminalCompletion;

pub use self::view::item_content::{
    CompactionOutcome, CompactionTrigger, MessageAttachment, ModelVisibleContent, OutputRef,
    OutputRefAvailability, PatchSummary, WebSearchHit,
};

pub use self::view::item_damaged_range::DamagedRange;

pub use self::view::item_earlier_history::{EarlierHistory, EarlierHistoryMessage};

pub use self::view::item_hold::HeldFor;

pub use self::view::item_kind::{HookRunStatus, ItemKind, ItemStatus};

pub use self::view::item_peer_message::PeerMessage;

pub use self::view::item_status::{
    StatusAttempt, StatusChildren, StatusHealth, StatusHealthLevel, StatusProgress, StatusStep,
};

pub use self::view::item_subagent_workflow::{
    SubagentControlStatus, SubagentResult, WorkflowChild, WorkflowTokenBudget,
};

pub use self::view::message_phase::MessagePhase;

pub use self::view::monitor_inbox::{
    MonitorInboxItemAdmittedParams, MonitorInboxItemDrainedParams, MonitorInboxItemVoidedParams,
    MonitorInboxSnapshotEntry,
};

pub use self::view::state::{
    ApprovalMode, ApprovalModeSource, Goal, ModelChangeSource, ReasoningEffortChangeSource,
    SessionApprovalModeChangedParams, SessionBranchChangedParams, SessionGoalChangedParams,
    SessionModelChangedParams, SessionModelRouteUnservedParams,
    SessionReasoningEffortChangedParams, SessionTodoListChangedParams, TodoItem, TodoStatus, Vcs,
};

pub use self::view::state::permission_profile::{
    PermissionApprovalAxis, PermissionAxes, PermissionFilesystemAxis, PermissionNetworkAxis,
    ReviewerAuthority,
};

pub use self::view::state::session_name::{SessionNameChangedParams, SessionNameOrigin};

pub use self::view::state::usage::{
    ContextPressureLevel, ContextUsage, CumulativeCost, CumulativeTokenUsage,
    SessionContextUsageParams, SessionTokenUsageParams, TokenUsage,
};

pub use self::view::subagent_input_phase::SubagentInputPhase;

pub use self::view::subagent_result_status::SubagentResultStatus;

pub use self::view::tool_label::ToolDisplayLabel;

pub use self::view::tool_receipt::{CronReceipt, CronReceiptJob, ToolReceipt, ToolReceiptBody};

pub use self::view::tool_receipt::code_mode::{
    CodeModeLanguage, CodeModeOutputSpan, CodeModeOutputStream, CodeModeReceipt,
};

pub use self::view::tool_receipt::vocabulary::{ToolReceiptOperation, ToolReceiptOutcome};

pub use self::view::user_input::{
    UserInputAnswer, UserInputClarification, UserInputOption, UserInputOptionPreview,
    UserInputOutcome, UserInputQuestion, UserInputRequestParams, UserInputSelection,
    UserInputSelectionMode, UserInputSettledParams,
};
