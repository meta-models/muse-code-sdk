// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::turn::CommandStatus;
use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// `skill/list` params. Per-session because skill scope follows the session's
/// workspace and plugin state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillListParams {
    /// The target session.
    pub session_id: String,
}

/// `skill/list` result: one row per typed-invocable shortcut spelling — exactly
/// the invocations the first-party typed dispatch accepts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SkillListResult {
    /// The session's user-invocable skill rows.
    pub skills: Vec<SkillCatalogEntry>,
}

/// One typed-invocable shortcut spelling. A plugin skill may contribute two
/// rows: its bare-name winner and its qualified `<pluginId>:<skillId>` form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SkillCatalogEntry {
    /// The shortcut token without the leading slash — bare (`fix-bug`) or
    /// plugin-qualified (`acme:deploy`) — the exact value a `skill` input
    /// part submits. Unique within one response.
    pub selector: String,
    /// The skill display name the first-party palette shows.
    pub display_name: String,
    /// The skill's declared human-readable name, for clients to show where
    /// people read the skill's name; absent when the skill declares none. The
    /// palette keeps showing `displayName`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The skill's palette summary.
    pub description: String,
    /// Present when the skill declares an argument hint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
    /// Where the skill comes from.
    pub source: SkillSource,
    /// The owning plugin's identifier; present when `source` is `plugin`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
}

/// A skill row's source scope: the projection of the skills crate's
/// `SkillsSourceScope`. Open: a future scope value is additive.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SkillSource {
    /// Shipped with the binary.
    Bundled,
    /// The user's personal skill directories.
    User,
    /// The session workspace's project skills.
    Project,
    /// Contributed by an installed plugin (`pluginId` names it).
    Plugin,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// A `skill` input part's picked-copy source: the catalog-row `source` enum
/// values, sent by the TUI on every skill submit so the host resolves the exact
/// `(selector, source)` row. **Closed**: a client-selected write vocabulary —
/// an unknown value is `invalidParams`, never a fall-through to the bare row.
/// Contrast the open read-side [`SkillSource`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillInvocationSource {
    /// Shipped with the binary.
    Bundled,
    /// The user's personal skill directories.
    User,
    /// The session workspace's project skills.
    Project,
    /// Contributed by an installed plugin.
    Plugin,
}

/// `skill/changed` params: the session's user-invocable set changed; clients
/// re-issue `skill/list`. Advisory — the host may coalesce bursts and
/// guarantees no ordering relative to view events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SkillChangedParams {
    /// The session whose set changed.
    pub session_id: String,
}

/// `skill/setActivation` activation target. **Closed**: a client-selected write
/// vocabulary — a write must fail a scope the host does not implement rather
/// than record activation against an unknown target. Contrast the open
/// read-side [`SkillSource`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillActivationScope {
    /// The user's personal skill directories.
    User,
    /// The session workspace's project skills.
    Project,
    /// Shipped with the binary.
    Bundled,
    /// Contributed by an installed plugin.
    Plugin,
}

/// The three-state skill activation. **Closed**: a client-selected write
/// vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillActivationState {
    /// Fully active: user-invoked and model-invoked.
    On,
    /// User-invoked only; the model cannot invoke it.
    UserInvocableOnly,
    /// Inactive everywhere.
    Off,
}

/// `skill/setActivation` params: turn one skill on or off in any scope through
/// the single `SkillsService::set_activation` seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSetActivationParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7).
    pub command_id: String,
    /// Names one skill: a bare or plugin-qualified token from the session's
    /// full catalog, the row vocabulary.
    pub selector: String,
    /// The activation target.
    pub scope: SkillActivationScope,
    /// The activation to apply.
    pub activation: SkillActivationState,
}

/// `skill/setActivation` result: the ack envelope plus the applied state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SkillSetActivationResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// Echoes the applied write's selector.
    pub selector: String,
    /// Echoes the applied write's scope.
    pub scope: SkillActivationScope,
    /// The applied activation.
    pub activation: SkillActivationState,
    /// The activation value in force for that `(selector, scope)`
    /// immediately before the write: the same value a full-catalog
    /// `skill/list` row would have carried in `activation` for it.
    pub previous: SkillActivationState,
}

/// `skill/import` foreign ecosystem. **Closed**: a client-selected write
/// vocabulary — a write must fail an ecosystem the host does not implement
/// rather than import from an unknown dir. The host resolves its own foreign
/// dir (the `foreign_skills_sources` derivation); no client paths cross the
/// wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkillImportSource {
    /// `~/.claude/skills`.
    Claude,
    /// `$CODEX_HOME/skills` (else `~/.codex/skills`).
    Codex,
}

/// `skill/import` params: import foreign skills through the single
/// `SkillsService::import_skills` seam.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillImportParams {
    /// The target session.
    pub session_id: String,
    /// The idempotency handle (UUIDv7) — required even for `dryRun` previews.
    pub command_id: String,
    /// The foreign ecosystem to import from.
    pub source: SkillImportSource,
    /// Preview for the consent UI; writes nothing. Additive-optional,
    /// default false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dry_run: bool,
    /// Re-import over already-imported ids (the CLI `--force` twin).
    /// Additive-optional, default false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub force: bool,
}

/// One quarantined import candidate: kept, not loaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SkillImportQuarantine {
    /// The candidate's id.
    pub id: String,
    /// The quarantine reasons.
    pub reasons: Vec<String>,
}

/// One import candidate that could neither install nor quarantine: recorded so
/// the run continues past it. `id` is null when the candidate never yielded one
/// — present-but-null, never omitted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SkillImportFailure {
    /// The candidate's id, or null when it never yielded one.
    pub id: Option<String>,
    /// Why the candidate failed.
    pub reason: String,
}

/// The four receipt-list lengths: a client renders counts without walking
/// lists.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SkillImportCounts {
    /// `installed.len()`.
    pub installed: u64,
    /// `quarantined.len()`.
    pub quarantined: u64,
    /// `skipped.len()`.
    pub skipped: u64,
    /// `failed.len()`.
    pub failed: u64,
}

/// `skill/import` result: the ack envelope plus the service receipt projection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SkillImportResult {
    /// Echoes the client's id.
    pub command_id: String,
    /// Admission status.
    pub status: CommandStatus,
    /// Echoes the call's ecosystem.
    pub source: SkillImportSource,
    /// Echoes the call's preview flag.
    pub dry_run: bool,
    /// The ids the run installed, in pipeline order.
    pub installed: Vec<String>,
    /// Kept, not loaded, with reasons.
    pub quarantined: Vec<SkillImportQuarantine>,
    /// Ids the run did not install: already-imported ids and in-run
    /// duplicates, verbatim from the seam's `skipped` vec.
    pub skipped: Vec<String>,
    /// Candidates that could neither install nor quarantine. Import never
    /// aborts the whole run on one bad candidate.
    pub failed: Vec<SkillImportFailure>,
    /// The four list lengths.
    pub counts: SkillImportCounts,
}
