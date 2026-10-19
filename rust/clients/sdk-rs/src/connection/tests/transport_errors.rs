use std::sync::atomic::AtomicBool;

use super::*;

struct FaultTransport {
    incoming: mpsc::Receiver<io::Result<Option<String>>>,
    outgoing: mpsc::Sender<String>,
    fail_next_write: Arc<AtomicBool>,
}

struct FaultPeer {
    incoming: mpsc::Sender<io::Result<Option<String>>>,
    outgoing: mpsc::Receiver<String>,
    fail_next_write: Arc<AtomicBool>,
}

impl DuplexTransport for FaultTransport {
    fn read_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
        Box::pin(async move {
            match self.incoming.recv().await {
                Some(result) => result,
                None => Ok(None),
            }
        })
    }

    fn write(&mut self, frame: &str) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        let fail = self.fail_next_write.swap(false, Ordering::Relaxed);
        let outgoing = self.outgoing.clone();
        let frame = frame.to_owned();
        Box::pin(async move {
            if fail {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "scripted write failure",
                ));
            }
            outgoing
                .send(frame)
                .await
                .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "test peer closed"))
        })
    }
}

fn fault_transport() -> (FaultTransport, FaultPeer) {
    let (incoming, read) = mpsc::channel(4);
    let (write, outgoing) = mpsc::channel(4);
    let fail_next_write = Arc::new(AtomicBool::new(false));
    (
        FaultTransport {
            incoming: read,
            outgoing: write,
            fail_next_write: Arc::clone(&fail_next_write),
        },
        FaultPeer {
            incoming,
            outgoing,
            fail_next_write,
        },
    )
}

#[derive(Clone, Copy, Debug)]
enum TransportFailure {
    InboundRead,
    RequestWrite,
    NotificationWrite,
    ServerRequestReplyWrite,
}

fn require_transport_error<T>(
    result: Result<T, ConnectionError>,
    context: &str,
) -> Result<(), String> {
    match result {
        Err(ConnectionError::Transport(error)) if error.kind() == io::ErrorKind::BrokenPipe => {
            Ok(())
        }
        Err(error) => Err(format!("{context} returned the wrong error: {error}")),
        Ok(_) => Err(format!("{context} unexpectedly succeeded")),
    }
}

async fn require_transport_exit_bypasses_drain(failure: TransportFailure) -> Result<(), String> {
    let (transport, mut peer) = fault_transport();
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
    let mut pending = Box::pin(connection.request("test/pending", None));
    if poll_once(pending.as_mut()).await.is_some() {
        return Err(format!("{failure:?}: request settled before submission"));
    }
    if poll_once(driver.as_mut()).await.is_some() {
        return Err(format!("{failure:?}: driver stopped after submission"));
    }
    peer.outgoing
        .recv()
        .await
        .ok_or_else(|| format!("{failure:?}: driver did not submit the request"))?;

    peer.incoming
        .send(Ok(Some(format!(
            "{}\n",
            json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"session-1"}})
        ))))
        .await
        .map_err(|_| format!("{failure:?}: notification did not reach the driver"))?;
    if poll_once(driver.as_mut()).await.is_some() {
        return Err(format!(
            "{failure:?}: driver stopped after accepting the notification"
        ));
    }

    match failure {
        TransportFailure::InboundRead => {
            peer.incoming
                .send(Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "scripted read failure",
                )))
                .await
                .map_err(|_| "read failure did not reach the driver".to_owned())?;
            if poll_once(driver.as_mut()).await.is_none() {
                return Err("inbound read error waited for the notification drain".to_owned());
            }
        }
        TransportFailure::RequestWrite => {
            peer.fail_next_write.store(true, Ordering::Relaxed);
            let mut failed = Box::pin(connection.request("test/write-failure", None));
            if poll_once(failed.as_mut()).await.is_some() {
                return Err("failed request settled before the driver wrote it".to_owned());
            }
            if poll_once(driver.as_mut()).await.is_none() {
                return Err("request write error waited for the notification drain".to_owned());
            }
            require_transport_error(failed.await, "failed request")?;
        }
        TransportFailure::NotificationWrite => {
            peer.fail_next_write.store(true, Ordering::Relaxed);
            let mut failed = Box::pin(connection.notify("test/write-failure", None));
            if poll_once(failed.as_mut()).await.is_some() {
                return Err("failed notification settled before the driver wrote it".to_owned());
            }
            if poll_once(driver.as_mut()).await.is_none() {
                return Err("notification write error waited for the notification drain".to_owned());
            }
            require_transport_error(failed.await, "failed notification")?;
        }
        TransportFailure::ServerRequestReplyWrite => {
            // The driver answers a server-initiated request with a
            // -32601 reply; a failed reply write is the fourth transport exit.
            // A client-owned connection routes `approval/request` and
            // `userInput/request`, so this uses a
            // method no connection routes.
            peer.fail_next_write.store(true, Ordering::Relaxed);
            let frame = json!({"jsonrpc":"2.0","id":7,"method":"test/unroutedRequest","params":{}});
            peer.incoming
                .send(Ok(Some(format!("{frame}\n"))))
                .await
                .map_err(|_| "server request did not reach the driver".to_owned())?;
            if poll_once(driver.as_mut()).await.is_none() {
                return Err(
                    "server-request reply write error waited for the notification drain".to_owned(),
                );
            }
        }
    }

    require_transport_error(pending.await, "pending request")?;
    if applications.load(Ordering::Relaxed) != 0 {
        return Err(format!(
            "{failure:?}: notification applied before the dispatcher ran"
        ));
    }
    if *closed.borrow() {
        return Err(format!(
            "{failure:?}: connection closed before its notification drained"
        ));
    }
    dispatcher.run().await;
    if applications.load(Ordering::Relaxed) != 1 {
        return Err(format!(
            "{failure:?}: dispatcher lost the accepted notification"
        ));
    }
    if !*closed.borrow() {
        return Err(format!(
            "{failure:?}: dispatcher drained without publishing closure"
        ));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn transport_error_exits_bypass_notification_drain() -> Result<(), String> {
    for failure in [
        TransportFailure::InboundRead,
        TransportFailure::RequestWrite,
        TransportFailure::NotificationWrite,
        TransportFailure::ServerRequestReplyWrite,
    ] {
        require_transport_exit_bypasses_drain(failure).await?;
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn malformed_recovery_observation_keeps_msp_error_and_connection_usable() -> Result<(), String>
{
    let session_id = "550e8400-e29b-41d4-a716-446655440000";
    for reason in ["recoverySelectionCommitUnknown", "recoveryUnavailable"] {
        for observation in [
            Value::Null,
            json!({}),
            json!([]),
            json!({"requestedMode": null}),
            json!([
                session_id,
                "0198f0ab-2222-7000-8000-0000000000bb",
                "on",
                "on",
                "request",
                "qualified"
            ]),
        ] {
            let (transport, mut peer) = test_transport();
            let (connection, driver) = Connection::new(transport);
            let mut driver = Box::pin(driver.run());
            let mut pending = Box::pin(connection.request("session/resume", None));
            assert!(poll_once(pending.as_mut()).await.is_none());
            assert!(poll_once(driver.as_mut()).await.is_none());
            let request = peer
                .outgoing
                .try_recv()
                .map_err(|error| error.to_string())?;
            let id = request_id(&request).ok_or("resume request ID")?;
            let response = json!({"jsonrpc": "2.0", "id": id, "error": {
                "code": -32603, "message": "recovery refused", "data": {
                    "kind": "internal", "reason": reason, "sessionId": session_id,
                    "recoveryObservation": observation
                }
            }});
            peer.incoming
                .send(format!("{response}\n"))
                .map_err(|error| error.to_string())?;
            assert!(poll_once(driver.as_mut()).await.is_none());
            let result = poll_once(pending.as_mut())
                .await
                .ok_or("resume stayed pending")?;
            let Err(ConnectionError::Msp(error)) = result else {
                return Err(format!(
                    "expected structured recovery refusal, got {result:?}"
                ));
            };
            assert_eq!(error.code(), -32603);
            assert_eq!(error.kind(), crate::msp::ErrorKind::Internal);
            assert_eq!(error.data().reason.as_deref(), Some(reason));
            assert_eq!(error.data().session_id.as_deref(), Some(session_id));
            assert!(error.data().recovery_observation.is_none());

            let mut read = Box::pin(connection.request("session/read", None));
            assert!(poll_once(read.as_mut()).await.is_none());
            assert!(poll_once(driver.as_mut()).await.is_none());
            let request = peer
                .outgoing
                .try_recv()
                .map_err(|error| error.to_string())?;
            let id = request_id(&request).ok_or("read request ID")?;
            let response = json!({"jsonrpc": "2.0", "id": id, "result": {
                "session": {"sessionId": session_id, "path": "", "status": "notLoaded",
                    "activeTurnId": null, "createdAt": "2026-10-17T00:00:00Z", "updatedAt": "2026-10-17T00:00:00Z",
                    "turnCount": 0, "workspaceRoot": null, "providerId": null, "modelId": null, "forkedFrom": null},
                "viewCursor": "cursor-1", "history": {"mode": "inline", "items": [], "snapshot": null},
                "pendingRequests": [], "recoveryObservation": observation
            }});
            peer.incoming
                .send(format!("{response}\n"))
                .map_err(|error| error.to_string())?;
            assert!(poll_once(driver.as_mut()).await.is_none());
            let result = poll_once(read.as_mut())
                .await
                .ok_or("read stayed pending")?
                .map_err(|error| error.to_string())?;
            let read: crate::msp::method::lifecycle::SessionReadResult =
                serde_json::from_value(json!(result)).map_err(|error| error.to_string())?;
            assert_eq!(read.session.session_id, session_id);
            assert!(read.recovery_observation.is_none());
            drop(peer.incoming);
            assert!(poll_once(driver.as_mut()).await.is_some());
        }
    }
    Ok(())
}
