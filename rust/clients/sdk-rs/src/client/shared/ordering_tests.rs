use std::future::{Future, poll_fn};
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::task::Poll;

use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::*;
use crate::DuplexTransport;
use crate::client::{MuseClient, StartSessionOptions};
use crate::connection::{Connection, NOTIFICATION_HANDLER_CAPACITY};
use crate::msp::{SessionDurability, TurnTerminal};
use crate::session::{SendUserTurnOptions, Session};
use crate::turn::{Turn, TurnOutcome};

mod first_failure;
mod late_register;
mod marker_cap;
mod overflow_next_step;
mod router;
mod terminal_cleanup;
mod truncated_eof;

struct TestTransport {
    inbound: mpsc::UnboundedReceiver<String>,
    outbound: mpsc::UnboundedSender<String>,
    eof_observed: mpsc::UnboundedSender<()>,
}

pub(super) struct TestPeer {
    inbound: Option<mpsc::UnboundedSender<String>>,
    outbound: mpsc::UnboundedReceiver<String>,
    eof_observed: mpsc::UnboundedReceiver<()>,
}

impl DuplexTransport for TestTransport {
    fn read_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
        Box::pin(async move {
            let chunk = self.inbound.recv().await;
            if chunk.is_none() {
                let _ = self.eof_observed.send(());
            }
            Ok(chunk)
        })
    }

    fn write(&mut self, frame: &str) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        let result = self
            .outbound
            .send(frame.to_owned())
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "test peer closed"));
        Box::pin(async move { result })
    }
}

impl TestPeer {
    pub(super) async fn request(&mut self, method: &str) -> Result<Value, String> {
        let frame = self
            .outbound
            .recv()
            .await
            .ok_or_else(|| format!("driver closed before {method} was submitted"))?;
        let request = serde_json::from_str::<Value>(&frame)
            .map_err(|error| format!("submitted {method} frame is not JSON: {error}"))?;
        if request.get("method").and_then(Value::as_str) != Some(method) {
            return Err(format!("expected {method}, received {request}"));
        }
        Ok(request)
    }

    pub(super) fn send(&self, frame: Value) -> Result<(), String> {
        let inbound = self
            .inbound
            .as_ref()
            .ok_or_else(|| "test peer input is closed".to_owned())?;
        inbound
            .send(format!("{frame}\n"))
            .map_err(|_| "driver closed before receiving test frame".to_owned())
    }

    fn send_raw(&self, chunk: String) -> Result<(), String> {
        let inbound = self
            .inbound
            .as_ref()
            .ok_or_else(|| "test peer input is closed".to_owned())?;
        inbound
            .send(chunk)
            .map_err(|_| "driver closed before receiving test chunk".to_owned())
    }

    async fn close_input(&mut self) -> Result<(), String> {
        self.inbound.take();
        self.eof_observed
            .recv()
            .await
            .ok_or_else(|| "transport dropped without observing EOF".to_owned())
    }
}

pub(super) fn paused_client(
    pause_count: usize,
) -> (
    MuseClient,
    TestPeer,
    mpsc::UnboundedReceiver<usize>,
    std::sync::mpsc::Sender<()>,
    mpsc::UnboundedReceiver<usize>,
) {
    paused_client_with(pause_count, SessionDurability::Durable)
}

fn paused_client_with(
    pause_count: usize,
    durability: SessionDurability,
) -> (
    MuseClient,
    TestPeer,
    mpsc::UnboundedReceiver<usize>,
    std::sync::mpsc::Sender<()>,
    mpsc::UnboundedReceiver<usize>,
) {
    let (inbound, read) = mpsc::unbounded_channel();
    let (write, outbound) = mpsc::unbounded_channel();
    let (eof_seen, eof_observed) = mpsc::unbounded_channel();
    let transport = TestTransport {
        inbound: read,
        outbound: write,
        eof_observed: eof_seen,
    };
    let peer = TestPeer {
        inbound: Some(inbound),
        outbound,
        eof_observed,
    };
    let router = Arc::new(NotificationRouter::default());
    let route = Arc::clone(&router);
    let overflow = Arc::clone(&router);
    let entries = Arc::new(AtomicUsize::new(0));
    let handler_entries = Arc::clone(&entries);
    let applied = Arc::new(AtomicUsize::new(0));
    let handler_applied = Arc::clone(&applied);
    let overflow_applied = Arc::clone(&applied);
    let (started, application_started) = mpsc::unbounded_channel();
    let (overflow_started, overflow_observed) = mpsc::unbounded_channel();
    let (release, released) = std::sync::mpsc::channel();
    let released = Arc::new(StdMutex::new(released));
    let handler_released = Arc::clone(&released);
    let (connection, driver, dispatcher) = Connection::with_notification_handler(
        transport,
        move |notification| {
            let entry = handler_entries.fetch_add(1, Ordering::Relaxed);
            if entry < pause_count {
                let _ = started.send(entry);
                let receiver = match handler_released.lock() {
                    Ok(receiver) => receiver,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let _ = receiver.recv();
            }
            route.route(notification);
            handler_applied.fetch_add(1, Ordering::Relaxed);
        },
        move |notification| {
            let _ = overflow_started.send(overflow_applied.load(Ordering::Relaxed));
            overflow.overflow(notification);
        },
    );
    tokio::spawn(dispatcher.run());
    tokio::spawn(driver.run());
    let sequence = Arc::new(AtomicUsize::new(0));
    let minter_sequence = Arc::clone(&sequence);
    let client = MuseClient::from_connection(
        connection,
        Arc::clone(&router),
        durability,
        move || {
            let value = minter_sequence.fetch_add(1, Ordering::Relaxed);
            format!("command-{value}")
        },
        None,
        None,
    );
    (
        client,
        peer,
        application_started,
        release,
        overflow_observed,
    )
}

pub(super) async fn poll_once<F: Future>(mut future: Pin<&mut F>) -> Option<F::Output> {
    poll_fn(|context| {
        Poll::Ready(match future.as_mut().poll(context) {
            Poll::Ready(output) => Some(output),
            Poll::Pending => None,
        })
    })
    .await
}

async fn start_session(
    client: &MuseClient,
    peer: &mut TestPeer,
    session_id: &str,
) -> Result<Session, String> {
    let mut opening = Box::pin(client.start_session(StartSessionOptions::default()));
    if poll_once(opening.as_mut()).await.is_some() {
        return Err("session/start settled before submission".to_owned());
    }
    let request = peer.request("session/start").await?;
    let id = request
        .get("id")
        .cloned()
        .ok_or_else(|| "session/start request has no id".to_owned())?;
    peer.send(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "session": session_value(session_id),
            "viewCursor": "cursor-1"
        }
    }))?;
    opening
        .await
        .map_err(|error| format!("session/start failed: {error}"))
}

async fn start_turn(session: &Session, peer: &mut TestPeer, turn_id: &str) -> Result<Turn, String> {
    let mut submission = Box::pin(session.send_user_turn(SendUserTurnOptions::default()));
    if poll_once(submission.as_mut()).await.is_some() {
        return Err("turn/start settled before submission".to_owned());
    }
    let request = peer.request("turn/start").await?;
    peer.send(turn_started_reply(&request, turn_id)?)?;
    submission
        .await
        .map_err(|error| format!("turn/start failed: {error}"))
}

/// The server's `started` reply to `request`, a submitted `turn/start`.
pub(super) fn turn_started_reply(request: &Value, turn_id: &str) -> Result<Value, String> {
    let id = request
        .get("id")
        .cloned()
        .ok_or_else(|| "turn/start request has no id".to_owned())?;
    let command_id = request
        .pointer("/params/commandId")
        .cloned()
        .ok_or_else(|| "turn/start request has no command id".to_owned())?;
    Ok(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "commandId": command_id,
            "status": "accepted",
            "turnId": turn_id,
            "startedNewTurn": true,
            "disposition": "started"
        }
    }))
}

pub(super) fn session_value(session_id: &str) -> Value {
    json!({
        "sessionId": session_id,
        "path": "/tmp/session.jsonl",
        "status": "idle",
        "activeTurnId": null,
        "createdAt": "2026-09-29T00:00:00Z",
        "updatedAt": "2026-09-29T00:00:00Z",
        "workspaceRoot": null,
        "providerId": null,
        "modelId": null,
        "turnCount": 0,
        "forkedFrom": null
    })
}

fn notification(method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "method": method, "params": params})
}

pub(super) fn terminal(session_id: &str, turn_id: &str) -> Value {
    notification(
        "turn/completed",
        json!({
            "sessionId": session_id,
            "viewCursor": "cursor-terminal",
            "sourceRange": {
                "stream": {"kind": "run", "id": turn_id},
                "first": {"id": "event-terminal", "sequence": 1},
                "last": {"id": "event-terminal", "sequence": 1}
            },
            "turnId": turn_id,
            "terminal": "completed",
            "reason": null,
            "durationMs": null,
            "timeToFirstTokenMs": null,
            "usage": null,
            "error": null
        }),
    )
}

fn overflow_refusal_burst() -> String {
    let mut burst = String::new();
    for stage in ["live", "queued", "saturated"] {
        for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
            burst.push_str(
                &notification(
                    "item/completed",
                    json!({"sessionId": format!("{stage}-{sequence}")}),
                )
                .to_string(),
            );
            burst.push('\n');
        }
    }
    burst.push_str("not-json\n");
    burst.push_str(
        &notification("item/completed", json!({"sessionId": "one-too-many"})).to_string(),
    );
    burst.push('\n');
    burst
}

fn routed_notification(value: Value) -> Result<crate::msp::Notification, String> {
    serde_json::from_value(value)
        .map_err(|error| format!("test notification did not decode: {error}"))
}

async fn expect_overflow_failure(
    completed: impl Future<Output = Result<TurnOutcome, FacadeError>>,
    label: &str,
) -> Result<(), String> {
    expect_event_source_failure(
        completed,
        "notification backlog exceeded for this session; close this client, then resume the session on a new client to continue",
        label,
    )
    .await
}

async fn expect_event_source_failure(
    completed: impl Future<Output = Result<TurnOutcome, FacadeError>>,
    message: &str,
    label: &str,
) -> Result<(), String> {
    let mut completed = Box::pin(completed);
    match poll_once(completed.as_mut()).await {
        Some(Err(FacadeError::Protocol(error))) if error.message() == message => Ok(()),
        Some(Err(error)) => Err(format!("{label} settled with the wrong error: {error}")),
        Some(Ok(outcome)) => Err(format!("{label} unexpectedly completed: {outcome:?}")),
        None => Err(format!("{label} did not settle from its overflow marker")),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn eof_drains_accepted_terminal_before_settling_pending_request() -> Result<(), String> {
    let (client, mut peer, mut application_started, release, _overflow_observed) = paused_client(1);
    let session = start_session(&client, &mut peer, "session-1").await?;
    let turn = start_turn(&session, &mut peer, "turn-1").await?;

    let mut pending = Box::pin(client.start_session(StartSessionOptions::default()));
    if poll_once(pending.as_mut()).await.is_some() {
        return Err("second session/start settled before submission".to_owned());
    }
    let _request = peer.request("session/start").await?;
    peer.send(terminal("session-1", "turn-1"))?;
    if application_started.recv().await != Some(0) {
        return Err("terminal did not enter the paused notification handler".to_owned());
    }

    peer.close_input().await?;
    if poll_once(pending.as_mut()).await.is_some() {
        return Err("EOF settled the request before the accepted terminal applied".to_owned());
    }
    release
        .send(())
        .map_err(|_| "paused terminal handler closed".to_owned())?;

    match turn.completed().await {
        Ok(TurnOutcome::Completed { params, .. }) if params.terminal == TurnTerminal::Completed => {
        }
        Ok(outcome) => return Err(format!("queued terminal settled unexpectedly: {outcome:?}")),
        Err(error) => return Err(format!("queued terminal was displaced by EOF: {error}")),
    }
    let request_result = pending.as_mut().await;
    match request_result {
        Err(FacadeError::TransportEnded) => {}
        Err(error) => return Err(format!("EOF request settled with the wrong error: {error}")),
        Ok(_) => return Err("EOF request unexpectedly succeeded".to_owned()),
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn overflow_refusal_drains_terminal_before_settling_pending_request() -> Result<(), String> {
    let (client, mut peer, mut application_started, release, _overflow_observed) = paused_client(1);
    let mut protocol_errors = client.shared.connection.subscribe_protocol_errors();
    let session = start_session(&client, &mut peer, "session-1").await?;
    let turn = start_turn(&session, &mut peer, "turn-1").await?;

    let mut pending = Box::pin(client.start_session(StartSessionOptions::default()));
    if poll_once(pending.as_mut()).await.is_some() {
        return Err("second session/start settled before submission".to_owned());
    }
    let _request = peer.request("session/start").await?;
    peer.send(terminal("session-1", "turn-1"))?;
    if application_started.recv().await != Some(0) {
        return Err("terminal did not enter the paused notification handler".to_owned());
    }

    peer.send_raw(overflow_refusal_burst())?;
    protocol_errors
        .recv()
        .await
        .map_err(|error| format!("refusal trigger receipt was not observed: {error}"))?;
    if poll_once(pending.as_mut()).await.is_some() {
        return Err(
            "overflow refusal settled the request before the accepted terminal applied".to_owned(),
        );
    }
    release
        .send(())
        .map_err(|_| "paused terminal handler closed".to_owned())?;

    let receipts = async { (turn.completed().await, pending.as_mut().await) };
    // antipattern-ok(timeout-wrapper): failure-only cap; success ends on terminal and request receipts
    let settled = tokio::time::timeout(std::time::Duration::from_secs(30), receipts)
        .await
        .map_err(|_| {
            "overflow refusal did not settle the accepted terminal and request".to_owned()
        })?;
    let (turn_result, request_result) = settled;

    match turn_result {
        Ok(TurnOutcome::Completed { params, .. }) if params.terminal == TurnTerminal::Completed => {
        }
        Ok(outcome) => return Err(format!("queued terminal settled unexpectedly: {outcome:?}")),
        Err(error) => {
            return Err(format!(
                "queued terminal was displaced by overflow refusal: {error}"
            ));
        }
    }
    match request_result {
        Err(FacadeError::TransportEnded) => Ok(()),
        Err(error) => Err(format!(
            "overflow-refused request settled with the wrong error: {error}"
        )),
        Ok(_) => Err("overflow-refused request unexpectedly succeeded".to_owned()),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn overflow_failure_stays_scoped_to_affected_session() -> Result<(), String> {
    let (client, mut peer, _application_started, _release, _overflow_observed) = paused_client(0);
    let router = Arc::clone(&client.shared.router);
    let affected = start_session(&client, &mut peer, "affected").await?;
    let affected_turn = start_turn(&affected, &mut peer, "turn-affected").await?;
    let independent = start_session(&client, &mut peer, "independent").await?;
    let independent_turn = start_turn(&independent, &mut peer, "turn-independent").await?;

    router.overflow(routed_notification(notification(
        "test/overflow",
        json!({"sessionId": "affected"}),
    ))?);
    expect_overflow_failure(affected_turn.completed(), "affected session").await?;

    router.route(routed_notification(terminal(
        "independent",
        "turn-independent",
    ))?);
    let mut independent_completed = Box::pin(independent_turn.completed());
    match poll_once(independent_completed.as_mut()).await {
        Some(Ok(TurnOutcome::Completed { params, .. }))
            if params.terminal == TurnTerminal::Completed => {}
        Some(Ok(outcome)) => {
            return Err(format!(
                "independent session completed unexpectedly: {outcome:?}"
            ));
        }
        Some(Err(error)) => {
            return Err(format!("independent session inherited overflow: {error}"));
        }
        None => return Err("independent session did not apply its terminal".to_owned()),
    }

    client.close().await;
    Ok(())
}

mod replacement_health_tests;
