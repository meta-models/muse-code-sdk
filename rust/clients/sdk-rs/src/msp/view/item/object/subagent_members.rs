// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::item_content::WorkspacePlacement;
use serde::Deserialize;
use serde::Serialize;

/// `subagent` members, flattened beside the other optional members.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SubagentMembers {
    /// `subagent`: the spawn's workspace placement — `shared` when the spawn
    /// requested no worktree isolation, `isolated` when it did, the same read
    /// gate-off uses. Served from the item's first emission; absent when the
    /// host cannot read the spawn record. Clients treat an absent member and an
    /// unknown value as unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_placement: Option<WorkspacePlacement>,
}
