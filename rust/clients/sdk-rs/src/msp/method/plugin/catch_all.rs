// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::PluginSource;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl PluginSource {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Curated => "curated",
            Self::MarketplaceUserAdded => "marketplaceUserAdded",
            Self::ForeignImport => "foreignImport",
            Self::NativeLocal => "nativeLocal",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for PluginSource {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for PluginSource {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "curated" => Self::Curated,
            "marketplaceUserAdded" => Self::MarketplaceUserAdded,
            "foreignImport" => Self::ForeignImport,
            "nativeLocal" => Self::NativeLocal,
            _ => Self::Unknown(word),
        })
    }
}
