//! The spawned host's one exit observer.

use std::future::Future;
use std::io;
use std::sync::Arc;

use tokio::sync::watch;

use crate::spawn::{ExitClassification, MuseChild};

/// The observed exit, shared by every awaiter; `io::Error` is not `Clone`.
type Observed = Result<ExitClassification, Arc<io::Error>>;

/// The client's handle on the task that owns its spawned host.
pub(super) struct HostExit {
    close: watch::Sender<bool>,
    observed: watch::Receiver<Option<Observed>>,
}

/// The two ways the watcher can reach an exit; `MuseChild` in production.
pub(super) trait OwnedHost {
    async fn wait(&mut self) -> io::Result<ExitClassification>;
    async fn close(&mut self) -> io::Result<ExitClassification>;
}

impl OwnedHost for MuseChild {
    async fn wait(&mut self) -> io::Result<ExitClassification> {
        MuseChild::wait(self).await
    }

    async fn close(&mut self) -> io::Result<ExitClassification> {
        MuseChild::close(self).await
    }
}

impl HostExit {
    pub(super) fn spawn(host: MuseChild) -> Self {
        let (exit, watcher) = Self::watch(host);
        tokio::spawn(watcher);
        exit
    }

    fn watch<H: OwnedHost>(host: H) -> (Self, impl Future<Output = ()>) {
        let (close, close_requested) = watch::channel(false);
        let (observed_tx, observed) = watch::channel(None);
        let exit = Self { close, observed };
        (exit, watch_host(host, close_requested, observed_tx))
    }

    /// Runs the close ladder unless the host already exited, then reads the row.
    pub(super) async fn close(&self) -> io::Result<ExitClassification> {
        self.close.send_replace(true);
        self.exit().await
    }

    pub(super) async fn exit(&self) -> io::Result<ExitClassification> {
        let mut observed = self.observed.clone();
        let observed = match observed.wait_for(Option::is_some).await {
            Ok(observed) => observed.clone(),
            Err(_) => None,
        };
        match observed {
            Some(Ok(exit)) => Ok(exit),
            Some(Err(error)) => Err(io::Error::new(error.kind(), error)),
            // The watcher was dropped unpublished: its runtime shut down.
            None => Err(io::Error::other(
                "host exit watcher stopped before it observed an exit",
            )),
        }
    }
}

async fn watch_host<H: OwnedHost>(
    mut host: H,
    mut close: watch::Receiver<bool>,
    observed: watch::Sender<Option<Observed>>,
) {
    let exit = tokio::select! {
        biased;
        requested = close_requested(&mut close) => {
            if !requested {
                // The client is gone: dropping the child kills it, as before.
                return;
            }
            // Only the runtime dropping the close() teardown task can drop the
            // last holder mid-ladder (the teardown holds it otherwise); a HostExit
            // dropped there must still kill the child.
            tokio::select! {
                biased;
                () = client_dropped(&mut close) => return,
                exit = host.close() => exit,
            }
        }
        exit = host.wait() => exit,
    };
    observed.send_replace(Some(exit.map_err(Arc::new)));
    // Keep the child while anything holds the client's shared state (the
    // client, its sessions, any handle that keeps a session alive, or a
    // running close() teardown; a session's gap walk and approval
    // worker never hold it past them): a
    // ladder the OS refused leaves it running, and only the last drop kills it.
    client_dropped(&mut close).await;
}

/// `false` once the client dropped its handle without asking to close.
async fn close_requested(close: &mut watch::Receiver<bool>) -> bool {
    close.wait_for(|requested| *requested).await.is_ok()
}

/// Resolves only once the client dropped its handle; any close request, before
/// or after an observed exit, is ignored here.
async fn client_dropped(close: &mut watch::Receiver<bool>) {
    while close.changed().await.is_ok() {}
}

#[cfg(test)]
mod tests {
    use std::future::{Future, pending};
    use std::io;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};
    use std::task::Poll;

    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;

    use super::{HostExit, OwnedHost};
    use crate::client::lock;
    use crate::spawn::{CloseAttribution, ExitClassification, classify_exit};

    #[derive(Default)]
    struct Calls {
        closes: usize,
        dropped: bool,
    }

    /// A host whose own exit arrives only when the test sends it, and whose
    /// close ladder returns a scripted result or, with none, never finishes.
    struct FakeHost {
        exited: Option<oneshot::Receiver<io::Result<ExitClassification>>>,
        close: Option<io::Result<ExitClassification>>,
        calls: Arc<Mutex<Calls>>,
    }

    impl FakeHost {
        fn new(
            exited: Option<oneshot::Receiver<io::Result<ExitClassification>>>,
            close: Option<io::Result<ExitClassification>>,
        ) -> (Self, Arc<Mutex<Calls>>) {
            let calls = Arc::new(Mutex::new(Calls::default()));
            let host = Self {
                exited,
                close,
                calls: Arc::clone(&calls),
            };
            (host, calls)
        }
    }

    impl OwnedHost for FakeHost {
        async fn wait(&mut self) -> io::Result<ExitClassification> {
            match self.exited.as_mut() {
                Some(exited) => match exited.await {
                    Ok(exit) => exit,
                    Err(_) => pending().await,
                },
                None => pending().await,
            }
        }

        async fn close(&mut self) -> io::Result<ExitClassification> {
            lock(&self.calls).closes += 1;
            match self.close.take() {
                Some(close) => close,
                None => pending().await,
            }
        }
    }

    impl Drop for FakeHost {
        fn drop(&mut self) {
            lock(&self.calls).dropped = true;
        }
    }

    fn row(code: i32) -> ExitClassification {
        classify_exit(
            Some(code),
            None,
            vec![format!("exit {code}")],
            CloseAttribution::Theirs,
        )
    }

    fn closes(calls: &Mutex<Calls>) -> usize {
        lock(calls).closes
    }

    fn dropped(calls: &Mutex<Calls>) -> bool {
        lock(calls).dropped
    }

    fn start(host: FakeHost) -> (HostExit, JoinHandle<()>) {
        let (exit, watcher) = HostExit::watch(host);
        (exit, tokio::spawn(watcher))
    }

    /// Drops the client's handle and waits for the watcher to finish.
    async fn drop_client(exit: HostExit, watcher: JoinHandle<()>) -> Result<(), String> {
        drop(exit);
        watcher.await.map_err(|error| error.to_string())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn host_exit_before_close_is_the_one_row_and_runs_no_ladder() -> Result<(), String> {
        let (exit_tx, exited) = oneshot::channel();
        let (host, calls) = FakeHost::new(Some(exited), None);
        let (exit, watcher) = start(host);

        exit_tx
            .send(Ok(row(3)))
            .map_err(|_| "the watcher stopped awaiting the exit")?;

        assert_eq!(exit.exit().await.ok(), Some(row(3)));
        assert_eq!(
            exit.close().await.ok(),
            Some(row(3)),
            "close after an observed exit reads the same row"
        );
        assert_eq!(closes(&calls), 0, "an exited host has no ladder to run");
        assert!(
            !dropped(&calls),
            "the child stays owned while the client lives"
        );

        drop_client(exit, watcher).await?;
        assert!(dropped(&calls));
        Ok(())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn close_request_runs_the_ladder_while_the_host_still_runs() -> Result<(), String> {
        let (host, calls) = FakeHost::new(None, Some(Ok(row(0))));
        let (exit, watcher) = start(host);

        assert_eq!(exit.close().await.ok(), Some(row(0)));
        assert_eq!(
            exit.exit().await.ok(),
            Some(row(0)),
            "every later awaiter reads the ladder's row"
        );
        assert_eq!(closes(&calls), 1);

        drop_client(exit, watcher).await?;
        assert!(dropped(&calls));
        Ok(())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn close_error_settles_exit_and_keeps_the_child_until_the_client_drops()
    -> Result<(), String> {
        let refused = io::Error::from(io::ErrorKind::PermissionDenied);
        let (host, calls) = FakeHost::new(None, Some(Err(refused)));
        let (exit, watcher) = start(host);

        let closed = exit.close().await.err().map(|error| error.kind());
        assert_eq!(
            closed,
            Some(io::ErrorKind::PermissionDenied),
            "a refused ladder observed no exit"
        );
        let later = exit.exit().await.err().map(|error| error.kind());
        assert_eq!(
            later,
            Some(io::ErrorKind::PermissionDenied),
            "a later awaiter reads the same failure instead of hanging"
        );
        assert!(
            !dropped(&calls),
            "a child the ladder could not end stays owned until the client drops"
        );

        drop_client(exit, watcher).await?;
        assert!(dropped(&calls), "dropping the client still kills the child");
        Ok(())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn wait_error_settles_exit_with_that_error() -> Result<(), String> {
        let (exit_tx, exited) = oneshot::channel();
        let (host, calls) = FakeHost::new(Some(exited), None);
        let (exit, watcher) = start(host);

        exit_tx
            .send(Err(io::Error::other("no child left to reap")))
            .map_err(|_| "the watcher stopped awaiting the exit")?;

        let failed = exit.exit().await.err().map(|error| error.to_string());
        assert!(
            failed
                .as_deref()
                .is_some_and(|message| message.contains("no child left to reap")),
            "a failed wait observed no exit: {failed:?}"
        );
        assert_eq!(closes(&calls), 0);

        drop_client(exit, watcher).await
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dropping_the_client_before_any_exit_drops_the_child_without_a_ladder()
    -> Result<(), String> {
        let (host, calls) = FakeHost::new(None, None);
        let (exit, watcher) = start(host);

        drop_client(exit, watcher).await?;

        assert!(dropped(&calls), "dropping the child is what kills it");
        assert_eq!(closes(&calls), 0, "a dropped client runs no close ladder");
        Ok(())
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dropping_the_client_mid_ladder_drops_the_child() -> Result<(), String> {
        let (host, calls) = FakeHost::new(None, None);
        let (exit, watcher) = HostExit::watch(host);
        let mut watcher = std::pin::pin!(watcher);
        assert!(poll_once(watcher.as_mut()).await.is_pending());

        // The caller starts close(), so the watcher enters a ladder that never
        // finishes, then cancels close() and drops the client.
        let mut closing = Box::pin(exit.close());
        assert!(poll_once(closing.as_mut()).await.is_pending());
        assert!(poll_once(watcher.as_mut()).await.is_pending());
        assert_eq!(closes(&calls), 1, "the watcher is inside the ladder");
        drop(closing);
        drop(exit);

        assert!(
            poll_once(watcher.as_mut()).await.is_ready(),
            "the client's drop must end a running ladder"
        );
        assert!(
            dropped(&calls),
            "dropping the client mid-ladder kills the child"
        );
        Ok(())
    }

    /// One poll of `future` with the test task's waker.
    async fn poll_once<F: Future + ?Sized>(mut future: Pin<&mut F>) -> Poll<F::Output> {
        std::future::poll_fn(|context| Poll::Ready(future.as_mut().poll(context))).await
    }
}
