// The capacity check is a `debug_assert!`, so the whole module, helper
// included, builds only where it is compiled in.
#![cfg(debug_assertions)]

use super::*;

// A send that already holds its permit or marker can find the dispatch
// channel full only if `NOTIFICATION_DISPATCH_CAPACITY` stopped covering every
// permit and marker. That broken sum must fail loudly in the send that found
// it, instead of rerouting the frame through the overflow path, which would
// fail a session that never overflowed. Each channel below is one slot short
// of what its budgets admit, the shape a capacity change that forgot one
// budget would leave. The check is a `debug_assert!`, so these tests run only
// where it is compiled in. `saturated_overflow_cap_closes_the_driver` (in the
// overflow tests) fills the real channel to exactly its capacity without
// reaching this state.

#[test]
fn a_full_channel_fails_a_permitted_send_loudly_without_rerouting() -> Result<(), String> {
    let (queue, _notifications) = mpsc::channel(1);
    let dispatch = NotificationDispatch {
        queue,
        accepted: Arc::new(AtomicU64::new(0)),
        notification_capacity: Arc::new(Semaphore::new(2)),
        session_permits: SessionPermits::default(),
        queued_overflows: Arc::new(Mutex::new(HashSet::new())),
        saturated_overflow: Arc::new(Mutex::new(SaturatedOverflow::default())),
    };
    if !dispatch.try_send(session_notification("item/completed", "first")) {
        return Err("the first permitted send was refused".to_owned());
    }

    let sent = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dispatch.try_send(session_notification("item/completed", "second"))
    }));
    expect_capacity_invariant_panic(sent)?;
    if !lock_notification_overflows(&dispatch.queued_overflows).is_empty() {
        return Err("the permitted send was rerouted through the overflow path".to_owned());
    }
    Ok(())
}

#[test]
fn a_full_channel_fails_an_overflow_marker_send_loudly() -> Result<(), String> {
    // No permits, so every frame takes the overflow path; the first session's
    // marker fills the one slot.
    let (queue, _notifications) = mpsc::channel(1);
    let dispatch = NotificationDispatch {
        queue,
        accepted: Arc::new(AtomicU64::new(0)),
        notification_capacity: Arc::new(Semaphore::new(0)),
        session_permits: SessionPermits::default(),
        queued_overflows: Arc::new(Mutex::new(HashSet::new())),
        saturated_overflow: Arc::new(Mutex::new(SaturatedOverflow::default())),
    };
    if !dispatch.try_send(session_notification("item/completed", "first")) {
        return Err("the first session's overflow marker was refused".to_owned());
    }

    let sent = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        dispatch.try_send(session_notification("item/completed", "second"))
    }));
    expect_capacity_invariant_panic(sent)
}

fn expect_capacity_invariant_panic(sent: std::thread::Result<bool>) -> Result<(), String> {
    let payload = match sent {
        Ok(_) => return Err("a send into a full channel did not fail loudly".to_owned()),
        Err(payload) => payload,
    };
    let message = payload
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| payload.downcast_ref::<String>().map(String::as_str))
        .unwrap_or_default();
    if message.contains("NOTIFICATION_DISPATCH_CAPACITY must cover every permit and marker") {
        Ok(())
    } else {
        Err(format!("the send panicked for another reason: {message:?}"))
    }
}
