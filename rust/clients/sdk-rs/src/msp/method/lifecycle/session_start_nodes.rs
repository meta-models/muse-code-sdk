// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// One node a `session/start` names: where the session's tool calls run.
/// The host validates the three strings; this shape only carries them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStartNode {
    /// The node's name in this session's roster.
    pub name: String,
    /// The SSH target, `[user@]host[:port]`.
    pub target: String,
    /// The absolute workspace root on the node.
    pub root: String,
}

/// The roster a session started with, echoed on the `session/start`
/// result. A client that named nodes and reads no echo sends no turn: the
/// host did not attach them, or no longer holds the roster it started with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionStartNodeRoster {
    /// The name of the node a call runs on when it names none.
    pub default_node: String,
    /// The attached nodes, in the order the start named them.
    pub nodes: Vec<SessionStartRosterNode>,
}

/// One attached node of a [`SessionStartNodeRoster`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionStartRosterNode {
    /// The node's name.
    pub name: String,
    /// The target as the start gave it.
    pub target: String,
    /// The target as `ssh` resolved it: `user@host:port`.
    pub resolved_target: String,
    /// The workspace root as the start gave it.
    pub root: String,
}
