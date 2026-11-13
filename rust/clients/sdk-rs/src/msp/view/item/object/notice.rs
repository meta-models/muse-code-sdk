// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// `systemNotice`: the notice's level. Open; an unknown value is an
/// unknown-but-present level, rendered generically.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum NoticeSeverity {
    /// `info`: informational.
    Info,
    /// `warning`: something to look at.
    Warning,
    /// `error`: something failed.
    Error,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

impl NoticeSeverity {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Info => "info",
            Self::Warning => "warning",
            Self::Error => "error",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for NoticeSeverity {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for NoticeSeverity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "info" => Self::Info,
            "warning" => Self::Warning,
            "error" => Self::Error,
            _ => Self::Unknown(value),
        })
    }
}

/// `systemNotice`: the producing family, so a client routes a notice without
/// parsing its text. Open. The v1 vocabulary is the Monitor notice and the
/// three system-chrome producers plus the hook-run producer, the
/// paused-Workflow checkpoint producer and the continued-child tools producer;
/// absent means the server named no origin, and a client never infers one.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum NoticeOrigin {
    /// `monitor`: a Monitor terminal notice.
    Monitor,
    /// `skillsStartup`: the skills-startup system-chrome row.
    SkillsStartup,
    /// `scheduledFire`: the scheduled-fire system-chrome row.
    ScheduledFire,
    /// `incompleteGeneration`: the incomplete-generation system-chrome row.
    IncompleteGeneration,
    /// `hook`: a hook handler's `systemMessage`, produced by the hook-run fold
    /// for a `Completed` hook terminal that carries one.
    Hook,
    /// `workflowCheckpoint`: a compaction left a paused Workflow out of its
    /// checkpoint, so that Workflow cannot resume after a restart.
    WorkflowCheckpoint,
    /// `continuedChildTools`: a continued child run's tools notice, projected
    /// from the governing rules durable fact.
    ContinuedChildTools,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}

impl NoticeOrigin {
    /// The exact wire spelling, including a value from a newer host.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Monitor => "monitor",
            Self::SkillsStartup => "skillsStartup",
            Self::ScheduledFire => "scheduledFire",
            Self::IncompleteGeneration => "incompleteGeneration",
            Self::Hook => "hook",
            Self::WorkflowCheckpoint => "workflowCheckpoint",
            Self::ContinuedChildTools => "continuedChildTools",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for NoticeOrigin {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for NoticeOrigin {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "monitor" => Self::Monitor,
            "skillsStartup" => Self::SkillsStartup,
            "scheduledFire" => Self::ScheduledFire,
            "incompleteGeneration" => Self::IncompleteGeneration,
            "hook" => Self::Hook,
            "workflowCheckpoint" => Self::WorkflowCheckpoint,
            "continuedChildTools" => Self::ContinuedChildTools,
            _ => Self::Unknown(value),
        })
    }
}

/// `systemNotice`: the durable thing the notice is about. `id` is required
/// whenever the object is present; `label` is the producer's sanitized,
/// already-capped display value, omitted when it is empty, never `""`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct NoticeSubject {
    /// The subject's durable identity: for `monitor`, the monitor's task id
    /// (its `toolCall` `itemId`); for `hook`, the hook run's item id.
    pub id: String,
    /// The subject's bounded display label (the `hookRun.label` shape).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}
