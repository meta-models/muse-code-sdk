//! Typed SDK errors.

use std::error::Error as StdError;
use std::io;

use thiserror::Error;

use crate::msp::{ErrorData, ErrorKind, ErrorObject};
use crate::spawn::SpawnError;

pub use crate::msp::error::ErrorCode;

/// A server-authored MSP error whose branch key is `error.data.kind`.
#[derive(Clone, Debug, Error, PartialEq)]
#[error("MSP error {code}: {message}")]
pub struct MspError {
    code: i64,
    message: String,
    data: Box<ErrorData>,
}

impl MspError {
    /// The JSON-RPC error code.
    #[must_use]
    pub const fn code(&self) -> i64 {
        self.code
    }

    /// The server's human-readable error message.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The branch key, `error.data.kind`.
    #[must_use]
    pub const fn kind(&self) -> ErrorKind {
        self.data.kind
    }

    /// The whole `error.data` payload.
    #[must_use]
    pub const fn data(&self) -> &ErrorData {
        &self.data
    }

    /// Whether this error is one of a registry row's admitted kind/code pairs.
    #[must_use]
    pub fn matches(&self, expected: ErrorCode) -> bool {
        self.code == expected.code()
            && (self.kind() == expected.kind() || expected.override_kinds().contains(&self.kind()))
    }

    /// Payload guidance wins; otherwise use a matching generated registry row.
    #[must_use]
    pub fn retryable(&self) -> Option<bool> {
        self.data.retryable.or_else(|| {
            ErrorCode::ALL
                .into_iter()
                .find(|code| self.matches(*code))
                .and_then(ErrorCode::retryable)
        })
    }
}

impl TryFrom<ErrorObject> for MspError {
    type Error = ProtocolError;

    fn try_from(error: ErrorObject) -> Result<Self, Self::Error> {
        let Some(data) = error.data else {
            return Err(ProtocolError::MissingErrorData);
        };
        Ok(Self {
            code: error.code,
            message: error.message,
            data,
        })
    }
}

/// A failure the client raises itself. It is never a typed MSP error from the
/// server, though its message can quote one.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ProtocolError {
    /// An MSP error response carried no `error.data`, so it has no kind to
    /// branch on.
    #[error("MSP error response has no data.kind")]
    MissingErrorData,
    /// A failure the client detected or raised itself, for example: a frame
    /// that broke MSP framing or request correlation; arguments it refused (a
    /// pending turn from another session); its own event delivery failing (a
    /// notification backlog overflow); or, as a turn's failure, an approval
    /// answer that could not be sent, that the server refused with an
    /// unexpected error, or that named a choice the server did not offer. The
    /// message says what went wrong. A later release may give one of these
    /// cases its own variant, so match `Other` only as a fallback, never to
    /// detect a specific case.
    #[error("{message}")]
    Other {
        /// What went wrong.
        message: String,
        /// The offending NDJSON line, when the failure came from a complete
        /// frame.
        line: Option<String>,
    },
}

impl ProtocolError {
    pub(crate) fn new(message: impl Into<String>, line: Option<&str>) -> Self {
        Self::Other {
            message: message.into(),
            line: line.map(str::to_owned),
        }
    }

    /// Human-readable protocol failure detail.
    #[must_use]
    pub fn message(&self) -> &str {
        match self {
            Self::MissingErrorData => "MSP error response has no data.kind",
            Self::Other { message, .. } => message,
        }
    }

    /// The offending NDJSON line, when the failure came from a complete frame.
    #[must_use]
    pub fn line(&self) -> Option<&str> {
        match self {
            Self::MissingErrorData => None,
            Self::Other { line, .. } => line.as_deref(),
        }
    }
}

/// A typed failure returned by the public client and session facade.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum MuseError {
    /// The client was closed, so the call could not complete.
    #[error("client is closed")]
    ClientClosed,
    /// The transport ended before the server answered, or had already ended
    /// when the call was made.
    #[error("transport ended before the server answered")]
    TransportEnded,
    /// The session with this id was discarded: its transport ended on a client
    /// that is not durable, so nothing survives to resume.
    #[error("session {0} was discarded after an ephemeral transport ended")]
    SessionDiscarded(String),
    /// The command was discarded locally, because the last handle that could
    /// await it was dropped.
    #[error("command {command_id} was discarded locally")]
    Discarded {
        /// The discarded command's id.
        command_id: String,
    },
    /// Reading from or writing to the transport failed.
    #[error("transport failed: {0}")]
    Transport(#[from] io::Error),
    /// The host process could not be started.
    #[error(transparent)]
    Spawn(#[from] SpawnError),
    /// The server refused the request with a typed MSP error.
    #[error(transparent)]
    Msp(#[from] MspError),
    /// A failure the client raised itself rather than a typed MSP error from
    /// the server. See [`ProtocolError`].
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
}

/// A page or live event named a different session than its consumer.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
#[error("event for session {actual} was routed to session {expected}")]
pub struct ForeignSessionError {
    /// The session the consumer serves.
    pub expected: String,
    /// The session the page or event named.
    pub actual: String,
}

/// One delivery-gap recovery attempt failed without making the fold current.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum GapFillError {
    /// A gap, event or page could not be used: [`GapFill`](crate::gap::GapFill)
    /// returns this when one names another session, or when a page arrives
    /// with no gap pending. Code that sends the page requests can also wrap an
    /// [`MspError`] or a transport error in it. [`GapFillError::page_failure`]
    /// names the cause.
    #[error("view/gap ({after}, {next}) page failed")]
    PageFailed {
        /// The refused gap's `after` cursor, else the pending gap's, or empty
        /// when no gap was pending.
        after: String,
        /// The refused gap's `next` cursor, else the pending gap's, or empty
        /// when no gap was pending.
        next: String,
        /// The underlying failure.
        #[source]
        source: Box<dyn StdError + Send + Sync>,
    },
    /// A page made no progress: it said more pages follow but held no events,
    /// or it returned the cursor it was requested from.
    #[error("view/gap ({after}, {next}) page stalled at {cursor}")]
    PageStalled {
        /// The gap's `after` cursor.
        after: String,
        /// The gap's `next` cursor.
        next: String,
        /// The cursor the stalled page was requested from.
        cursor: String,
    },
}

/// The typed cause behind a failed gap-page operation.
#[derive(Debug)]
#[non_exhaustive]
pub enum GapPageFailure<'a> {
    /// A page arrived without a gap waiting for it.
    NoPendingGap(&'a ProtocolError),
    /// A page or event named a different session.
    ForeignSession(&'a ForeignSessionError),
    /// The server refused the page request with a typed MSP error.
    Msp(&'a MspError),
    /// The page response violated the MSP protocol.
    Protocol(&'a ProtocolError),
    /// The page request failed outside local gap validation.
    Transport(&'a (dyn StdError + Send + Sync + 'static)),
}

impl GapFillError {
    /// Whether this is [`Self::PageFailed`].
    #[must_use]
    pub const fn is_page_failed(&self) -> bool {
        matches!(self, Self::PageFailed { .. })
    }

    /// Whether this is [`Self::PageStalled`].
    #[must_use]
    pub const fn is_page_stalled(&self) -> bool {
        matches!(self, Self::PageStalled { .. })
    }

    /// Returns the typed cause of [`Self::PageFailed`].
    #[must_use]
    pub fn page_failure(&self) -> Option<GapPageFailure<'_>> {
        let Self::PageFailed { source, .. } = self else {
            return None;
        };
        if let Some(error) = source.downcast_ref::<ProtocolError>() {
            return Some(match error {
                ProtocolError::Other { .. } => GapPageFailure::NoPendingGap(error),
                ProtocolError::MissingErrorData => GapPageFailure::Protocol(error),
            });
        }
        if let Some(error) = source.downcast_ref::<ForeignSessionError>() {
            return Some(GapPageFailure::ForeignSession(error));
        }
        if let Some(error) = source.downcast_ref::<MspError>() {
            return Some(GapPageFailure::Msp(error));
        }
        Some(GapPageFailure::Transport(source.as_ref()))
    }
}

#[cfg(test)]
mod tests {
    use crate::msp::error::ErrorCode;

    use crate::msp::{ErrorData, ErrorObject};

    use super::{MspError, ProtocolError};

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn typed_msp_errors_are_bound_to_every_generated_registry_pair() -> TestResult {
        for code in ErrorCode::ALL {
            for kind in std::iter::once(code.kind()).chain(code.override_kinds().iter().copied()) {
                let object = ErrorObject {
                    code: code.code(),
                    message: format!("{kind:?}"),
                    data: Some(Box::new(ErrorData::new(kind))),
                };
                let error = MspError::try_from(object.clone())?;

                assert_eq!(error.code(), code.code());
                assert_eq!(error.kind(), kind);
                assert_eq!(Some(error.data()), object.data.as_deref());
                assert_eq!(error.retryable(), code.retryable());
                assert!(error.matches(code));
            }
        }
        Ok(())
    }

    #[test]
    fn contradictory_code_and_kind_remain_visible_but_do_not_match() -> TestResult {
        let code = ErrorCode::ALL[0];
        let other = ErrorCode::ALL[1];
        let object = ErrorObject {
            code: code.code(),
            message: "contradictory registry pair".to_owned(),
            data: Some(Box::new(ErrorData::new(other.kind()))),
        };
        let error = MspError::try_from(object)?;

        assert_eq!(error.code(), code.code());
        assert_eq!(error.kind(), other.kind());
        assert!(!error.matches(code));
        assert_eq!(error.retryable(), None);
        Ok(())
    }

    #[test]
    fn missing_error_kind_is_a_typed_protocol_failure() {
        let object = ErrorObject {
            code: ErrorCode::ALL[0].code(),
            message: "missing data".to_owned(),
            data: None,
        };
        let error = MspError::try_from(object).expect_err("MSP errors require data.kind");

        assert!(matches!(error, ProtocolError::MissingErrorData));
    }

    #[test]
    fn payload_retry_guidance_overrides_the_generated_default() -> TestResult {
        let Some(code) = ErrorCode::ALL
            .into_iter()
            .find(|code| code.retryable() == Some(false))
        else {
            return Err("the registry has no non-retryable row".into());
        };
        let mut data = ErrorData::new(code.kind());
        data.retryable = Some(true);
        let error = MspError::try_from(ErrorObject {
            code: code.code(),
            message: "payload override".to_owned(),
            data: Some(Box::new(data)),
        })?;

        assert_eq!(error.retryable(), Some(true));
        Ok(())
    }
}
