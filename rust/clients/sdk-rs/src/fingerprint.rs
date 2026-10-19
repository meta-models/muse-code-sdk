//! Stable schema pin and compatibility warning.

/// The stable fingerprint this release expects; a compatibility test keeps it equal to
/// the committed stable manifest and the generated protocol fingerprint.
pub const EXPECTED: &str = crate::msp::GENERATED_FINGERPRINT;

/// A newer (or older) host reports a different fingerprint. Warning-only:
/// clients may still use compatible methods without losing the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FingerprintWarning {
    /// The fingerprint this SDK release was generated from.
    pub expected: &'static str,
    /// The fingerprint the host reported.
    pub actual: String,
}

impl FingerprintWarning {
    /// Returns a warning on mismatch, without refusing any independent action.
    #[must_use]
    pub fn for_server(actual: impl Into<String>) -> Option<Self> {
        let actual = actual.into();
        (actual != EXPECTED).then_some(Self {
            expected: EXPECTED,
            actual,
        })
    }
}
