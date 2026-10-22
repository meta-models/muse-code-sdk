// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::SourceRange;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `session/tokenUsage` params: one per model completion that reports usage.
/// Carries the raw counters verbatim plus the server-derived counted-once
/// `promptTokens`/`totalTokens` and the session `cumulative` block.
/// Accumulate-only: `cumulative` never goes backward.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionTokenUsageParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The turn whose model call completed.
    pub turn_id: String,
    /// The effective model that produced this usage; `null` on pre-schema
    /// records — never back-filled, an unpriced leg.
    pub model_id: Option<String>,
    /// Raw counters verbatim from the durable record.
    pub usage: TokenUsage,
    /// Prompt tokens counted exactly once under the provider's cache
    /// convention. Server-derived; deterministic — the provider is in the log.
    pub prompt_tokens: u64,
    /// `promptTokens + outputTokens` — the honest per-completion total.
    pub total_tokens: u64,
    /// Provider finish reason when reported (open vocabulary, verbatim).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    /// Model-call wall time, when measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    /// Session running totals at this cursor; the fold owns the accumulation.
    /// Subagent/workflow-child usage is never folded in — it rides the owning
    /// items.
    pub cumulative: CumulativeTokenUsage,
}

/// Raw token counters, verbatim from the durable record. Not directly summable
/// across providers — sum the counted-once derivations instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TokenUsage {
    /// Provider-reported input tokens.
    pub input_tokens: u64,
    /// Provider-reported output tokens.
    pub output_tokens: u64,
    /// Provider-reported cache tokens (inside or beside `inputTokens`,
    /// provider-convention-dependent — the reason `promptTokens` exists).
    pub cached_tokens: u64,
    /// Cache write tokens, only when the provider distinguishes
    /// writes/reads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_write_tokens: Option<u64>,
    /// Cache read tokens, only when the provider distinguishes writes/reads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<u64>,
    /// Output tokens spent on reasoning, when the provider reports it.
    pub reasoning_tokens: u64,
}

/// Session running totals of counted-once usage.
///
/// The cache splits and server-computed `cost` join the counters. The counters
/// stay accumulate-only; `cost` is the documented exception — it may move
/// either way on price re-adoption and is labeled estimate. `Copy` was dropped
/// for the `cost` member.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CumulativeTokenUsage {
    /// Counted-once prompt tokens, session total.
    pub prompt_tokens: u64,
    /// Output tokens, session total.
    pub output_tokens: u64,
    /// Counted-once totals, session total.
    pub total_tokens: u64,
    /// Cache-read tokens, session total: saturating sum of the per-completion
    /// splits; an absent split contributes 0. Additive-optional: absent on the
    /// wire reads as 0 and zero totals are omitted, so pre-feature bytes decode
    /// and re-encode identically.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cache_read_tokens: u64,
    /// Cache-write tokens, session total. Additive-optional like the read
    /// split.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub cache_write_tokens: u64,
    /// Server-computed session cost: `None` (wire-absent) when no leg is priced
    /// — clients omit the row. Additive-optional: absent reads as unpriced.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost: Option<CumulativeCost>,
}

fn is_zero(value: &u64) -> bool {
    *value == 0
}

/// Server-computed session cost member of [`CumulativeTokenUsage`].
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CumulativeCost {
    /// Estimated USD total, finite and non-negative.
    pub usd: f64,
    /// True when at least one leg lacked price data — clients render
    /// `(partial)`.
    pub partial: bool,
}

/// `session/contextUsage` params: context-window pressure — the counted-once
/// occupancy at the latest provider-reported durable fact, joined with the
/// host's pressure basis. Replace wholesale; emitted only when the
/// `(windowTokens, usedTokens, pressure)` triple changes value (identical
/// adoptions emit nothing).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionContextUsageParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The effective context-window size from the host's pressure basis; absent
    /// when the basis has no limit — the limit part is omitted, never invented.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_tokens: Option<u64>,
    /// Counted-once prompt tokens plus output tokens of the driving record,
    /// saturating — the honest occupancy floor.
    pub used_tokens: u64,
    /// Server-computed pressure level over the basis thresholds.
    pub pressure: ContextPressureLevel,
}

/// Context pressure level: hard threshold first, both inclusive `>=`. Open.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ContextPressureLevel {
    /// No threshold reached.
    Normal,
    /// At or above the soft threshold.
    Warning,
    /// At or above the hard threshold.
    Blocked,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// The snapshot `contextUsage` block: the latest `(windowTokens, usedTokens,
/// pressure)` triple; the snapshot member is `null` until the fold's generation
/// chain holds a tracked anchor AND the current basis is present (absent is
/// never fabricated).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ContextUsage {
    /// The effective context-window size; absent when the basis has no limit.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub window_tokens: Option<u64>,
    /// Counted-once occupancy at the latest provider-reported fact.
    pub used_tokens: u64,
    /// Server-computed pressure level.
    pub pressure: ContextPressureLevel,
}
