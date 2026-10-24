// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// The first-tree-transition hint verdict plus anchor: `rowKinds` is the open
/// lowercase row-kind vocabulary the client formats through its shared
/// kind-noun constructor; `afterItemId` is the item id after whose rows the
/// hint renders. Both members always ride when the object does.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ReplayHint {
    pub row_kinds: Vec<String>,
    pub after_item_id: String,
}
