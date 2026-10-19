// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::{HookEventName, HookHandlerKind};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

impl HookHandlerKind {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Managed => "managed",
            Self::User => "user",
            Self::Project => "project",
            Self::Plugin => "plugin",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for HookHandlerKind {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HookHandlerKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "managed" => Self::Managed,
            "user" => Self::User,
            "project" => Self::Project,
            "plugin" => Self::Plugin,
            _ => Self::Unknown(word),
        })
    }
}

impl HookEventName {
    /// The exact wire spelling, including an unknown word kept verbatim.
    pub fn as_str(&self) -> &str {
        match self {
            Self::SessionStart => "sessionStart",
            Self::UserPromptSubmit => "userPromptSubmit",
            Self::PreToolUse => "preToolUse",
            Self::PermissionRequest => "permissionRequest",
            Self::PostToolUse => "postToolUse",
            Self::PreLLMCall => "preLLMCall",
            Self::PostLLMCall => "postLLMCall",
            Self::PreCompact => "preCompact",
            Self::PostCompact => "postCompact",
            Self::SubagentStart => "subagentStart",
            Self::SubagentStop => "subagentStop",
            Self::Stop => "stop",
            Self::SessionEnd => "sessionEnd",
            Self::Notification => "notification",
            Self::PostToolUseFailure => "postToolUseFailure",
            Self::StopFailure => "stopFailure",
            Self::PostToolBatch => "postToolBatch",
            Self::Interrupt => "interrupt",
            Self::SessionFork => "sessionFork",
            Self::ToolUseStart => "toolUseStart",
            Self::Unknown(word) => word,
        }
    }
}

impl Serialize for HookEventName {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for HookEventName {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let word = String::deserialize(deserializer)?;
        Ok(match word.as_str() {
            "sessionStart" => Self::SessionStart,
            "userPromptSubmit" => Self::UserPromptSubmit,
            "preToolUse" => Self::PreToolUse,
            "permissionRequest" => Self::PermissionRequest,
            "postToolUse" => Self::PostToolUse,
            "preLLMCall" => Self::PreLLMCall,
            "postLLMCall" => Self::PostLLMCall,
            "preCompact" => Self::PreCompact,
            "postCompact" => Self::PostCompact,
            "subagentStart" => Self::SubagentStart,
            "subagentStop" => Self::SubagentStop,
            "stop" => Self::Stop,
            "sessionEnd" => Self::SessionEnd,
            "notification" => Self::Notification,
            "postToolUseFailure" => Self::PostToolUseFailure,
            "stopFailure" => Self::StopFailure,
            "postToolBatch" => Self::PostToolBatch,
            "interrupt" => Self::Interrupt,
            "sessionFork" => Self::SessionFork,
            "toolUseStart" => Self::ToolUseStart,
            _ => Self::Unknown(word),
        })
    }
}
