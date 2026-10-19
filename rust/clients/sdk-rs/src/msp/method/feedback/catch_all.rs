// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::FeedbackSubmitOutcome;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl FeedbackSubmitOutcome {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Uploaded => "uploaded",
            Self::Recorded => "recorded",
            Self::AcceptedWithoutReceipt => "acceptedWithoutReceipt",
            Self::TrackingFailed => "trackingFailed",
            Self::TrackingUncertain => "trackingUncertain",
            Self::Dark => "dark",
            Self::Disabled => "disabled",
            Self::NoCredential => "noCredential",
            Self::AuthRejected => "authRejected",
            Self::RateLimited => "rateLimited",
            Self::Failed => "failed",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for FeedbackSubmitOutcome {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for FeedbackSubmitOutcome {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "uploaded" => Self::Uploaded,
            "recorded" => Self::Recorded,
            "acceptedWithoutReceipt" => Self::AcceptedWithoutReceipt,
            "trackingFailed" => Self::TrackingFailed,
            "trackingUncertain" => Self::TrackingUncertain,
            "dark" => Self::Dark,
            "disabled" => Self::Disabled,
            "noCredential" => Self::NoCredential,
            "authRejected" => Self::AuthRejected,
            "rateLimited" => Self::RateLimited,
            "failed" => Self::Failed,
            _ => Self::Unknown(word),
        })
    }
}
