// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

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
