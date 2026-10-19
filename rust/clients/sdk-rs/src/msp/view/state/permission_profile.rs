// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// A profile's selected reviewer authority. **Open**: the reviewer vocabulary
/// can widen.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ReviewerAuthority {
    /// An automated reviewer decides (the `:auto-review` authority).
    AutoReview,
    /// A human reviewer decides (`ReviewerAuthorityV1::Human` — wire `"human"`).
    Human,
    /// No reviewer authority is configured (`ReviewerAuthorityV1::None`, e.g.
    /// `:unrestricted`) — the native catalog lists such a profile.
    None,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// A committed profile's effective four axis values: the resolved filesystem,
/// network, approval, and reviewer the YOLO predicate reads. The reviewer
/// member reuses `ReviewerAuthority`, so its spelling never drifts from the
/// served `reviewerAuthority`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct PermissionAxes {
    /// The resolved filesystem mode in the picker's wording.
    pub filesystem: PermissionFilesystemAxis,
    /// The resolved local-command network mode in the picker's wording.
    pub network: PermissionNetworkAxis,
    /// The resolved approval authority.
    pub approval: PermissionApprovalAxis,
    /// The resolved reviewer authority.
    pub reviewer: ReviewerAuthority,
}

/// A profile's effective filesystem axis. **Open**: the vocabulary can widen.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum PermissionFilesystemAxis {
    /// Sandboxed execution (`FilesystemModeV1::Managed`).
    Sandboxed,
    /// No filesystem sandbox (`FilesystemModeV1::Unrestricted`).
    Unrestricted,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// A profile's effective local-command network axis. **Open**: the vocabulary
/// can widen.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum PermissionNetworkAxis {
    /// Fully restricted network (`LocalCommandNetworkModeV1::Restricted`).
    Restricted,
    /// Proxy-only network; direct local-command network is off
    /// (`LocalCommandNetworkModeV1::ProxyOnly` — wire `"off"`).
    ProxyOnly,
    /// Direct local-command network access
    /// (`LocalCommandNetworkModeV1::Enabled`).
    Enabled,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

/// A profile's effective approval axis. **Open**: the vocabulary can widen.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum PermissionApprovalAxis {
    /// Tools run sandboxed; prompt only on explicit permission requests
    /// (`ApprovalAuthorityV1::OnRequest`).
    OnRequest,
    /// Prompt for anything no rule matches (`ApprovalAuthorityV1::PromptUnmatched`).
    PromptUnmatched,
    /// No prompts; everything runs (`ApprovalAuthorityV1::AllowAll`).
    AllowAll,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}
