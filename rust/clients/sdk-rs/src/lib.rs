//! Async, caller-runtime-owned Rust client for the Muse Stream Protocol.
//!
//! The SDK can spawn a `muse serve` host, or attach to a caller-owned
//! [`DuplexTransport`]. Both constructors complete the initialization
//! handshake before returning a [`client::MuseClientConnection`], including
//! any warning-only schema fingerprint mismatch.
//!
//! A [`session::Session`] submits turns
//! ([`session::Session::send_user_turn`]), answers approvals through a
//! handler ([`session::Session::on_approval`]) and questions
//! ([`session::Session::answer_user_input`]), and keeps a fold of the events
//! it applied, read through [`session::Session::fold`]. After a transport
//! drop on a durable client, [`session::Session::pending`] lists the
//! submissions it never saw settle, and
//! [`session::Session::resolve_reconnect`] resends them on the resumed
//! session.
//!
//! ```no_run
//! use muse_code_sdk::client::{MuseClient, StartSessionOptions};
//! use muse_code_sdk::msp::{TurnInputPart, TurnInputPartType};
//! use muse_code_sdk::session::SendUserTurnOptions;
//! use muse_code_sdk::spawn::SpawnOptions;
//! use muse_code_sdk::turn::TurnOutcome;
//!
//! # async fn run() -> Result<(), Box<dyn std::error::Error>> {
//! let connection = MuseClient::spawn(SpawnOptions::default()).await?;
//! let client = connection.client;
//! let session = client.start_session(StartSessionOptions::default()).await?;
//! let turn = session
//!     .send_user_turn(SendUserTurnOptions {
//!         input: vec![text_part("Summarize this repository.")],
//!         ..SendUserTurnOptions::default()
//!     })
//!     .await?;
//!
//! let mut items = turn.items();
//! while let Some(item) = items.recv().await? {
//!     drop(item);
//! }
//! match turn.completed().await? {
//!     TurnOutcome::Completed { params, .. } => println!("turn ended as {:?}", params.terminal),
//!     TurnOutcome::Unqueued(params) => println!("turn {} was unqueued", params.turn_id),
//!     _ => println!("turn ended"),
//! }
//! client.close().await;
//! # Ok(())
//! # }
//! #
//! # fn text_part(text: impl Into<String>) -> TurnInputPart {
//! #     TurnInputPart {
//! #         part_type: TurnInputPartType::Text,
//! #         text: Some(text.into()),
//! #         media_type: None,
//! #         base64_data: None,
//! #         width: None,
//! #         height: None,
//! #         selector: None,
//! #         arguments: None,
//! #         upload_id: None,
//! #         source: None,
//! #     }
//! # }
//! ```

use std::future::Future;
use std::io;
use std::pin::Pin;

/// Outside this crate, every public enum in the SDK's own API (errors,
/// outcomes and states) is `#[non_exhaustive]`, so a later release can add a
/// variant without breaking your build. A `match` on one needs a catch-all arm;
/// an exhaustive match without one does not compile.
///
/// ```compile_fail,E0004
/// use muse_code_sdk::turn::TurnOutcome;
///
/// fn name(outcome: &TurnOutcome) -> &'static str {
///     match outcome {
///         TurnOutcome::Completed { .. } => "completed",
///         TurnOutcome::Unqueued(_) => "unqueued",
///         TurnOutcome::Ended(_) => "ended",
///     }
/// }
/// ```
///
/// ```compile_fail,E0004
/// use muse_code_sdk::turn::TurnWaitError;
///
/// fn name(error: &TurnWaitError) -> &'static str {
///     match error {
///         TurnWaitError::SourceClosed => "source closed",
///         TurnWaitError::ClientClosed => "client closed",
///         TurnWaitError::EventSourceFailed { .. } => "event source failed",
///     }
/// }
/// ```
///
/// With the catch-all arm, both compile:
///
/// ```
/// use muse_code_sdk::turn::{TurnOutcome, TurnWaitError};
///
/// fn outcome(outcome: &TurnOutcome) -> &'static str {
///     match outcome {
///         TurnOutcome::Completed { .. } => "completed",
///         TurnOutcome::Unqueued(_) => "unqueued",
///         _ => "other",
///     }
/// }
///
/// fn error(error: &TurnWaitError) -> &'static str {
///     match error {
///         TurnWaitError::SourceClosed => "source closed",
///         TurnWaitError::ClientClosed => "client closed",
///         TurnWaitError::EventSourceFailed { .. } => "event source failed",
///         _ => "other",
///     }
/// }
/// ```
#[cfg(doctest)]
pub struct OpenEnumsNeedACatchAllArm;

pub mod approval;
pub mod client;
pub mod connection;
pub mod errors;
pub mod fingerprint;
pub mod fold;
pub mod gap;
pub mod handshake;
pub mod host_death;
pub mod msp;
pub mod pending;
pub mod session;
pub mod spawn;
pub mod turn;

/// A two-way stream of decoded UTF-8 chunks and outgoing newline-framed MSP.
///
/// Inbound chunks may be empty or split at any point; the connection assembles
/// frames. `write` means a frame was handed to the transport, not that the
/// server completed the command. The implementer decodes bytes incrementally.
/// Neither method creates a runtime: callers drive both on their Tokio runtime.
pub trait DuplexTransport: Send {
    /// Returns the next decoded chunk, or `None` after transport EOF.
    fn read_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>>;

    /// Submits an already newline-framed outgoing message.
    fn write(&mut self, frame: &str) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>>;
}
