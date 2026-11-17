// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `InitializeResult.launchContext`: the two launcher variables of the serve
/// process's environment, verbatim, read once at process start; one value for
/// every connection and session the process hosts. Each member is `null` when
/// its variable is unset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct LaunchContext {
    /// `META_3PAI_INVOCATION_ID` (required, nullable).
    pub invocation_id: Option<String>,
    /// `META_3PAI_INVOCATION_CONTEXT` (required, nullable).
    pub invocation_context: Option<String>,
}
