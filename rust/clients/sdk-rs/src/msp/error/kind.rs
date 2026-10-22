// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// A stable `error.data.kind` category: camelCase, the value clients branch on.
/// Open: new kinds are added as their methods land, and a new `kind` is
/// additive only because this domain is declared open.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum ErrorKind {
    /// Line was not valid JSON (`-32700`); `id` is `null`.
    ParseError,
    /// Valid JSON, invalid frame (`-32600`).
    InvalidRequest,
    /// Pre-handshake request other than `initialize` (`-32600` override).
    NotInitialized,
    /// Second `initialize` on one connection (`-32600` override).
    AlreadyInitialized,
    /// Unknown method (`-32601`).
    MethodNotFound,
    /// Malformed params (`-32602`).
    InvalidParams,
    /// Experimental method, field, or variant without the `experimentalApi`
    /// opt-in.
    ExperimentalRequired,
    /// Unexpected server failure (`-32603`).
    Internal,
    /// One durable view event cannot fit the configured page-result budget
    /// (`-32603` override); `sessionId`, `viewCursor`, and `limitBytes` name
    /// the blocked range and budget.
    PageEventTooLarge,
    /// A bounded `item/readOutput` result cannot fit the configured result
    /// budget even at zero progress (`-32603` override); `sessionId` and
    /// `limitBytes` name the session and exceeded budget.
    OutputResultTooLarge,
    /// Ingress queue saturated (`-32001`); retry with backoff and jitter.
    Overloaded,
    /// Frame or params over the limit (`-32002`); `data.limitBytes` present.
    InputTooLarge,
    /// Capability-gated method without the grant (`-32010`);
    /// `data.capability` names it.
    CapabilityRequired,
    /// Run, item, subscription, or cursor anchor missing (`-32011`); a
    /// missing view-cursor anchor sets `data.reason: "missingAnchor"`.
    NotFound,
    /// Interrupt pre-empted the request (`-32013`); outcome on the view.
    Interrupted,
    /// Cancellation pre-empted the request (`-32014`); outcome on the view.
    Cancelled,
    /// `sessionId` resolves to no session on this host; `data.sessionId` names
    /// the rejected id.
    SessionNotFound,
    /// The session writer lease is held by another host (`-32021`).
    SessionInUse,
    /// More than one canonical retained log matches the session (`-32022`).
    SessionAmbiguous,
    /// A fork cut names an unknown or non-terminal turn (`-32023`).
    ForkBoundaryInvalid,
    /// Session exists but is not loaded on this host; `data.sessionId` names
    /// the unloaded session.
    SessionNotLoaded,
    /// The resolved store's own stream id is not the requested session: a moved
    /// or renamed session directory whose log belongs to a different session.
    /// `data.sessionId` names the requested session.
    SessionStreamMismatch,
    /// A `session/start` choice is wider than the host ceiling on at least one
    /// axis; `data.axes` names every too-wide axis with its requested and
    /// ceiling values and `data.retryable` is `false`. Experimental tier with
    /// the socket limits surface.
    LimitsAboveMax,
    /// A worktree action names an untrusted repository; `data.path` names the
    /// subject repo and `data.retryable` is `false`. Experimental tier with the
    /// worktree surface.
    WorkspaceNotTrusted,
    /// An command id was replayed with a different payload (`-32030`).
    CommandRejected,
    /// The bounded command-admission queue is full (`-32031`).
    Backpressured,
    /// A skill selector names no skill in the session's current user-invocable
    /// catalog; `data.sessionId` and `data.selector` name the rejected pair.
    SkillNotFound,
    /// Computer use is unavailable on this host: its gate was off when the host
    /// launched, or the host is not macOS. The `computerUseSettings/*` methods
    /// stay registered and answer this.
    ComputerUseUnavailable,
    /// A plugin verb names no configured marketplace; `data.sessionId` and
    /// `data.name` name the rejected pair.
    MarketplaceNotFound,
    /// The install arm names no plugin in the named store; `data.sessionId`,
    /// `data.marketplace`, and `data.name` name the rejected triple.
    PluginNotFound,
    /// Marketplace add over an already-configured name; the existing record is
    /// untouched. `data.sessionId` and `data.name` name the rejected pair.
    MarketplaceAlreadyExists,
    /// The managed policy disables plugin mutation; nothing was touched.
    /// `data.sessionId` names the acting session.
    PluginMutationsDisabled,
    /// A `video` input part names an upload id with no completed upload;
    /// `data.sessionId` and `data.uploadId` name the rejected pair.
    UploadNotFound,
    /// The requested range predates the retained view; `data.earliestCursor`
    /// names the oldest servable position when one exists. Recovery is
    /// `session/resume` snapshot semantics.
    ViewTruncated,
    /// An `item/readOutput` ref exists but its bytes are not servable;
    /// `data.availability` carries the durable `ToolOutputAvailability`,
    /// read-time-derived (`"unsupported"`/`"accessFailed"`) when the durable
    /// record still says `available`.
    OutputUnavailable,
    /// A requested installed boundary has been pruned.
    BoundaryPruned,
    /// The installed boundary cannot safely serve the requested read
    /// (`-32042` override).
    BoundaryUnusable,
    /// No installed boundary exists for the requested read
    /// (`-32042` override).
    NoBoundary,
    /// Approval id is unknown (`-32050`).
    ApprovalNotFound,
    /// Approval already has a durable terminal (`-32051`).
    ApprovalAlreadyResolved,
    /// Choice or feedback is invalid for this approval (`-32052`).
    ApprovalChoiceInvalid,
    /// Requirement token is not the current stage (`-32053`).
    ApprovalRequirementStale,
    /// A protected write has no live reviewer lease (`-32054`).
    ApprovalReviewerUnavailable,
    /// User-input prompt id is unknown (`-32055`).
    UserInputNotFound,
    /// User-input prompt already has a durable settlement (`-32056`).
    UserInputAlreadySettled,
    /// Structured answer or clarification is invalid (`-32057`).
    UserInputAnswerInvalid,
    /// A raw-log cursor position names no position of the requested stream;
    /// `data.stream` and `data.after` name the rejected anchor. Experimental
    /// tier.
    MissingAnchor,
    /// A raw-log anchor (or the origin) falls in a retention-pruned prefix;
    /// `data.nextAvailable` carries the earliest readable position.
    /// Experimental tier.
    PrunedPrefix,
    /// A raw-log anchor id exists in the session but belongs to a different
    /// stream. Experimental tier.
    WrongStream,
    /// No such stream in the session. Experimental tier.
    UnknownStream,
    /// No such registered projection. Experimental tier.
    UnknownProjection,
    /// Admission id is unknown; `data.sessionId` and `data.admissionId` name
    /// the rejected pair. Experimental tier.
    AdmissionNotFound,
    /// Decide after the durable terminal; `data.admissionId` plus the winning
    /// `data.admissionResolution`, `data.retryable: false`. Experimental tier.
    AdmissionAlreadyResolved,
    /// Choice is not among the current `availableChoices`; `data.admissionId`
    /// and `data.choiceId` name the rejected pair. Experimental tier.
    AdmissionChoiceInvalid,
    /// A value from a newer host. The rest of the message still decodes, but
    /// the word is not kept, and encoding this variant fails. Never construct it.
    #[serde(other, skip_serializing)]
    Unrecognized,
}
