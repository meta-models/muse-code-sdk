// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `toolCall.statusProgress`: the latest `TaskProgressDetail`, field-for-field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct StatusProgress {
    /// Completed units.
    pub current: u64,
    /// Total units, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// Unit label, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unit: Option<String>,
}

/// `toolCall.statusStep`: the latest `TaskActiveStepDetail`, field-for-field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct StatusStep {
    /// The active step's label.
    pub label: String,
    /// The step index, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<u64>,
    /// The step count, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}

/// `toolCall.statusAttempt`: the latest `TaskExternalAttemptDetail`,
/// field-for-field — countdown inputs the client renders the tick from, so no
/// event spam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct StatusAttempt {
    /// The external system (durable vocabulary, verbatim).
    pub system: String,
    /// The operation (durable vocabulary, verbatim).
    pub operation: String,
    /// The attempt number.
    pub attempt: u32,
    /// The scheduled next attempt, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_attempt: Option<u32>,
    /// The maximum attempts, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<u32>,
    /// The retry delay in ms, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_delay_ms: Option<u64>,
    /// The error kind (durable vocabulary, verbatim), when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    /// The HTTP status, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_status: Option<u16>,
}

/// `toolCall.statusHealth`: the latest `TaskHealthDetail`, field-for-field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct StatusHealth {
    /// The health level (the durable `TaskHealthLevel` vocabulary verbatim).
    pub level: StatusHealthLevel,
    /// The reason, when recorded.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `toolCall.statusHealth.level`: the durable `TaskHealthLevel` vocabulary
/// verbatim. Open — runtime vocabulary may grow additively, and clients MUST
/// render unknown levels generically.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum StatusHealthLevel {
    /// Healthy.
    Ok,
    /// Waiting.
    Waiting,
    /// Degraded.
    Degraded,
    /// Retrying.
    Retrying,
    /// Blocked.
    Blocked,
    /// Failed.
    Failed,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `toolCall.statusChildren`: the latest `TaskChildSummaryDetail`,
/// field-for-field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct StatusChildren {
    /// Active children.
    pub active: u64,
    /// Completed children.
    pub completed: u64,
    /// Failed children.
    pub failed: u64,
    /// Cancelled children.
    pub cancelled: u64,
    /// Total children, when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
}
