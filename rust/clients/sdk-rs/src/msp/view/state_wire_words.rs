// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::state::ApprovalModeSource;
use super::state::PermissionApprovalAxis;
use super::state::PermissionFilesystemAxis;
use super::state::PermissionNetworkAxis;
use super::state::ReviewerAuthority;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

impl ReviewerAuthority {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::AutoReview => "autoReview",
            Self::Human => "human",
            Self::None => "none",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ReviewerAuthority {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ReviewerAuthority {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "autoReview" => Self::AutoReview,
            "human" => Self::Human,
            "none" => Self::None,
            _ => Self::Unknown(value),
        })
    }
}

impl ApprovalModeSource {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Startup => "startup",
            Self::Replay => "replay",
            Self::ApprovalReconfigure => "approvalReconfigure",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ApprovalModeSource {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ApprovalModeSource {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "startup" => Self::Startup,
            "replay" => Self::Replay,
            "approvalReconfigure" => Self::ApprovalReconfigure,
            _ => Self::Unknown(value),
        })
    }
}

impl PermissionFilesystemAxis {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Sandboxed => "sandboxed",
            Self::Unrestricted => "unrestricted",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for PermissionFilesystemAxis {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PermissionFilesystemAxis {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "sandboxed" => Self::Sandboxed,
            "unrestricted" => Self::Unrestricted,
            _ => Self::Unknown(value),
        })
    }
}

impl PermissionNetworkAxis {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Restricted => "restricted",
            Self::ProxyOnly => "off",
            Self::Enabled => "enabled",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for PermissionNetworkAxis {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PermissionNetworkAxis {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "restricted" => Self::Restricted,
            "off" => Self::ProxyOnly,
            "enabled" => Self::Enabled,
            _ => Self::Unknown(value),
        })
    }
}

impl PermissionApprovalAxis {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::OnRequest => "onRequest",
            Self::PromptUnmatched => "promptUnmatched",
            Self::AllowAll => "allowAll",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for PermissionApprovalAxis {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PermissionApprovalAxis {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "onRequest" => Self::OnRequest,
            "promptUnmatched" => Self::PromptUnmatched,
            "allowAll" => Self::AllowAll,
            _ => Self::Unknown(value),
        })
    }
}
