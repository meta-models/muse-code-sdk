use std::io;

use thiserror::Error;

use crate::errors::{MspError, ProtocolError};

/// Failure returned to one client request.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum ConnectionError {
    /// The connection driver is no longer running.
    #[error("connection is closed")]
    Closed,
    /// The transport itself refused a read or write.
    #[error(transparent)]
    Transport(#[from] io::Error),
    /// The peer sent a well-framed MSP error response.
    #[error(transparent)]
    Msp(#[from] MspError),
    /// The peer broke the framing or correlation contract, or a request or
    /// notification could not be built. See [`ProtocolError`].
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
}

impl Clone for ConnectionError {
    fn clone(&self) -> Self {
        match self {
            Self::Closed => Self::Closed,
            // `io::Error` is not cloneable. The stable contract is its kind;
            // retain the message as diagnostic context.
            Self::Transport(error) => {
                Self::Transport(io::Error::new(error.kind(), error.to_string()))
            }
            Self::Msp(error) => Self::Msp(error.clone()),
            Self::Protocol(error) => Self::Protocol(error.clone()),
        }
    }
}

impl PartialEq for ConnectionError {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Self::Closed, Self::Closed) => true,
            (Self::Transport(left), Self::Transport(right)) => left.kind() == right.kind(),
            (Self::Msp(left), Self::Msp(right)) => left == right,
            (Self::Protocol(left), Self::Protocol(right)) => left == right,
            _ => false,
        }
    }
}
