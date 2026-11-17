// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `capabilities.skillProvider` in `initialize` params, and the host's echo
/// of the effective value in the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillProviderCapability {
    /// The wire version; only `1` is defined.
    pub version: u32,
}
