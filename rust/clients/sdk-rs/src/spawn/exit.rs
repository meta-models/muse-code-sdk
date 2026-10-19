use std::io::{self, Read};
use std::process::ExitStatus;
use std::sync::{Arc, Mutex};

use super::STDERR_TAIL_LIMIT;

/// Semantic host-exit class shared with the Python and TypeScript SDKs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum ExitKind {
    /// Exit code 0: the host shut down cleanly.
    CleanShutdown,
    /// Exit code 1: the host failed for a reason it could not report over the
    /// protocol; its stderr says why.
    UnhandledError,
    /// Exit code 2: the host refused its command-line arguments.
    UsageError,
    /// Exit code 3: the host could not load a usable configuration, profile or
    /// credentials.
    ConfigError,
    /// Exit code 4: another live process owns the session the host was started
    /// to load.
    LeaseUnavailable,
    /// Exit code 5: this host build does not serve the SDK surface, whatever the
    /// arguments.
    SdkSurfaceUnavailable,
    /// Any other exit code, or an exit by signal (an out-of-memory kill, for
    /// example).
    Crash,
}

/// Whether retrying a documented host refusal can help.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum RetryGuidance {
    /// Do not retry: the same launch fails the same way.
    Never,
    /// Retry after fixing the host's configuration.
    FixConfig,
    /// Retry once the other process releases the session.
    AfterLeaseRelease,
}

/// How the spawned-host close path credits available exit evidence.
///
/// On Unix, `Ours` records an accepted SDK escalation signal (`SIGTERM` or
/// `SIGKILL`) followed by an observed exit signal matching that signal. On
/// Windows and other non-Unix targets, it records an accepted kill request
/// before reap. Neither is proof that the request caused the exit: another
/// actor can win the race and leave indistinguishable exit evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum CloseAttribution {
    /// The SDK asked the host to stop: on Unix it sent `SIGTERM` or `SIGKILL`
    /// and the process died by that signal; on other targets its kill request
    /// was accepted before the exit was collected, whatever the exit code.
    Ours,
    /// The exit does not meet [`Self::Ours`]. This includes a host that exited
    /// on its own after the SDK closed its input, and, on Unix, one that caught
    /// the SDK's stop signal and then exited with a code.
    Theirs,
}

/// Classified exit evidence. A crash may carry a code or a signal.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct ExitClassification {
    /// The exit class.
    pub kind: ExitKind,
    /// The process exit code, when it exited with one.
    pub exit_code: Option<i32>,
    /// The signal that ended the process, when one did (Unix only).
    pub exit_signal: Option<i32>,
    /// The last lines the host wrote to stderr, at most
    /// [`STDERR_TAIL_LIMIT`](crate::spawn::STDERR_TAIL_LIMIT) bytes in all.
    pub stderr_tail: Vec<String>,
    /// Whether a retry can help, for exit codes 2 to 5; `None` otherwise.
    pub retry: Option<RetryGuidance>,
    /// Who the exit is credited to; see [`CloseAttribution`].
    pub close_attribution: CloseAttribution,
}

/// Classify raw process evidence using the host's documented exit table.
#[must_use]
pub fn classify_exit(
    exit_code: Option<i32>,
    exit_signal: Option<i32>,
    stderr_tail: Vec<String>,
    close_attribution: CloseAttribution,
) -> ExitClassification {
    let (kind, retry) = match exit_code {
        Some(0) => (ExitKind::CleanShutdown, None),
        Some(1) => (ExitKind::UnhandledError, None),
        Some(2) => (ExitKind::UsageError, Some(RetryGuidance::Never)),
        Some(3) => (ExitKind::ConfigError, Some(RetryGuidance::FixConfig)),
        Some(4) => (
            ExitKind::LeaseUnavailable,
            Some(RetryGuidance::AfterLeaseRelease),
        ),
        Some(5) => (ExitKind::SdkSurfaceUnavailable, Some(RetryGuidance::Never)),
        _ => (ExitKind::Crash, None),
    };
    ExitClassification {
        kind,
        exit_code,
        exit_signal,
        stderr_tail: bounded_stderr_tail(stderr_tail),
        retry,
        close_attribution,
    }
}

pub(super) fn classify_status(
    status: ExitStatus,
    stderr_tail: Vec<String>,
    close_attribution: CloseAttribution,
) -> ExitClassification {
    let exit = raw_exit(status);
    classify_exit(exit.0, exit.1, stderr_tail, close_attribution)
}

pub(super) fn raw_exit(status: ExitStatus) -> (Option<i32>, Option<i32>) {
    #[cfg(unix)]
    let signal = std::os::unix::process::ExitStatusExt::signal(&status);
    #[cfg(not(unix))]
    let signal = None;
    (status.code(), signal)
}

#[derive(Debug, Clone, Default)]
pub(super) struct StderrTailBuffer(Arc<Mutex<Vec<u8>>>);

impl StderrTailBuffer {
    fn push(&self, bytes: &[u8]) {
        let mut tail = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let bytes = &bytes[bytes.len().saturating_sub(STDERR_TAIL_LIMIT)..];
        let overflow = (tail.len() + bytes.len()).saturating_sub(STDERR_TAIL_LIMIT);
        tail.drain(..overflow);
        tail.extend(bytes);
    }

    pub(super) fn snapshot(&self) -> Vec<String> {
        let bytes = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        bounded_stderr_tail(
            String::from_utf8_lossy(&bytes)
                .lines()
                .map(str::to_owned)
                .collect(),
        )
    }

    #[cfg(test)]
    pub(super) fn len(&self) -> usize {
        self.0.lock().map_or(usize::MAX, |tail| tail.len())
    }
}

pub(super) fn drain_stderr(mut reader: impl Read, tail: StderrTailBuffer) {
    let mut chunk = [0_u8; 4096];
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => tail.push(&chunk[..read]),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

fn bounded_stderr_tail(lines: Vec<String>) -> Vec<String> {
    let mut kept = Vec::new();
    let mut kept_bytes = 0;
    for line in lines.into_iter().rev() {
        let separator = usize::from(!kept.is_empty());
        if kept_bytes + separator >= STDERR_TAIL_LIMIT {
            break;
        }
        let remaining = STDERR_TAIL_LIMIT - kept_bytes - separator;
        let line = if line.len() <= remaining {
            line
        } else {
            let mut start = line.len() - remaining;
            while !line.is_char_boundary(start) {
                start += 1;
            }
            line[start..].to_owned()
        };
        kept_bytes += separator + line.len();
        kept.push(line);
    }
    kept.reverse();
    kept
}
