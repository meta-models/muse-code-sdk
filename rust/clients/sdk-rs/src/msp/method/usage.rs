// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// The current usage window (the provider's 5-hour-class block): verbatim
/// provider percentages with the reset stamp normalized to epoch milliseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SubscriptionUsageWindow {
    /// Percent of the window's budget used: an integer ≥ 0, verbatim from
    /// the provider — over-quota values above 100 are valid.
    pub used_percent: i64,
    /// The window's length in minutes (> 0).
    pub window_duration_mins: i64,
    /// When the window resets, epoch milliseconds.
    pub resets_at_ms: i64,
}

/// The rolling weekly block: same semantics as [`SubscriptionUsageWindow`]
/// without a duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SubscriptionUsageWeekly {
    /// Percent of the weekly budget used (integer ≥ 0, may exceed 100).
    pub used_percent: i64,
    /// When the weekly window resets, epoch milliseconds.
    pub resets_at_ms: i64,
}

/// The one usage payload shape: the `usage/read` result's `usage` member and
/// the `usage/changed` params. The numbers are point-in-time — `observedAtMs`
/// is the host's arrival stamp, so a client renders "as of", never implies live
/// data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SubscriptionUsage {
    /// The current window.
    pub window: SubscriptionUsageWindow,
    /// The rolling weekly block.
    pub weekly: SubscriptionUsageWeekly,
    /// The provider's subscription tier id, verbatim.
    pub tier: String,
    /// When the host RECEIVED this observation (frame arrival or mint
    /// request-send), epoch milliseconds.
    pub observed_at_ms: i64,
}

/// `usage/read` result: `{usage?}` — omitted, never `null`, when the host has
/// observed nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UsageReadResult {
    /// The last-observed subscription usage window, when one exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<SubscriptionUsage>,
}
