use std::future::Future;
use std::io;
use std::pin::Pin;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};

use crate::DuplexTransport;

/// The newline-framed MSP transport over a spawned host's stdin and stdout.
///
/// Hand it the pipes from [`MuseChild::take_stdin`] and
/// [`MuseChild::take_stdout`], and [`Connection::new`] gives you a raw
/// connection to that host. [`MuseClient::spawn`] uses this same transport.
///
/// The transport owns the host's stdin, so close the connection before
/// [`MuseChild::close`]: closing it sends the host EOF, and the host exits.
/// Closing the host first sends no EOF, so it waits out the shutdown timeout
/// and then ends the host by signal.
///
/// ```no_run
/// use muse_code_sdk::connection::{Connection, StdioTransport};
/// use muse_code_sdk::spawn::{SpawnOptions, spawn_muse};
///
/// # async fn run() -> Result<(), Box<dyn std::error::Error>> {
/// let mut host = spawn_muse(SpawnOptions::default())?;
/// let (stdin, stdout) = (host.take_stdin(), host.take_stdout());
/// let transport = StdioTransport::new(stdin.ok_or("no stdin")?, stdout.ok_or("no stdout")?);
/// let (connection, driver) = Connection::new(transport);
/// tokio::spawn(driver.run());
/// // ... the handshake, then requests ...
/// connection.close().await;
/// host.close().await?;
/// # Ok(())
/// # }
/// ```
///
/// [`MuseChild::take_stdin`]: crate::spawn::MuseChild::take_stdin
/// [`MuseChild::take_stdout`]: crate::spawn::MuseChild::take_stdout
/// [`MuseChild::close`]: crate::spawn::MuseChild::close
/// [`Connection::new`]: crate::connection::Connection::new
/// [`MuseClient::spawn`]: crate::client::MuseClient::spawn
#[derive(Debug)]
pub struct StdioTransport {
    pipes: PipeTransport<ChildStdin, ChildStdout>,
}

impl StdioTransport {
    /// Wraps a spawned host's stdin and stdout.
    #[must_use]
    pub fn new(stdin: ChildStdin, stdout: ChildStdout) -> Self {
        Self {
            pipes: PipeTransport::new(stdin, stdout),
        }
    }
}

impl DuplexTransport for StdioTransport {
    fn read_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
        self.pipes.read_chunk()
    }

    fn write(&mut self, frame: &str) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        self.pipes.write(frame)
    }
}

/// The stdio transport's framing, generic over the pipe halves so tests can
/// drive it over in-memory pipes. [`StdioTransport`] is this over a child's
/// stdin and stdout.
#[derive(Debug)]
pub(crate) struct PipeTransport<W, R> {
    stdin: W,
    stdout: BufReader<R>,
    /// Bytes already taken out of `stdout` that do not yet end on a UTF-8
    /// boundary. They live on the transport, not in a read future, so a read
    /// the driver drops in favour of an outbound write loses nothing.
    held: Vec<u8>,
}

impl<W, R> PipeTransport<W, R>
where
    W: AsyncWrite + Unpin + Send,
    R: AsyncRead + Unpin + Send,
{
    pub(crate) fn new(stdin: W, stdout: R) -> Self {
        Self {
            stdin,
            stdout: BufReader::new(stdout),
            held: Vec::new(),
        }
    }
}

impl<W, R> DuplexTransport for PipeTransport<W, R>
where
    W: AsyncWrite + Unpin + Send,
    R: AsyncRead + Unpin + Send,
{
    fn read_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
        Box::pin(async move {
            loop {
                // `fill_buf` is cancel safe: a read dropped here leaves every
                // byte inside the reader, unlike `read_line`, whose dropped
                // future takes the bytes it already copied out with it.
                let available = self.stdout.fill_buf().await?;
                if available.is_empty() {
                    return if self.held.is_empty() {
                        Ok(None)
                    } else {
                        Err(io::Error::new(
                            io::ErrorKind::InvalidData,
                            "inbound stream ended inside a UTF-8 sequence",
                        ))
                    };
                }
                let pulled = available.len();
                self.held.extend_from_slice(available);
                self.stdout.consume(pulled);
                if let Some(chunk) = take_complete_utf8(&mut self.held)? {
                    return Ok(Some(chunk));
                }
            }
        })
    }

    fn write(&mut self, frame: &str) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        let frame = frame.as_bytes().to_vec();
        Box::pin(async move {
            self.stdin.write_all(&frame).await?;
            self.stdin.flush().await
        })
    }
}

/// Splits the longest complete UTF-8 prefix off `bytes`, leaving a trailing
/// partial sequence behind for the next read. `None` means nothing complete
/// has arrived yet; invalid UTF-8 is an error, as it was for `read_line`.
fn take_complete_utf8(bytes: &mut Vec<u8>) -> io::Result<Option<String>> {
    let complete = match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(error) => return Err(io::Error::new(io::ErrorKind::InvalidData, error)),
    };
    if complete == 0 {
        return Ok(None);
    }
    let rest = bytes.split_off(complete);
    let chunk = std::mem::replace(bytes, rest);
    String::from_utf8(chunk)
        .map(Some)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}
