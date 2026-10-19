// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::turn::CommandStatus;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `recap/request` params: the session plus the client-minted UUIDv7 retry id.
/// No other param; unknown fields are `invalidParams`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecapRequestParams {
    /// The session to recap (required).
    pub session_id: String,
    /// The client-minted retry id.
    pub command_id: String,
}

/// `recap/request` result: admission only — the ack is never the recap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RecapRequestResult {
    /// The request's id, echoed.
    pub command_id: String,
    /// Always `accepted` on this path.
    pub status: CommandStatus,
}

/// `recap/cancel` params: the session plus the cancel's own retry id. No target
/// — one in-flight slot per session makes the target unambiguous.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecapCancelParams {
    /// The session whose in-flight recap to cancel (required).
    pub session_id: String,
    /// The cancel's own retry id.
    pub command_id: String,
}

/// `recap/cancel` result: admission only. In flight → the recap settles
/// `cancelled`; idle → accepted no-op.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RecapCancelResult {
    /// The cancel's id, echoed.
    pub command_id: String,
    /// Always `accepted` on this path.
    pub status: CommandStatus,
}

/// `recap/completed` outcome: the terminal vocabulary, camelCase per the
/// protocol spec. **Open**: a server-produced result vocabulary.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RecapOutcome {
    /// The recap text is delivered in `text`.
    Completed,
    /// The side-call failed; `reason` says why.
    Failed,
    /// `recap/cancel` won the race.
    Cancelled,
    /// The host-enforced 45s bound fired.
    TimedOut,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `recap/completed` failure reason: post-ack failures fold to the single
/// initial value. **Open**: later splits stay additive.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum RecapFailureReason {
    /// Provider errors, tool requests, setup-fence and projection
    /// refusals, missing models — the TUI's single failure rendering.
    ProviderFailed,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `recap/completed` params: the settlement, delivered to the requesting
/// connection outside the view stream — no `viewCursor`, no `sourceRange`.
/// `text` is required on `completed`; `reason` is required on `failed`; neither
/// rides `cancelled`/`timedOut`. The struct marks the conditional members
/// optional; the SS prose pins the per-outcome rule, the `turn/completed`
/// usage/error convention.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RecapCompletedParams {
    /// The recapped session.
    pub session_id: String,
    /// The request's id — the correlation key.
    pub command_id: String,
    /// How the request settled.
    pub outcome: RecapOutcome,
    /// The recap text verbatim (on `completed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// The model-produced short title (on `completed`, when produced).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Why the side-call failed (on `failed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<RecapFailureReason>,
}
