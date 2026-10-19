//! The stdio transport must not lose inbound bytes when the driver's race
//! between a pending read and an outbound write is won by the write.

use super::*;

use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, SimplexStream, WriteHalf, simplex};

const PIPE_CAPACITY: usize = 64 * 1024;

type HostPipes = (
    PipeTransport<WriteHalf<SimplexStream>, ReadHalf<SimplexStream>>,
    WriteHalf<SimplexStream>,
    ReadHalf<SimplexStream>,
);

/// Returns the transport plus the host's ends: what the host writes to its
/// stdout and what it reads from its stdin.
fn host_pipes() -> HostPipes {
    let (host_stdout, host_writes) = simplex(PIPE_CAPACITY);
    let (client_writes, host_stdin) = simplex(PIPE_CAPACITY);
    (
        PipeTransport::new(host_stdin, host_stdout),
        host_writes,
        client_writes,
    )
}

async fn host_writes(writer: &mut WriteHalf<SimplexStream>, bytes: &[u8]) -> Result<(), String> {
    writer
        .write_all(bytes)
        .await
        .map_err(|error| format!("host write failed: {error}"))
}

async fn read_until_newline<T: DuplexTransport>(
    transport: &mut T,
    mut collected: String,
) -> Result<String, String> {
    while !collected.ends_with('\n') {
        match transport.read_chunk().await {
            Ok(Some(chunk)) => collected.push_str(&chunk),
            other => return Err(format!("stream ended before the newline: {other:?}")),
        }
    }
    Ok(collected)
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_stdio_read_loses_none_of_the_bytes_it_already_pulled() -> Result<(), String> {
    let (mut transport, mut host_stdout, _host_stdin) = host_pipes();
    host_writes(&mut host_stdout, b"{\"half\":").await?;
    let collected = {
        let mut read = transport.read_chunk();
        match poll_once(read.as_mut()).await {
            None => String::new(),
            Some(Ok(Some(chunk))) => chunk,
            Some(other) => return Err(format!("first read ended the stream: {other:?}")),
        }
    };
    host_writes(&mut host_stdout, b"1}\n").await?;
    let collected = read_until_newline(&mut transport, collected).await?;
    if collected != "{\"half\":1}\n" {
        return Err(format!(
            "bytes pulled by the dropped read were lost: {collected:?}"
        ));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn client_write_during_a_split_inbound_frame_still_delivers_the_frame_whole()
-> Result<(), String> {
    let (transport, mut host_stdout, mut host_stdin) = host_pipes();
    let (connection, driver) = Connection::new(transport);
    let mut notifications = connection.subscribe_notifications();
    let mut protocol_errors = connection.subscribe_protocol_errors();
    let mut driver = Box::pin(driver.run());

    let frame = json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {"sessionId": "session-1", "turnId": "turn-1", "itemId": "item-1"},
    })
    .to_string();
    let split = frame.len() / 2;
    host_writes(&mut host_stdout, &frame.as_bytes()[..split]).await?;
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("driver exited while the frame was mid-read".to_owned());
    }

    let mut notify = Box::pin(connection.notify("client/ping", None));
    if poll_once(notify.as_mut()).await.is_some() {
        return Err("client write settled before the driver submitted it".to_owned());
    }
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("driver exited while submitting the client write".to_owned());
    }
    let mut written = vec![0_u8; 256];
    let written_len = {
        let mut host_read = Box::pin(host_stdin.read(&mut written));
        match poll_once(host_read.as_mut()).await {
            Some(Ok(len)) => len,
            other => {
                return Err(format!(
                    "the client write did not reach the host: {other:?}"
                ));
            }
        }
    };
    if !String::from_utf8_lossy(&written[..written_len]).contains("client/ping") {
        return Err("the client write did not reach the host".to_owned());
    }
    match poll_once(notify.as_mut()).await {
        Some(Ok(())) => {}
        other => {
            return Err(format!(
                "client write did not settle as submitted: {other:?}"
            ));
        }
    }

    host_writes(&mut host_stdout, &frame.as_bytes()[split..]).await?;
    host_writes(&mut host_stdout, b"\n").await?;
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("driver exited after the second half arrived".to_owned());
    }

    match notifications.try_recv() {
        Ok(notification) if notification.method == "item/completed" => {
            let item_id = notification
                .params
                .as_ref()
                .and_then(|params| params.get("itemId"))
                .and_then(Value::as_str);
            if item_id != Some("item-1") {
                return Err(format!("delivered frame lost its params: {notification:?}"));
            }
        }
        other => {
            return Err(format!(
                "the split frame was not delivered whole: {other:?}; protocol error: {:?}",
                protocol_errors.try_recv()
            ));
        }
    }
    if let Ok(error) = protocol_errors.try_recv() {
        return Err(format!(
            "a protocol error was reported for a well-formed frame: {error}"
        ));
    }

    // The host closes its stdout; the driver sees EOF and exits. A dropped
    // simplex write half signals nothing, so the close must be explicit.
    host_stdout
        .shutdown()
        .await
        .map_err(|error| format!("host could not close its stdout: {error}"))?;
    if poll_once(driver.as_mut()).await.is_none() {
        return Err("driver did not exit on host EOF".to_owned());
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn stdio_reader_holds_a_split_utf8_sequence_until_it_completes() -> Result<(), String> {
    let (mut transport, mut host_stdout, _host_stdin) = host_pipes();
    let text = "{\"text\":\"\u{e9}\"}\n";
    let split = text
        .find('\u{e9}')
        .ok_or_else(|| "fixture has no multi-byte character".to_owned())?
        + 1;
    host_writes(&mut host_stdout, &text.as_bytes()[..split]).await?;
    let collected = {
        let mut read = transport.read_chunk();
        match poll_once(read.as_mut()).await {
            None => String::new(),
            Some(Ok(Some(chunk))) => chunk,
            Some(other) => return Err(format!("first read ended the stream: {other:?}")),
        }
    };
    host_writes(&mut host_stdout, &text.as_bytes()[split..]).await?;
    let collected = read_until_newline(&mut transport, collected).await?;
    if collected != text {
        return Err(format!(
            "split UTF-8 sequence was not reassembled: {collected:?}"
        ));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn dropped_stdio_read_keeps_a_held_partial_utf8_sequence() -> Result<(), String> {
    let (mut transport, mut host_stdout, _host_stdin) = host_pipes();
    let text = "\u{e9}\"}\n";
    host_writes(&mut host_stdout, &text.as_bytes()[..1]).await?;
    {
        let mut read = transport.read_chunk();
        if poll_once(read.as_mut()).await.is_some() {
            return Err("a lone UTF-8 lead byte must not complete a read".to_owned());
        }
    }
    host_writes(&mut host_stdout, &text.as_bytes()[1..]).await?;
    let collected = read_until_newline(&mut transport, String::new()).await?;
    if collected != text {
        return Err(format!(
            "the held lead byte was lost by the dropped read: {collected:?}"
        ));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn stdio_reader_fails_as_invalid_data_when_the_stream_ends_inside_a_utf8_sequence()
-> Result<(), String> {
    let (mut transport, mut host_stdout, _host_stdin) = host_pipes();
    host_writes(&mut host_stdout, b"{\"text\":\"\xC3").await?;
    host_stdout
        .shutdown()
        .await
        .map_err(|error| format!("host could not close its stdout: {error}"))?;
    match transport.read_chunk().await {
        Ok(Some(chunk)) if chunk == "{\"text\":\"" => {}
        other => return Err(format!("the complete prefix must arrive first: {other:?}")),
    }
    match transport.read_chunk().await {
        Err(error) if error.kind() == io::ErrorKind::InvalidData => Ok(()),
        other => Err(format!(
            "a stream ending inside a UTF-8 sequence must fail as InvalidData: {other:?}"
        )),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn stdio_reader_fails_as_invalid_data_on_an_invalid_utf8_byte() -> Result<(), String> {
    let (mut transport, mut host_stdout, _host_stdin) = host_pipes();
    host_writes(&mut host_stdout, b"\xFF\n").await?;
    // The bytes are already in the pipe and the host's stdout stays open, so
    // one poll decides: a read that held `\xFF` as an incomplete tail would
    // wait for more bytes forever instead of failing.
    let mut read = transport.read_chunk();
    match poll_once(read.as_mut()).await {
        Some(Err(error)) if error.kind() == io::ErrorKind::InvalidData => Ok(()),
        None => Err("an invalid UTF-8 byte was held as an incomplete tail: \
             the read waits for more bytes instead of failing as InvalidData"
            .to_owned()),
        Some(other) => Err(format!(
            "an invalid UTF-8 byte must fail as InvalidData: {other:?}"
        )),
    }
}

/// No capability survives the `InvalidData` refusal. A request the driver
/// already wrote settles as a transport
/// error keeping that kind, one still in the outbound queue settles as
/// `Closed`, the driver exits, and `closed` resolves.
#[tokio::test(flavor = "current_thread")]
async fn an_invalid_utf8_byte_settles_pending_requests_and_closes_the_connection()
-> Result<(), String> {
    let (transport, mut host_stdout, _host_stdin) = host_pipes();
    let (connection, driver) = Connection::new(transport);
    let closed = connection.subscribe_closed();
    let mut driver = Box::pin(driver.run());
    let mut request = Box::pin(connection.request("client/ping", None));
    if poll_once(request.as_mut()).await.is_some() {
        return Err("the request settled before the driver submitted it".to_owned());
    }
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("the driver exited before any inbound byte".to_owned());
    }

    host_writes(&mut host_stdout, b"\xFF\n").await?;
    // The driver alternates which side it prefers and its parked wait now
    // prefers the read, so the bad byte wins over this queued request: the
    // driver never takes it.
    let mut queued = Box::pin(connection.request("client/queued", None));
    if poll_once(queued.as_mut()).await.is_some() {
        return Err("the queued request settled before the driver ran".to_owned());
    }
    if poll_once(driver.as_mut()).await.is_none() {
        return Err("the driver kept reading after an invalid UTF-8 byte".to_owned());
    }
    match poll_once(request.as_mut()).await {
        Some(Err(ConnectionError::Transport(error)))
            if error.kind() == io::ErrorKind::InvalidData => {}
        other => {
            return Err(format!(
                "the pending request must settle as an InvalidData transport error: {other:?}"
            ));
        }
    }
    match poll_once(queued.as_mut()).await {
        Some(Err(ConnectionError::Closed)) => {}
        other => {
            return Err(format!(
                "a request still in the outbound queue must settle as Closed: {other:?}"
            ));
        }
    }
    if !*closed.borrow() {
        return Err("closed did not resolve after the InvalidData refusal".to_owned());
    }
    Ok(())
}

/// With a notification handler installed, the `InvalidData` refusal
/// leaves a notification the driver already accepted to the dispatcher:
/// `closed` stays unresolved until the dispatcher has applied it.
#[tokio::test(flavor = "current_thread")]
async fn an_invalid_utf8_byte_closes_only_after_accepted_notifications_apply() -> Result<(), String>
{
    let (transport, mut host_stdout, _host_stdin) = host_pipes();
    let applications = Arc::new(AtomicUsize::new(0));
    let handler_applications = Arc::clone(&applications);
    let (connection, driver, dispatcher) = Connection::with_notification_handler(
        transport,
        move |_| {
            handler_applications.fetch_add(1, Ordering::Relaxed);
        },
        |_| {},
    );
    let closed = connection.subscribe_closed();
    let mut driver = Box::pin(driver.run());
    let mut request = Box::pin(connection.request("client/ping", None));
    if poll_once(request.as_mut()).await.is_some() {
        return Err("the request settled before the driver submitted it".to_owned());
    }
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("the driver exited before any inbound byte".to_owned());
    }

    // A whole notification in its own read, accepted before the bad byte.
    let notification = json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {"sessionId": "session-1"},
    });
    host_writes(&mut host_stdout, format!("{notification}\n").as_bytes()).await?;
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("the driver exited after accepting the notification".to_owned());
    }
    host_writes(&mut host_stdout, b"\xFF\n").await?;
    if poll_once(driver.as_mut()).await.is_none() {
        return Err("the driver kept reading after an invalid UTF-8 byte".to_owned());
    }
    match poll_once(request.as_mut()).await {
        Some(Err(ConnectionError::Transport(error)))
            if error.kind() == io::ErrorKind::InvalidData => {}
        other => {
            return Err(format!(
                "the pending request must settle as an InvalidData transport error: {other:?}"
            ));
        }
    }
    if applications.load(Ordering::Relaxed) != 0 {
        return Err("the notification applied before the dispatcher ran".to_owned());
    }
    if *closed.borrow() {
        return Err("closed resolved before the accepted notification was applied".to_owned());
    }
    dispatcher.run().await;
    if applications.load(Ordering::Relaxed) != 1 {
        return Err("the dispatcher lost the accepted notification".to_owned());
    }
    if !*closed.borrow() {
        return Err("closed did not resolve after the dispatcher drained".to_owned());
    }
    Ok(())
}
