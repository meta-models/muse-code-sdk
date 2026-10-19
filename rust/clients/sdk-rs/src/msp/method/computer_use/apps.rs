// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// A per-app choice. **Open**, like `ComputerUseChoice`.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ComputerUseAppChoice {
    /// Each use of the app shows the approval card.
    Ask,
    /// The app is used without asking.
    AlwaysAllow,
    /// The app is never used.
    Blocked,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// Why Settings can't change a row. **Open**.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ComputerUseAppLock {
    /// A built-in block.
    BuiltIn,
    /// A block in the hand-edited blocked-apps file beside the policy store.
    File,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// One row of the Settings apps list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ComputerUseApp {
    /// The app's bundle ID: the stored key.
    pub bundle_id: String,
    /// The name the approval card shows for it, else the name stored with
    /// its grant or its last card; absent when there is none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The choice as it applies: a block wins over a grant.
    pub choice: ComputerUseAppChoice,
    /// Settings can't change this row; its choice is `blocked`. Omitted
    /// means false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub locked: bool,
    /// Why the row is locked, when it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub locked_by: Option<ComputerUseAppLock>,
    /// When Computer Use last showed an approval card for the app, RFC3339
    /// UTC; absent when it never has.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_asked_at: Option<String>,
}

/// One installed or running app, for Settings' app picker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ComputerUseInstalledApp {
    /// The app's bundle ID.
    pub bundle_id: String,
    /// The name the approval card shows for it.
    pub name: String,
}

/// One per-app choice to set in `computerUseSettings/update`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseAppPatch {
    /// The app's bundle ID.
    pub bundle_id: String,
    /// `ask` removes the app's grant and the user's block; `alwaysAllow`
    /// saves a grant and removes the user's block; `blocked` adds the
    /// user's block and removes the grant.
    pub choice: ComputerUseAppChoice,
}
