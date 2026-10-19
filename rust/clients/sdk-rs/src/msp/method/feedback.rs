// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `feedback/submit` classification: the four TUI classes in camelCase wire
/// spelling. **Closed**: a client-selected param vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FeedbackClassification {
    /// A bug report; the note is non-empty.
    Bug,
    /// A bad model result.
    BadResult,
    /// A good model result; never attaches the session record.
    GoodResult,
    /// Anything else.
    Other,
}

/// `feedback/submit` result `outcome`: how one confirmed submit resolved,
/// mirroring the TUI `FeedbackSubmitOutcome` taxonomy. **Open**: a
/// server-produced result vocabulary — an older client reading a newer value it
/// does not know follows the open-enum tolerance rule instead of rejecting it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum FeedbackSubmitOutcome {
    /// The intake accepted and returned an upload id.
    Uploaded,
    /// A suppressed accept — recorded with no upload id.
    Recorded,
    /// Accepted, but the response receipt could not be read.
    AcceptedWithoutReceipt,
    /// Accepted, but the internal receipt Task definitely could not be
    /// created.
    TrackingFailed,
    /// Accepted and receipt-Task creation started, but its outcome is
    /// unknown.
    TrackingUncertain,
    /// The endpoint is dark — quiet, one attempt.
    Dark,
    /// The process-lifetime disable latch was already set.
    Disabled,
    /// No Model API key resolved — the upload was not attempted.
    NoCredential,
    /// The key was rejected; the latch is now set.
    AuthRejected,
    /// Rate limited, with the effective retry delay.
    RateLimited,
    /// Everything else (timeouts, transport errors, 4xx/5xx).
    Failed,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `feedback/submit` params: mirrors the TUI confirm-time `FeedbackRequest`.
/// The call itself is the explicit confirm.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackSubmitParams {
    /// The report class (required).
    pub classification: FeedbackClassification,
    /// The user report text (required; non-empty for `bug`).
    pub note: String,
    /// The files-consent decision (required).
    pub with_files: bool,
    /// Consent to attach the session record; honored only for
    /// `bug`/`badResult` with `session_id` present. `true` with
    /// `with_files: false`, with a non-`bug`/`badResult` classification,
    /// or without `session_id` is `invalidParams` (F4, F8).
    /// Defaults to `false`.
    #[serde(default)]
    pub attach_session_record: bool,
    /// Names the session this call is about when present (F8,
    /// superseding F3): the bundle lands in that session's dir. Names a
    /// session this host owns. When absent, the bundle lands in the
    /// host-level feedback folder and the `session_id` tag is omitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// An absolute same-host path to a client-packed bundle, admitted
    /// only as a regular file under a size cap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_artifacts_path: Option<String>,
}

/// `feedback/submit` result: the upload receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct FeedbackSubmitResult {
    /// How the submit resolved.
    pub outcome: FeedbackSubmitOutcome,
    /// The intake's accept id — always present on the `uploaded` arm,
    /// optional on `trackingFailed`/`trackingUncertain`; never fabricated
    /// on `recorded`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    /// The internal receipt-Task id once that Task succeeds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// The host-local absolute path of the always-written local bundle.
    pub bundle_path: String,
    /// The failure cause on the `failed`, `acceptedWithoutReceipt`,
    /// `trackingFailed`, and `trackingUncertain` arms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
    /// The effective retry delay in milliseconds, on `rateLimited`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    /// Whether the consented session record rode at all.
    pub session_record_attached: bool,
    /// Whether the consented session record rode shortened to fit.
    pub session_record_truncated: bool,
    /// The consent-vs-reality session note, kept for display.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_note: Option<String>,
    /// The consent-vs-reality local-tracing note, kept for display.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_tracing_note: Option<String>,
}
