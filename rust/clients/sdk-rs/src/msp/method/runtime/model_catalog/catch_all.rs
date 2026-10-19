// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::ModelCatalogSource;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl ModelCatalogSource {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::ProviderCatalog => "providerCatalog",
            Self::FakeCatalog => "fakeCatalog",
            Self::UnresolvedCatalog => "unresolvedCatalog",
            Self::BundledCatalog => "bundledCatalog",
            Self::ConfigCatalog => "configCatalog",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ModelCatalogSource {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ModelCatalogSource {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "providerCatalog" => Self::ProviderCatalog,
            "fakeCatalog" => Self::FakeCatalog,
            "unresolvedCatalog" => Self::UnresolvedCatalog,
            "bundledCatalog" => Self::BundledCatalog,
            "configCatalog" => Self::ConfigCatalog,
            _ => Self::Unknown(word),
        })
    }
}
