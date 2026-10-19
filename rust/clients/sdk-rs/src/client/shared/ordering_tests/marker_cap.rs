use std::sync::Arc;

use super::super::tests::notification;
use super::{
    MAX_OVERFLOWED_SESSIONS, MAX_PENDING_NOTIFICATIONS_TOTAL, NotificationRouter,
    expect_event_source_failure, expect_overflow_failure, lock, overflow_tombstone_slot,
    paused_client, start_session, start_turn, terminal,
};

const UNCONFIRMED_LOSS: &str = "a notification for this session may have been lost; the SDK cannot rule it out until this connection closes";

// Past the pre-registration marker cap, no affected session may
// register with a stream that looks complete, and the oldest refusal must not
// be traded for the newest.
#[tokio::test(flavor = "current_thread")]
async fn marker_cap_refuses_every_affected_session_and_spares_an_unaffected_one()
-> Result<(), String> {
    let (client, mut peer, _application_started, _release, _overflow_observed) = paused_client(0);
    let registered = start_session(&client, &mut peer, "registered").await?;
    let registered_turn = start_turn(&registered, &mut peer, "turn-1").await?;
    let router = Arc::clone(&client.shared.router);
    for sequence in 0..MAX_PENDING_NOTIFICATIONS_TOTAL {
        router.route(notification(&format!("held-{sequence}"), sequence));
    }
    for sequence in 0..=MAX_OVERFLOWED_SESSIONS {
        router.route(notification(&format!("overflow-{sequence}"), sequence));
    }

    let oldest = start_session(&client, &mut peer, "overflow-0").await?;
    let turn = start_turn(&oldest, &mut peer, "turn-1").await?;
    expect_overflow_failure(turn.completed(), "overflow-0").await?;

    // Past the cap the loss is unconfirmed, and it stays refused on later
    // registrations of the same id on this connection.
    let newest = format!("overflow-{MAX_OVERFLOWED_SESSIONS}");
    for registration in ["first", "second"] {
        let session = start_session(&client, &mut peer, &newest).await?;
        let turn = start_turn(&session, &mut peer, "turn-1").await?;
        expect_event_source_failure(
            turn.completed(),
            UNCONFIRMED_LOSS,
            &format!("{registration} registration of {newest}"),
        )
        .await?;
    }

    peer.send(terminal("registered", "turn-1"))?;
    registered_turn
        .completed()
        .await
        .map_err(|error| format!("a session registered before the cap was refused: {error}"))?;

    let session = start_session(&client, &mut peer, "unaffected").await?;
    let turn = start_turn(&session, &mut peer, "turn-1").await?;
    peer.send(terminal("unaffected", "turn-1"))?;
    match turn.completed().await {
        Ok(_) => Ok(()),
        Err(error) => Err(format!("an unaffected session was refused: {error}")),
    }
}

// A loss recorded in a session's own pending queue is certain, so on
// its first registration the session gets the backlog message even when its id
// also has a tombstone bit past the marker cap
// (`PendingRoute::record_unconfirmed_prior_overflow`); later registrations get
// the table refusal.
#[test]
fn a_certain_own_queue_loss_keeps_the_backlog_message_past_the_marker_cap() -> Result<(), String> {
    let router = NotificationRouter::default();
    for sequence in 0..MAX_PENDING_NOTIFICATIONS_TOTAL {
        router.route(notification(&format!("held-{sequence}"), sequence));
    }
    for sequence in 0..=MAX_OVERFLOWED_SESSIONS {
        router.route(notification(&format!("overflow-{sequence}"), sequence));
    }
    let newest = format!("overflow-{MAX_OVERFLOWED_SESSIONS}");
    // Free one global slot: the newest session's next notification is
    // retained, and the one after it is lost from that session's own queue.
    drop(lock(&router.state).take_pending("held-0"));
    router.route(notification(&newest, 0));
    router.route(notification(&newest, 1));
    {
        // Without this the test could pass on the marker path, which also
        // reports a confirmed loss, and never reach the guard it pins.
        let state = lock(&router.state);
        let (word, bit) = overflow_tombstone_slot(&newest);
        let tombstoned = state
            .overflow_tombstones
            .as_ref()
            .is_some_and(|table| table[word] & bit != 0);
        if state.overflowed_sessions.contains(&newest) || !tombstoned {
            return Err(
                "the fixture did not put the newest session past the marker cap".to_owned(),
            );
        }
    }

    let pending = lock(&router.state).take_pending(&newest);
    if pending.overflow_at != Some(0) {
        return Err(format!(
            "the newest session registered without its loss: {:?}",
            pending.overflow_at
        ));
    }
    if pending.overflow_unconfirmed {
        return Err(
            "a certain own-queue loss was reported as unconfirmed because the id also has a tombstone bit"
                .to_owned(),
        );
    }
    // The bit outlives that registration: a later one gets the table refusal.
    let later = lock(&router.state).take_pending(&newest);
    if later.overflow_at != Some(0) || !later.overflow_unconfirmed {
        return Err(
            "a later registration of the newest session did not get the table refusal".to_owned(),
        );
    }
    Ok(())
}

// Before a session registers, a loss for a session that
// already has queued notifications stays in that session's own queue. It
// refuses that registration once, after the retained notification, and sets
// no marker or table bit, so a later registration is accepted.
#[test]
fn own_queue_loss_refuses_once_then_a_later_registration_is_accepted() -> Result<(), String> {
    let router = NotificationRouter::default();
    router.route(notification("own-queue", 0));
    for sequence in 1..MAX_PENDING_NOTIFICATIONS_TOTAL {
        router.route(notification(&format!("held-{sequence}"), sequence));
    }
    // The global pending total is full, and this session already has a queued
    // notification, so the loss lands in its own queue.
    router.route(notification("own-queue", 1));

    let mut state = lock(&router.state);
    if state.overflowed_sessions.contains("own-queue") || state.overflow_tombstones.is_some() {
        return Err("an own-queue loss set a marker or a tombstone bit".to_owned());
    }
    let first = state.take_pending("own-queue");
    if first.notifications.len() != 1 || first.overflow_at != Some(1) || first.overflow_unconfirmed
    {
        return Err(format!(
            "the first registration did not get the retained notification and then a confirmed loss: {} retained, overflow_at {:?}, unconfirmed {}",
            first.notifications.len(),
            first.overflow_at,
            first.overflow_unconfirmed
        ));
    }
    let second = state.take_pending("own-queue");
    if second.overflow_at.is_some() {
        return Err("a later registration was refused after an own-queue loss".to_owned());
    }
    Ok(())
}
