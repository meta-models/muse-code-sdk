// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{HookRunStatus, ItemKind, ItemStatus};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl ItemKind {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::UserMessage => "userMessage",
            Self::AgentMessage => "agentMessage",
            Self::Reasoning => "reasoning",
            Self::ToolCall => "toolCall",
            Self::UserShell => "userShell",
            Self::Subagent => "subagent",
            Self::Workflow => "workflow",
            Self::ReminderChild => "reminderChild",
            Self::Compaction => "compaction",
            Self::HookRun => "hookRun",
            Self::SideChat => "sideChat",
            Self::SkillRead => "skillRead",
            Self::WebSearch => "webSearch",
            Self::MonitorFeed => "monitorFeed",
            Self::DamagedRange => "damagedRange",
            Self::ScheduledFire => "scheduledFire",
            Self::BackgroundTerminalCompletion => "backgroundTerminalCompletion",
            Self::OverdueNotice => "overdueNotice",
            Self::EarlierHistory => "earlierHistory",
            Self::PeerMessage => "peerMessage",
            Self::SubagentInput => "subagentInput",
            Self::SubagentResult => "subagentResult",
            Self::SystemNotice => "systemNotice",
            Self::BodyCompletion => "bodyCompletion",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ItemKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ItemKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "userMessage" => Self::UserMessage,
            "agentMessage" => Self::AgentMessage,
            "reasoning" => Self::Reasoning,
            "toolCall" => Self::ToolCall,
            "userShell" => Self::UserShell,
            "subagent" => Self::Subagent,
            "workflow" => Self::Workflow,
            "reminderChild" => Self::ReminderChild,
            "compaction" => Self::Compaction,
            "hookRun" => Self::HookRun,
            "sideChat" => Self::SideChat,
            "skillRead" => Self::SkillRead,
            "webSearch" => Self::WebSearch,
            "monitorFeed" => Self::MonitorFeed,
            "damagedRange" => Self::DamagedRange,
            "scheduledFire" => Self::ScheduledFire,
            "backgroundTerminalCompletion" => Self::BackgroundTerminalCompletion,
            "overdueNotice" => Self::OverdueNotice,
            "earlierHistory" => Self::EarlierHistory,
            "peerMessage" => Self::PeerMessage,
            "subagentInput" => Self::SubagentInput,
            "subagentResult" => Self::SubagentResult,
            "systemNotice" => Self::SystemNotice,
            "bodyCompletion" => Self::BodyCompletion,
            _ => Self::Unknown(word),
        })
    }
}

impl ItemStatus {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::InProgress => "inProgress",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Rejected => "rejected",
            Self::TimedOut => "timedOut",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for ItemStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ItemStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "inProgress" => Self::InProgress,
            "completed" => Self::Completed,
            "failed" => Self::Failed,
            "cancelled" => Self::Cancelled,
            "rejected" => Self::Rejected,
            "timedOut" => Self::TimedOut,
            _ => Self::Unknown(word),
        })
    }
}

impl HookRunStatus {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Completed => "completed",
            Self::Blocked => "blocked",
            Self::Failed => "failed",
            Self::TimedOut => "timedOut",
            Self::Cancelled => "cancelled",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for HookRunStatus {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HookRunStatus {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "completed" => Self::Completed,
            "blocked" => Self::Blocked,
            "failed" => Self::Failed,
            "timedOut" => Self::TimedOut,
            "cancelled" => Self::Cancelled,
            _ => Self::Unknown(word),
        })
    }
}
