// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::ErrorKind;

/// The session-lifecycle wire code for [`ErrorKind::SessionNotLoaded`]: one
/// shared symbol so producers and test assertions cannot drift on the literal.
pub const SESSION_NOT_LOADED_CODE: i64 = -32024;

/// The session-lifecycle wire code for [`ErrorKind::SessionStreamMismatch`]:
/// the resolved store's own stream id is not the requested session, so every
/// write lane refuses before it can append a fabricated history.
pub const SESSION_STREAM_MISMATCH_CODE: i64 = -32025;

/// The v1 error codes enrolled in the public bundle.
///
/// Enrolment tracks what the BINARY can emit, not what the bundle's method
/// index has reached: the protocol spec makes the export exact for the binary
/// that produced it, so a code a v1 host puts on the wire is enrolled here even
/// while its method's params/result types are still pending. The
/// `-32060…-32069` the protocol spec block stays out because it is deferred
/// whole and a v1 host never emits it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ErrorCode {
    /// `-32700` — unparseable line.
    ParseError,
    /// `-32600` — invalid frame or handshake ordering.
    InvalidRequest,
    /// `-32601` — unknown or ungated-experimental method.
    MethodNotFound,
    /// `-32602` — malformed params or ungated-experimental field/variant.
    InvalidParams,
    /// `-32603` — unexpected server failure.
    Internal,
    /// `-32001` — ingress saturated.
    Overloaded,
    /// `-32002` — frame or params over the limit.
    InputTooLarge,
    /// `-32010` — missing capability grant.
    CapabilityRequired,
    /// `-32011` — run/item/subscription/cursor anchor missing.
    NotFound,
    /// `-32013` — user interrupt pre-empted the request.
    Interrupted,
    /// `-32014` — cancellation pre-empted the request.
    Cancelled,
    /// `-32020` — no log resolves for `sessionId`.
    SessionNotFound,
    /// `-32021` — writer lease held by another process.
    SessionInUse,
    /// `-32022` — multiple canonical logs for the id.
    SessionAmbiguous,
    /// `-32023` — `cutPoint.lastTurnId` unknown or in-progress.
    ForkBoundaryInvalid,
    /// `-32024` — log exists but the session is not loaded on this host.
    SessionNotLoaded,
    /// `-32025` — the store's own stream id is not the requested session
    /// (a moved or renamed session directory).
    SessionStreamMismatch,
    /// `-32029` — a worktree action names an untrusted repository.
    WorkspaceNotTrusted,
    /// `-32030` — durable runtime rejection; `data.reason` is snake_case.
    CommandRejected,
    /// `-32031` — command-admission queue full; `data.capacity` present.
    Backpressured,
    /// `-32032` — the skill selector names no user-invocable skill in this
    /// session's catalog.
    SkillNotFound,
    /// `-32033` — computer use is unavailable on this host.
    ComputerUseUnavailable,
    /// `-32034` — the plugin verb names no configured marketplace.
    MarketplaceNotFound,
    /// `-32035` — the install arm names no plugin in the named store.
    PluginNotFound,
    /// `-32036` — marketplace add over an already-configured name.
    MarketplaceAlreadyExists,
    /// `-32037` — the managed policy disables plugin mutation.
    PluginMutationsDisabled,
    /// `-32038` — a `video` input part names an upload id with no completed
    /// upload.
    UploadNotFound,
    /// `-32040` — requested range predates the retained view.
    ViewTruncated,
    /// `-32041` — an `item/readOutput` ref exists but its bytes are not
    /// servable; `data.availability` carries the durable
    /// `ToolOutputAvailability`.
    OutputUnavailable,
    /// `-32042` — installed boundary pruned, unusable, or absent.
    Boundary,
    /// `-32050` — `approvalId` names no approval record in this session.
    ApprovalNotFound,
    /// `-32051` — decide after the durable terminal.
    ApprovalAlreadyResolved,
    /// `-32052` — `choiceId` is not among the current `availableChoices`.
    ApprovalChoiceInvalid,
    /// `-32053` — `requirementId` is not the current requirement.
    ApprovalRequirementStale,
    /// `-32054` — protected-write decision with no live reviewer.
    ApprovalReviewerUnavailable,
    /// `-32055` — `userInputId` names no prompt in this session.
    UserInputNotFound,
    /// `-32056` — answer/cancel/clarify after settlement.
    UserInputAlreadySettled,
    /// `-32057` — answers do not match the prompt's questions or bounds.
    UserInputAnswerInvalid,
    /// `-32060` — cursor anchor names no position of the requested stream.
    MissingAnchor,
    /// `-32061` — anchor (or origin) falls in a retention-pruned prefix.
    PrunedPrefix,
    /// `-32062` — anchor id belongs to a different stream of the session.
    WrongStream,
    /// `-32063` — stream not present in the session.
    UnknownStream,
    /// `-32064` — projection name not registered.
    UnknownProjection,
    /// `-32070` — `admissionId` names no admission record in this session.
    AdmissionNotFound,
    /// `-32071` — decide after the durable terminal.
    AdmissionAlreadyResolved,
    /// `-32072` — `choiceId` is not among the current `availableChoices`.
    AdmissionChoiceInvalid,
}

#[derive(Clone, Copy)]
struct ErrorCodeDefinition {
    code: i64,
    kind: ErrorKind,
    override_kinds: &'static [ErrorKind],
    retryable: Option<bool>,
    experimental: bool,
}

impl ErrorCodeDefinition {
    const fn new(
        code: i64,
        kind: ErrorKind,
        override_kinds: &'static [ErrorKind],
        retryable: Option<bool>,
    ) -> Self {
        Self {
            code,
            kind,
            override_kinds,
            retryable,
            experimental: false,
        }
    }

    /// An experimental-tier row: exported only in the experimental bundle
    /// render, like the experimental method rows.
    const fn experimental(code: i64, kind: ErrorKind) -> Self {
        Self {
            code,
            kind,
            override_kinds: &[],
            retryable: Some(false),
            experimental: true,
        }
    }
}

/// A single-kind row a retry cannot fix (`retryable: false`). The column is the
/// CODE's default; a payload that knows better sets `data.retryable`.
const fn fatal(code: i64, kind: ErrorKind) -> ErrorCodeDefinition {
    ErrorCodeDefinition::new(code, kind, &[], Some(false))
}

/// A single-kind saturation row (`retryable: true`): the queue drains, so the
/// same request can succeed later.
const fn drains(code: i64, kind: ErrorKind) -> ErrorCodeDefinition {
    ErrorCodeDefinition::new(code, kind, &[], Some(true))
}

/// A single-kind pre-emption row (`retryable` absent): retry is not the
/// question — the outcome arrives on the view stream.
const fn preempted(code: i64, kind: ErrorKind) -> ErrorCodeDefinition {
    ErrorCodeDefinition::new(code, kind, &[], None)
}

impl ErrorCode {
    /// Every code enrolled in the public bundle, in the protocol spec order:
    /// the 37 stable rows plus the 5 experimental the protocol spec rows, the
    /// experimental row, and the 3 experimental a tracked change rows, which
    /// render only in the experimental bundle.
    pub const ALL: [Self; 46] = [
        Self::ParseError,
        Self::InvalidRequest,
        Self::MethodNotFound,
        Self::InvalidParams,
        Self::Internal,
        Self::Overloaded,
        Self::InputTooLarge,
        Self::CapabilityRequired,
        Self::NotFound,
        Self::Interrupted,
        Self::Cancelled,
        Self::SessionNotFound,
        Self::SessionInUse,
        Self::SessionAmbiguous,
        Self::ForkBoundaryInvalid,
        Self::SessionNotLoaded,
        Self::SessionStreamMismatch,
        Self::WorkspaceNotTrusted,
        Self::CommandRejected,
        Self::Backpressured,
        Self::SkillNotFound,
        Self::ComputerUseUnavailable,
        Self::MarketplaceNotFound,
        Self::PluginNotFound,
        Self::MarketplaceAlreadyExists,
        Self::PluginMutationsDisabled,
        Self::UploadNotFound,
        Self::ViewTruncated,
        Self::OutputUnavailable,
        Self::Boundary,
        Self::ApprovalNotFound,
        Self::ApprovalAlreadyResolved,
        Self::ApprovalChoiceInvalid,
        Self::ApprovalRequirementStale,
        Self::ApprovalReviewerUnavailable,
        Self::UserInputNotFound,
        Self::UserInputAlreadySettled,
        Self::UserInputAnswerInvalid,
        Self::MissingAnchor,
        Self::PrunedPrefix,
        Self::WrongStream,
        Self::UnknownStream,
        Self::UnknownProjection,
        Self::AdmissionNotFound,
        Self::AdmissionAlreadyResolved,
        Self::AdmissionChoiceInvalid,
    ];

    /// This code's complete the protocol spec row. Keeping the row together
    /// prevents the generated bundle columns from drifting across separate
    /// matches, so this stays ONE wildcard-free match over every variant: a new
    /// code fails to compile until its row exists. The three shape helpers
    /// below carry the `retryable` column's vocabulary — a shared name per
    /// column value, not a default anyone can inherit by omission.
    const fn definition(self) -> ErrorCodeDefinition {
        match self {
            Self::ParseError => fatal(-32700, ErrorKind::ParseError),
            Self::InvalidRequest => ErrorCodeDefinition::new(
                -32600,
                ErrorKind::InvalidRequest,
                &[ErrorKind::NotInitialized, ErrorKind::AlreadyInitialized],
                Some(false),
            ),
            Self::MethodNotFound => ErrorCodeDefinition::new(
                -32601,
                ErrorKind::MethodNotFound,
                &[ErrorKind::ExperimentalRequired],
                Some(false),
            ),
            Self::InvalidParams => ErrorCodeDefinition::new(
                -32602,
                ErrorKind::InvalidParams,
                &[ErrorKind::ExperimentalRequired],
                Some(false),
            ),
            Self::Internal => ErrorCodeDefinition::new(
                -32603,
                ErrorKind::Internal,
                &[
                    ErrorKind::PageEventTooLarge,
                    ErrorKind::OutputResultTooLarge,
                ],
                Some(false),
            ),
            Self::Overloaded => drains(-32001, ErrorKind::Overloaded),
            Self::InputTooLarge => fatal(-32002, ErrorKind::InputTooLarge),
            Self::CapabilityRequired => fatal(-32010, ErrorKind::CapabilityRequired),
            Self::NotFound => fatal(-32011, ErrorKind::NotFound),
            Self::Interrupted => preempted(-32013, ErrorKind::Interrupted),
            Self::Cancelled => preempted(-32014, ErrorKind::Cancelled),
            Self::SessionNotFound => fatal(-32020, ErrorKind::SessionNotFound),
            Self::SessionInUse => fatal(-32021, ErrorKind::SessionInUse),
            Self::SessionAmbiguous => fatal(-32022, ErrorKind::SessionAmbiguous),
            Self::ForkBoundaryInvalid => fatal(-32023, ErrorKind::ForkBoundaryInvalid),
            Self::SessionNotLoaded => fatal(SESSION_NOT_LOADED_CODE, ErrorKind::SessionNotLoaded),
            Self::SessionStreamMismatch => fatal(
                SESSION_STREAM_MISMATCH_CODE,
                ErrorKind::SessionStreamMismatch,
            ),
            Self::WorkspaceNotTrusted => {
                ErrorCodeDefinition::experimental(-32029, ErrorKind::WorkspaceNotTrusted)
            }
            Self::CommandRejected => fatal(-32030, ErrorKind::CommandRejected),
            Self::Backpressured => drains(-32031, ErrorKind::Backpressured),
            Self::SkillNotFound => fatal(-32032, ErrorKind::SkillNotFound),
            Self::ComputerUseUnavailable => fatal(-32033, ErrorKind::ComputerUseUnavailable),
            Self::MarketplaceNotFound => fatal(-32034, ErrorKind::MarketplaceNotFound),
            Self::PluginNotFound => fatal(-32035, ErrorKind::PluginNotFound),
            Self::MarketplaceAlreadyExists => fatal(-32036, ErrorKind::MarketplaceAlreadyExists),
            Self::PluginMutationsDisabled => fatal(-32037, ErrorKind::PluginMutationsDisabled),
            Self::UploadNotFound => fatal(-32038, ErrorKind::UploadNotFound),
            Self::ViewTruncated => fatal(-32040, ErrorKind::ViewTruncated),
            Self::OutputUnavailable => fatal(-32041, ErrorKind::OutputUnavailable),
            Self::Boundary => ErrorCodeDefinition::new(
                -32042,
                ErrorKind::BoundaryPruned,
                &[ErrorKind::BoundaryUnusable, ErrorKind::NoBoundary],
                Some(false),
            ),
            Self::ApprovalNotFound => fatal(-32050, ErrorKind::ApprovalNotFound),
            Self::ApprovalAlreadyResolved => fatal(-32051, ErrorKind::ApprovalAlreadyResolved),
            Self::ApprovalChoiceInvalid => fatal(-32052, ErrorKind::ApprovalChoiceInvalid),
            Self::ApprovalRequirementStale => fatal(-32053, ErrorKind::ApprovalRequirementStale),
            Self::ApprovalReviewerUnavailable => {
                fatal(-32054, ErrorKind::ApprovalReviewerUnavailable)
            }
            Self::UserInputNotFound => fatal(-32055, ErrorKind::UserInputNotFound),
            Self::UserInputAlreadySettled => fatal(-32056, ErrorKind::UserInputAlreadySettled),
            Self::UserInputAnswerInvalid => fatal(-32057, ErrorKind::UserInputAnswerInvalid),
            Self::MissingAnchor => {
                ErrorCodeDefinition::experimental(-32060, ErrorKind::MissingAnchor)
            }
            Self::PrunedPrefix => {
                ErrorCodeDefinition::experimental(-32061, ErrorKind::PrunedPrefix)
            }
            Self::WrongStream => ErrorCodeDefinition::experimental(-32062, ErrorKind::WrongStream),
            Self::UnknownStream => {
                ErrorCodeDefinition::experimental(-32063, ErrorKind::UnknownStream)
            }
            Self::UnknownProjection => {
                ErrorCodeDefinition::experimental(-32064, ErrorKind::UnknownProjection)
            }
            Self::AdmissionNotFound => {
                ErrorCodeDefinition::experimental(-32070, ErrorKind::AdmissionNotFound)
            }
            Self::AdmissionAlreadyResolved => {
                ErrorCodeDefinition::experimental(-32071, ErrorKind::AdmissionAlreadyResolved)
            }
            Self::AdmissionChoiceInvalid => {
                ErrorCodeDefinition::experimental(-32072, ErrorKind::AdmissionChoiceInvalid)
            }
        }
    }

    /// The wire integer.
    #[must_use]
    pub const fn code(self) -> i64 {
        self.definition().code
    }

    /// The primary `data.kind` for this code.
    #[must_use]
    pub const fn kind(self) -> ErrorKind {
        self.definition().kind
    }

    /// Kinds that override the primary on this code: handshake-ordering
    /// overrides on `-32600`, the experimental gate on `-32601`/`-32602`, the
    /// permanent page/output budget residuals on `-32603`, and the
    /// unusable/absent boundary arms on `-32042`.
    #[must_use]
    pub const fn override_kinds(self) -> &'static [ErrorKind] {
        self.definition().override_kinds
    }

    /// Whether a retry can succeed. `None` for the pre-emption codes, where
    /// retry is not applicable — the outcome arrives on the view stream.
    #[must_use]
    pub const fn retryable(self) -> Option<bool> {
        self.definition().retryable
    }

    /// Whether this row renders only in the experimental bundle.
    #[must_use]
    pub const fn is_experimental(self) -> bool {
        self.definition().experimental
    }
}
