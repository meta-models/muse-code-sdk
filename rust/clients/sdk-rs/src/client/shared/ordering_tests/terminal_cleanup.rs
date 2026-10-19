use std::collections::VecDeque;
use std::sync::Weak;

use super::super::tests::notification;
use super::{
    ActiveRoute, MAX_OVERFLOWED_SESSIONS, NotificationRouter, RoutedNotification, lock,
    paused_client,
};

fn seed_terminal_cleanup_state(router: &NotificationRouter) {
    let mut state = lock(&router.state);
    state.sessions.insert(
        "dead".to_owned(),
        ActiveRoute {
            session: Weak::new(),
            notifications: VecDeque::from([
                RoutedNotification::Notification(notification("dead", 1)),
                RoutedNotification::Overflow,
            ]),
            draining: false,
            overflowed: true,
        },
    );
    state.enqueue_pending("pending".to_owned(), notification("pending", 2));
    for sequence in 0..=MAX_OVERFLOWED_SESSIONS {
        state.mark_overflowed(format!("overflowed-{sequence}"));
    }
}

fn require_terminal_cleanup_state_empty(router: &NotificationRouter) -> Result<(), String> {
    let state = lock(&router.state);
    if !state.sessions.is_empty()
        || !state.pending.is_empty()
        || state.pending_total != 0
        || !state.overflowed_sessions.is_empty()
        || state.overflow_tombstones.is_some()
    {
        return Err(format!(
            "terminal cleanup retained router state: sessions={}, pending={}, pending_total={}, overflowed_sessions={}, overflow_tombstones={}",
            state.sessions.len(),
            state.pending.len(),
            state.pending_total,
            state.overflowed_sessions.len(),
            state.overflow_tombstones.is_some()
        ));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn client_close_clears_notifications_demoted_from_dead_routes() -> Result<(), String> {
    let (client, _peer, _application_started, _release, _overflow_observed) = paused_client(0);
    seed_terminal_cleanup_state(&client.shared.router);

    client.shared.begin_close();

    require_terminal_cleanup_state_empty(&client.shared.router)
}

#[tokio::test(flavor = "current_thread")]
async fn transport_end_clears_notifications_demoted_from_dead_routes() -> Result<(), String> {
    let (client, _peer, _application_started, _release, _overflow_observed) = paused_client(0);
    seed_terminal_cleanup_state(&client.shared.router);

    client.shared.mark_transport_ended();

    require_terminal_cleanup_state_empty(&client.shared.router)
}

#[test]
fn terminal_snapshot_clears_state_after_demoting_dead_routes() -> Result<(), String> {
    let router = NotificationRouter::default();
    seed_terminal_cleanup_state(&router);

    if !router.sessions_for_terminal_cleanup().is_empty() {
        return Err("terminal cleanup snapshot retained a live session".to_owned());
    }

    require_terminal_cleanup_state_empty(&router)
}

#[tokio::test(start_paused = true)]
async fn cancelled_close_keeps_shared_state_until_teardown_finishes() -> Result<(), String> {
    let (client, mut peer, _application_started, _release, _overflow_observed) = paused_client(0);
    let shared = std::sync::Arc::downgrade(&client.shared);
    let mut close = Box::pin(client.close());
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    if close.as_mut().poll(&mut context).is_ready() {
        return Err("close finished before its teardown task ran".to_owned());
    }
    drop(close);
    drop(client);

    // The caller holds nothing now; only the teardown task can keep the shared
    // state alive, which is what lets a cancelled close() finish the ladder.
    if shared.upgrade().is_none() {
        return Err("teardown does not hold the client's shared state".to_owned());
    }
    // antipattern-ok(timeout-wrapper): paused failure-only cap; success ends when the driver drops the transport
    tokio::time::timeout(std::time::Duration::from_secs(30), async {
        while peer.outbound.recv().await.is_some() {}
    })
    .await
    .map_err(|_| "teardown never closed the connection".to_owned())?;
    Ok(())
}
