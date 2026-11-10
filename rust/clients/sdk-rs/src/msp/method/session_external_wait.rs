// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `session/declareExternalWait` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDeclareExternalWaitParams {
    /// The loaded session the declaration is for.
    pub session_id: String,
    /// The host's label for what the session waits on, shown in the
    /// session view while the declaration is live. Omitted when the
    /// host has no label to show.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `session/declareExternalWait` result: the declaration is live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionDeclareExternalWaitResult {
    /// Always `true` on a successful declare: a declaration is live.
    pub declared: bool,
    /// The live declaration's reason, as declared (truncated by the
    /// host runtime). Omitted when the host declared without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// `session/clearExternalWait` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionClearExternalWaitParams {
    /// The loaded session the declaration is cleared for.
    pub session_id: String,
}

/// `session/clearExternalWait` result: no declaration is live.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionClearExternalWaitResult {
    /// Always `false` on a successful clear: no declaration is live.
    pub declared: bool,
}

/// The live host-declared external wait as served on a `Session` object
/// (`Session.externalWait`): present exactly while a declaration is
/// live for the loaded session, absent otherwise. Absence is never
/// fabricated — an unloaded row carries no member.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ExternalWaitView {
    /// The host's label for what the session waits on. Omitted when
    /// the host declared without one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}
