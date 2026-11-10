// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// How a `model/complete` call settled. **Open**: a server-produced result
/// vocabulary, so a word a newer host adds decodes to `Unknown`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ModelCompleteOutcome {
    /// The model answered; `text` carries the answer.
    Completed,
    /// The call failed; `message` says why.
    Failed,
    /// `model/cancel` or a connection close won the race.
    Cancelled,
    /// The host-enforced 45 s bound fired.
    TimedOut,
    /// A value from a newer host, kept verbatim. Excluded from the generated
    /// schema; never construct it with a known word.
    Unknown(String),
}

impl ModelCompleteOutcome {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::TimedOut => "timedOut",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ModelCompleteOutcome {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ModelCompleteOutcome {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "timedOut" => Self::TimedOut,
            _ => Self::Unknown(value),
        })
    }
}

/// Why the model stopped on a `completed` call. **Open**: a server-produced
/// word, so a word a newer host adds decodes to `Unknown`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ModelCompleteStopReason {
    /// The answer ended, for any reason but the request's bound.
    End,
    /// The provider stopped at the request's `maxTokens`.
    MaxTokens,
    /// A value from a newer host, kept verbatim. Excluded from the generated
    /// schema; never construct it with a known word.
    Unknown(String),
}

impl ModelCompleteStopReason {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::End => "end",
            Self::MaxTokens => "maxTokens",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ModelCompleteStopReason {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ModelCompleteStopReason {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "end" => Self::End,
            "maxTokens" => Self::MaxTokens,
            _ => Self::Unknown(value),
        })
    }
}

/// The provider's token counts for one completed call: real counts only, never
/// an estimate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelCompleteUsage {
    /// Input tokens, as the provider counted them.
    pub input_tokens: u64,
    /// Output tokens, as the provider counted them.
    pub output_tokens: u64,
}

/// `model/completed` params. `text`, `stopReason`, `modelId` and `usage` ride
/// `completed` (`usage` only when the provider reported counts); `message`
/// rides `failed`; `cancelled` and `timedOut` carry neither. The struct marks
/// the conditional members optional; the SS prose pins the per-outcome rule.
/// `text` is untrusted model output.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ModelCompletedParams {
    /// The request's id — the correlation key.
    pub command_id: String,
    /// How the call settled.
    pub outcome: ModelCompleteOutcome,
    /// The model's answer, verbatim (on `completed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Why the model stopped (on `completed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<ModelCompleteStopReason>,
    /// The `model/list` id of the model that ran (on `completed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// The provider's counts (on `completed`, when it reported them).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<ModelCompleteUsage>,
    /// Why the call failed, in words (on `failed`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
