//! Which answers settle from `lastTurn`, and claims the session refuses.

use super::*;

/// An answer that names a turn other than the resume's `lastTurn` is a live
/// turn: it waits for its own terminal and stays in `pending()` until then.
#[tokio::test(flavor = "current_thread")]
async fn an_answer_naming_another_turn_is_followed_live() -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;

    let turn = answered_retry(&session, &mut peer, |request| {
        turn_started_reply(request, "turn-new")
    })
    .await?;
    let completion = std::pin::pin!(turn.completed());
    if poll_once(completion).await.is_some() {
        return Err("a turn other than lastTurn must not settle from it".to_owned());
    }
    if session.pending().len() != 1 {
        return Err("a live turn stays in pending() until its terminal".to_owned());
    }
    peer.send(terminal(SESSION, "turn-new"))?;
    match capped("the live turn", turn.completed()).await? {
        Ok(TurnOutcome::Completed { params, .. }) if params.turn_id == "turn-new" => Ok(()),
        other => Err(format!(
            "a turn other than lastTurn settles on its own terminal, got {other:?}"
        )),
    }
}

/// Once the ended turn has settled here, an answer naming another turn still
/// claims that turn live: only an answer naming `lastTurn` takes the kept
/// route.
#[tokio::test(flavor = "current_thread")]
async fn an_answer_naming_another_turn_after_last_turn_settled_is_followed_live()
-> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;
    peer.send(terminal(SESSION, ENDED_TURN))?;
    read_and_apply_earlier_frames(&client, &session, &mut peer).await?;

    let turn = answered_retry(&session, &mut peer, |request| {
        turn_started_reply(request, "turn-new")
    })
    .await?;
    let completion = std::pin::pin!(turn.completed());
    if poll_once(completion).await.is_some() {
        return Err("a turn other than lastTurn must not take the kept route".to_owned());
    }
    if session.pending().len() == 1 {
        Ok(())
    } else {
        Err("a live turn stays in pending() until its terminal".to_owned())
    }
}

/// A steered answer that names the resume's `lastTurn` (a written intake
/// replays its first disposition) settles `Ended` the same way.
#[tokio::test(flavor = "current_thread")]
async fn a_steered_answer_naming_last_turn_settles_ended() -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;

    let turn = answered_retry(&session, &mut peer, |request| {
        let mut reply = turn_started_reply(request, ENDED_TURN)?;
        reply["result"]["disposition"] = json!("steered");
        reply["result"]["startedNewTurn"] = json!(false);
        Ok(reply)
    })
    .await?;
    match capped("the retried turn", turn.completed()).await? {
        Ok(TurnOutcome::Ended(last_turn)) if last_turn.turn_id == ENDED_TURN => Ok(()),
        other => Err(format!(
            "a steered answer naming lastTurn must settle Ended, got {other:?}"
        )),
    }
}

/// A claim the session refuses opens no route, so a retry naming `lastTurn`
/// after the event source failed keeps that failure, and the submission stays
/// in `pending()` for a reconnect, as for any refused claim.
#[tokio::test(flavor = "current_thread")]
async fn a_refused_claim_keeps_its_failure_and_stays_pending() -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;
    let inner = session.downgrade().upgrade().ok_or("session alive")?;
    inner.fail_event_source(crate::turn::TurnWaitError::EventSourceFailed {
        message: "test fault".to_owned(),
    });

    let turn = answered_retry(&session, &mut peer, |request| {
        turn_started_reply(request, ENDED_TURN)
    })
    .await?;
    let outcome = capped("the refused claim", turn.completed()).await?;
    if outcome.is_ok() {
        return Err(format!(
            "a refused claim must keep its failure, got {outcome:?}"
        ));
    }
    if session.pending().len() == 1 {
        Ok(())
    } else {
        Err("a refused claim keeps the retry in pending()".to_owned())
    }
}

/// At the active-turn cap the claim is refused as for any turn: the retry
/// keeps that failure and stays in `pending()` for a reconnect.
#[tokio::test(flavor = "current_thread")]
async fn a_cap_refused_claim_keeps_its_failure_and_stays_pending() -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let session = resume_after_the_turn_ended(&client, &mut peer, History::Inline).await?;
    let inner = session.downgrade().upgrade().ok_or("session alive")?;
    let _routed: Vec<_> = (0..crate::session::MAX_ACTIVE_TURNS)
        .map(|index| inner.claim_turn_for_ordering_tests(&format!("turn-fill-{index}")))
        .collect();

    let turn = answered_retry(&session, &mut peer, |request| {
        turn_started_reply(request, ENDED_TURN)
    })
    .await?;
    match capped("the refused claim", turn.completed()).await? {
        Err(error) if error.to_string().contains("too many active turns") => {}
        other => {
            return Err(format!(
                "a cap-refused claim keeps the cap failure, got {other:?}"
            ));
        }
    }
    if session.pending().len() == 1 {
        Ok(())
    } else {
        Err("a cap-refused claim keeps the retry in pending()".to_owned())
    }
}
