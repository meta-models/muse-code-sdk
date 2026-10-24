// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use super::ErrorKind;

#[derive(Clone, Copy)]
pub(super) struct ErrorCodeDefinition {
    pub(super) code: i64,
    pub(super) kind: ErrorKind,
    pub(super) override_kinds: &'static [ErrorKind],
    pub(super) retryable: Option<bool>,
    pub(super) experimental: bool,
}

impl ErrorCodeDefinition {
    pub(super) const fn new(
        code: i64,
        kind: ErrorKind,
        override_kinds: &'static [ErrorKind],
        retryable: Option<bool>,
    ) -> Self {
        Self {
            code,
            kind,
            override_kinds,
            retryable,
            experimental: false,
        }
    }

    /// An experimental-tier row: exported only in the experimental bundle
    /// render, like the experimental method rows.
    pub(super) const fn experimental(code: i64, kind: ErrorKind) -> Self {
        Self::experimental_with_retry(code, kind, Some(false))
    }

    /// An experimental-tier row with its own retry column, for a code a
    /// retry can fix (a rate limit: the same request succeeds later).
    pub(super) const fn experimental_with_retry(
        code: i64,
        kind: ErrorKind,
        retryable: Option<bool>,
    ) -> Self {
        Self {
            code,
            kind,
            override_kinds: &[],
            retryable,
            experimental: true,
        }
    }
}

/// A single-kind row a retry cannot fix (`retryable: false`). The column is the
/// CODE's default; a payload that knows better sets `data.retryable`.
pub(super) const fn fatal(code: i64, kind: ErrorKind) -> ErrorCodeDefinition {
    ErrorCodeDefinition::new(code, kind, &[], Some(false))
}

/// A single-kind saturation row (`retryable: true`): the queue drains, so the
/// same request can succeed later.
pub(super) const fn drains(code: i64, kind: ErrorKind) -> ErrorCodeDefinition {
    ErrorCodeDefinition::new(code, kind, &[], Some(true))
}

/// A single-kind pre-emption row (`retryable` absent): retry is not the
/// question — the outcome arrives on the view stream.
pub(super) const fn preempted(code: i64, kind: ErrorKind) -> ErrorCodeDefinition {
    ErrorCodeDefinition::new(code, kind, &[], None)
}
