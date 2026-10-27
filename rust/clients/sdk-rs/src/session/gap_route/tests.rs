use std::sync::Arc;

use super::walk;
use crate::client::{MuseClient, StartSessionOptions, lock};
use crate::msp::{SessionDurability, ViewPageParams};
use crate::session::Session;
use crate::session::state::tests::{StartsOneSession, StartsThenFailsRead};
use crate::turn::TurnWaitError;

/// `close()` sets the client's closed flag before it settles each
/// session, so a walk awaiting `view/page` can see `ClientClosed` first (on a
/// multi-thread runtime). A session `close()` has not reached yet stands in
/// for that window: the walk must return without failing it, leaving `close()`
/// to settle it as `ClientClosed` rather than as a
/// `view/page` protocol failure.
#[tokio::test(flavor = "current_thread")]
async fn a_walk_that_meets_a_closing_client_leaves_its_session_to_close() -> Result<(), String> {
    let client = MuseClient::new(StartsOneSession::new(), SessionDurability::Durable);
    let session = client
        .start_session(StartSessionOptions::default())
        .await
        .map_err(|error| error.to_string())?;
    // Same client, never registered with its router, so `close()` skips it.
    let unsettled = Session::from_opening(
        Arc::clone(&session.inner.client),
        session.opening().clone(),
        &[],
        None,
    );
    client.close().await;
    assert!(
        matches!(
            lock(&session.inner.state).event_source_failure,
            Some(TurnWaitError::ClientClosed)
        ),
        "control: close() settles the session it reaches as ClientClosed"
    );

    walk(
        Arc::downgrade(&unsettled.inner),
        ViewPageParams {
            session_id: "session-1".to_owned(),
            cursor: Some("cursor-1".to_owned()),
            anchor: None,
            direction: None,
            limit: 1,
            max_bytes: None,
        },
    )
    .await;

    let failure = lock(&unsettled.inner.state).event_source_failure.clone();
    assert!(
        failure.is_none(),
        "a walk that meets a closing client must leave its session to close(): {failure:?}"
    );
    Ok(())
}

/// Answers `session/start`, then ends its stream when the next request is
/// written, so the session registers before the transport ends and that
/// request observes the end.
struct StartsThenEnds {
    inbound: tokio::sync::mpsc::UnboundedReceiver<String>,
    replies: Option<tokio::sync::mpsc::UnboundedSender<String>>,
}

impl crate::DuplexTransport for StartsThenEnds {
    fn read_chunk(
        &mut self,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = std::io::Result<Option<String>>> + Send + '_>,
    > {
        Box::pin(async { Ok(self.inbound.recv().await) })
    }

    fn write(
        &mut self,
        frame: &str,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = std::io::Result<()>> + Send + '_>> {
        let request = serde_json::from_str::<serde_json::Value>(frame.trim()).ok();
        let starts = request
            .as_ref()
            .is_some_and(|request| request["method"] == "session/start");
        if !starts {
            self.replies = None;
        } else if let (Some(request), Some(replies)) = (request, self.replies.as_ref()) {
            let reply = serde_json::json!({
                "jsonrpc": "2.0",
                "id": request["id"],
                "result": {
                    "session": {
                        "sessionId": "session-1",
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
                    },
                    "viewCursor": "cursor-1"
                }
            });
            let _ = replies.send(format!("{reply}\n"));
        }
        Box::pin(async { Ok(()) })
    }
}

/// A transport end with no `close()` sets the client's `transport_ended` flag
/// before it settles each session, so a walk that issues its next `view/page`
/// in that window is refused with `TransportEnded` first. A session the transport-end sweep has not reached
/// stands in for that window. The walk must return and leave the sweep to
/// settle the session as `TransportEnded`, as it does for `close()`.
#[tokio::test(flavor = "current_thread")]
async fn a_walk_that_meets_an_ended_transport_leaves_its_session_to_the_sweep() -> Result<(), String>
{
    let (replies, inbound) = tokio::sync::mpsc::unbounded_channel();
    let client = MuseClient::new(
        StartsThenEnds {
            inbound,
            replies: Some(replies),
        },
        SessionDurability::Durable,
    );
    let session = client
        .start_session(StartSessionOptions::default())
        .await
        .map_err(|error| error.to_string())?;
    // Same client, never registered with its router, so the sweep skips it.
    let unsettled = Session::from_opening(
        Arc::clone(&session.inner.client),
        session.opening().clone(),
        &[],
        None,
    );
    // A request that observes the ended transport sets the flag and runs the
    // sweep before it returns.
    let ended = session
        .send_user_turn(crate::session::SendUserTurnOptions::default())
        .await
        .err();
    assert!(
        matches!(ended, Some(crate::client::FacadeError::TransportEnded)),
        "control: the request observes the ended transport, got {ended:?}"
    );
    assert!(
        matches!(
            lock(&session.inner.state).event_source_failure,
            Some(TurnWaitError::SourceClosed)
        ),
        "control: the sweep settles the session it reaches as SourceClosed (TransportEnded), got {:?}",
        lock(&session.inner.state).event_source_failure
    );

    walk(
        Arc::downgrade(&unsettled.inner),
        ViewPageParams {
            session_id: "session-1".to_owned(),
            cursor: Some("cursor-1".to_owned()),
            anchor: None,
            direction: None,
            limit: 1,
            max_bytes: None,
        },
    )
    .await;

    let failure = lock(&unsettled.inner.state).event_source_failure.clone();
    assert!(
        failure.is_none(),
        "a walk that meets an ended transport must leave its session to the sweep: {failure:?}"
    );
    Ok(())
}

/// A connection that breaks with a read error, rather than a clean end, fails
/// every pending request with that I/O error, and the driver's end then runs
/// the transport-end sweep. A walk whose `view/page` is pending at that moment
/// must return and leave its session to that sweep, as it does for a clean
/// transport end, rather than fail it with the read error.
#[tokio::test(flavor = "current_thread")]
async fn a_walk_cut_short_by_a_read_error_leaves_its_session_to_the_sweep() -> Result<(), String> {
    let client = MuseClient::new(
        StartsThenFailsRead::new("view/page"),
        SessionDurability::Durable,
    );
    let session = client
        .start_session(StartSessionOptions::default())
        .await
        .map_err(|error| error.to_string())?;
    // A turn of the registered session, which the sweep reaches.
    let swept = session.inner.claim_turn_for_ordering_tests("turn-0");
    // Same client, never registered with its router, so the sweep skips it.
    let unsettled = Session::from_opening(
        Arc::clone(&session.inner.client),
        session.opening().clone(),
        &[],
        None,
    );

    walk(
        Arc::downgrade(&unsettled.inner),
        ViewPageParams {
            session_id: "session-1".to_owned(),
            cursor: Some("cursor-1".to_owned()),
            anchor: None,
            direction: None,
            limit: 1,
            max_bytes: None,
        },
    )
    .await;

    let failure = lock(&unsettled.inner.state).event_source_failure.clone();
    assert!(
        failure.is_none(),
        "a walk cut short by a read error must leave its session to the sweep: {failure:?}"
    );
    // antipattern-ok(timeout-wrapper): failure-only cap; success ends when the sweep settles the registered turn
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(5), swept.completed())
        .await
        .map_err(|_| "control: the sweep never settled the registered turn".to_owned())?;
    assert!(
        matches!(outcome, Err(crate::client::FacadeError::TransportEnded)),
        "control: the read error's sweep settles the sessions it reaches as TransportEnded, got {outcome:?}"
    );
    Ok(())
}
