// @generated from the MSP stable schema and protocol sources; do not edit by hand.

mod catch_all;

/// A grantable capability name. Open: the reserved `rawLog` entry joins this
/// domain as an additive open-enum extension when the protocol spec un-defers —
/// closed would make that a retype.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CapabilityName {
    /// `session/userShell`.
    UserShell,
    /// Native MCP definitions supplied at session construction.
    SessionMcp,
    /// The opt-in `session/listChanged` row change stream: granted-by-default
    /// delivery preference — the stream is emitted only on connections holding
    /// this grant.
    SessionListStream,
    /// First-party feedback submission through the host: the host-policy gate
    /// for `feedback/submit` — granted at `initialize` only when feedback is
    /// allowed on the install, never by client identity.
    Feedback,
    /// Settings-driven computer-use setup: the gate for `computerUseSetup/*` —
    /// granted at `initialize` only when computer use is offered on this host.
    ComputerUseSetup,
    /// Computer-use setup with no chat: `computerUseSetup/read` and `/start`
    /// without `sessionId`, `computerUseSetup/check`, and the host's
    /// `computerUseSetup/changed` — granted at `initialize` only when computer
    /// use is offered and the host composes host setup.
    ComputerUseHostSetup,
    /// Whether this host can rename sessions: granted on request where the
    /// session-name store exists (macOS, Linux; not the ephemeral profile),
    /// never on Windows. Advisory: `session/rename` is not gated by it.
    SessionRename,
    /// Cross-session peer messaging and admission: the one gate for `peer/*`
    /// and `admission/*` — granted at `initialize` iff the host serves the
    /// plane (unix platform with registry access over a spawner-is-client or
    /// same-user transport), refused on beyond-same-user transports.
    /// Experimental-tier only: the per-variant stability strips it from the
    /// stable render, like `rawLog` below.
    PeerMessaging,
    /// The raw-log altitude: all `log/*` and `projection/*` methods.
    /// Experimental-tier only: granted solely on connections that opted into
    /// `experimentalApi`; a v1 host never grants it as a stable surface. The
    /// per-variant stability strips it from the stable render, keeping the
    /// governing rules "nowhere outside reserved tables" pin green.
    RawLog,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Never construct it with a known word.
    Unknown(String),
}
