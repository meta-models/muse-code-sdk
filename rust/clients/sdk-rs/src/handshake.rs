//! MSP initialization handshake.

use std::error::Error;
use std::fmt;
use std::future::Future;
use std::pin::Pin;

use serde_json::Value;
use thiserror::Error;

use crate::fingerprint::FingerprintWarning;
use crate::msp::{InitializeParams, InitializeResult};

/// The only request legal before initialization.
pub const INITIALIZE_METHOD: &str = "initialize";
/// Notification that completes the initialization sequence.
pub const INITIALIZED_METHOD: &str = "initialized";

/// Caller-runtime-owned future returned by the connection seam.
pub type HandshakeFuture<'a, T, E> = Pin<Box<dyn Future<Output = Result<T, E>> + Send + 'a>>;

/// The request/notification subset the initialization state machine needs.
///
/// The full connection implements this seam; tests can use a scripted fake
/// without a real process, network, clock, or runtime.
pub trait HandshakeConnection {
    /// The transport failure type.
    type Error: Error + Send + Sync + 'static;

    /// Sends one request and resolves to its raw JSON result.
    fn request<'a>(
        &'a mut self,
        method: &'static str,
        params: Value,
    ) -> HandshakeFuture<'a, Value, Self::Error>;

    /// Sends one notification, which has no params and gets no answer.
    fn notify<'a>(&'a mut self, method: &'static str) -> HandshakeFuture<'a, (), Self::Error>;
}

/// Failure before the connection reaches the `initialized` state.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum HandshakeError<E: Error + 'static> {
    /// The `initialize` params could not be encoded as JSON.
    #[error("could not encode initialize params: {0}")]
    Encode(#[source] serde_json::Error),
    /// The connection failed the `initialize` request or the `initialized`
    /// notification. `E` is the connection's own error type, so this can also
    /// carry a server refusal the connection reports.
    #[error("initialize transport failed: {0}")]
    Transport(#[source] E),
    /// The `initialize` result did not match the MSP shape this SDK expects.
    #[error("initialize result did not match the generated MSP shape: {0}")]
    InvalidResult(#[source] serde_json::Error),
}

/// Notify-phase failure that preserves the accepted connection for retry/close.
#[non_exhaustive]
pub enum HandshakeRecoveryError<C, E: Error + 'static> {
    /// The `initialize` params could not be encoded as JSON.
    Encode(serde_json::Error),
    /// The connection failed the `initialize` request. `E` is the
    /// connection's own error type, so this can also carry a server refusal
    /// the connection reports.
    Transport(E),
    /// The `initialize` result did not match the MSP shape this SDK expects.
    InvalidResult(serde_json::Error),
    /// The server accepted `initialize`, but sending `initialized` failed.
    InitializedNotify {
        /// The transport failure.
        source: E,
        /// The connection the server accepted, kept for a retry or a close.
        connection: C,
    },
}

impl<C, E: Error + 'static> HandshakeRecoveryError<C, E> {
    /// Returns the accepted connection when failure happened after initialize.
    #[must_use]
    pub fn connection(&self) -> Option<&C> {
        match self {
            Self::InitializedNotify { connection, .. } => Some(connection),
            Self::Encode(_) | Self::Transport(_) | Self::InvalidResult(_) => None,
        }
    }

    /// Consumes the error and returns the accepted connection, if one exists.
    #[must_use]
    pub fn into_connection(self) -> Option<C> {
        match self {
            Self::InitializedNotify { connection, .. } => Some(connection),
            Self::Encode(_) | Self::Transport(_) | Self::InvalidResult(_) => None,
        }
    }

    /// Converts to the connection-agnostic handshake error shape.
    #[must_use]
    pub fn into_handshake_error(self) -> HandshakeError<E> {
        match self {
            Self::Encode(error) => HandshakeError::Encode(error),
            Self::Transport(error) | Self::InitializedNotify { source: error, .. } => {
                HandshakeError::Transport(error)
            }
            Self::InvalidResult(error) => HandshakeError::InvalidResult(error),
        }
    }
}

impl<C, E: Error + 'static> fmt::Debug for HandshakeRecoveryError<C, E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Encode(error) => formatter.debug_tuple("Encode").field(error).finish(),
            Self::Transport(source) => formatter.debug_tuple("Transport").field(source).finish(),
            Self::InvalidResult(error) => {
                formatter.debug_tuple("InvalidResult").field(error).finish()
            }
            Self::InitializedNotify { source, .. } => formatter
                .debug_struct("InitializedNotify")
                .field("source", source)
                .field("connection", &"<preserved>")
                .finish(),
        }
    }
}

impl<C, E: Error + 'static> fmt::Display for HandshakeRecoveryError<C, E> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Encode(error) => {
                write!(formatter, "could not encode initialize params: {error}")
            }
            Self::Transport(source) => write!(formatter, "initialize transport failed: {source}"),
            Self::InvalidResult(error) => write!(
                formatter,
                "initialize result did not match the generated MSP shape: {error}"
            ),
            Self::InitializedNotify { source, .. } => write!(
                formatter,
                "initialized notification transport failed: {source}"
            ),
        }
    }
}

impl<C, E: Error + 'static> Error for HandshakeRecoveryError<C, E> {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Encode(error) | Self::InvalidResult(error) => Some(error),
            Self::Transport(source) | Self::InitializedNotify { source, .. } => Some(source),
        }
    }
}

/// The pre-initialized connection state. Consuming `initialize` makes sending
/// it twice unrepresentable through this API.
pub struct Handshake<C> {
    connection: C,
}

impl<C> Handshake<C> {
    /// Wraps a connection that has not sent `initialize` yet.
    #[must_use]
    pub fn new(connection: C) -> Self {
        Self { connection }
    }
}

impl<C: HandshakeConnection> Handshake<C> {
    /// Run `initialize` exactly once and complete the `initialized` sequence.
    ///
    /// A served fingerprint mismatch is attached to the returned ready state;
    /// it never prevents the final notification or discards the connection.
    /// To keep the accepted connection after an `initialized` notify failure,
    /// call [`Self::initialize_preserving_connection`].
    pub async fn initialize(
        self,
        params: InitializeParams,
    ) -> Result<Initialized<C>, HandshakeError<C::Error>> {
        self.initialize_preserving_connection(params)
            .await
            .map_err(HandshakeRecoveryError::into_handshake_error)
    }

    /// Run `initialize` and preserve the accepted connection if `initialized`
    /// fails after the server accepted the request.
    pub async fn initialize_preserving_connection(
        mut self,
        params: InitializeParams,
    ) -> Result<Initialized<C>, HandshakeRecoveryError<C, C::Error>> {
        let params = serde_json::to_value(params).map_err(HandshakeRecoveryError::Encode)?;
        let raw = self
            .connection
            .request(INITIALIZE_METHOD, params)
            .await
            .map_err(HandshakeRecoveryError::Transport)?;
        let initialize_result: InitializeResult =
            serde_json::from_value(raw).map_err(HandshakeRecoveryError::InvalidResult)?;
        let fingerprint_warning =
            FingerprintWarning::for_server(initialize_result.schema.fingerprint.clone());

        if let Err(source) = self.connection.notify(INITIALIZED_METHOD).await {
            return Err(HandshakeRecoveryError::InitializedNotify {
                source,
                connection: self.connection,
            });
        }

        Ok(Initialized {
            connection: self.connection,
            initialize_result,
            fingerprint_warning,
        })
    }
}

/// A connection that completed the MSP initialization sequence.
pub struct Initialized<C> {
    connection: C,
    /// The server's `initialize` result.
    pub initialize_result: InitializeResult,
    /// Set when the server's schema fingerprint differs from the one this SDK
    /// was generated from.
    pub fingerprint_warning: Option<FingerprintWarning>,
}

impl<C> Initialized<C> {
    /// The initialized connection.
    #[must_use]
    pub fn connection(&self) -> &C {
        &self.connection
    }

    /// The initialized connection, mutably.
    #[must_use]
    pub fn connection_mut(&mut self) -> &mut C {
        &mut self.connection
    }

    /// Consumes the ready state and returns the connection.
    #[must_use]
    pub fn into_connection(self) -> C {
        self.connection
    }
}
