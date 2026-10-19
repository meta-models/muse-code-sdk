//! A session keeps its first event-source failure. A transport
//! EOF or a client close after a notification overflow is a second failure,
//! so a turn claimed after both still fails with the overflow, not
//! `TransportEnded` or `ClientClosed`; a client close after a transport EOF
//! leaves it `TransportEnded`.

use std::sync::Arc;

use serde_json::json;

use super::{
    expect_overflow_failure, notification, paused_client, poll_once, routed_notification,
    start_session, turn_started_reply,
};
use crate::client::FacadeError;
use crate::session::SendUserTurnOptions;

fn overflow_for(session_id: &str) -> Result<crate::msp::Notification, String> {
    routed_notification(notification(
        "test/overflow",
        json!({"sessionId": session_id}),
    ))
}

/// The `turn/start` reply is read before EOF, but its caller resumes only
/// after the session has seen the overflow and then EOF, so the claim that
/// reply makes comes after both failures and reads the first.
#[tokio::test(flavor = "current_thread")]
async fn overflow_then_transport_eof_keeps_the_overflow_for_a_later_claim() -> Result<(), String> {
    let (client, mut peer, _application_started, _release, _overflow_observed) = paused_client(0);
    let router = Arc::clone(&client.shared.router);
    let session = start_session(&client, &mut peer, "session-1").await?;
    let mut submission = Box::pin(session.send_user_turn(SendUserTurnOptions::default()));
    if poll_once(submission.as_mut()).await.is_some() {
        return Err("turn/start settled before submission".to_owned());
    }
    let request = peer.request("turn/start").await?;

    router.overflow(overflow_for("session-1")?);
    peer.send(turn_started_reply(&request, "turn-late")?)?;
    // The driver hands over every frame of a chunk before it reads the next
    // one, so the reply is waiting on its request once EOF is seen.
    peer.close_input().await?;
    // The driver-closed watcher makes this same call; making it here puts EOF
    // before the claim without waiting on that task.
    client.shared.mark_transport_ended();

    let turn = submission
        .await
        .map_err(|error| format!("turn/start read before EOF failed: {error}"))?;
    expect_overflow_failure(turn.completed(), "a turn claimed after overflow then EOF").await
}

#[tokio::test(flavor = "current_thread")]
async fn overflow_then_client_close_keeps_the_overflow_for_a_later_claim() -> Result<(), String> {
    let (client, mut peer, _application_started, _release, _overflow_observed) = paused_client(0);
    let router = Arc::clone(&client.shared.router);
    let session = start_session(&client, &mut peer, "session-1").await?;
    let inner = session.downgrade().upgrade().ok_or("session alive")?;

    router.overflow(overflow_for("session-1")?);
    client.close().await;

    let turn = inner.claim_turn_for_ordering_tests("turn-late");
    expect_overflow_failure(
        turn.completed(),
        "a turn claimed after overflow then client close",
    )
    .await
}

/// With no overflow, a transport EOF is the first failure, so the close after
/// it leaves a later claim with `TransportEnded`, not `ClientClosed`.
#[tokio::test(flavor = "current_thread")]
async fn transport_eof_then_client_close_keeps_transport_ended_for_a_later_claim()
-> Result<(), String> {
    let (client, mut peer, _application_started, _release, _overflow_observed) = paused_client(0);
    let session = start_session(&client, &mut peer, "session-1").await?;
    let inner = session.downgrade().upgrade().ok_or("session alive")?;

    peer.close_input().await?;
    // As in the overflow-then-EOF test: EOF reaches the session before close.
    client.shared.mark_transport_ended();
    client.close().await;

    let turn = inner.claim_turn_for_ordering_tests("turn-late");
    let mut completed = Box::pin(turn.completed());
    match poll_once(completed.as_mut()).await {
        Some(Err(FacadeError::TransportEnded)) => Ok(()),
        Some(Err(error)) => Err(format!(
            "a turn claimed after EOF then client close settled with the wrong error: {error}"
        )),
        Some(Ok(outcome)) => Err(format!(
            "a turn claimed after EOF then client close unexpectedly completed: {outcome:?}"
        )),
        None => Err("a turn claimed after EOF then client close did not settle".to_owned()),
    }
}
