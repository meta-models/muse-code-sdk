//! A truncated-frame EOF fails pending requests before the
//! accepted-notification drain, unlike a clean EOF.

use super::{paused_client, poll_once, start_session, start_turn, terminal};
use crate::client::{FacadeError, StartSessionOptions};
use crate::msp::TurnTerminal;
use crate::turn::TurnOutcome;

#[tokio::test(flavor = "current_thread")]
async fn truncated_eof_fails_pending_request_before_the_accepted_terminal_applies()
-> Result<(), String> {
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

    // Unlike a clean EOF, a cut trailing frame fails pending requests with its
    // protocol error before the accepted-notification drain.
    peer.send_raw("{\"jsonrpc\":".to_owned())?;
    peer.close_input().await?;
    // `close_input` returns once the driver has seen EOF, and it reports the cut
    // frame in that same poll; a report deferred past the drain fails here
    // instead of waiting on the paused handler.
    let reported = protocol_errors
        .try_recv()
        .map_err(|error| format!("truncated frame was not reported before the drain: {error}"))?;
    if !reported.message().contains("truncated frame") {
        return Err(format!("unexpected protocol error: {}", reported.message()));
    }
    match poll_once(pending.as_mut()).await {
        Some(Err(FacadeError::Protocol(error))) if error.message() == reported.message() => {}
        Some(Err(error)) => {
            return Err(format!(
                "truncated EOF settled the request wrongly: {error}"
            ));
        }
        Some(Ok(_)) => return Err("truncated EOF request unexpectedly succeeded".to_owned()),
        None => {
            return Err("truncated EOF waited for the accepted-notification drain".to_owned());
        }
    }
    release
        .send(())
        .map_err(|_| "paused terminal handler closed".to_owned())?;

    match turn.completed().await {
        Ok(TurnOutcome::Completed { params, .. }) if params.terminal == TurnTerminal::Completed => {
            Ok(())
        }
        Ok(outcome) => Err(format!("queued terminal settled unexpectedly: {outcome:?}")),
        Err(error) => Err(format!("queued terminal was displaced by EOF: {error}")),
    }
}
