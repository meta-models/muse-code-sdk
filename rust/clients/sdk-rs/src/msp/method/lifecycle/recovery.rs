// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// A requested construction choice; omission is distinct from explicit OFF.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryMode {
    On,
    Off,
}

impl<'de> Deserialize<'de> for RecoveryMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let word = String::deserialize(deserializer)?;
        match word.as_str() {
            "on" => Ok(Self::On),
            "off" => Ok(Self::Off),
            _ => Err(serde::de::Error::unknown_variant(&word, &["on", "off"])),
        }
    }
}

/// A proven mode or unknown; future strings cannot establish OFF.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum RecoveryObservedMode {
    On,
    Off,
    Unknown,
    #[serde(untagged)]
    Unrecognized(String),
}

impl<'de> Deserialize<'de> for RecoveryObservedMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "on" => Self::On,
            "off" => Self::Off,
            "unknown" => Self::Unknown,
            _ => Self::Unrecognized(word),
        })
    }
}

/// Proven effective-choice provenance, independently of input presence.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum RecoveryEffectiveSource {
    Request,
    Retained,
    LegacyOmission,
    HostPolicy,
    Unknown,
    #[serde(untagged)]
    Unrecognized(String),
}

impl<'de> Deserialize<'de> for RecoveryEffectiveSource {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "request" => Self::Request,
            "retained" => Self::Retained,
            "legacyOmission" => Self::LegacyOmission,
            "hostPolicy" => Self::HostPolicy,
            "unknown" => Self::Unknown,
            _ => Self::Unrecognized(word),
        })
    }
}

/// This construction's assessment, never an operation acceptance receipt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum RecoveryQualification {
    Qualified,
    Unavailable,
    NotRequired,
    Unknown,
    #[serde(untagged)]
    Unrecognized(String),
}

impl<'de> Deserialize<'de> for RecoveryQualification {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "qualified" => Self::Qualified,
            "unavailable" => Self::Unavailable,
            "notRequired" => Self::NotRequired,
            "unknown" => Self::Unknown,
            _ => Self::Unrecognized(word),
        })
    }
}

/// One coherent producer snapshot; all members are required and non-null.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct RecoveryObservation {
    pub session_id: String,
    pub construction_id: String,
    pub requested_mode: RecoveryObservedMode,
    pub effective_mode: RecoveryObservedMode,
    pub effective_source: RecoveryEffectiveSource,
    pub qualification: RecoveryQualification,
}
