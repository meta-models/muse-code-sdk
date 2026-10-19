use std::future::{Future, poll_fn};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::task::Poll;
use std::thread;
use std::time::Duration;

use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::oneshot;

use super::exit::{StderrTailBuffer, classify_status, drain_stderr, raw_exit};
use super::{
    CloseAttribution, ExitClassification, SIGTERM_GRACE, STDERR_DRAIN_TIMEOUT, SpawnError,
    SpawnOptions, classify_exit, launch_error,
};

pub(super) fn launch(binary: PathBuf, options: SpawnOptions) -> Result<MuseChild, SpawnError> {
    let (stderr_reader, stderr_writer) =
        io::pipe().map_err(|source| launch_error(&binary, source))?;
    let stderr_tail = StderrTailBuffer::default();
    let drain_tail = stderr_tail.clone();
    let (stderr_drained_tx, stderr_drained_rx) = oneshot::channel();
    thread::Builder::new()
        .name("muse-sdk-stderr".to_owned())
        .spawn(move || {
            drain_stderr(stderr_reader, drain_tail);
            let _ = stderr_drained_tx.send(());
        })
        .map_err(|source| launch_error(&binary, source))?;

    let mut command = Command::new(&binary);
    command
        .args(options.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(stderr_writer))
        .kill_on_drop(true);

    if let Some(cwd) = options.cwd {
        command.current_dir(cwd);
    }
    if let Some(environment) = options.env {
        command.envs(environment);
    }

    let child = command
        .spawn()
        .map_err(|source| launch_error(&binary, source))?;
    Ok(MuseChild {
        binary,
        child,
        stderr_tail,
        stderr_drained: Some(stderr_drained_rx),
        close_attribution: None,
        sent_signals: SentSignals::default(),
        shutdown_timeout: options.shutdown_timeout,
    })
}

/// The SDK-owned host process and its stdio handles.
#[derive(Debug)]
pub struct MuseChild {
    binary: PathBuf,
    child: Child,
    stderr_tail: StderrTailBuffer,
    stderr_drained: Option<oneshot::Receiver<()>>,
    close_attribution: Option<CloseAttribution>,
    sent_signals: SentSignals,
    shutdown_timeout: Duration,
}

impl MuseChild {
    /// The explicit or discovered binary used for this child.
    #[must_use]
    pub fn binary(&self) -> &Path {
        &self.binary
    }

    /// OS process identifier, while the platform exposes one.
    #[must_use]
    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    /// Take the host's stdin for the connection transport.
    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    /// Take the host's stdout for the connection transport.
    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    /// Ask the OS to end the owned child without awaiting it.
    pub fn start_kill(&mut self) -> io::Result<()> {
        start_kill_lifecycle(
            &mut self.child,
            &mut self.close_attribution,
            &mut self.sent_signals,
        )
        .map(|_| ())
    }

    /// End the owned child and wait until it has been reaped.
    pub async fn kill(&mut self) -> io::Result<()> {
        self.start_kill()?;
        let exit = self.child.wait().await.map(raw_exit)?;
        attribute_reaped_exit(&mut self.close_attribution, self.sent_signals, exit);
        Ok(())
    }

    /// Read an already-observed host-initiated exit without blocking.
    ///
    /// Stderr evidence is best-effort because this synchronous path cannot
    /// await the background drain's completion.
    pub fn try_wait(&mut self) -> io::Result<Option<ExitClassification>> {
        let Some(status) = self.child.try_wait()? else {
            return Ok(None);
        };
        let attribution = attribute_reaped_exit(
            &mut self.close_attribution,
            self.sent_signals,
            raw_exit(status),
        );
        Ok(Some(self.classify(status, attribution)))
    }

    /// Wait for a host-initiated exit and classify it with drained stderr.
    pub async fn wait(&mut self) -> io::Result<ExitClassification> {
        let status = self.child.wait().await?;
        let attribution = attribute_reaped_exit(
            &mut self.close_attribution,
            self.sent_signals,
            raw_exit(status),
        );
        self.wait_for_stderr_drain_until(tokio::time::Instant::now() + STDERR_DRAIN_TIMEOUT)
            .await;
        Ok(self.classify(status, attribution))
    }

    /// Close with the bounded ladder: end stdin, wait `shutdown_timeout` for
    /// the host's own exit, `SIGTERM`, wait [`SIGTERM_GRACE`], `SIGKILL`, and
    /// resolve only on the observed exit; then bound the post-exit stderr
    /// drain by [`STDERR_DRAIN_TIMEOUT`]. Off Unix the first escalation is the
    /// platform kill, the grace only spaces its repeat, and the reap stays
    /// unbounded. Escalation reaches an exit and never classifies one: the
    /// row is a function of the observed `(code, signal)`.
    pub async fn close(&mut self) -> io::Result<ExitClassification> {
        // A stdin the transport took is the transport's to end (the client
        // closes its connection before the host); an untaken one ends here.
        drop(self.child.stdin.take());
        let (exit, attribution) = close_lifecycle(
            &mut self.child,
            &mut self.close_attribution,
            &mut self.sent_signals,
            tokio::time::sleep(self.shutdown_timeout),
            || tokio::time::sleep(SIGTERM_GRACE),
        )
        .await?;
        self.wait_for_stderr_drain_until(tokio::time::Instant::now() + STDERR_DRAIN_TIMEOUT)
            .await;
        let stderr_tail = self.stderr_tail.snapshot();
        Ok(classify_exit(exit.0, exit.1, stderr_tail, attribution))
    }

    async fn wait_for_stderr_drain_until(&mut self, deadline: tokio::time::Instant) {
        let Some(stderr_drained) = self.stderr_drained.as_mut() else {
            return;
        };
        if wait_until_exit_or_deadline(stderr_drained, tokio::time::sleep_until(deadline))
            .await
            .is_some()
        {
            self.stderr_drained = None;
        }
    }

    fn classify(&self, status: ExitStatus, attribution: CloseAttribution) -> ExitClassification {
        classify_status(status, self.stderr_tail.snapshot(), attribution)
    }
}

type RawExit = (Option<i32>, Option<i32>);

#[cfg(unix)]
const SDK_TERMINATE_SIGNAL: i32 = 15;
#[cfg(unix)]
const SDK_KILL_SIGNAL: i32 = 9;

/// Which escalation signals the SDK has sent to the child. On Unix, `Ours`
/// attribution needs the observed exit to carry one of them; elsewhere any
/// accepted request counts, conservatively.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct SentSignals {
    term: bool,
    kill: bool,
}

trait ChildLifecycle {
    fn try_wait_raw(&mut self) -> io::Result<Option<RawExit>>;
    fn start_terminate(&mut self) -> io::Result<()>;
    fn start_kill(&mut self) -> io::Result<()>;
    async fn wait_raw(&mut self) -> io::Result<RawExit>;
}

impl ChildLifecycle for Child {
    fn try_wait_raw(&mut self) -> io::Result<Option<RawExit>> {
        self.try_wait().map(|status| status.map(raw_exit))
    }

    fn start_terminate(&mut self) -> io::Result<()> {
        #[cfg(unix)]
        {
            use nix::errno::Errno;
            use nix::sys::signal::{Signal, kill};
            use nix::unistd::Pid;

            // No pid means the child was already reaped; its exit is already
            // observable, so there is nothing left to signal.
            let Some(pid) = self.id() else {
                return Ok(());
            };
            let pid = Pid::from_raw(i32::try_from(pid).map_err(io::Error::other)?);
            match kill(pid, Signal::SIGTERM) {
                // ESRCH: the process is gone between the pid read and the
                // signal; the reap below observes its exit.
                Ok(()) | Err(Errno::ESRCH) => Ok(()),
                Err(errno) => Err(io::Error::from(errno)),
            }
        }
        #[cfg(not(unix))]
        {
            // No SIGTERM on this platform: the first escalation is the kill.
            Child::start_kill(self)
        }
    }

    fn start_kill(&mut self) -> io::Result<()> {
        Child::start_kill(self)
    }

    async fn wait_raw(&mut self) -> io::Result<RawExit> {
        Child::wait(self).await.map(raw_exit)
    }
}

fn start_terminate_lifecycle(
    child: &mut impl ChildLifecycle,
    attribution: &mut Option<CloseAttribution>,
    sent: &mut SentSignals,
) -> io::Result<Option<RawExit>> {
    if let Some(exit) = child.try_wait_raw()? {
        attribute_reaped_exit(attribution, *sent, exit);
        return Ok(Some(exit));
    }
    child.start_terminate()?;
    sent.term = true;
    Ok(None)
}

fn start_kill_lifecycle(
    child: &mut impl ChildLifecycle,
    attribution: &mut Option<CloseAttribution>,
    sent: &mut SentSignals,
) -> io::Result<Option<RawExit>> {
    if let Some(exit) = child.try_wait_raw()? {
        attribute_reaped_exit(attribution, *sent, exit);
        return Ok(Some(exit));
    }
    child.start_kill()?;
    sent.kill = true;
    Ok(None)
}

async fn wait_until_exit_or_deadline<T>(
    wait: impl Future<Output = T>,
    deadline: impl Future<Output = ()>,
) -> Option<T> {
    let mut wait = std::pin::pin!(wait);
    let mut deadline = std::pin::pin!(deadline);
    poll_fn(move |context| {
        if let Poll::Ready(exit) = wait.as_mut().poll(context) {
            return Poll::Ready(Some(exit));
        }
        if deadline.as_mut().poll(context).is_ready() {
            return Poll::Ready(None);
        }
        Poll::Pending
    })
    .await
}

/// The close ladder: the host's own exit inside `drain_deadline`, else
/// `SIGTERM`, the host's exit inside `grace`, else `SIGKILL` and the reap.
/// Every rung ends on the child's real exit; a signal is a way to reach one.
async fn close_lifecycle<Grace: Future<Output = ()>>(
    child: &mut impl ChildLifecycle,
    attribution: &mut Option<CloseAttribution>,
    sent: &mut SentSignals,
    drain_deadline: impl Future<Output = ()>,
    grace: impl FnOnce() -> Grace,
) -> io::Result<(RawExit, CloseAttribution)> {
    if let Some(exit) = child.try_wait_raw()? {
        return Ok((exit, attribute_reaped_exit(attribution, *sent, exit)));
    }
    if let Some(exit) = wait_until_exit_or_deadline(child.wait_raw(), drain_deadline).await {
        let exit = exit?;
        return Ok((exit, attribute_reaped_exit(attribution, *sent, exit)));
    }
    if let Some(exit) = start_terminate_lifecycle(child, attribution, sent)? {
        return Ok((exit, attribute_reaped_exit(attribution, *sent, exit)));
    }
    if let Some(exit) = wait_until_exit_or_deadline(child.wait_raw(), grace()).await {
        let exit = exit?;
        return Ok((exit, attribute_reaped_exit(attribution, *sent, exit)));
    }
    if let Some(exit) = start_kill_lifecycle(child, attribution, sent)? {
        return Ok((exit, attribute_reaped_exit(attribution, *sent, exit)));
    }
    let exit = child.wait_raw().await?;
    Ok((exit, attribute_reaped_exit(attribution, *sent, exit)))
}

fn attribute_reaped_exit(
    stored: &mut Option<CloseAttribution>,
    sent: SentSignals,
    exit: RawExit,
) -> CloseAttribution {
    #[cfg(unix)]
    {
        // A sent signal alone is not evidence that it won the race: the exit
        // must carry one of the SDK's own signals, else it belongs to the host.
        let ours = (sent.term && exit.1 == Some(SDK_TERMINATE_SIGNAL))
            || (sent.kill && exit.1 == Some(SDK_KILL_SIGNAL));
        let observed = if ours {
            CloseAttribution::Ours
        } else {
            CloseAttribution::Theirs
        };
        remember(stored, observed)
    }
    #[cfg(not(unix))]
    {
        attribute_non_unix_reaped_exit(stored, sent, exit)
    }
}

#[cfg(any(test, not(unix)))]
fn attribute_non_unix_reaped_exit(
    stored: &mut Option<CloseAttribution>,
    sent: SentSignals,
    _exit: RawExit,
) -> CloseAttribution {
    let observed = if sent.term || sent.kill {
        CloseAttribution::Ours
    } else {
        CloseAttribution::Theirs
    };
    remember(stored, observed)
}

fn remember(stored: &mut Option<CloseAttribution>, observed: CloseAttribution) -> CloseAttribution {
    *stored.get_or_insert(observed)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::future::{Future, pending, poll_fn, ready};
    use std::io;
    use std::task::{Context, Poll, Waker};

    #[cfg(unix)]
    use super::attribute_reaped_exit;
    use super::{
        ChildLifecycle, CloseAttribution, RawExit, SentSignals, StderrTailBuffer,
        attribute_non_unix_reaped_exit, close_lifecycle, drain_stderr, remember,
        start_kill_lifecycle,
    };
    use crate::spawn::STDERR_TAIL_LIMIT;

    #[derive(Default)]
    struct FakeChild {
        try_waits: VecDeque<Option<RawExit>>,
        waits: VecDeque<RawExit>,
        /// The host runs until a signal reaches it; `ignores_terminate` makes
        /// only the kill count.
        pending_until_signal: bool,
        ignores_terminate: bool,
        terminate_error: Option<io::ErrorKind>,
        kill_error: Option<io::ErrorKind>,
        terminate_calls: usize,
        kill_calls: usize,
    }

    impl FakeChild {
        fn signalled(&self) -> bool {
            if self.ignores_terminate {
                self.kill_calls > 0
            } else {
                self.terminate_calls > 0 || self.kill_calls > 0
            }
        }
    }

    impl ChildLifecycle for FakeChild {
        fn try_wait_raw(&mut self) -> io::Result<Option<RawExit>> {
            Ok(self.try_waits.pop_front().flatten())
        }

        fn start_terminate(&mut self) -> io::Result<()> {
            self.terminate_calls += 1;
            if let Some(kind) = self.terminate_error.take() {
                return Err(io::Error::from(kind));
            }
            Ok(())
        }

        fn start_kill(&mut self) -> io::Result<()> {
            self.kill_calls += 1;
            if let Some(kind) = self.kill_error.take() {
                return Err(io::Error::from(kind));
            }
            Ok(())
        }

        async fn wait_raw(&mut self) -> io::Result<RawExit> {
            poll_fn(|_| {
                if self.pending_until_signal && !self.signalled() {
                    return Poll::Pending;
                }
                let Some(exit) = self.waits.pop_front() else {
                    return Poll::Pending;
                };
                Poll::Ready(Ok(exit))
            })
            .await
        }
    }

    fn block_on_ready<F: Future>(future: F) -> Option<F::Output> {
        let mut future = std::pin::pin!(future);
        let mut context = Context::from_waker(Waker::noop());
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => Some(output),
            Poll::Pending => None,
        }
    }

    fn settled_close(
        result: Option<io::Result<(RawExit, CloseAttribution)>>,
    ) -> Result<(RawExit, CloseAttribution), String> {
        match result {
            Some(Ok(pair)) => Ok(pair),
            other => Err(format!("close did not settle causally: {other:?}")),
        }
    }

    #[test]
    fn drain_deadline_sends_sigterm_and_the_sigterm_exit_is_ours() -> Result<(), String> {
        let mut child = FakeChild {
            waits: VecDeque::from([(None, Some(15))]),
            pending_until_signal: true,
            ..FakeChild::default()
        };
        let mut stored_attribution = None;
        let mut sent = SentSignals::default();
        let (exit, attribution) = settled_close(block_on_ready(close_lifecycle(
            &mut child,
            &mut stored_attribution,
            &mut sent,
            ready(()),
            pending,
        )))?;
        assert_eq!(exit, (None, Some(15)));
        assert_eq!(attribution, CloseAttribution::Ours);
        assert_eq!(stored_attribution, Some(CloseAttribution::Ours));
        assert_eq!(child.terminate_calls, 1);
        assert_eq!(child.kill_calls, 0);
        assert!(sent.term);
        assert!(!sent.kill);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn close_deadline_accepted_kill_then_normal_exit_is_theirs() -> Result<(), String> {
        // Both deadlines pass and the SDK reaches the kill rung, but the host
        // exits normally: the accepted signals do not make that exit ours.
        let exit = (Some(4), None);
        let mut child = FakeChild {
            waits: VecDeque::from([exit]),
            pending_until_signal: true,
            ignores_terminate: true,
            ..FakeChild::default()
        };
        let mut stored_attribution = None;
        let mut sent = SentSignals::default();

        let (observed_exit, attribution) = settled_close(block_on_ready(close_lifecycle(
            &mut child,
            &mut stored_attribution,
            &mut sent,
            ready(()),
            || ready(()),
        )))?;

        assert_eq!(observed_exit, exit);
        assert_eq!(attribution, CloseAttribution::Theirs);
        assert_eq!(stored_attribution, Some(CloseAttribution::Theirs));
        assert!(sent.term);
        assert!(sent.kill);
        assert_eq!(child.terminate_calls, 1);
        assert_eq!(child.kill_calls, 1);
        Ok(())
    }

    #[test]
    fn grace_deadline_escalates_to_sigkill_when_sigterm_is_ignored() -> Result<(), String> {
        let mut child = FakeChild {
            waits: VecDeque::from([(None, Some(9))]),
            pending_until_signal: true,
            ignores_terminate: true,
            ..FakeChild::default()
        };
        let mut stored_attribution = None;
        let mut sent = SentSignals::default();
        let (exit, attribution) = settled_close(block_on_ready(close_lifecycle(
            &mut child,
            &mut stored_attribution,
            &mut sent,
            ready(()),
            || ready(()),
        )))?;
        assert_eq!(exit, (None, Some(9)));
        assert_eq!(attribution, CloseAttribution::Ours);
        assert_eq!(stored_attribution, Some(CloseAttribution::Ours));
        assert_eq!(child.terminate_calls, 1);
        assert_eq!(child.kill_calls, 1);
        assert!(sent.term);
        assert!(sent.kill);
        Ok(())
    }

    #[test]
    fn host_that_catches_sigterm_and_exits_keeps_its_own_row_as_theirs() -> Result<(), String> {
        let mut child = FakeChild {
            waits: VecDeque::from([(Some(3), None)]),
            pending_until_signal: true,
            ..FakeChild::default()
        };
        let mut stored_attribution = None;
        let mut sent = SentSignals::default();
        let (exit, attribution) = settled_close(block_on_ready(close_lifecycle(
            &mut child,
            &mut stored_attribution,
            &mut sent,
            ready(()),
            pending,
        )))?;
        assert_eq!(exit, (Some(3), None));
        assert_eq!(attribution, CloseAttribution::Theirs);
        assert_eq!(stored_attribution, Some(CloseAttribution::Theirs));
        assert_eq!(child.terminate_calls, 1);
        assert_eq!(child.kill_calls, 0);
        Ok(())
    }

    #[test]
    fn escalation_is_pending_until_reap() {
        let mut child = FakeChild {
            pending_until_signal: true,
            ignores_terminate: true,
            ..FakeChild::default()
        };
        let mut attribution = None;
        let mut sent = SentSignals::default();

        assert!(
            block_on_ready(close_lifecycle(
                &mut child,
                &mut attribution,
                &mut sent,
                ready(()),
                || ready(()),
            ))
            .is_none()
        );

        assert_eq!(attribution, None);
        assert!(sent.term);
        assert!(sent.kill);
        assert_eq!(child.terminate_calls, 1);
        assert_eq!(child.kill_calls, 1);
    }

    #[test]
    fn already_exited_child_is_attributed_theirs_without_signals() -> Result<(), String> {
        let mut child = FakeChild {
            try_waits: VecDeque::from([Some((Some(3), None))]),
            ..FakeChild::default()
        };
        let mut stored_attribution = None;
        let mut sent = SentSignals::default();
        let (exit, attribution) = settled_close(block_on_ready(close_lifecycle(
            &mut child,
            &mut stored_attribution,
            &mut sent,
            ready(()),
            || ready(()),
        )))?;
        assert_eq!(exit.0, Some(3));
        assert_eq!(attribution, CloseAttribution::Theirs);
        assert_eq!(stored_attribution, Some(CloseAttribution::Theirs));
        assert_eq!(child.terminate_calls, 0);
        assert_eq!(child.kill_calls, 0);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn external_sigkill_without_sdk_kill_request_is_theirs() -> Result<(), String> {
        let exit = (None, Some(9));
        let mut child = FakeChild {
            try_waits: VecDeque::from([Some(exit)]),
            ..FakeChild::default()
        };
        let mut stored_attribution = None;
        let mut sent = SentSignals::default();

        let (observed_exit, attribution) = settled_close(block_on_ready(close_lifecycle(
            &mut child,
            &mut stored_attribution,
            &mut sent,
            pending(),
            || ready(()),
        )))?;

        assert_eq!(observed_exit, exit);
        assert_eq!(attribution, CloseAttribution::Theirs);
        assert_eq!(stored_attribution, Some(CloseAttribution::Theirs));
        assert_eq!(sent, SentSignals::default());
        assert_eq!(child.terminate_calls, 0);
        assert_eq!(child.kill_calls, 0);
        Ok(())
    }

    #[test]
    fn start_kill_does_not_claim_an_already_exited_child() -> Result<(), String> {
        let mut child = FakeChild {
            try_waits: VecDeque::from([Some((Some(3), None))]),
            ..FakeChild::default()
        };
        let mut attribution = None;
        let mut sent = SentSignals::default();

        start_kill_lifecycle(&mut child, &mut attribution, &mut sent)
            .map_err(|error| format!("start_kill failed: {error}"))?;

        assert_eq!(attribution, Some(CloseAttribution::Theirs));
        assert!(!sent.kill);
        assert_eq!(child.kill_calls, 0);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn accepted_kill_of_normal_exit_uses_reaped_attribution() -> Result<(), String> {
        let exit = (Some(4), None);
        let mut child = FakeChild {
            try_waits: VecDeque::from([None]),
            waits: VecDeque::from([exit]),
            ..FakeChild::default()
        };
        let mut attribution = None;
        let mut sent = SentSignals::default();

        let observed_before_reap = start_kill_lifecycle(&mut child, &mut attribution, &mut sent)
            .map_err(|error| format!("start_kill failed: {error}"))?;
        let Some(observed_after_reap) = block_on_ready(child.wait_raw()) else {
            return Err("child did not expose its accepted normal exit".to_owned());
        };
        let observed_after_reap =
            observed_after_reap.map_err(|error| format!("wait failed: {error}"))?;
        let observed_attribution =
            attribute_reaped_exit(&mut attribution, sent, observed_after_reap);

        assert_eq!(observed_before_reap, None);
        assert_eq!(observed_after_reap, exit);
        assert_eq!(observed_attribution, CloseAttribution::Theirs);
        assert_eq!(attribution, Some(CloseAttribution::Theirs));
        assert!(sent.kill);
        assert_eq!(child.kill_calls, 1);
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn only_a_signal_the_sdk_sent_is_attributed_ours() {
        let term_only = SentSignals {
            term: true,
            kill: false,
        };
        let both = SentSignals {
            term: true,
            kill: true,
        };
        assert_eq!(
            attribute_reaped_exit(&mut None, term_only, (None, Some(15))),
            CloseAttribution::Ours
        );
        assert_eq!(
            attribute_reaped_exit(&mut None, term_only, (None, Some(9))),
            CloseAttribution::Theirs
        );
        assert_eq!(
            attribute_reaped_exit(&mut None, both, (None, Some(15))),
            CloseAttribution::Ours
        );
        assert_eq!(
            attribute_reaped_exit(&mut None, both, (None, Some(9))),
            CloseAttribution::Ours
        );
        assert_eq!(
            attribute_reaped_exit(&mut None, both, (Some(3), None)),
            CloseAttribution::Theirs
        );
        assert_eq!(
            attribute_reaped_exit(&mut None, SentSignals::default(), (None, Some(15))),
            CloseAttribution::Theirs
        );
    }

    #[test]
    fn non_unix_accepted_kill_uses_conservative_attribution() -> Result<(), String> {
        let exit = (Some(4), None);
        let mut child = FakeChild {
            try_waits: VecDeque::from([None]),
            waits: VecDeque::from([exit]),
            ..FakeChild::default()
        };
        let mut attribution = None;
        let mut sent = SentSignals::default();

        let observed_before_reap = start_kill_lifecycle(&mut child, &mut attribution, &mut sent)
            .map_err(|error| format!("start_kill failed: {error}"))?;
        let Some(observed_after_reap) = block_on_ready(child.wait_raw()) else {
            return Err("child did not expose its accepted non-Unix exit".to_owned());
        };
        let observed_after_reap =
            observed_after_reap.map_err(|error| format!("wait failed: {error}"))?;
        let observed_attribution =
            attribute_non_unix_reaped_exit(&mut attribution, sent, observed_after_reap);

        assert_eq!(observed_before_reap, None);
        assert_eq!(observed_after_reap, exit);
        assert_eq!(observed_attribution, CloseAttribution::Ours);
        assert_eq!(attribution, Some(CloseAttribution::Ours));
        assert!(sent.kill);
        assert_eq!(child.kill_calls, 1);
        Ok(())
    }

    #[test]
    fn non_unix_exit_without_kill_is_attributed_theirs() {
        let mut attribution = None;

        let observed = attribute_non_unix_reaped_exit(
            &mut attribution,
            SentSignals::default(),
            (Some(4), None),
        );

        assert_eq!(observed, CloseAttribution::Theirs);
        assert_eq!(attribution, Some(CloseAttribution::Theirs));
    }

    #[test]
    fn rejected_kill_keeps_attribution_unset_and_does_not_reap() {
        let mut child = FakeChild {
            try_waits: VecDeque::from([None, Some((Some(4), None))]),
            waits: VecDeque::from([(Some(4), None)]),
            kill_error: Some(io::ErrorKind::PermissionDenied),
            ..FakeChild::default()
        };
        let mut attribution = None;
        let mut sent = SentSignals::default();

        let error = start_kill_lifecycle(&mut child, &mut attribution, &mut sent);

        assert!(error.is_err_and(|error| error.kind() == io::ErrorKind::PermissionDenied));
        assert_eq!(attribution, None);
        assert!(!sent.kill);
        assert_eq!(child.try_waits.len(), 1);
        assert_eq!(child.waits.len(), 1);
        assert_eq!(child.kill_calls, 1);
    }

    #[test]
    fn rejected_sigterm_surfaces_the_error_without_escalating() {
        let mut child = FakeChild {
            try_waits: VecDeque::from([None, None]),
            pending_until_signal: true,
            terminate_error: Some(io::ErrorKind::PermissionDenied),
            ..FakeChild::default()
        };
        let mut attribution = None;
        let mut sent = SentSignals::default();

        let result = block_on_ready(close_lifecycle(
            &mut child,
            &mut attribution,
            &mut sent,
            ready(()),
            || ready(()),
        ));

        assert!(
            matches!(result, Some(Err(error)) if error.kind() == io::ErrorKind::PermissionDenied)
        );
        assert_eq!(attribution, None);
        assert!(!sent.term);
        assert!(!sent.kill);
        assert_eq!(child.terminate_calls, 1);
        assert_eq!(child.kill_calls, 0);
    }

    #[test]
    fn exit_after_drain_window_before_sigterm_is_theirs_without_signals() -> Result<(), String> {
        let mut child = FakeChild {
            try_waits: VecDeque::from([None, Some((Some(4), None))]),
            pending_until_signal: true,
            ..FakeChild::default()
        };
        let mut stored_attribution = None;
        let mut sent = SentSignals::default();
        let (exit, attribution) = settled_close(block_on_ready(close_lifecycle(
            &mut child,
            &mut stored_attribution,
            &mut sent,
            ready(()),
            || ready(()),
        )))?;

        assert_eq!(exit, (Some(4), None));
        assert_eq!(attribution, CloseAttribution::Theirs);
        assert_eq!(stored_attribution, Some(CloseAttribution::Theirs));
        assert_eq!(child.terminate_calls, 0);
        assert_eq!(child.kill_calls, 0);
        Ok(())
    }

    #[test]
    fn late_sigterm_exit_seen_at_the_kill_rung_is_ours_without_a_kill() -> Result<(), String> {
        let mut child = FakeChild {
            try_waits: VecDeque::from([None, None, Some((None, Some(15)))]),
            pending_until_signal: true,
            ignores_terminate: true,
            ..FakeChild::default()
        };
        let mut stored_attribution = None;
        let mut sent = SentSignals::default();
        let (exit, attribution) = settled_close(block_on_ready(close_lifecycle(
            &mut child,
            &mut stored_attribution,
            &mut sent,
            ready(()),
            || ready(()),
        )))?;

        assert_eq!(exit, (None, Some(15)));
        assert_eq!(attribution, CloseAttribution::Ours);
        assert_eq!(stored_attribution, Some(CloseAttribution::Ours));
        assert_eq!(child.terminate_calls, 1);
        assert_eq!(child.kill_calls, 0);
        assert!(sent.term);
        assert!(!sent.kill);
        Ok(())
    }

    #[test]
    fn exit_inside_the_drain_window_sends_no_signal() -> Result<(), String> {
        let mut child = FakeChild {
            waits: VecDeque::from([(Some(0), None)]),
            ..FakeChild::default()
        };
        let mut stored_attribution = None;
        let mut sent = SentSignals::default();
        let (exit, attribution) = settled_close(block_on_ready(close_lifecycle(
            &mut child,
            &mut stored_attribution,
            &mut sent,
            pending(),
            || ready(()),
        )))?;
        assert_eq!(exit, (Some(0), None));
        assert_eq!(attribution, CloseAttribution::Theirs);
        assert_eq!(stored_attribution, Some(CloseAttribution::Theirs));
        assert_eq!(child.terminate_calls, 0);
        assert_eq!(child.kill_calls, 0);
        Ok(())
    }

    #[test]
    fn first_close_actor_remains_attributed() {
        let mut attribution = None;
        assert_eq!(
            remember(&mut attribution, CloseAttribution::Ours),
            CloseAttribution::Ours
        );
        assert_eq!(
            remember(&mut attribution, CloseAttribution::Theirs),
            CloseAttribution::Ours
        );
    }

    #[test]
    fn stderr_drain_keeps_only_the_bounded_tail() {
        let bytes = [b"discarded-prefix".as_slice(), &vec![b'x'; 16 * 1024]].concat();
        let buffer = StderrTailBuffer::default();

        drain_stderr(io::Cursor::new(bytes), buffer.clone());

        assert_eq!(buffer.len(), STDERR_TAIL_LIMIT);
        assert_eq!(buffer.snapshot(), vec!["x".repeat(16 * 1024)]);
    }
}
