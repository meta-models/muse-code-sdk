// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `scheduledFire` members, flattened into the item row.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ScheduledFireMembers {
    /// `scheduledFire`: the cron job id that fired.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// `scheduledFire`: the fire's scheduled epoch in milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheduled_fire_at_ms: Option<i64>,
    /// `scheduledFire`: the occurrence number within the job's history, present
    /// with occurrence metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_number: Option<u64>,
    /// `scheduledFire`: the next scheduled epoch in milliseconds; absent on a
    /// final delivery.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_fire_at_ms: Option<i64>,
}
