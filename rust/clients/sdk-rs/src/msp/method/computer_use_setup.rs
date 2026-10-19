// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

mod catch_all;

/// Where the session's setup stands: `cua_setup`'s state codes, camelCase.
/// **Open**: a result vocabulary, so an older client tolerates a new state.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ComputerUseSetupPhase {
    /// No attempt has run.
    Dormant,
    /// An attempt is running.
    InProgress,
    /// Grants changed; only a relaunched host can recheck them.
    RestartRequired,
    /// The worker is up with its grants; each app still needs approval.
    ReadyForTarget,
    /// The chat stopped setup.
    Stopped,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}

/// One macOS permission as setup last saw it. **Open**, like the phase.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ComputerUsePermission {
    /// Setup is ready and didn't name it missing.
    Granted,
    /// Setup named it missing.
    Missing,
    /// Setup can't say.
    Unknown,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unrecognized(String),
}

/// The session's setup state: the result of both methods and the
/// `computerUseSetup/changed` payload's `state`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ComputerUseSetupState {
    /// Where setup stands.
    pub setup: ComputerUseSetupPhase,
    /// Accessibility.
    pub accessibility: ComputerUsePermission,
    /// Screen Recording.
    pub screen_recording: ComputerUsePermission,
    /// Input Monitoring: computer use is ready without it; some actions need it.
    pub input_monitoring: ComputerUsePermission,
    /// The `cua_setup` refusal code when the call was refused, verbatim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
    /// The sentence `cua_setup` gives the user for this answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// `computerUseSetup/read` params.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseSetupReadParams {
    /// The session whose setup to read. Omitted reads the host's own setup,
    /// which needs the `computerUseHostSetup` grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// `computerUseSetup/start` params: a human command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerUseSetupStartParams {
    /// The session whose setup to start. Omitted starts the host's own
    /// setup, which needs the `computerUseHostSetup` grant.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The client's id for this command.
    pub command_id: String,
}

/// `computerUseSetup/changed` params.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ComputerUseSetupChanged {
    /// The session whose setup state changed; absent for the host's own
    /// setup, which only `computerUseHostSetup` holders receive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Its new state.
    pub state: ComputerUseSetupState,
}
