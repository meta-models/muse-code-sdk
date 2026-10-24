// @generated from the MSP stable schema and protocol sources; do not edit by hand.

//! Stable Muse Session Protocol (MSP) wire types.
//!
//! Serde names equal the stable schema names; use these types and never
//! rename an MSP field or variant by hand.

// Copied doc comments can name schema-only helpers or private items the
// copy omits; those links render as plain text.
#![allow(rustdoc::broken_intra_doc_links, rustdoc::private_intra_doc_links)]

/// Fingerprint of the stable schema these types were generated from; the
/// SDK pin test checks it against the committed manifest.
pub const GENERATED_FINGERPRINT: &str =
    "sha256:7fddaf646dbc317e5fcac0785e135eb04df14fbb0db1863089dfd6da21730e5b";

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
    ClientCapabilities, ClientInfo, InitializeParams, InitializeResult, PlatformFamily, PlatformOs,
    SandboxAvailability, SandboxUnavailableReason, SchemaInfo, ServerInfo, SessionDurability,
};

pub use self::method::approval::{
    ApprovalDecideParams, ApprovalDecideResult, ApprovalListPendingParams,
    ApprovalListPendingResult, ApprovalModeApplyOutcome, SessionSetApprovalModeParams,
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
    ForkCutPoint, QueuedInput, SessionForkParams, SessionForkResult, SessionReadParams,
    SessionReadResult, SessionSideChatParams, SessionSideChatResult, SessionStartParams,
    SessionStartResult,
};

pub use self::method::lifecycle::recovery::{
    RecoveryEffectiveSource, RecoveryMode, RecoveryObservation, RecoveryObservedMode,
    RecoveryQualification,
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

pub use self::method::lifecycle::session_resume::{
    BlockedPrompt, CheckpointBoundary, HistoryMode, HistoryNoneReason, HistoryPreference, LastTurn,
    PendingRequestKind, PendingRequestPointer, SessionHistory, SessionResumeParams,
    SessionResumeResult,
};

pub use self::method::limits::{
    LimitsAboveMaxAxis, LimitsAxisValue, LimitsNetworkMode, SessionLimits, SessionLimitsChoice,
};

pub use self::method::media::{MediaUploadParams, MediaUploadResult};

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

pub use self::method::session::{
    AttentionFlag, EffectiveApprovalModeState, EffectivePermissionState, ForkProvenance, Session,
    SessionKind, SessionListChangedParams, SideProvenance,
};

pub use self::method::session_events::{
    SessionClosedParams, SessionClosedReason, SessionStartedParams, SessionStatus,
    SessionStatusChangedParams,
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

pub use self::method::task::{
    TaskBackgroundParams, TaskCommandResult, TaskExecutionMode, TaskListEntry, TaskListParams,
    TaskListResult, TaskListStatus, TaskStopAllParams, TaskStopAllResult, TaskStopParams,
};

pub use self::method::turn::{
    CommandStatus, IfBusy, ReasoningEffort, TurnCancelParams, TurnCancelResult, TurnInputPart,
    TurnInputPartType, TurnInterruptParams, TurnInterruptResult, TurnStartDisposition,
    TurnStartParams, TurnStartResult, TurnSteerParams, TurnSteerResult, TurnUnqueueParams,
    TurnUnqueueResult, TurnUserShell,
};

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
    ApprovalUpdatedParams,
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
    TurnForegroundCompletedParams, TurnModelRetryScheduledParams, TurnRetractedParams,
    TurnRetryScheduledParams, TurnStartedParams, TurnTerminal, TurnUnqueuedParams,
};

pub use self::view::gap::ViewGapParams;

pub use self::view::health::{SessionViewHealth, SessionViewHealthChangedParams};

pub use self::view::item::object::item::Item;

pub use self::view::item::object::replay_hint::ReplayHint;

pub use self::view::item::object::scheduled_fire::ScheduledFireMembers;

pub use self::view::item::object::tool_call::ToolCallMembers;

pub use self::view::item_background::{BackgroundInitiator, BackgroundState, BackgroundStatus};

pub use self::view::item_background_terminal_completion::BackgroundTerminalCompletion;

pub use self::view::item_content::{
    CompactionOutcome, CompactionTrigger, HookRunStatus, ItemKind, ItemStatus, MessageAttachment,
    ModelVisibleContent, OutputRef, OutputRefAvailability, PatchSummary, SubagentControlStatus,
    SubagentResult, WebSearchHit, WorkflowChild, WorkflowTokenBudget,
};

pub use self::view::item_damaged_range::DamagedRange;

pub use self::view::item_status::{
    StatusAttempt, StatusChildren, StatusHealth, StatusHealthLevel, StatusProgress, StatusStep,
};

pub use self::view::message_phase::MessagePhase;

pub use self::view::monitor_inbox::{
    MonitorInboxItemAdmittedParams, MonitorInboxItemDrainedParams, MonitorInboxItemVoidedParams,
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
