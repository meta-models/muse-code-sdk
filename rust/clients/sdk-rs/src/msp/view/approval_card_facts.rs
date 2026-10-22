// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// One Computer Use card's facts. Empty collections and absent rows are
/// omitted, never `null`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalCuaCardFacts {
    /// The target window's title: the app's own text, which a page can set;
    /// a client shows it quoted and as plain text, never as markup or a
    /// choice, and may cap it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window_title: Option<String>,
    /// For a browser, the host of the window's current page.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<ApprovalCuaPage>,
    /// Only the consequential steps, in call order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub steps: Vec<ApprovalCuaStep>,
}

/// The page's full host, no path or query.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalCuaPage {
    /// The host in Unicode.
    pub host: String,
    /// The host's `xn--` form; equal to `host` when they don't differ.
    pub host_ascii: String,
}

/// One consequential step. A client renders "Step N: <action> <roleWord>
/// "<label>" — <effect>"; a key step names its `chord`, and only a step with
/// a `point` (and no label or chord) reads "at x,y".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ApprovalCuaStep {
    /// 1-based, as the batch numbers its steps.
    pub step: u32,
    /// An open tag for styling and tests only (`verb:<class>`, `unresolved`,
    /// `unlabeled`); a client that doesn't know a value renders the step from
    /// `effect` and its label as usual.
    pub kind: String,
    /// The host's verb phrase, such as `click` or `type into`.
    pub action: String,
    /// The host's trusted sentence for what the step may do.
    pub effect: String,
    /// `button`, `link`, `menu item` or `key`; absent for a point step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role_word: Option<String>,
    /// The control's label: the app's own text, shown quoted and as plain
    /// text; a client may cap it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// The chord, for a key step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chord: Option<String>,
    /// The step's own 0–1000 model coordinates, only for a point step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub point: Option<ApprovalCuaPoint>,
}

/// A point in the model's 0–1000 coordinates.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct ApprovalCuaPoint {
    pub x: u16,
    pub y: u16,
}
