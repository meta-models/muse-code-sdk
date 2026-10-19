//! The arrival order of the turn's terminal and the retry's answer, and the
//! wait that preserves it.

use super::*;

/// The turn's live terminal reaches the wire before the retry's answer, but the
/// notification handler is held, so the SDK has not applied it when the answer
/// resolves. The retry must still settle from that terminal, as
/// `TurnOutcome::Completed`, not from the resume's `lastTurn`.
#[tokio::test(flavor = "current_thread")]
async fn a_terminal_received_before_the_retry_answer_settles_the_retry_completed()
-> Result<(), String> {
    let (client, mut peer, mut started, release, _overflow) = paused_client(1);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;

    peer.send(terminal(SESSION, ENDED_TURN))?;
    if capped("the held terminal", started.recv()).await? != Some(0) {
        return Err("the handler did not hold the turn's terminal".to_owned());
    }
    let mut retry = Box::pin(session.send_user_turn(SendUserTurnOptions::default()));
    if poll_once(retry.as_mut()).await.is_some() {
        return Err("turn/start settled before submission".to_owned());
    }
    let request = capped("turn/start submission", peer.request("turn/start")).await??;
    peer.send(turn_started_reply(&request, ENDED_TURN)?)?;
    // A later answer proves the driver has read the retry's answer: frames are
    // read in order.
    read_fence(&session, &mut peer).await?;
    if poll_once(retry.as_mut()).await.is_some() {
        return Err(
            "the retry returned before the terminal received ahead of its answer was applied"
                .to_owned(),
        );
    }

    release
        .send(())
        .map_err(|_| "the held handler is gone".to_owned())?;
    let turn = capped("the same-command retry", retry)
        .await?
        .map_err(|error| format!("the same-command retry failed: {error}"))?;
    match capped("the retried turn", turn.completed()).await? {
        Ok(TurnOutcome::Completed { params, .. })
            if params.turn_id == ENDED_TURN && params.terminal == TurnTerminal::Completed =>
        {
            Ok(())
        }
        other => Err(format!(
            "a terminal received before the answer must settle the retry Completed, got {other:?}"
        )),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn inline_history_retry_answered_before_any_terminal_settles_ended() -> Result<(), String> {
    retry_answered_before_any_terminal_settles_ended(History::Inline).await
}

#[tokio::test(flavor = "current_thread")]
async fn snapshot_history_retry_answered_before_any_terminal_settles_ended() -> Result<(), String> {
    retry_answered_before_any_terminal_settles_ended(History::Snapshot).await
}

#[tokio::test(flavor = "current_thread")]
async fn anchored_snapshot_history_retry_answered_before_any_terminal_settles_ended()
-> Result<(), String> {
    retry_answered_before_any_terminal_settles_ended(History::AnchoredSnapshot).await
}

#[tokio::test(flavor = "current_thread")]
async fn cursor_suffix_retry_answered_before_any_terminal_settles_ended() -> Result<(), String> {
    retry_answered_before_any_terminal_settles_ended(History::None).await
}

/// The retry's answer arrives before any terminal for the turn, so the retry
/// settles from the resume's `lastTurn` as `TurnOutcome::Ended`, after
/// replaying the turn's history item where the mode serves one. A terminal
/// that arrives after the answer leaves it `Ended`, and the submission leaves
/// `pending()`.
async fn retry_answered_before_any_terminal_settles_ended(history: History) -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let session = resume_after_the_turn_ended(&client, &mut peer, history).await?;

    let mut retry = Box::pin(session.send_user_turn(SendUserTurnOptions::default()));
    if poll_once(retry.as_mut()).await.is_some() {
        return Err("turn/start settled before submission".to_owned());
    }
    let request = capped("turn/start submission", peer.request("turn/start")).await??;
    peer.send(turn_started_reply(&request, ENDED_TURN)?)?;
    let turn = capped("the same-command retry", retry)
        .await?
        .map_err(|error| format!("the same-command retry failed: {error}"))?;
    peer.send(terminal(SESSION, ENDED_TURN))?;

    match capped("the retried turn", turn.completed()).await? {
        Ok(TurnOutcome::Ended(last_turn))
            if last_turn.turn_id == ENDED_TURN && last_turn.terminal == TurnTerminal::Completed => {
        }
        other => {
            return Err(format!(
                "an answer received before any terminal must settle the retry Ended, got {other:?}"
            ));
        }
    }
    let mut items = turn.items();
    if !matches!(history, History::None) {
        match capped("the replayed item", items.recv()).await? {
            Ok(Some(item)) if item.item_id == "item-ended" => {}
            other => {
                return Err(format!(
                    "the retry must replay the ended turn's history item, got {other:?}"
                ));
            }
        }
    }
    if !matches!(
        capped("the item stream's end", items.recv()).await?,
        Ok(None)
    ) {
        return Err("the history item must replay once, and only where served".to_owned());
    }
    if !session.pending().is_empty() {
        return Err("a retry settled Ended must leave pending()".to_owned());
    }
    Ok(())
}

/// A retry the caller cancels while it waits for the notifications received
/// before its answer keeps nothing, like any other cancelled call: it leaves
/// `pending()`.
#[tokio::test(flavor = "current_thread")]
async fn a_retry_cancelled_while_it_waits_leaves_pending() -> Result<(), String> {
    let (client, mut peer, mut started, release, _overflow) = paused_client(1);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;

    peer.send(terminal(SESSION, ENDED_TURN))?;
    if capped("the held terminal", started.recv()).await? != Some(0) {
        return Err("the handler did not hold the turn's terminal".to_owned());
    }
    let mut retry = Box::pin(session.send_user_turn(SendUserTurnOptions::default()));
    if poll_once(retry.as_mut()).await.is_some() {
        return Err("turn/start settled before submission".to_owned());
    }
    let request = capped("turn/start submission", peer.request("turn/start")).await??;
    peer.send(turn_started_reply(&request, ENDED_TURN)?)?;
    read_fence(&session, &mut peer).await?;
    if poll_once(retry.as_mut()).await.is_some() {
        return Err("control: the retry must be waiting for the held terminal".to_owned());
    }
    if session.pending().len() != 1 {
        return Err("control: the waiting retry is still listed in pending()".to_owned());
    }

    drop(retry);
    let _ = release.send(());
    if session.pending().is_empty() {
        Ok(())
    } else {
        Err("a retry cancelled while it waits must leave pending()".to_owned())
    }
}

/// Several notifications ahead of the answer reach the handler as one batch;
/// the wait counts each of them, so the retry claims only after the terminal
/// at the end of that batch is applied.
#[tokio::test(flavor = "current_thread")]
async fn a_terminal_at_the_end_of_a_batch_ahead_of_the_answer_settles_completed()
-> Result<(), String> {
    let (client, mut peer, mut started, release, _overflow) = paused_client(1);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;

    // Held on entry, so the next two frames queue up behind it as one batch.
    peer.send(terminal("other-session", "turn-other"))?;
    if capped("the held notification", started.recv()).await? != Some(0) {
        return Err("the handler did not hold the first notification".to_owned());
    }
    peer.send(terminal("other-session", "turn-other-2"))?;
    peer.send(terminal(SESSION, ENDED_TURN))?;
    let mut retry = Box::pin(session.send_user_turn(SendUserTurnOptions::default()));
    if poll_once(retry.as_mut()).await.is_some() {
        return Err("turn/start settled before submission".to_owned());
    }
    let request = capped("turn/start submission", peer.request("turn/start")).await??;
    peer.send(turn_started_reply(&request, ENDED_TURN)?)?;
    release
        .send(())
        .map_err(|_| "the held handler is gone".to_owned())?;
    let turn = capped("the same-command retry", retry)
        .await?
        .map_err(|error| format!("the same-command retry failed: {error}"))?;
    match capped("the retried turn", turn.completed()).await? {
        Ok(TurnOutcome::Completed { params, .. }) if params.turn_id == ENDED_TURN => Ok(()),
        other => Err(format!(
            "a terminal batched ahead of the answer must settle the retry Completed, got {other:?}"
        )),
    }
}
