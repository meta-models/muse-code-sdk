// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::SourceRange;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// How the served session name was set. **Open enum** (`x-msp-openness: open`):
/// v1 serves `automatic` and `custom`; a client MUST read absent — and any
/// value it does not recognize — as unknown, never fabricated. Open: a future
/// source such as conversation-generated names adds a value here, so closed
/// would make that a breaking change.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionNameOrigin {
    /// The settled name carries no rename proof (an allocate, or a rename
    /// that never proved: rejected, failed, or superseded).
    Automatic,
    /// The settled name carries rename proof (an accepted `Rename` intake
    /// whose bound task completed, or a validated legacy `source: User`
    /// chain).
    Custom,
    /// A value introduced by a newer host. Preserved so an older client
    /// reads it as unknown without failing the decode. Not a v1
    /// server-emission value, so it is excluded from the generated
    /// known-value schema while the enum remains declared open.
    Unknown(String),
}

impl SessionNameOrigin {
    /// The exact wire spelling, including a future value an older client does
    /// not understand.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Automatic => "automatic",
            Self::Custom => "custom",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for SessionNameOrigin {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SessionNameOrigin {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "automatic" => Self::Automatic,
            "custom" => Self::Custom,
            _ => Self::Unknown(value),
        })
    }
}

/// `session/nameChanged` params: the fold of ANY durable session-name record —
/// the FIRST-NAMING automatic allocate as well as an accepted `session/rename`
/// (or the same in-process runtime command). Replace-wholesale like every
/// sibling.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionNameChangedParams {
    /// The owning session.
    pub session_id: String,
    /// Opaque, strictly monotonic view cursor.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
    /// The new canonical name now in effect.
    pub name: String,
    /// How the new name was set. **Additive-optional**: omitted when the
    /// emitting fold cannot prove an origin — absent reads as unknown, never
    /// fabricated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_origin: Option<SessionNameOrigin>,
    /// The latest retained generated short title. **Additive-optional**:
    /// carried at generated-pair publication and at settlement when a pair is
    /// already published; omitted when no pair was ever published — absent
    /// reads as unpublished, never fabricated. `name` stays canonical.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generated_name: Option<String>,
}
