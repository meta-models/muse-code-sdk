//! Host-exit attribution helpers.

use crate::msp::{InitializeResult, SessionDurability};

/// Conservative reading of the host's session durability profile.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum SessionDurabilityProfile {
    /// Absent and declared `durable` both mean sessions survive host death.
    Durable,
    /// The host declared that sessions exist only in process memory.
    Ephemeral,
    /// A newer host declared a value this SDK predates.
    Unrecognized(String),
}

/// Read `sessionDurability` from the generated handshake result.
#[must_use]
pub fn read_session_durability(result: &InitializeResult) -> SessionDurabilityProfile {
    durability_profile(result.session_durability.as_ref())
}

pub(crate) fn durability_profile(declared: Option<&SessionDurability>) -> SessionDurabilityProfile {
    match declared {
        None | Some(SessionDurability::Durable) => SessionDurabilityProfile::Durable,
        Some(SessionDurability::Ephemeral) => SessionDurabilityProfile::Ephemeral,
        Some(SessionDurability::Unknown(value)) => {
            SessionDurabilityProfile::Unrecognized(value.clone())
        }
    }
}

/// Only a durable profile promises that sessions survive an abnormal host death.
#[must_use]
pub const fn survives_host_death(profile: &SessionDurabilityProfile) -> bool {
    matches!(profile, SessionDurabilityProfile::Durable)
}

/// The client-side observation that the host stopped serving the session.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum HostDeathNotification {
    /// Orderly shutdown: the host had the chance to write session-end records.
    CleanShutdown,
    /// The transport reached EOF after the caller ruled out a client-owned close.
    ///
    /// Raw EOF must first pass through [`attribute_transport_eof`]; constructing
    /// this variant for an own-close EOF would contradict that attribution.
    TransportEof,
    /// Any process exit other than clean shutdown.
    AbnormalExit,
}

/// Whether this already-attributed observation means no orderly session end was written.
#[must_use]
pub fn is_abnormal_host_death(notification: &HostDeathNotification) -> bool {
    !matches!(notification, HostDeathNotification::CleanShutdown)
}

/// Whether a close was ours, harmless, reattachable, or destructive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum HostCloseAttribution {
    /// EOF followed a close initiated by this client.
    Ours,
    /// The host process exited cleanly after completing its drain.
    CleanHostExit,
    /// A durable host died; live waits fail, but the session may be reattached.
    DurableHostDeath,
    /// A non-durable or unknown-profile host died; the session is discarded.
    DiscardedHostDeath,
}

impl HostCloseAttribution {
    /// Whether this is a durable host death, after which the session may be
    /// reattached on a new transport.
    #[must_use]
    pub const fn may_reattach(self) -> bool {
        matches!(self, Self::DurableHostDeath)
    }

    /// Whether the host died, durable or not.
    #[must_use]
    pub const fn is_host_death(self) -> bool {
        matches!(self, Self::DurableHostDeath | Self::DiscardedHostDeath)
    }
}

/// Attribute transport EOF at the layer that knows whether `close()` was ours.
#[must_use]
pub fn attribute_transport_eof(
    profile: &SessionDurabilityProfile,
    client_closing: bool,
) -> HostCloseAttribution {
    if client_closing {
        HostCloseAttribution::Ours
    } else {
        death_for(profile)
    }
}

/// Attribute a classified process exit.
///
/// A client-requested close does not suppress an abnormal process exit: a
/// close escalation can still kill or crash the host. The caller therefore
/// supplies only the spawn layer's `cleanShutdown` classification here.
#[must_use]
pub fn attribute_process_exit(
    profile: &SessionDurabilityProfile,
    clean_shutdown: bool,
) -> HostCloseAttribution {
    if clean_shutdown {
        HostCloseAttribution::CleanHostExit
    } else {
        death_for(profile)
    }
}

const fn death_for(profile: &SessionDurabilityProfile) -> HostCloseAttribution {
    if survives_host_death(profile) {
        HostCloseAttribution::DurableHostDeath
    } else {
        HostCloseAttribution::DiscardedHostDeath
    }
}
