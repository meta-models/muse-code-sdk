// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// The `session/start` `limits` choice: every member is optional — a start
/// names only the axes it chooses. Reports use `SessionLimits`, whose members
/// are always present.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLimitsChoice {
    /// Shell filesystem/network sandboxing (`--disable-sandbox` absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_enabled: Option<bool>,
    /// Sandbox network policy (`--sandbox-network` grammar).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_network: Option<LimitsNetworkMode>,
    /// Non-shell workspace filesystem writes (`--disable-write` absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub writes_enabled: Option<bool>,
    /// Workspace shell execution (`--disable-shell` absent).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell_enabled: Option<bool>,
    /// Loading the workspace's skills and rules (`--trust-workspace`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_trusted: Option<bool>,
}

/// A five-axis limits report: every `maxLimits` / `currentLimits` member is
/// this one definition, and every member is required — reporting always fills
/// all five, so readers never see an absence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionLimits {
    /// Shell filesystem/network sandboxing (`--disable-sandbox` absent).
    pub sandbox_enabled: bool,
    /// Sandbox network policy (`--sandbox-network` grammar).
    pub sandbox_network: LimitsNetworkMode,
    /// Non-shell workspace filesystem writes (`--disable-write` absent).
    pub writes_enabled: bool,
    /// Workspace shell execution (`--disable-shell` absent).
    pub shell_enabled: bool,
    /// Loading the workspace's skills and rules (`--trust-workspace`).
    pub workspace_trusted: bool,
}

impl SessionLimits {
    /// The wire name of the sandbox-enabled axis (single source: this
    /// struct's camelCase).
    pub const SANDBOX_ENABLED_AXIS: &str = "sandboxEnabled";
    /// The wire name of the sandbox-network axis (single source: this
    /// struct's camelCase).
    pub const SANDBOX_NETWORK_AXIS: &str = "sandboxNetwork";
    /// The wire name of the writes axis (single source: this struct's
    /// camelCase).
    pub const WRITES_ENABLED_AXIS: &str = "writesEnabled";
    /// The wire name of the shell axis (single source: this struct's
    /// camelCase).
    pub const SHELL_ENABLED_AXIS: &str = "shellEnabled";
    /// The wire name of the trust axis, shared by the `-32028` axes and
    /// the resume `tightenedAxes` (single source: this struct's camelCase).
    pub const WORKSPACE_TRUSTED_AXIS: &str = "workspaceTrusted";
}

/// The sandbox-network axis values. **Closed**: a client selects one of the
/// three serve spellings and can never construct another; the socket promise is
/// same-version, so the result use needs no unknown arm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LimitsNetworkMode {
    /// `restricted`: no network for sandboxed shells.
    #[serde(rename = "restricted")]
    Restricted,
    /// `enabled`: full network for sandboxed shells — also what a sandbox-OFF
    /// ceiling reports, so the plain per-axis compare needs no special case.
    #[serde(rename = "enabled")]
    Enabled,
    /// `proxy-only`: the built-in default.
    #[serde(rename = "proxy-only")]
    ProxyOnly,
}

/// One too-wide axis in a `-32028 limitsAboveMax` refusal: every too-wide axis
/// is listed, never the first only. `requested`/`max` carry the axis's own JSON
/// values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct LimitsAboveMaxAxis {
    /// The axis name (`workspaceTrusted`,...).
    pub axis: String,
    /// The requested value.
    pub requested: LimitsAxisValue,
    /// The ceiling value.
    pub max: LimitsAxisValue,
}

/// One axis value in a limits refusal: a boolean on the four boolean axes, the
/// mode string on `sandboxNetwork`. **Closed**: exactly the two shapes, never
/// another — named in the governing rules closed untagged-union list
/// (`CLOSED_WITHOUT_MARKER`), since the untagged shape carries no schema
/// marker. Untagged so the wire carries the bare JSON value; untagged also
/// keeps the shape the schema builder requires (a bare `serde_json::Value`
/// renders no type and is rejected).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum LimitsAxisValue {
    /// A boolean-axis value.
    Bool(bool),
    /// A `sandboxNetwork`-axis value.
    Mode(LimitsNetworkMode),
}
