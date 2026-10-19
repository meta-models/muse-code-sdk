//! The edges of the ordering promise: a released settled-turn hold, a local
//! fault, a gap fill that holds the terminal back, and frames the handoff never
//! counts.

use super::*;

/// `resolve_reconnect(Vec::new())` releases the resumed session's hold on
/// settled turns, but the session keeps the turn the resume restates as
/// `lastTurn` once it settles. A retry answered with that turn still settles
/// on the terminal this session applied, with the history its route replayed,
/// whichever came first: the terminal or the release.
#[tokio::test(flavor = "current_thread")]
async fn a_retry_after_the_settled_turn_hold_is_released_settles_on_the_applied_terminal()
-> Result<(), String> {
    for terminal_first in [true, false] {
        let (client, mut peer, _started, _release, _overflow) = paused_client(0);
        let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;
        if terminal_first {
            peer.send(terminal(SESSION, ENDED_TURN))?;
            read_and_apply_earlier_frames(&client, &session, &mut peer).await?;
        }
        capped("the hold release", session.resolve_reconnect(Vec::new()))
            .await?
            .map_err(|error| format!("releasing the hold failed: {error}"))?;
        if !terminal_first {
            peer.send(terminal(SESSION, ENDED_TURN))?;
            read_and_apply_earlier_frames(&client, &session, &mut peer).await?;
        }

        let turn = answered_retry(&session, &mut peer, |request| {
            turn_started_reply(request, ENDED_TURN)
        })
        .await?;
        match capped("the retried turn", turn.completed()).await? {
            Ok(TurnOutcome::Completed { params, .. }) if params.turn_id == ENDED_TURN => {}
            other => {
                return Err(format!(
                    "with the hold released (terminal first: {terminal_first}), a retry naming \
                     lastTurn settles on the applied terminal, got {other:?}"
                ));
            }
        }
        let mut items = turn.items();
        match capped("the replayed item", items.recv()).await? {
            Ok(Some(item)) if item.item_id == "item-ended" => {}
            other => {
                return Err(format!(
                    "the retry carries the history its route replayed (terminal first: \
                     {terminal_first}), got {other:?}"
                ));
            }
        }
        if !session.pending().is_empty() {
            return Err(format!(
                "a settled retry leaves pending() (terminal first: {terminal_first})"
            ));
        }
    }
    Ok(())
}

/// A malformed frame naming the ended turn fails and retires its route here,
/// with no terminal applied. The resume still says the turn ended, so a retry
/// answered with it settles `Ended` from that `lastTurn`, with the history its
/// route replayed, whether or not the hold was released first.
#[tokio::test(flavor = "current_thread")]
async fn a_retry_of_a_turn_a_local_fault_retired_settles_ended() -> Result<(), String> {
    for release_first in [false, true] {
        let (client, mut peer, _started, _release, _overflow) = paused_client(0);
        let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;
        // A live `turn/started` opens the route, after the held item it
        // replays; a live item follows.
        peer.send(turn_started(ENDED_TURN))?;
        peer.send(live_item(ENDED_TURN, "item-live"))?;
        peer.send(malformed_terminal(ENDED_TURN))?;
        read_and_apply_earlier_frames(&client, &session, &mut peer).await?;
        if release_first {
            capped("the hold release", session.resolve_reconnect(Vec::new()))
                .await?
                .map_err(|error| format!("releasing the hold failed: {error}"))?;
        }

        let turn = answered_retry(&session, &mut peer, |request| {
            turn_started_reply(request, ENDED_TURN)
        })
        .await?;
        match capped("the retried turn", turn.completed()).await? {
            Ok(TurnOutcome::Ended(last_turn)) if last_turn.turn_id == ENDED_TURN => {}
            other => {
                return Err(format!(
                    "a retry of a fault-retired turn settles Ended (hold released: \
                     {release_first}), got {other:?}"
                ));
            }
        }
        if !turn.observed_start() {
            return Err("the retry keeps the route's observed `turn/started`".to_owned());
        }
        let mut items = turn.items();
        for expected in ["item-ended", "item-live"] {
            match capped("the route's items", items.recv()).await? {
                Ok(Some(item)) if item.item_id == expected => {}
                other => {
                    return Err(format!(
                        "the retry carries the route's items in order, expected {expected}, \
                         got {other:?}"
                    ));
                }
            }
        }
        if !matches!(
            capped("the item stream's end", items.recv()).await?,
            Ok(None)
        ) {
            return Err("the retry's item stream ends after the route's items".to_owned());
        }
        if !matches!(
            capped("the delta stream's end", turn.deltas().recv()).await?,
            Ok(None)
        ) {
            return Err("the retry's delta stream ends".to_owned());
        }
        if !session.pending().is_empty() {
            return Err("a retry settled Ended leaves pending()".to_owned());
        }
    }
    Ok(())
}

/// After a local fault retired the ended turn's route, a failed event source
/// still wins: the retry keeps a failure and stays in `pending()` for a
/// reconnect, as for any claim after a lost event source.
#[tokio::test(flavor = "current_thread")]
async fn a_failed_event_source_after_a_local_fault_keeps_the_retry_failed_and_pending()
-> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;
    peer.send(malformed_terminal(ENDED_TURN))?;
    read_and_apply_earlier_frames(&client, &session, &mut peer).await?;
    capped("the hold release", session.resolve_reconnect(Vec::new()))
        .await?
        .map_err(|error| format!("releasing the hold failed: {error}"))?;
    let inner = session.downgrade().upgrade().ok_or("session alive")?;
    inner.fail_event_source(crate::turn::TurnWaitError::EventSourceFailed {
        message: "test fault".to_owned(),
    });

    let turn = answered_retry(&session, &mut peer, |request| {
        turn_started_reply(request, ENDED_TURN)
    })
    .await?;
    let outcome = capped("the retried turn", turn.completed()).await?;
    if outcome.is_ok() {
        return Err(format!(
            "after a failed event source the retry keeps a failure, got {outcome:?}"
        ));
    }
    if session.pending().len() == 1 {
        Ok(())
    } else {
        Err("after a failed event source the retry stays in pending()".to_owned())
    }
}

/// Once the ended turn's own terminal has settled its route here, a failed
/// event source does not displace it: a retry still settles `Completed` and
/// leaves `pending()`.
#[tokio::test(flavor = "current_thread")]
async fn a_failed_event_source_after_the_terminal_still_settles_the_retry_completed()
-> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;
    peer.send(terminal(SESSION, ENDED_TURN))?;
    read_and_apply_earlier_frames(&client, &session, &mut peer).await?;
    capped("the hold release", session.resolve_reconnect(Vec::new()))
        .await?
        .map_err(|error| format!("releasing the hold failed: {error}"))?;
    let inner = session.downgrade().upgrade().ok_or("session alive")?;
    inner.fail_event_source(crate::turn::TurnWaitError::EventSourceFailed {
        message: "test fault".to_owned(),
    });

    let turn = answered_retry(&session, &mut peer, |request| {
        turn_started_reply(request, ENDED_TURN)
    })
    .await?;
    match capped("the retried turn", turn.completed()).await? {
        Ok(TurnOutcome::Completed { params, .. }) if params.turn_id == ENDED_TURN => {}
        other => {
            return Err(format!(
                "a failed event source does not displace the applied terminal, got {other:?}"
            ));
        }
    }
    if session.pending().is_empty() {
        Ok(())
    } else {
        Err("a retry settled on the applied terminal leaves pending()".to_owned())
    }
}

/// A retry that finds the kept route settles from it without a claim, so the
/// active-turn cap does not refuse it: `Completed` after the turn's own
/// terminal, `Ended` after a local fault.
#[tokio::test(flavor = "current_thread")]
async fn a_kept_route_retry_settles_at_the_active_turn_cap() -> Result<(), String> {
    for fault in [false, true] {
        let (client, mut peer, _started, _release, _overflow) = paused_client(0);
        let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;
        peer.send(if fault {
            malformed_terminal(ENDED_TURN)
        } else {
            terminal(SESSION, ENDED_TURN)
        })?;
        read_and_apply_earlier_frames(&client, &session, &mut peer).await?;
        capped("the hold release", session.resolve_reconnect(Vec::new()))
            .await?
            .map_err(|error| format!("releasing the hold failed: {error}"))?;
        let inner = session.downgrade().upgrade().ok_or("session alive")?;
        let _routed: Vec<_> = (0..crate::session::MAX_ACTIVE_TURNS)
            .map(|index| inner.claim_turn_for_ordering_tests(&format!("turn-fill-{index}")))
            .collect();

        let turn = answered_retry(&session, &mut peer, |request| {
            turn_started_reply(request, ENDED_TURN)
        })
        .await?;
        match (fault, capped("the retried turn", turn.completed()).await?) {
            (false, Ok(TurnOutcome::Completed { .. })) | (true, Ok(TurnOutcome::Ended(_))) => {}
            (_, other) => {
                return Err(format!(
                    "a kept-route retry at the cap settles (fault: {fault}), got {other:?}"
                ));
            }
        }
        if !session.pending().is_empty() {
            return Err(format!(
                "a kept-route retry at the cap leaves pending() (fault: {fault})"
            ));
        }
    }
    Ok(())
}

/// The session keeps the ended turn's settled route for its life, while
/// `retired_turns` keeps only the latest retirements. A retry answered with that
/// turn after many later turns have retired still settles and leaves
/// `pending()`.
#[tokio::test(flavor = "current_thread")]
async fn a_late_retry_after_many_retirements_leaves_pending() -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;
    peer.send(terminal(SESSION, ENDED_TURN))?;
    read_and_apply_earlier_frames(&client, &session, &mut peer).await?;
    capped("the hold release", session.resolve_reconnect(Vec::new()))
        .await?
        .map_err(|error| format!("releasing the hold failed: {error}"))?;
    for index in 0..=crate::session::MAX_RETIRED_TURNS {
        peer.send(terminal(SESSION, &format!("turn-later-{index}")))?;
    }
    read_and_apply_earlier_frames(&client, &session, &mut peer).await?;

    let turn = answered_retry(&session, &mut peer, |request| {
        turn_started_reply(request, ENDED_TURN)
    })
    .await?;
    match capped("the retried turn", turn.completed()).await? {
        Ok(TurnOutcome::Completed { params, .. }) if params.turn_id == ENDED_TURN => {}
        other => {
            return Err(format!(
                "a late retry settles on the applied terminal, got {other:?}"
            ));
        }
    }
    if session.pending().is_empty() {
        Ok(())
    } else {
        Err("a late retry that settled leaves pending()".to_owned())
    }
}

/// A terminal received before the answer but held back by a pending view-gap
/// fill is not applied when the retry claims the turn, so the retry settles
/// `Ended` from the resume's `lastTurn` and leaves `pending()`.
#[tokio::test(flavor = "current_thread")]
async fn a_terminal_held_behind_a_pending_gap_fill_settles_the_retry_ended() -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;

    peer.send(json!({
        "jsonrpc": "2.0",
        "method": "view/gap",
        "params": {"sessionId": SESSION, "after": "cursor-1", "next": "cursor-5"}
    }))?;
    // The fill's page stays unanswered, so the hole stays open.
    capped("the gap fill's view/page", peer.request("view/page")).await??;
    peer.send(terminal(SESSION, ENDED_TURN))?;

    let turn = answered_retry(&session, &mut peer, |request| {
        turn_started_reply(request, ENDED_TURN)
    })
    .await?;
    match capped("the retried turn", turn.completed()).await? {
        Ok(TurnOutcome::Ended(last_turn)) if last_turn.turn_id == ENDED_TURN => {}
        other => {
            return Err(format!(
                "a terminal held behind a pending gap fill settles the retry Ended, got {other:?}"
            ));
        }
    }
    if session.pending().is_empty() {
        Ok(())
    } else {
        Err("a retry settled Ended leaves pending()".to_owned())
    }
}

/// Frames that never reach the handler (here one past the handoff's capacity,
/// which takes the overflow path) are not counted, so the wait still ends once
/// every counted frame ahead of the answer is applied.
#[tokio::test(flavor = "current_thread")]
async fn an_overflowed_frame_ahead_of_the_answer_does_not_hold_the_retry() -> Result<(), String> {
    let (client, mut peer, mut started, release, _overflow) = paused_client(1);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;

    peer.send(terminal("other-session", "turn-held"))?;
    if capped("the held notification", started.recv()).await? != Some(0) {
        return Err("the handler did not hold the first notification".to_owned());
    }
    for index in 0..=crate::connection::NOTIFICATION_HANDLER_CAPACITY {
        peer.send(terminal("other-session", &format!("turn-other-{index}")))?;
    }
    let mut retry = Box::pin(session.send_user_turn(SendUserTurnOptions::default()));
    if poll_once(retry.as_mut()).await.is_some() {
        return Err("turn/start settled before submission".to_owned());
    }
    let request = capped("turn/start submission", peer.request("turn/start")).await??;
    peer.send(turn_started_reply(&request, ENDED_TURN)?)?;
    // A later answer proves the driver read every frame, the overflowed one
    // included, while the handler was still held.
    read_fence(&session, &mut peer).await?;
    if poll_once(retry.as_mut()).await.is_some() {
        return Err("control: the retry waits for the held handler".to_owned());
    }
    release
        .send(())
        .map_err(|_| "the held handler is gone".to_owned())?;
    let turn = capped("the same-command retry", retry)
        .await?
        .map_err(|error| format!("the same-command retry failed: {error}"))?;
    match capped("the retried turn", turn.completed()).await? {
        Ok(TurnOutcome::Ended(last_turn)) if last_turn.turn_id == ENDED_TURN => Ok(()),
        other => Err(format!(
            "an overflowed frame must not hold the retry; it settles Ended, got {other:?}"
        )),
    }
}
