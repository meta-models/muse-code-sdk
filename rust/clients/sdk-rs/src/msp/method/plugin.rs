// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::turn::CommandStatus;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `plugin/list` params. Per-session params; rows are the installed plugin
/// records.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListParams {
    /// The target session.
    pub session_id: String,
}

/// `plugin/list` result: one row per installed plugin record; the spec promises
/// the set, not an order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PluginListResult {
    /// The installed plugin rows.
    pub plugins: Vec<PluginCatalogEntry>,
}

/// One installed plugin record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PluginCatalogEntry {
    /// The installed plugin's identifier.
    pub id: String,
    /// The installed version.
    pub version: String,
    /// The record's own install switch; non-enabled rows are included
    /// as `false`, never dropped.
    pub enabled: bool,
    /// The installed record's source provenance.
    pub source: PluginSource,
}

/// A plugin row's source provenance: camelCase of `PluginSourceProvenance`.
/// Open: a future provenance is additive.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum PluginSource {
    /// A curated (built-in official) marketplace install.
    Curated,
    /// A user-added marketplace install.
    MarketplaceUserAdded,
    /// An imported foreign-manifest plugin.
    ForeignImport,
    /// A native local (ad-hoc manifest) plugin.
    NativeLocal,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// `plugin/install` params. Per-session params plus a client-generated
/// `commandId` (UUIDv7) with the uniform idempotency contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallParams {
    /// The target session; its workspace resolves project scope.
    pub session_id: String,
    /// The client-generated idempotency key (UUIDv7).
    pub command_id: String,
    /// Exactly one install target arm.
    pub target: PluginInstallTarget,
}

/// The one structured install target: a flat object with two optional arms,
/// exactly one present — the `TurnInputPart` convention, since the v1 schema
/// model names no object-variant union. Both arms or neither is `-32602
/// invalidParams`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallTarget {
    /// The marketplace arm: install a named plugin from a store.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<PluginInstallMarketplaceTarget>,
    /// The local-path arm: install from a host folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<PluginInstallLocalPathTarget>,
}

/// The `plugin/install` marketplace arm.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallMarketplaceTarget {
    /// The configured marketplace name.
    pub marketplace: String,
    /// The plugin name within the store.
    pub name: String,
}

/// The `plugin/install` local-path arm.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallLocalPathTarget {
    /// The host folder to install from; absolute recommended, relative
    /// resolves against the host working directory.
    pub path: String,
    /// The install lane; omitted means `default`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<PluginInstallScope>,
}

/// The `plugin/install` local-path scope. Closed: an unknown scope is `-32602
/// invalidParams`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginInstallScope {
    /// The default lane (omitted `scope`).
    Default,
    /// The explicit-user lane.
    User,
    /// The explicit-project lane, resolved against the session's
    /// workspace (degrades to the default lane with no workspace root).
    Project,
}

/// `plugin/install` result: the ack envelope plus the installed receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PluginInstallResult {
    /// The echoed idempotency key.
    pub command_id: String,
    /// The ack status.
    pub status: CommandStatus,
    /// The installed record's identifier.
    pub id: String,
    /// The installed record's version.
    pub version: String,
    /// The installed record's own switch.
    pub enabled: bool,
    /// The installed-list provenance vocabulary.
    pub source: PluginSource,
    /// The installer's advisory text when the install succeeded with a
    /// caveat; absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// `plugin/marketplaceAdd` params. Per-session params plus a client-generated
/// `commandId` (UUIDv7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceAddParams {
    /// The target session.
    pub session_id: String,
    /// The client-generated idempotency key (UUIDv7).
    pub command_id: String,
    /// The marketplace name to configure.
    pub name: String,
    /// The app's source vocabulary: `owner/repo`, a git URL, a `file://`
    /// URL, or a local path.
    pub source: String,
}

/// The stored marketplace record both add and update answer: the ack envelope
/// plus the record.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PluginMarketplaceRecordResult {
    /// The echoed idempotency key.
    pub command_id: String,
    /// The ack status.
    pub status: CommandStatus,
    /// The configured marketplace name.
    pub name: String,
    /// The normalized stored source.
    pub source: PluginMarketplaceSourceShape,
    /// The plugins the store now offers.
    pub plugin_count: u64,
    /// Entries the store could not offer, with the reason each was
    /// skipped; empty when nothing was skipped.
    pub skipped: Vec<PluginMarketplaceSkippedEntry>,
}

/// The normalized stored marketplace source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PluginMarketplaceSourceShape {
    /// The stored source kind.
    pub kind: String,
    /// The stored source path.
    pub path: String,
}

/// One skipped marketplace entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PluginMarketplaceSkippedEntry {
    /// The skipped plugin.
    pub plugin: String,
    /// Why it was skipped.
    pub reason: String,
}

/// `plugin/marketplaceUpdate` params. Per-session params plus a
/// client-generated `commandId` (UUIDv7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceUpdateParams {
    /// The target session.
    pub session_id: String,
    /// The client-generated idempotency key (UUIDv7).
    pub command_id: String,
    /// The marketplace name to refresh.
    pub name: String,
}

/// `plugin/marketplaceRemove` params. Per-session params plus a
/// client-generated `commandId` (UUIDv7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMarketplaceRemoveParams {
    /// The target session.
    pub session_id: String,
    /// The client-generated idempotency key (UUIDv7).
    pub command_id: String,
    /// The marketplace name to remove.
    pub name: String,
}

/// `plugin/marketplaceRemove` result: the ack envelope plus the removed name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PluginMarketplaceRemoveResult {
    /// The echoed idempotency key.
    pub command_id: String,
    /// The ack status.
    pub status: CommandStatus,
    /// The removed marketplace name.
    pub name: String,
}

/// What happened to a marketplace. Closed: an unknown change is a contract
/// violation, never tolerated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginMarketplaceChange {
    /// The marketplace was added.
    Added,
    /// The marketplace was updated.
    Updated,
    /// The marketplace was removed.
    Removed,
}

/// `plugin/changed` params: an install landed; clients re-issue `plugin/list`
/// (plus `hook/list` and `skill/list`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PluginChangedParams {
    /// The acting session.
    pub session_id: String,
    /// The installed record's identifier.
    pub id: String,
    /// The installed record's version.
    pub version: String,
    /// The installed record's own switch.
    pub enabled: bool,
    /// The installed-list provenance vocabulary.
    pub source: PluginSource,
}

/// `plugin/marketplaceChanged` params: a marketplace was added, updated, or
/// removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PluginMarketplaceChangedParams {
    /// The acting session.
    pub session_id: String,
    /// What happened.
    pub change: PluginMarketplaceChange,
    /// The marketplace name.
    pub name: String,
    /// The stored record's plugin count; omitted on `removed`, never
    /// fabricated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_count: Option<u64>,
    /// The stored record's skipped count; omitted on `removed`, never
    /// fabricated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped_count: Option<u64>,
}
