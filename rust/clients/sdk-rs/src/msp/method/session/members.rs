// @generated from the MSP stable schema and protocol sources; do not edit by hand.

/// Why a workspace status probe produced no fresh reading.
///
/// **Open**: a new reason is additive evolution, and a client MUST render an
/// unknown value as an unknown-but-present reason rather than rejecting the
/// row.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProbeDegradedReason {
    /// The workspace is not trusted, so the probe never ran.
    SkippedUntrusted,
    /// No enforceable sandbox (or no host-trusted program), so the probe
    /// failed closed without running.
    SkippedSandboxUnavailable,
    /// The sandboxed probe ran but exited non-zero.
    ProbeFailed,
    /// A value from a newer host, kept verbatim so an older client decodes the
    /// rest of the message. Excluded from the generated schema while the enum
    /// stays declared open; never construct it with a known word.
    Unknown(String),
}
