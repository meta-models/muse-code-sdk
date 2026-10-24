// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::capability::CapabilityName;
use crate::msp::envelope::JsonObject;
pub use kind::ErrorKind;
pub use registry::ErrorCode;
use serde::Deserialize;
use serde::Serialize;

pub(crate) mod definition;
pub(crate) mod kind;
pub(crate) mod registry;

/// Identifies one requirement of an approval: for a `shell` approval, one
/// stage. A client sends it back as `requirementId` in `approval/decide`, and a
/// stale-requirement error names the current one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequirementRef {
    /// The approval this requirement belongs to.
    pub approval_id: String,
    /// The requirement's index within the approval, counting from 0; an
    /// approval with a single requirement uses 0.
    pub source_index: usize,
}

/// Winning terminal returned to a losing `approval/decide` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalResolutionSummary {
    /// The winning decision, as an `approval/resolved` decision value such as
    /// `approved` or `abort`.
    pub decision: String,
    /// Who made the winning decision, such as `user`, `policy` or `llmJudge`.
    pub resolved_by: String,
    /// The view cursor of the winning `approval/resolved` event.
    pub view_cursor: String,
}

/// Winning terminal returned to a late user-input command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UserInputSettlementSummary {
    /// How the prompt settled, as a `userInput/settled` outcome value such as
    /// `answered` or `timedOut`.
    pub outcome: String,
    /// The view cursor of the `userInput/settled` event that recorded the
    /// settlement.
    pub view_cursor: String,
}

/// Winning terminal returned to a losing `admission/decide` command:
/// `resolvedBy` is omitted on timeout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct AdmissionResolutionSummary {
    /// The winning decision, such as `allow_once` or `timedOut`.
    pub decision: String,
    /// Who made the winning decision; absent when no person decided, for
    /// example a timeout, an automatic allow, or a cancelled or retired
    /// request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
    /// The view cursor of the winning `admission/resolved` event.
    pub view_cursor: String,
}

/// Deserialize a PRESENT member into the presence-tracking double-`Option`:
/// serde only calls this when the key exists, so an explicit JSON null becomes
/// `Some(None)` while an absent key stays `None` via `#[serde(default)]`.
/// Serialization is symmetric — `Some(None)` emits the explicit null, `None`
/// skips the key.
fn present_member<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// The optional `error.data` object. All members additive-optional; `kind` is
/// always present when `data` is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ErrorData {
    /// The stable camelCase category clients branch on.
    pub kind: ErrorKind,
    /// Whether retrying can succeed (e.g. `overloaded`). When present,
    /// overrides the error table row's `retryable` default for this code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    /// On `experimentalRequired` errors, the name of the experimental method,
    /// field or variant the request used, for example
    /// `turn/start.providerRequestOptions`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub descriptor: Option<String>,
    /// The missing capability, on `capabilityRequired` errors. Typed on the
    /// grantable registry, so the experimental-only `rawLog` joins the stable
    /// domain as an additive open-enum extension when it graduates.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capability: Option<CapabilityName>,
    /// The rejected command's identifier, on `commandRejected` errors. The
    /// ratified v1 contract pairs it with `reason`, so a client can settle the
    /// exact command it sent without parsing the message string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    /// Failure detail vocabulary (e.g. `"missingAnchor"` on `notFound` for a
    /// missing view-cursor anchor).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The exceeded byte limit, on `inputTooLarge` errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit_bytes: Option<u64>,
    /// The blocked view position on `pageEventTooLarge` errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_cursor: Option<String>,
    /// The item whose stored output was requested, on the `item/readOutput`
    /// arms (`notFound`, `outputUnavailable`, and the misaligned-offset
    /// `invalidParams`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_id: Option<String>,
    /// The requested `outputRef.id`, on the same `item/readOutput` arms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_ref: Option<String>,
    /// The stored output's availability on `outputUnavailable` — the durable
    /// `ToolOutputAvailability` value, read-time-derived when the durable
    /// record still says `available`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability: Option<String>,
    /// The next provable UTF-8 boundary on a misaligned text-media
    /// `item/readOutput` read: absent when no boundary is provable from the
    /// stored bytes ahead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aligned_next_offset: Option<u64>,
    /// The configured command-admission bound, on `backpressured` errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacity: Option<u64>,
    /// Free-form additive detail.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<JsonObject>,
    /// Session identity on errors whose lookup is session-scoped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The original recovery-dependent construction's coherent observation.
    /// An absent or unusable observation establishes no supported recovery.
    #[serde(
        default,
        deserialize_with = "crate::msp::method::lifecycle::deserialize_optional_recovery_observation",
        skip_serializing_if = "Option::is_none"
    )]
    pub recovery_observation: Option<crate::msp::method::lifecycle::RecoveryObservation>,
    /// The rejected skill selector on `skillNotFound`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// The rejected marketplace name on `marketplaceNotFound` and
    /// `marketplaceAlreadyExists`; the rejected plugin name on
    /// `pluginNotFound`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The store on `pluginNotFound`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<String>,
    /// The rejected upload id on `uploadNotFound`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    /// The oldest servable view position on `viewTruncated`; served as an
    /// explicit `null` when nothing before the head is servable — the null is
    /// present on the wire, never a dropped key.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_member"
    )]
    pub earliest_cursor: Option<Option<String>>,
    /// The rejected anchor value on `notFound`/`missingAnchor` and the `-32042`
    /// boundary arms; on `-32042` it is served as an explicit `null` when the
    /// request named no concrete anchor.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_member"
    )]
    pub anchor: Option<Option<String>>,
    /// The latest installed boundary's view cursor on the `-32042` arms —
    /// always present in the `-32042` JSON and explicitly `null` when no
    /// boundary exists.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "present_member"
    )]
    pub latest_boundary_cursor: Option<Option<String>>,
    /// Rejected inclusive fork boundary on `forkBoundaryInvalid`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_turn_id: Option<String>,
    /// The branch-seed path the host read before rejecting, on
    /// branch-validation rejections: one of `runtime_checkpoint_tail`,
    /// `runtime_full_replay`, `legacy_session_data` — the durable branch-seed
    /// vocabulary, so the client cites the real seed decision instead of
    /// guessing at a stale binary.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed_path: Option<String>,
    /// Why the branch seed did not use a checkpoint, on the same arms:
    /// one of `no_usable_checkpoint`, `unsupported_checkpoint_shape`,
    /// `checkpoint_has_model_visible_tail`, `checkpoint_missing_suffix`;
    /// absent when the seed used a checkpoint or no fallback was recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed_fallback_reason: Option<String>,
    /// Candidate retained paths on `sessionAmbiguous`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<String>>,
    /// Approval id on approval errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    /// Winning resolution on `approvalAlreadyResolved`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<ApprovalResolutionSummary>,
    /// Current stage token on `approvalRequirementStale`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_requirement_id: Option<ApprovalRequirementRef>,
    /// Rejected server-minted choice on `approvalChoiceInvalid`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub choice_id: Option<String>,
    /// Prompt identity on user-input errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input_id: Option<String>,
    /// Winning settlement on `userInputAlreadySettled`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settlement: Option<UserInputSettlementSummary>,
    /// Admission identity on admission errors.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admission_id: Option<String>,
    /// Winning resolution on `admissionAlreadyResolved`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admission_resolution: Option<AdmissionResolutionSummary>,
    /// The rejected raw-log stream, on the anchor arms (`missingAnchor`,
    /// `prunedPrefix`, `unknownStream`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stream: Option<crate::msp::view::StreamRef>,
    /// The rejected raw-log anchor, on `missingAnchor`, `prunedPrefix`,
    /// and `wrongStream`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<crate::msp::view::RecordPosition>,
    /// The earliest readable position, on `prunedPrefix`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_available: Option<crate::msp::view::RecordPosition>,
    /// The requested stream, on `wrongStream`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_stream: Option<crate::msp::view::StreamRef>,
    /// The stream the anchor's id actually belongs to, on `wrongStream`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor_stream: Option<crate::msp::view::StreamRef>,
    /// The unregistered projection name, on `unknownProjection`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub projection: Option<String>,
    /// The subject repository path, on `workspaceNotTrusted`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The rejected settings key path, on the `settings/writeValue` and
    /// `settings/writeMany` arms: the structural `-32602 invalidParams` shape
    /// and the `-32030` managed-denial block. File spelling verbatim, like the
    /// request's `keyPath`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// The rejected edit's index into the `settings/writeMany` `edits`
    /// array, on the same arms; absent on `settings/writeValue`, which
    /// carries no edit list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u64>,
    /// Every too-wide axis with its requested and ceiling values, on
    /// `limitsAboveMax`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub axes: Option<Vec<crate::msp::method::limits::LimitsAboveMaxAxis>>,
    /// How long until the next refresh may mint, on `usageRefreshRateLimited`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    /// The mint failure class, on `usageRefreshFailed`: `terminal`, `transient`
    /// (a 5xx, 429 or network failure; the only class with `retryable: true`),
    /// `onboarding`, `age_requirement`, `payment_subscription_required` or
    /// `credential_rejected`. Never credential material.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure_kind: Option<String>,
}

impl ErrorData {
    /// A `kind`-only payload with every optional field `None` — the one
    /// constructor call sites extend with struct-update syntax, so an
    /// additive SS field touches this file alone, never every literal.
    #[must_use]
    pub const fn new(kind: ErrorKind) -> Self {
        Self {
            kind,
            retryable: None,
            descriptor: None,
            capability: None,
            command_id: None,
            reason: None,
            limit_bytes: None,
            view_cursor: None,
            item_id: None,
            output_ref: None,
            availability: None,
            aligned_next_offset: None,
            capacity: None,
            details: None,
            session_id: None,
            recovery_observation: None,
            selector: None,
            name: None,
            marketplace: None,
            upload_id: None,
            earliest_cursor: None,
            anchor: None,
            latest_boundary_cursor: None,
            last_turn_id: None,
            seed_path: None,
            seed_fallback_reason: None,
            paths: None,
            approval_id: None,
            resolution: None,
            current_requirement_id: None,
            choice_id: None,
            user_input_id: None,
            settlement: None,
            admission_id: None,
            admission_resolution: None,
            stream: None,
            after: None,
            next_available: None,
            requested_stream: None,
            cursor_stream: None,
            projection: None,
            path: None,
            key_path: None,
            index: None,
            axes: None,
            retry_after_ms: None,
            failure_kind: None,
        }
    }
}

/// The `error` member of an error response.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ErrorObject {
    /// Registry code. Typed as a plain integer on the wire; the value domain is
    /// the registry below.
    pub code: i64,
    /// Human-readable message. Never a branch point.
    pub message: String,
    /// Structured detail; carries `kind` when present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Box<ErrorData>>,
}
