//! Client lifecycle and command-id minting.

mod host;
mod list;
mod open;
mod shared;

use std::collections::HashSet;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::sync::watch;

use crate::DuplexTransport;
use crate::connection::{Connection, ConnectionError, StdioTransport};
use crate::errors::ProtocolError;
use crate::fingerprint::FingerprintWarning;
use crate::handshake::{Handshake, HandshakeError};
use crate::host_death::{SessionDurabilityProfile, durability_profile};
use crate::msp::{ClientInfo, InitializeParams, InitializeResult, SessionDurability};
use crate::spawn::{ExitClassification, MuseChild, SpawnOptions, spawn_muse};

use host::HostExit;
use shared::NotificationRouter;

static NEXT_CLIENT_NONCE: AtomicU64 = AtomicU64::new(0);

pub use crate::errors::MuseError as FacadeError;

/// The result type of the client and session calls.
pub type FacadeResult<T> = Result<T, FacadeError>;

pub use list::ListSessionsOptions;
pub use open::{ResumeSessionOptions, StartSessionOptions};

/// A client connected to one host over MSP.
///
/// Create one with [`MuseClient::spawn`] (a host process the SDK starts) or
/// [`MuseClient::attach`] (a transport you provide). Then open sessions with
/// [`MuseClient::start_session`] or [`MuseClient::resume_session`], and call
/// [`MuseClient::close`] when you are done.
pub struct MuseClient {
    shared: Arc<ClientShared>,
}

/// A ready client and any advisory schema mismatch found during initialize.
pub struct MuseClientConnection {
    /// The ready client.
    pub client: MuseClient,
    /// Set when the host's schema fingerprint differs from the one this SDK
    /// was generated from. Calls both versions share still work.
    pub fingerprint_warning: Option<FingerprintWarning>,
}

impl MuseClient {
    /// Spawns an SDK-owned host and completes initialize over its stdio.
    pub async fn spawn(options: SpawnOptions) -> FacadeResult<MuseClientConnection> {
        let mut host = spawn_muse(options)?;
        let stdin = host
            .take_stdin()
            .ok_or_else(|| missing_host_pipe("stdin"))?;
        let stdout = host
            .take_stdout()
            .ok_or_else(|| missing_host_pipe("stdout"))?;
        Self::attach_transport(StdioTransport::new(stdin, stdout), Some(host)).await
    }

    /// Completes initialize over a caller-provided transport.
    pub async fn attach<T>(transport: T) -> FacadeResult<MuseClientConnection>
    where
        T: DuplexTransport + 'static,
    {
        Self::attach_transport(transport, None).await
    }

    async fn attach_transport<T>(
        transport: T,
        mut host: Option<MuseChild>,
    ) -> FacadeResult<MuseClientConnection>
    where
        T: DuplexTransport + 'static,
    {
        let router = Arc::new(NotificationRouter::default());
        let route = Arc::clone(&router);
        let overflow = Arc::clone(&router);
        let (connection, driver, notifications) = Connection::with_notification_handler(
            transport,
            move |notification| {
                route.route(notification);
            },
            move |notification| {
                overflow.overflow(notification);
            },
        );
        tokio::spawn(notifications.run());
        tokio::spawn(driver.run());
        let initialized = match Handshake::new(connection)
            .initialize(initialize_params())
            .await
        {
            Ok(initialized) => initialized,
            Err(error) => {
                if let Some(host) = host.as_mut() {
                    let _ = host.close().await;
                }
                return Err(handshake_error(error));
            }
        };
        let durability = initialized
            .initialize_result
            .session_durability
            .clone()
            .unwrap_or(SessionDurability::Durable);
        let fingerprint_warning = initialized.fingerprint_warning.clone();
        let initialize_result = initialized.initialize_result.clone();
        let client = Self::from_connection(
            initialized.into_connection(),
            router,
            durability,
            command_id_minter(),
            Some(initialize_result),
            host,
        );
        Ok(MuseClientConnection {
            client,
            fingerprint_warning,
        })
    }

    /// Low-level constructor used by deterministic facade contract tests.
    ///
    /// # Panics
    ///
    /// Panics when called outside a Tokio runtime because the connection
    /// driver must run on the caller-owned runtime.
    pub fn new<T>(transport: T, durability: SessionDurability) -> Self
    where
        T: DuplexTransport + 'static,
    {
        Self::with_command_id_minter(transport, durability, command_id_minter())
    }

    /// Builds a deterministic-minter client on the current Tokio runtime.
    ///
    /// # Panics
    ///
    /// Panics when called outside a Tokio runtime because the connection
    /// driver must run on the caller-owned runtime.
    pub fn with_command_id_minter<T, F>(
        transport: T,
        durability: SessionDurability,
        minter: F,
    ) -> Self
    where
        T: DuplexTransport + 'static,
        F: Fn() -> String + Send + Sync + 'static,
    {
        let router = Arc::new(NotificationRouter::default());
        let route = Arc::clone(&router);
        let overflow = Arc::clone(&router);
        let (connection, driver, notifications) = Connection::with_notification_handler(
            transport,
            move |notification| {
                route.route(notification);
            },
            move |notification| {
                overflow.overflow(notification);
            },
        );
        tokio::spawn(notifications.run());
        tokio::spawn(driver.run());
        Self::from_connection(connection, router, durability, minter, None, None)
    }

    fn from_connection<F>(
        connection: Connection,
        router: Arc<NotificationRouter>,
        durability: SessionDurability,
        minter: F,
        initialize_result: Option<InitializeResult>,
        host: Option<MuseChild>,
    ) -> Self
    where
        F: Fn() -> String + Send + Sync + 'static,
    {
        let (close_tx, _) = watch::channel(false);
        let (close_finished, _) = watch::channel(false);
        let mut driver_closed = connection.subscribe_closed();
        router.set_durability(durability.clone());
        let shared = Arc::new(ClientShared {
            connection,
            host: host.map(HostExit::spawn),
            initialize_result,
            minter: Arc::new(minter),
            durability,
            router,
            discarded_session_ids: Mutex::new(HashSet::new()),
            closed: AtomicBool::new(false),
            transport_ended: AtomicBool::new(false),
            close_tx,
            close_finished,
            runtime: tokio::runtime::Handle::current(),
        });
        let weak = Arc::downgrade(&shared);
        tokio::spawn(async move {
            let already_closed = *driver_closed.borrow();
            if !already_closed {
                let _ = driver_closed.changed().await;
            }
            if let Some(shared) = weak.upgrade() {
                shared.mark_transport_ended();
            }
        });
        Self { shared }
    }

    /// Close the connection, then a spawned host through its bounded ladder:
    /// a host that honours stdin EOF exits at once, while one that ignores it
    /// is held for `SpawnOptions::shutdown_timeout` (thirty seconds by
    /// default; zero skips that window) before escalation, so a slow close is
    /// the host's drain window, not a hang. Teardown runs
    /// on the client's runtime; every call returns once it has finished (or
    /// that runtime dropped it), and cancelling a caller does not stop it.
    pub async fn close(&self) {
        let mut finished = self.shared.close_finished.subscribe();
        if !self.shared.closed.swap(true, Ordering::AcqRel) {
            self.shared.close_tx.send_replace(true);
            let workers = self.shared.begin_close();
            let finish = FinishOnDrop(Arc::clone(&self.shared));
            // Its own task on the client's runtime, so neither a dropped caller,
            // a transport-end abort of the calling approval handler, nor the
            // shutdown of some other runtime can stop teardown halfway.
            self.shared.runtime.spawn(async move {
                let shared = &finish.0;
                for worker in workers {
                    let _ = worker.await;
                }
                shared.connection.close().await;
                if let Some(host) = &shared.host {
                    // The row stays readable through `exit()`.
                    let _ = host.close().await;
                }
            });
        }
        let _ = finished.wait_for(|finished| *finished).await;
    }

    /// The `initialize` result this client's handshake returned; `None` only
    /// for [`MuseClient::new`] and [`MuseClient::with_command_id_minter`],
    /// which run no handshake.
    pub fn initialize_result(&self) -> Option<&InitializeResult> {
        self.shared.initialize_result.as_ref()
    }

    /// The durability profile every session this client opens inherits.
    pub fn durability(&self) -> SessionDurabilityProfile {
        durability_profile(Some(&self.shared.durability))
    }

    /// Waits for the spawned host's classified exit; `None` when this client
    /// owns no host ([`MuseClient::attach`] and the low-level constructors).
    ///
    /// Every awaiter reads the one row observed first, from the host's own
    /// exit or from [`MuseClient::close`]'s ladder, so awaiting it never
    /// delays `close()`. It settles with an I/O error instead of staying
    /// pending once no exit can be observed: the ladder or the wait failed,
    /// or the runtime that owned the client's host watcher shut down.
    pub async fn exit(&self) -> Option<io::Result<ExitClassification>> {
        Some(self.shared.host.as_ref()?.exit().await)
    }

    /// Whether [`MuseClient::close`] has been called.
    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::Acquire)
    }

    /// Whether the session with this id was discarded: its transport ended on
    /// a client that is not durable. Resuming it fails with
    /// [`MuseError::SessionDiscarded`](crate::errors::MuseError::SessionDiscarded).
    pub fn is_session_discarded(&self, session_id: &str) -> bool {
        lock(&self.shared.discarded_session_ids).contains(session_id)
    }

    /// Reports discard evidence retained by a live session's bounded turn history.
    pub fn is_command_discarded(&self, command_id: &str) -> bool {
        self.shared
            .router
            .sessions()
            .iter()
            .any(|session| session.is_command_discarded(command_id))
    }
}

/// Wakes every `close()` waiter when the teardown task ends, including when
/// its runtime drops it mid-teardown; a later `close()` must not hang.
struct FinishOnDrop(Arc<ClientShared>);

impl Drop for FinishOnDrop {
    fn drop(&mut self) {
        self.0.close_finished.send_replace(true);
    }
}

pub(crate) struct ClientShared {
    connection: Connection,
    host: Option<HostExit>,
    initialize_result: Option<InitializeResult>,
    minter: Arc<dyn Fn() -> String + Send + Sync>,
    durability: SessionDurability,
    router: Arc<NotificationRouter>,
    discarded_session_ids: Mutex<HashSet<String>>,
    closed: AtomicBool,
    transport_ended: AtomicBool,
    close_tx: watch::Sender<bool>,
    close_finished: watch::Sender<bool>,
    // The runtime that built the client, which also runs its driver and host
    // watcher. close() teardown and every session's approval worker and
    // view/gap walker run there too, whichever runtime polls close() or opens
    // the session, so dropping that other runtime stops none of them.
    pub(crate) runtime: tokio::runtime::Handle,
}

pub(crate) fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn invalid_frame(error: serde_json::Error) -> FacadeError {
    protocol_error(error.to_string())
}

fn protocol_error(message: impl Into<String>) -> FacadeError {
    FacadeError::Protocol(ProtocolError::new(message, None))
}

fn initialize_params() -> InitializeParams {
    InitializeParams {
        client_info: ClientInfo {
            name: "muse_code_sdk".to_owned(),
            version: env!("CARGO_PKG_VERSION").to_owned(),
            title: Some("Muse Code Rust SDK".to_owned()),
        },
        capabilities: None,
    }
}

fn command_id_minter() -> impl Fn() -> String + Send + Sync + 'static {
    let client_nonce = NEXT_CLIENT_NONCE.fetch_add(1, Ordering::Relaxed);
    let sequence = AtomicU64::new(0);
    move || mint_command_id(client_nonce, sequence.fetch_add(1, Ordering::Relaxed))
}

fn missing_host_pipe(name: &str) -> FacadeError {
    FacadeError::Transport(io::Error::new(
        io::ErrorKind::BrokenPipe,
        format!("spawned host has no {name} pipe"),
    ))
}

fn handshake_error(error: HandshakeError<ConnectionError>) -> FacadeError {
    match error {
        HandshakeError::Encode(error) | HandshakeError::InvalidResult(error) => {
            invalid_frame(error)
        }
        HandshakeError::Transport(error) => connection_error(error),
    }
}

fn connection_error(error: ConnectionError) -> FacadeError {
    match error {
        ConnectionError::Closed => FacadeError::TransportEnded,
        ConnectionError::Transport(error) => FacadeError::Transport(error),
        ConnectionError::Msp(error) => FacadeError::Msp(error),
        ConnectionError::Protocol(error) => FacadeError::Protocol(error),
    }
}

fn mint_command_id(client_nonce: u64, sequence: u64) -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
        & 0x0000_ffff_ffff_ffff;
    let process = u64::from(std::process::id());
    let mixed = sequence ^ client_nonce.rotate_left(31) ^ process.rotate_left(17);
    format!(
        "{:08x}-{:04x}-7{:03x}-8{:03x}-{:012x}",
        millis >> 16,
        millis & 0xffff,
        (mixed >> 60) & 0x0fff,
        (mixed >> 48) & 0x0fff,
        mixed & 0x0000_ffff_ffff_ffff
    )
}

#[cfg(test)]
mod tests {
    use super::mint_command_id;

    #[test]
    fn minted_command_ids_pin_the_uuid_v7_and_variant_shape() {
        let id = mint_command_id(0x1234, 0x5678);
        let bytes = id.as_bytes();

        assert_eq!(id.len(), 36);
        assert_eq!(&id[8..9], "-");
        assert_eq!(&id[13..14], "-");
        assert_eq!(&id[18..19], "-");
        assert_eq!(&id[23..24], "-");
        assert_eq!(bytes[14], b'7');
        assert!(matches!(bytes[19], b'8' | b'9' | b'a' | b'b'));
        assert!(id.chars().all(|ch| ch == '-' || ch.is_ascii_hexdigit()));
    }
}
