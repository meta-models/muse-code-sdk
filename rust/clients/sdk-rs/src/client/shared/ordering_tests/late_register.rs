use std::sync::Arc;
use std::sync::atomic::Ordering;

use super::super::tests::notification;
use super::{
    MuseClient, StartSessionOptions, json, lock, paused_client, paused_client_with, poll_once,
    session_value, start_session,
};
use crate::client::FacadeError;
use crate::msp::SessionDurability;
use crate::session::{Session, SessionOpening};
use crate::turn::TurnWaitError;

/// A second session on `client`, opened from `like`'s reply under another id,
/// and not yet registered.
fn another_session(client: &MuseClient, like: &Session, id: &str) -> Result<Session, String> {
    let SessionOpening::Start(mut result) = like.opening().clone() else {
        return Err("start_session opened no Start".to_owned());
    };
    result.session.session_id = id.to_owned();
    Ok(Session::from_opening(
        Arc::clone(&client.shared),
        SessionOpening::Start(result),
        &[],
        None,
    ))
}

/// `close()` sets the closed flag and settles the sessions in the one
/// router snapshot it takes, but an open whose reply returned first registers
/// after that. Calling `close()` and then `register` forces that order with
/// no timing: the late session must still settle as `ClientClosed`, as one
/// `close()` reached does.
#[tokio::test(flavor = "current_thread")]
async fn a_session_registered_after_close_settles_as_client_closed() -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let first = start_session(&client, &mut peer, "session-1").await?;
    let late = another_session(&client, &first, "late-session")?;

    client.close().await;
    let first_inner = first.downgrade().upgrade().ok_or("first session alive")?;
    if !matches!(
        first_inner.event_source_failure(),
        Some(TurnWaitError::ClientClosed)
    ) {
        return Err("control: close() did not settle the session it reached".to_owned());
    }

    client.shared.register(&late, false);
    if client
        .shared
        .router
        .sessions()
        .iter()
        .any(|session| session.session_id() == "late-session")
    {
        return Err("a session close() never saw must get no route".to_owned());
    }
    let late_inner = late.downgrade().upgrade().ok_or("late session alive")?;
    match late_inner.event_source_failure() {
        Some(TurnWaitError::ClientClosed) => Ok(()),
        other => Err(format!(
            "a session registered after close() must settle as ClientClosed, got {other:?}"
        )),
    }
}

/// `close()` clears the frames the router queued for ids that had not
/// registered yet, so a session registering after its snapshot may have lost
/// events: its fold must stop rather than claim to be whole.
#[tokio::test(flavor = "current_thread")]
async fn a_late_session_whose_queued_frames_close_dropped_has_a_stopped_fold() -> Result<(), String>
{
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let first = start_session(&client, &mut peer, "session-1").await?;
    let late = another_session(&client, &first, "late-session")?;
    lock(&client.shared.router.state)
        .enqueue_pending("late-session".to_owned(), notification("late-session", 1));

    client.close().await;
    client.shared.register(&late, false);
    if late.fold().is_stopped() {
        Ok(())
    } else {
        Err(
            "a late session whose queued frames close() dropped must have a stopped fold"
                .to_owned(),
        )
    }
}

/// On an ephemeral client the transport end `close()` causes discards every
/// routed session. A late session registering after that sweep has no route
/// for it to have reached, so its registration must discard it.
#[tokio::test(flavor = "current_thread")]
async fn a_late_session_on_an_ephemeral_client_is_discarded_like_the_others() -> Result<(), String>
{
    let (client, mut peer, _started, _release, _overflow) =
        paused_client_with(0, SessionDurability::Ephemeral);
    let first = start_session(&client, &mut peer, "session-1").await?;
    let late = another_session(&client, &first, "late-session")?;

    client.close().await;
    client.shared.mark_transport_ended();
    if !client.is_session_discarded("session-1") {
        return Err("control: the transport end did not discard a routed session".to_owned());
    }
    client.shared.register(&late, false);
    if !(client.is_session_discarded("late-session") && late.is_discarded()) {
        return Err(
            "a late session on an ephemeral client must be discarded like the others".to_owned(),
        );
    }
    let late_inner = late.downgrade().upgrade().ok_or("late session alive")?;
    match late_inner.event_source_failure() {
        Some(TurnWaitError::ClientClosed) => Ok(()),
        other => Err(format!(
            "a late session the transport end missed must still settle as ClientClosed, got {other:?}"
        )),
    }
}

/// A late session registering before the transport ends waits for that sweep,
/// as its routed peers do, rather than reading discarded while `close()` runs.
#[tokio::test(flavor = "current_thread")]
async fn a_late_session_is_discarded_by_the_transport_end_with_the_others() -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) =
        paused_client_with(0, SessionDurability::Ephemeral);
    let first = start_session(&client, &mut peer, "session-1").await?;
    let late = another_session(&client, &first, "late-session")?;

    // `close()`'s snapshot without its teardown, so the transport stays up.
    client.shared.closed.store(true, Ordering::Release);
    let _workers = client.shared.begin_close();
    client.shared.register(&late, false);
    if late.is_discarded() || client.is_session_discarded("late-session") {
        return Err("a late session must not read discarded before the transport ends".to_owned());
    }
    client.shared.mark_transport_ended();
    if !(client.is_session_discarded("session-1")
        && client.is_session_discarded("late-session")
        && late.is_discarded())
    {
        return Err(
            "the transport end must discard the late session with the routed one".to_owned(),
        );
    }
    let late_inner = late.downgrade().upgrade().ok_or("late session alive")?;
    match late_inner.event_source_failure() {
        Some(TurnWaitError::ClientClosed) => Ok(()),
        other => Err(format!(
            "the transport end must keep the late session's ClientClosed, got {other:?}"
        )),
    }
}

/// Only a terminal snapshot, here `close()`'s, makes a session the opener's to
/// settle: with the closed flag set but no snapshot taken yet, registration
/// routes the session and leaves it to that snapshot, so the two never both
/// settle it.
#[tokio::test(flavor = "current_thread")]
async fn registration_settles_only_a_session_the_close_snapshot_missed() -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let first = start_session(&client, &mut peer, "session-1").await?;
    let session = another_session(&client, &first, "racing-session")?;

    client.shared.closed.store(true, Ordering::Release);
    client.shared.register(&session, false);
    let inner = session.downgrade().upgrade().ok_or("session alive")?;
    if let Some(failure) = inner.event_source_failure() {
        return Err(format!(
            "registration settled a session close() has yet to snapshot: {failure:?}"
        ));
    }
    let _workers = client.shared.begin_close();
    match inner.event_source_failure() {
        Some(TurnWaitError::ClientClosed) => Ok(()),
        other => Err(format!(
            "close()'s snapshot must settle the session, got {other:?}"
        )),
    }
}

/// A host that exits right after it answers an open: the driver reads the
/// reply and then EOF, so the transport-end sweep runs before the opener
/// registers its session. That session must still report the transport end,
/// and an ephemeral client discards it like the sessions the sweep reached.
#[tokio::test(flavor = "current_thread")]
async fn a_session_whose_open_reply_raced_the_transport_end_reports_it() -> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) =
        paused_client_with(0, SessionDurability::Ephemeral);
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
            "session": session_value("session-1"),
            "viewCursor": "cursor-1"
        }
    }))?;
    peer.close_input().await?;
    // On this single-threaded runtime a request made after the end returns
    // only once the sweep has run: it either finds `transport_ended`, which
    // `mark_transport_ended` sets in the same non-yielding call as the sweep,
    // or fails on the closed driver and runs the sweep itself.
    let after = client
        .start_session(StartSessionOptions::default())
        .await
        .err();
    if !matches!(after, Some(FacadeError::TransportEnded)) {
        return Err(format!(
            "control: a request after the end must see TransportEnded, got {after:?}"
        ));
    }

    let session = opening
        .await
        .map_err(|error| format!("session/start failed: {error}"))?;
    let inner = session.downgrade().upgrade().ok_or("session alive")?;
    if !matches!(
        inner.event_source_failure(),
        Some(TurnWaitError::SourceClosed)
    ) {
        return Err(format!(
            "a session whose open raced the transport end must report it, got {:?}",
            inner.event_source_failure()
        ));
    }
    if !(session.is_discarded() && client.is_session_discarded("session-1")) {
        return Err(
            "an ephemeral client must discard a session whose open raced the transport end"
                .to_owned(),
        );
    }
    Ok(())
}

/// The transport-end sweep settles the sessions it finds, but an open whose
/// reply returned first can register after it. Ending the transport and then
/// calling `register` forces that order with no timing: the late session must
/// settle as the sweep settles the others, and get no route.
#[tokio::test(flavor = "current_thread")]
async fn a_session_registered_after_the_transport_end_settles_as_source_closed()
-> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let first = start_session(&client, &mut peer, "session-1").await?;
    let late = another_session(&client, &first, "late-session")?;

    client.shared.mark_transport_ended();
    let first_inner = first.downgrade().upgrade().ok_or("first session alive")?;
    if !matches!(
        first_inner.event_source_failure(),
        Some(TurnWaitError::SourceClosed)
    ) {
        return Err("control: the transport end did not settle the session it reached".to_owned());
    }

    client.shared.register(&late, false);
    if late.is_discarded() || client.is_session_discarded("late-session") {
        return Err(
            "a durable client must keep a session registered after the transport end".to_owned(),
        );
    }
    if client
        .shared
        .router
        .sessions()
        .iter()
        .any(|session| session.session_id() == "late-session")
    {
        return Err("a session the transport-end sweep never saw must get no route".to_owned());
    }
    let late_inner = late.downgrade().upgrade().ok_or("late session alive")?;
    match late_inner.event_source_failure() {
        Some(TurnWaitError::SourceClosed) => Ok(()),
        other => Err(format!(
            "a session registered after the transport end must settle as SourceClosed, got {other:?}"
        )),
    }
}

/// The transport-end sweep clears the frames the router queued for ids that
/// had not registered yet, so a session registering after it may have lost
/// events: its fold must stop rather than claim to be whole.
#[tokio::test(flavor = "current_thread")]
async fn a_late_session_whose_queued_frames_the_transport_end_dropped_has_a_stopped_fold()
-> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) = paused_client(0);
    let first = start_session(&client, &mut peer, "session-1").await?;
    let late = another_session(&client, &first, "late-session")?;
    lock(&client.shared.router.state)
        .enqueue_pending("late-session".to_owned(), notification("late-session", 1));

    client.shared.mark_transport_ended();
    client.shared.register(&late, false);
    if late.fold().is_stopped() {
        Ok(())
    } else {
        Err(
            "a late session whose queued frames the transport end dropped must have a stopped fold"
                .to_owned(),
        )
    }
}

/// On an ephemeral client the transport-end sweep discards every routed
/// session. A session registering after that sweep must be discarded too, and
/// a later `close()` must not replace its transport end.
#[tokio::test(flavor = "current_thread")]
async fn a_session_registered_after_the_transport_end_is_discarded_like_the_others()
-> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) =
        paused_client_with(0, SessionDurability::Ephemeral);
    let first = start_session(&client, &mut peer, "session-1").await?;
    let late = another_session(&client, &first, "late-session")?;

    client.shared.mark_transport_ended();
    if !client.is_session_discarded("session-1") {
        return Err("control: the transport end did not discard a routed session".to_owned());
    }
    client.shared.register(&late, false);
    if !(client.is_session_discarded("late-session") && late.is_discarded()) {
        return Err(
            "a session registered after the transport end must be discarded like the others"
                .to_owned(),
        );
    }
    client.close().await;
    let late_inner = late.downgrade().upgrade().ok_or("late session alive")?;
    match late_inner.event_source_failure() {
        Some(TurnWaitError::SourceClosed) => Ok(()),
        other => Err(format!(
            "a later close() must keep the late session's transport end, got {other:?}"
        )),
    }
}

/// When the transport-end sweep and then `close()`'s snapshot both run before
/// a session registers, the transport end came first, so the late session
/// settles as `SourceClosed` like its routed peers, and the ephemeral client
/// discards it. (`close()` first, then the sweep, settles it as
/// `ClientClosed`: `a_late_session_on_an_ephemeral_client_is_discarded_like_the_others`.)
#[tokio::test(flavor = "current_thread")]
async fn a_session_registered_after_the_transport_end_and_close_keeps_the_transport_end()
-> Result<(), String> {
    let (client, mut peer, _started, _release, _overflow) =
        paused_client_with(0, SessionDurability::Ephemeral);
    let first = start_session(&client, &mut peer, "session-1").await?;
    let late = another_session(&client, &first, "late-session")?;

    client.shared.mark_transport_ended();
    client.close().await;
    let first_inner = first.downgrade().upgrade().ok_or("first session alive")?;
    if !matches!(
        first_inner.event_source_failure(),
        Some(TurnWaitError::SourceClosed)
    ) {
        return Err("control: the routed session must keep the earlier transport end".to_owned());
    }
    client.shared.register(&late, false);
    if !(client.is_session_discarded("late-session") && late.is_discarded()) {
        return Err("the ephemeral client must discard the late session".to_owned());
    }
    let late_inner = late.downgrade().upgrade().ok_or("late session alive")?;
    match late_inner.event_source_failure() {
        Some(TurnWaitError::SourceClosed) => Ok(()),
        other => Err(format!(
            "a session registered after the transport end and then close() must keep the \
             transport end, got {other:?}"
        )),
    }
}
