// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::approval::ApprovalAmendmentDurability;
use super::approval::ApprovalChoiceScope;
use super::approval::ApprovalDecision;
use super::approval::ApprovalPersistenceStatus;
use super::approval::ApprovalPolicyResult;
use super::approval::ApprovalResolvedBy;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

impl ApprovalDecision {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Approved => "approved",
            Self::ApprovedForSession => "approvedForSession",
            Self::ApprovedPolicyAmendment => "approvedPolicyAmendment",
            Self::Denied => "denied",
            Self::DeniedPolicyAmendment => "deniedPolicyAmendment",
            Self::TimedOut => "timedOut",
            Self::Abort => "abort",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ApprovalDecision {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ApprovalDecision {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "approved" => Self::Approved,
            "approvedForSession" => Self::ApprovedForSession,
            "approvedPolicyAmendment" => Self::ApprovedPolicyAmendment,
            "denied" => Self::Denied,
            "deniedPolicyAmendment" => Self::DeniedPolicyAmendment,
            "timedOut" => Self::TimedOut,
            "abort" => Self::Abort,
            _ => Self::Unknown(value),
        })
    }
}

impl ApprovalChoiceScope {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Once => "once",
            Self::Session => "session",
            Self::LocalPersistent => "localPersistent",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ApprovalChoiceScope {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ApprovalChoiceScope {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "once" => Self::Once,
            "session" => Self::Session,
            "localPersistent" => Self::LocalPersistent,
            _ => Self::Unknown(value),
        })
    }
}

impl ApprovalPersistenceStatus {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ApprovalPersistenceStatus {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ApprovalPersistenceStatus {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "succeeded" => Self::Succeeded,
            "failed" => Self::Failed,
            _ => Self::Unknown(value),
        })
    }
}

impl ApprovalPolicyResult {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Allow => "allow",
            Self::Deny => "deny",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ApprovalPolicyResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ApprovalPolicyResult {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "allow" => Self::Allow,
            "deny" => Self::Deny,
            _ => Self::Unknown(value),
        })
    }
}

impl ApprovalAmendmentDurability {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Session => "session",
            Self::LocalPersistent => "localPersistent",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ApprovalAmendmentDurability {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ApprovalAmendmentDurability {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "session" => Self::Session,
            "localPersistent" => Self::LocalPersistent,
            _ => Self::Unknown(value),
        })
    }
}

impl ApprovalResolvedBy {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::User => "user",
            Self::Policy => "policy",
            Self::LlmJudge => "llmJudge",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ApprovalResolvedBy {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ApprovalResolvedBy {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "user" => Self::User,
            "policy" => Self::Policy,
            "llmJudge" => Self::LlmJudge,
            _ => Self::Unknown(value),
        })
    }
}
