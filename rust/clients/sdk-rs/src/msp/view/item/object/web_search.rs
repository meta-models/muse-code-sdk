// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::item_content::WebSearchHit;
use serde::Deserialize;
use serde::Serialize;

/// `webSearch` members, flattened into [`Item`](super::Item).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct WebSearchMembers {
    /// `webSearch`: the search action as an open-enum string — `search` |
    /// `openPage` | `findInPage`, else tolerated unknown. Absent while the call
    /// is open (the action is not final until the item completes).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// `webSearch`: the search query, verbatim — present iff `action ==
    /// "search"` with a query to carry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    /// `webSearch`: the page URL, verbatim — present iff `action == "openPage"`
    /// or `"findInPage"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// `webSearch`: the in-page pattern, verbatim — present iff `action ==
    /// "findInPage"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    /// `webSearch`: the provider's terminal status, verbatim (`"completed"` |
    /// `"failed"` | `"cancelled"` | other) — present on the completed item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_status: Option<String>,
    /// `webSearch`: the typed result hits, verbatim, never truncated — clients
    /// read `results.length` for the count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub results: Option<Vec<WebSearchHit>>,
    /// `webSearch`: the verbatim raw provider JSON frame under the 64 KiB
    /// per-surface budget; past-budget frames cut here and ride whole behind
    /// `outputRef`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_item: Option<String>,
}
