// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::SkillSource;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl SkillSource {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Bundled => "bundled",
            Self::User => "user",
            Self::Project => "project",
            Self::Plugin => "plugin",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for SkillSource {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for SkillSource {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "bundled" => Self::Bundled,
            "user" => Self::User,
            "project" => Self::Project,
            "plugin" => Self::Plugin,
            _ => Self::Unknown(word),
        })
    }
}
