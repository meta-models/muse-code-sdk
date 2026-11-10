// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// What a cold load does when a retained input image file is missing or
/// corrupt. Omitted means `fail`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MissingInputAssets {
    /// Refuse the resume, as before this member existed.
    Fail,
    /// Resume, put a text marker in each such image's place, and list the
    /// images in `unavailableInputAssets`.
    Report,
}

/// One retained input image a `report` load replaced with a marker. It names no
/// run: each digest is listed once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UnavailableInputAsset {
    /// The sha256 of the stored image bytes, lowercase hex.
    pub digest: String,
    /// The stored media type, e.g. `image/png`.
    pub media_type: String,
    pub byte_length: u64,
    pub width: u64,
    pub height: u64,
    pub reason: UnavailableInputAssetReason,
    /// The client's own name for the image, when its part carried one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_ref: Option<ClientRef>,
}

/// A client's own name for an image part: 1 to 256 bytes of UTF-8, returned
/// verbatim. Open, so a later optional member decodes on an older client.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientRef {
    pub name: String,
}

/// Why the image was replaced. Open: a newer host's word decodes to `Unknown`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum UnavailableInputAssetReason {
    /// No file at the asset's path.
    Missing,
    /// The file fails its length, digest or image-metadata check.
    Corrupt,
    /// A value from a newer host, kept verbatim; never construct it with a
    /// known word.
    Unknown(String),
}

impl UnavailableInputAssetReason {
    /// The exact wire spelling, including a value from a newer host.
    fn as_str(&self) -> &str {
        match self {
            Self::Missing => "missing",
            Self::Corrupt => "corrupt",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for UnavailableInputAssetReason {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for UnavailableInputAssetReason {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "missing" => Self::Missing,
            "corrupt" => Self::Corrupt,
            _ => Self::Unknown(value),
        })
    }
}
