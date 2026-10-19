// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `model/list` params: the discovery half of the model-picker gesture. **A
/// query, not a command** — no `commandId`, no durable intake record, no view
/// event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelListParams {
    /// When present, the row matching that session's effective model is flagged
    /// `isActive`. When absent, no row is active — a client may list before it
    /// has a session.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// Where a model catalog came from. **Open**: an unrecognized value is an
/// unknown source, not an error.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::enum_variant_names)]
#[non_exhaustive]
pub enum ModelCatalogSource {
    /// A live provider catalog.
    ProviderCatalog,
    /// A test fake.
    FakeCatalog,
    /// A production host whose catalog has not been resolved yet.
    UnresolvedCatalog,
    /// The compiled-in fallback.
    BundledCatalog,
    /// A user-configured fallback.
    ConfigCatalog,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// Per-1M-token catalog cost, carried **verbatim** for display and never
/// rounded or re-formatted by the host. Cost arithmetic stays client-local view
/// math.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelCost {
    /// Input cost, a decimal string.
    pub input: String,
    /// Output cost, a decimal string.
    pub output: String,
    /// Cached-input cost, a decimal string.
    pub cached: String,
    /// Currency; nullable — today's catalogs are USD.
    pub currency: Option<String>,
}

/// The only scalar alternative to a known effort array. Kept as a closed
/// singleton so arbitrary strings and uppercase spellings fail decoding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UnknownModelReasoningEffortVariants {
    Unknown,
}

/// A complete ordered effort set, or an explicit unknown capability.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ModelReasoningEffortVariants {
    Known(Vec<crate::msp::method::turn::ReasoningEffort>),
    Unknown(UnknownModelReasoningEffortVariants),
}

/// One described reasoning-effort tier of a `model/list` row: a selectable tier
/// plus the catalog's display string for it when declared.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelDescribedReasoningEffort {
    /// The tier, in the closed vocabulary.
    pub tier: crate::msp::method::turn::ReasoningEffort,
    /// The catalog's per-tier display string; absent when the catalog
    /// declared none. Optional only for decoding; a present value is never
    /// null.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub description: Option<String>,
}

/// One visible catalog row. Catalog rows marked hidden never reach the wire, so
/// a client cannot select one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelCatalogEntry {
    /// The selectable model id.
    pub model_id: String,
    /// Presentation label.
    pub display_label: String,
    /// Provider routing.
    pub provider_id: String,
    /// Provider profile; `null` when the catalog source declared nothing.
    pub profile_id: Option<String>,
    /// Release date; `null` when the catalog source declared nothing.
    pub release_date: Option<String>,
    /// Description; `null` when the catalog source declared nothing.
    pub description: Option<String>,
    /// Context limit; `null` when the catalog source declared nothing.
    pub context_limit: Option<u64>,
    /// Output limit; `null` when the catalog source declared nothing.
    pub output_limit: Option<u64>,
    /// Cost block; `null` when the catalog source declared nothing.
    pub cost: Option<ModelCost>,
    /// Complete ordered selectable efforts. Optional only for decoding older
    /// hosts; a present value is never null. Current hosts always send it.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub variants: Option<ModelReasoningEffortVariants>,
    /// Described selectable tiers, a same-order subset of `variants`. Optional
    /// only for decoding older hosts; a present value is never null. Absent
    /// under `"unknown"`.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub reasoning_effort_variants: Option<Vec<ModelDescribedReasoningEffort>>,
    /// The row's catalog default. Optional only for decoding older hosts; a
    /// present value is never null and is always a member of `variants`. Absent
    /// under `"unknown"`.
    #[serde(
        default,
        deserialize_with = "deserialize_non_null_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub default_reasoning_effort: Option<crate::msp::method::turn::ReasoningEffort>,
    /// Marks the session's effective model when `sessionId` was supplied. May
    /// be false for every row — a client MUST NOT assume exactly one.
    pub is_active: bool,
    /// Marks the catalog's default row. May be false for every row.
    pub is_default: bool,
}

fn deserialize_non_null_optional<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// `model/list` result. A snapshot at call time: v1 has no catalog
/// subscription. `models` MAY be empty — a build shipped with no bundled models
/// is a supported configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelListResult {
    /// The catalog's provider.
    pub provider_id: String,
    /// The catalog's profile; `null` when none.
    pub profile_id: Option<String>,
    /// Where the catalog came from — how a client tells a live provider
    /// catalog from a test fake and labels it honestly.
    pub source: ModelCatalogSource,
    /// Visible rows only, newest `releaseDate` first.
    pub models: Vec<ModelCatalogEntry>,
}
