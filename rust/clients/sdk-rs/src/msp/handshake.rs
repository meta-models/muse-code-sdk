// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::capability::CapabilityName;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// Client identification inside `initialize` params. Diagnostics and telemetry
/// attribution only; never an authority claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    /// Machine identifier, `[a-z0-9_]+`.
    pub name: String,
    /// Client version string.
    pub version: String,
    /// Human display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

/// The client's requested capability posture. Every member defaults; an absent
/// `capabilities` object means all defaults.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    /// Opt into experimental methods, fields, and variants (default `false`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experimental_api: Option<bool>,
    /// Exact notification method names the client declines; no wildcards;
    /// unknown names accepted and ignored; the protected set cannot be opted
    /// out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opt_out_notification_methods: Option<Vec<String>>,
    /// Names from the capability registry. Unknown entries are not an error
    /// and simply do not appear in `grantedCapabilities` — which is why this
    /// is a list of free strings rather than of registry names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_capabilities: Option<Vec<String>>,
    /// Whether this client can render a `userInput/request` dialog and answer
    /// it. **Absent means capable**: a client that predates the member keeps
    /// today's contract, so no existing client changes its handshake. `false`
    /// makes the host withhold `userInput/request` toward this client — the
    /// additive-optional-field + withheld-method convention.
    ///
    /// Deliberately NOT a `requestedCapabilities` name: that registry records
    /// operations a host GRANTS, and whether a client can draw a dialog is a
    /// fact about the client, never a privilege the host hands out.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_input_dialogs: Option<bool>,
}

/// `initialize` request params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    /// Client identification.
    pub client_info: ClientInfo,
    /// Capability posture; absent means all defaults.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ClientCapabilities>,
}

/// Server identification inside [`InitializeResult`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ServerInfo {
    /// Server name.
    pub name: String,
    /// Server version string.
    pub version: String,
}

/// The `schema` pair in [`InitializeResult`]. `version` is the wire
/// **envelope** schema version — distinct from the session-view
/// `schemaVersion`, the raw-log `schema_version`, and the 0.x/1.0 stability
/// posture, which is not on the wire at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SchemaInfo {
    /// Envelope schema version; `1` in v1, expected to stay `1` for a long
    /// time.
    pub version: u32,
    /// `sha256:<64 lower hex>` content hash of this server binary's
    /// stable-surface bundle. A mismatch is a warning condition, not an error.
    pub fingerprint: String,
}

/// The server runtime's platform family; may differ from the client's. Closed:
/// the protocol fixes the value set, so widening it is a deliberate,
/// gate-visible protocol change rather than a silent addition (a later
/// `Closed`→`Open` flip is itself additive).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformFamily {
    /// Unix-family runtime (macOS, Linux).
    Unix,
    /// Windows runtime.
    Windows,
}

/// The server's operating system. Closed, for the same reason as
/// [`PlatformFamily`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformOs {
    /// macOS.
    Macos,
    /// Linux.
    Linux,
    /// Windows.
    Windows,
}

/// Whether this host writes its sessions to disk. A property of the host
/// process, fixed at construction and identical for every session and every
/// connection it serves — never requested, granted, or negotiated, which is why
/// it is not a capability. Open: the unrepresented degraded state has candidate
/// resolutions that add a third value here, so closed would make that a
/// breaking change.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionDurability {
    /// Sessions are written to `session.jsonl` and can be resumed, read, and
    /// forked across processes.
    Durable,
    /// Nothing reaches the filesystem; the session lives only in this host's
    /// memory, and `session/resume`, `session/fork`, and `session/read` are
    /// withheld with `methodNotFound`.
    Ephemeral,
    /// A value introduced by a newer host. Preserved so an older client can
    /// conservatively assume no durability guarantee without failing the
    /// handshake. Not a v1 server-emission value, so it is excluded from the
    /// generated known-value schema while the enum remains declared open.
    Unknown(String),
}

impl SessionDurability {
    /// The exact wire spelling, including a future value an older client does
    /// not understand.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Durable => "durable",
            Self::Ephemeral => "ephemeral",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for SessionDurability {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SessionDurability {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "durable" => Self::Durable,
            "ephemeral" => Self::Ephemeral,
            _ => Self::Unknown(value),
        })
    }
}

/// Whether this host can enforce the sandbox. A property of the host process,
/// probed once at construction and identical for every session and every
/// connection it serves — never requested, granted, or negotiated, which is why
/// it is not a capability. Open: a future enforcement posture arrives as a new
/// value, read by older clients as unknown.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SandboxAvailability {
    /// Enforcement is possible on this host.
    Available,
    /// Enforcement is truly impossible (user-namespace denial, no usable
    /// backend including embedded) — never mere missing-PATH bwrap. The
    /// cause rides [`SandboxUnavailableReason`], when the host sends one.
    Unavailable,
    /// A value introduced by a newer host. Preserved so an older client can
    /// fall back to its own probe without failing the handshake. Not a v1
    /// server-emission value, so it is excluded from the generated
    /// known-value schema while the enum remains declared open.
    Unknown(String),
}

impl SandboxAvailability {
    /// The exact wire spelling, including a future value an older client does
    /// not understand.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Available => "available",
            Self::Unavailable => "unavailable",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for SandboxAvailability {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SandboxAvailability {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "available" => Self::Available,
            "unavailable" => Self::Unavailable,
            _ => Self::Unknown(value),
        })
    }
}

/// Why sandbox enforcement is impossible on this host. Sent only when
/// [`SandboxAvailability`] is `unavailable`; a client MUST NOT infer a
/// reason when none is sent. Open: a future reason arrives as a new
/// value, read by older clients as unknown.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SandboxUnavailableReason {
    /// Bubblewrap exists but cannot create user namespaces.
    UserNamespacesDenied,
    /// No capability-valid system bwrap on PATH and no usable embedded
    /// fallback.
    BubblewrapUnavailable,
    /// A value introduced by a newer host, preserved for the same reason
    /// as [`SandboxAvailability::Unknown`].
    Unknown(String),
}

impl SandboxUnavailableReason {
    /// The exact wire spelling, including a future value an older client does
    /// not understand.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::UserNamespacesDenied => "userNamespacesDenied",
            Self::BubblewrapUnavailable => "bubblewrapUnavailable",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for SandboxUnavailableReason {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SandboxUnavailableReason {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "userNamespacesDenied" => Self::UserNamespacesDenied,
            "bubblewrapUnavailable" => Self::BubblewrapUnavailable,
            _ => Self::Unknown(value),
        })
    }
}

/// The `initialize` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct InitializeResult {
    /// Server identification.
    pub server_info: ServerInfo,
    /// Exact user-agent string presented to upstream model providers.
    pub user_agent: String,
    /// Absolute path of the muse home directory.
    pub muse_home: String,
    /// Server runtime platform family.
    pub platform_family: PlatformFamily,
    /// Server operating system.
    pub platform_os: PlatformOs,
    /// Envelope schema version and stable-surface fingerprint.
    pub schema: SchemaInfo,
    /// Subset of the requested capabilities, plus policy-implicit grants. Fixed
    /// for the connection lifetime.
    pub granted_capabilities: Vec<CapabilityName>,
    /// Echo of the effective negotiated experimental setting.
    pub experimental_api: bool,
    /// Whether this host persists its sessions. Optional so adding it stays
    /// backward compatible; a v1 host always sends it, and a client reads
    /// absent as `durable` because no server that omits it has the ephemeral
    /// profile.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_durability: Option<SessionDurability>,
    /// Whether this host can enforce the sandbox. Optional so adding it stays
    /// backward compatible; a v1 host always sends it, and a client reads
    /// absent as unknown — the host predates the field, so the client falls
    /// back to its own probe rather than inventing an answer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_availability: Option<SandboxAvailability>,
    /// Why enforcement is impossible. Sent only when `sandbox_availability`
    /// is `unavailable`; a client MUST NOT infer a reason when none is
    /// sent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox_unavailable_reason: Option<SandboxUnavailableReason>,
    /// The host's posture ceiling as a five-axis limits object: what a
    /// connection may choose. **Experimental, same-user socket only**; absent
    /// means the host has no limits regime, so there is nothing to narrow and
    /// no read method to serve. Absent is never fabricated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_limits: Option<crate::msp::method::limits::SessionLimits>,
}
