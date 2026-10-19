//! Host discovery and process ownership.

use std::collections::HashMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub use exit::{CloseAttribution, ExitClassification, ExitKind, RetryGuidance, classify_exit};
use thiserror::Error;

mod child;
mod exit;

pub use child::MuseChild;

#[cfg(doctest)]
mod evolution;

/// The executable searched for when callers do not pass `muse_bin`.
pub const HOST_BINARY_NAME: &str = "muse";

/// The compatibility matrix cited by discovery errors.
pub const COMPATIBILITY_PAGE_URL: &str =
    "https://meta-models.github.io/muse-code-sdk/compatibility/";

/// Maximum retained host stderr evidence for exit classification.
pub const STDERR_TAIL_LIMIT: usize = 16 * 1024;

/// Default [`SpawnOptions::shutdown_timeout`]: how long [`MuseChild::close`]
/// (and so `MuseClient::close`) lets the host drain after stdin EOF before it
/// escalates (`SIGTERM` on Unix; the platform kill elsewhere). It is the host's
/// own stdio drain timeout, so a healthy host finishes its orderly wind-down
/// (turn cancel, durable session end) inside it.
pub const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(30);

/// Fixed grace between `SIGTERM` and `SIGKILL` inside [`MuseChild::close`].
/// Not a knob: by then the host has had its whole drain window, so this only
/// covers a signal handler's final flush. Off Unix, where the first escalation
/// is already the platform kill, it only spaces the repeated kill request; the
/// reap stays unbounded.
pub const SIGTERM_GRACE: Duration = Duration::from_secs(2);

/// Bound on waiting for the host's stderr tail once its exit was observed.
pub const STDERR_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

/// No host was supplied explicitly and no executable `muse` was on `PATH`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error(
    "no muse host found: pass {parameter}=<path to a muse binary> or put `muse` on PATH. \
     The crate does not bundle a host; supported host versions are listed on the \
     compatibility page's Rust row: {compatibility_url}"
)]
pub struct MuseHostDiscoveryError {
    parameter: &'static str,
    compatibility_url: &'static str,
}

impl MuseHostDiscoveryError {
    /// The spawn option callers use to provide an explicit host path.
    #[must_use]
    pub const fn parameter(&self) -> &'static str {
        self.parameter
    }

    /// The compatibility matrix that explains supported host versions.
    #[must_use]
    pub const fn compatibility_url(&self) -> &'static str {
        self.compatibility_url
    }
}

/// Resolve `muse_bin`, then `PATH`; return an explicit path verbatim.
///
/// The deterministic injected-`PATH` helper is not part of the public API:
///
/// ```compile_fail
/// use muse_code_sdk::spawn::discover_muse_bin_with_path_for_test;
/// ```
pub fn discover_muse_bin(muse_bin: Option<&Path>) -> Result<PathBuf, MuseHostDiscoveryError> {
    discover_muse_bin_with_path(muse_bin, env::var_os("PATH").as_deref())
}

fn discover_muse_bin_with_path(
    muse_bin: Option<&Path>,
    path: Option<&OsStr>,
) -> Result<PathBuf, MuseHostDiscoveryError> {
    if let Some(muse_bin) = muse_bin {
        return Ok(muse_bin.to_path_buf());
    }

    if let Some(path) = path
        && let Some(found) = find_executable_on_path(path)
    {
        return Ok(found);
    }

    Err(MuseHostDiscoveryError {
        parameter: "muse_bin",
        compatibility_url: COMPATIBILITY_PAGE_URL,
    })
}

fn find_executable_on_path(path: &OsStr) -> Option<PathBuf> {
    env::split_paths(path).find_map(|directory| {
        #[cfg(windows)]
        let candidate = directory.join("muse.exe");
        #[cfg(not(windows))]
        let candidate = directory.join(HOST_BINARY_NAME);

        is_executable(&candidate).then_some(candidate)
    })
}

#[cfg(unix)]
fn is_executable(candidate: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    candidate
        .metadata()
        .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

#[cfg(windows)]
fn is_executable(candidate: &Path) -> bool {
    candidate.is_file()
}

#[cfg(test)]
mod discovery_tests {
    use std::fs;
    use std::io;
    use std::path::{Path, PathBuf};

    use super::{COMPATIBILITY_PAGE_URL, SpawnError, discover_muse_bin_with_path};

    fn temp_dir(label: &str) -> io::Result<PathBuf> {
        let dir =
            std::env::temp_dir().join(format!("muse-code-sdk-{label}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir(&dir)?;
        Ok(dir)
    }

    #[cfg(unix)]
    fn install_fake_muse(dir: &Path) -> io::Result<PathBuf> {
        use std::os::unix::fs::PermissionsExt;

        let binary = dir.join("muse");
        fs::write(&binary, "#!/bin/sh\nexit 0\n")?;
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))?;
        Ok(binary)
    }

    #[cfg(windows)]
    fn install_fake_muse(dir: &Path) -> io::Result<PathBuf> {
        let binary = dir.join("muse.exe");
        fs::copy(std::env::current_exe()?, &binary)?;
        Ok(binary)
    }

    #[test]
    fn path_lookup_returns_the_first_executable_muse() -> Result<(), Box<dyn std::error::Error>> {
        let first = temp_dir("path-first")?;
        let second = temp_dir("path-second")?;
        let expected = install_fake_muse(&first)?;
        install_fake_muse(&second)?;
        let path = std::env::join_paths([&first, &second])?;

        let discovered = discover_muse_bin_with_path(None, Some(path.as_os_str()))?;

        assert_eq!(discovered, expected);
        fs::remove_dir_all(first)?;
        fs::remove_dir_all(second)?;
        Ok(())
    }

    #[test]
    fn missing_host_is_typed_before_spawn_and_names_the_parameter_and_compatibility_page()
    -> Result<(), Box<dyn std::error::Error>> {
        let empty_path = temp_dir("missing-host")?;

        let discovery = match discover_muse_bin_with_path(None, Some(empty_path.as_os_str())) {
            Ok(path) => {
                return Err(format!("unexpected host discovery: {}", path.display()).into());
            }
            Err(error) => error,
        };
        let error: SpawnError = discovery.into();
        let discovery = match error {
            SpawnError::Discovery(discovery) => discovery,
            error => return Err(format!("expected a discovery error, got {error:?}").into()),
        };

        assert_eq!(discovery.parameter(), "muse_bin");
        assert_eq!(discovery.compatibility_url(), COMPATIBILITY_PAGE_URL);
        let message = discovery.to_string();
        assert!(message.contains("muse_bin"), "{message}");
        assert!(message.contains(COMPATIBILITY_PAGE_URL), "{message}");
        assert!(
            std::error::Error::source(&discovery).is_none(),
            "the typed discovery failure precedes any OS spawn error"
        );
        fs::remove_dir_all(empty_path)?;
        Ok(())
    }
}

/// Inputs for an SDK-owned `muse serve` process.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct SpawnOptions {
    /// Explicit host binary. When absent, discovery searches `PATH`.
    pub muse_bin: Option<PathBuf>,
    /// Host arguments. The default is exactly `serve`.
    pub args: Vec<OsString>,
    /// Optional child working directory.
    pub cwd: Option<PathBuf>,
    /// Optional child environment overrides, inherited environment preserved.
    pub env: Option<HashMap<OsString, OsString>>,
    /// How long [`MuseChild::close`] and `MuseClient::close` let the host drain
    /// after stdin EOF before `SIGTERM` (the platform kill off Unix). Defaults to [`DEFAULT_SHUTDOWN_TIMEOUT`]; match it to a host
    /// configured with a different drain timeout. Zero skips the drain window
    /// but not the fixed [`SIGTERM_GRACE`] before `SIGKILL`.
    pub shutdown_timeout: Duration,
}

impl Default for SpawnOptions {
    fn default() -> Self {
        Self {
            muse_bin: None,
            args: vec![OsString::from("serve")],
            cwd: None,
            env: None,
            shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
        }
    }
}

/// A discovery failure or an OS refusal to launch the discovered binary.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum SpawnError {
    /// Neither discovery tier produced a host, before any spawn was attempted.
    #[error(transparent)]
    Discovery(#[from] MuseHostDiscoveryError),
    /// The explicit or discovered path could not be launched.
    #[error("failed to spawn muse host at {}: {source}", binary.display())]
    #[non_exhaustive]
    Launch {
        /// Binary passed to the OS.
        binary: PathBuf,
        /// OS spawn failure.
        #[source]
        source: io::Error,
    },
}

fn launch_error(binary: &Path, source: io::Error) -> SpawnError {
    SpawnError::Launch {
        binary: binary.to_path_buf(),
        source,
    }
}

/// Spawn an SDK-owned host driven by the caller's runtime.
pub fn spawn_muse(options: SpawnOptions) -> Result<MuseChild, SpawnError> {
    let binary = discover_muse_bin(options.muse_bin.as_deref())?;
    child::launch(binary, options)
}
