// @generated from the MSP stable schema and protocol sources; do not edit by hand.

pub use apps::ComputerUseApp;
pub use apps::ComputerUseAppPatch;
pub use apps::ComputerUseInstalledApp;
use serde::Deserialize;
use serde::Serialize;

pub(crate) mod apps;
mod catch_all;

/// A capability dropdown's value. **Open**: the read result carries it, so an
/// older client tolerates a value it does not know.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ComputerUseChoice {
    /// Each use shows the approval card.
    Ask,
    /// The whole Mac is allowed for this capability.
    AlwaysAllow,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// One row of the Settings blocked-apps list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ComputerUseBlockedApp {
    /// The app's bundle ID, or the family prefix when `prefix` is true.
    pub bundle_id: String,
    /// A built-in block, which Settings cannot remove.
    pub locked: bool,
    /// A built-in family row: it blocks every bundle ID that starts with
    /// `bundleId`. Omitted means false; only locked rows are prefixes.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub prefix: bool,
}

/// `computerUseSettings/read` params.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseSettingsReadParams {
    /// Also list the built-in blocks as locked rows (the D18.8 toggle).
    /// Omitted means false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_built_ins: Option<bool>,
    /// Also answer `installedApps`, for an app picker. Omitted means false.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed: Option<bool>,
}

/// `computerUseSettings/read` result, also answered by
/// `computerUseSettings/update`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ComputerUseSettings {
    /// The computer-control dropdown, as it applies: `ask` while the stored
    /// blocked-apps list can't be read.
    pub computer_control: ComputerUseChoice,
    /// The screenshots dropdown, under the same rule.
    pub screenshots: ComputerUseChoice,
    /// The user's blocks in the order they were added, then the built-in
    /// blocks when `showBuiltIns` asked for them.
    pub blocked_apps: Vec<ComputerUseBlockedApp>,
    /// The apps list: apps Computer Use has asked about, most recent first;
    /// then the other saved grants, then the user's other blocks; then the
    /// locked rows. Each app once. A host that serves the list always
    /// answers it, so its absence means an older host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub apps: Option<Vec<ComputerUseApp>>,
    /// The installed and running apps, sorted by name, when the read asked
    /// for `installed`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_apps: Option<Vec<ComputerUseInstalledApp>>,
}

/// `computerUseSettings/update` params: a patch. Omitted members are left
/// alone; the whole patch applies or none of it does.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseSettingsUpdateParams {
    /// The new computer-control dropdown value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub computer_control: Option<ComputerUseChoice>,
    /// The new screenshots dropdown value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshots: Option<ComputerUseChoice>,
    /// Bundle IDs to add to the user's blocked apps. A built-in block is
    /// refused: it is already blocked.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub block_apps: Vec<String>,
    /// Bundle IDs to remove from the user's blocked apps. Only the user's own
    /// entries can be removed; a built-in block stays.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unblock_apps: Vec<String>,
    /// Per-app choices to set. A locked app is refused; so is a bundle ID
    /// named twice, or also in `blockApps` or `unblockApps`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub apps: Vec<ComputerUseAppPatch>,
}
