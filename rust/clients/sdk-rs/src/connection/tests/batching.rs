use super::*;

fn recording_handler(order: &Arc<StdMutex<Vec<String>>>) -> NotificationHandler {
    let order = Arc::clone(order);
    Arc::new(move |notification: Notification| {
        let label = format!(
            "{}:{}",
            notification.method,
            notification_session_id(&notification).unwrap_or_default()
        );
        order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(label);
    })
}

fn dispatcher_with(
    handler: NotificationHandler,
    overflow: NotificationHandler,
) -> (
    mpsc::Sender<NotificationDispatchItem>,
    Arc<Semaphore>,
    NotificationDispatcher,
) {
    let (queue, notifications) = mpsc::channel(NOTIFICATION_DISPATCH_CAPACITY);
    let (closed, _) = watch::channel(false);
    let dispatcher = NotificationDispatcher {
        queue: notifications,
        applied: watch::channel(0).0,
        handler,
        overflow,
        queued_overflows: Arc::new(Mutex::new(HashSet::new())),
        saturated_overflow: Arc::new(Mutex::new(SaturatedOverflow::default())),
        closed,
    };
    (
        queue,
        Arc::new(Semaphore::new(NOTIFICATION_HANDLER_CAPACITY)),
        dispatcher,
    )
}

fn queue_notification(
    queue: &mpsc::Sender<NotificationDispatchItem>,
    capacity: &Arc<Semaphore>,
    method: &str,
    session_id: &str,
) -> Result<(), String> {
    let permit = Arc::clone(capacity)
        .try_acquire_owned()
        .map_err(|error| format!("no handoff permit: {error}"))?;
    queue
        .try_send(NotificationDispatchItem::Notification {
            notification: session_notification(method, session_id),
            permit: SessionPermit {
                session: None,
                _permit: permit,
            },
        })
        .map_err(|_| "dispatch queue refused a notification".to_owned())
}

fn blocking_hops() -> usize {
    crate::connection::dispatch::blocking_hops().with(std::cell::Cell::get)
}

/// Every notification already queued when the dispatcher wakes is
/// applied in one blocking-pool hop, in arrival order, instead of one hop each.
#[tokio::test(flavor = "current_thread")]
async fn queued_notifications_apply_in_one_blocking_hop_in_order() -> Result<(), String> {
    let order = Arc::new(StdMutex::new(Vec::new()));
    let (queue, capacity, dispatcher) =
        dispatcher_with(recording_handler(&order), recording_handler(&order));
    let sent: Vec<String> = (0..8)
        .map(|sequence| format!("item/completed:session-{}", sequence % 3))
        .collect();
    for label in &sent {
        let (method, session_id) = label.split_once(':').unwrap_or_default();
        queue_notification(&queue, &capacity, method, session_id)?;
    }
    drop(queue);

    let hops_before = blocking_hops();
    dispatcher.run().await;
    let hops = blocking_hops() - hops_before;

    let applied = order
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if applied != sent {
        return Err(format!("arrival order changed: {applied:?}"));
    }
    if hops != 1 {
        return Err(format!(
            "expected one blocking hop for the batch, took {hops}"
        ));
    }
    if capacity.available_permits() != NOTIFICATION_HANDLER_CAPACITY {
        return Err("the batch did not release every handoff permit".to_owned());
    }
    Ok(())
}

/// An overflow marker ends the batch and keeps its place, so the
/// overflow path still runs between the notifications queued around it.
#[tokio::test(flavor = "current_thread")]
async fn an_overflow_marker_ends_the_batch_and_keeps_its_place() -> Result<(), String> {
    let order = Arc::new(StdMutex::new(Vec::new()));
    let overflow_order = Arc::clone(&order);
    let overflow: NotificationHandler = Arc::new(move |notification: Notification| {
        overflow_order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(format!(
                "overflow:{}",
                notification_session_id(&notification).unwrap_or_default()
            ));
    });
    let (queue, capacity, dispatcher) = dispatcher_with(recording_handler(&order), overflow);
    queue_notification(&queue, &capacity, "item/completed", "a")?;
    queue_notification(&queue, &capacity, "item/completed", "b")?;
    queue
        .try_send(NotificationDispatchItem::Overflow {
            notification: session_notification("item/completed", "c"),
            marker: OverflowMarker::Session("c".to_owned()),
        })
        .map_err(|_| "dispatch queue refused the overflow marker".to_owned())?;
    queue_notification(&queue, &capacity, "item/completed", "d")?;
    drop(queue);

    let hops_before = blocking_hops();
    dispatcher.run().await;
    let hops = blocking_hops() - hops_before;

    let applied = order
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let expected = [
        "item/completed:a",
        "item/completed:b",
        "overflow:c",
        "item/completed:d",
    ];
    if applied != expected {
        return Err(format!("the overflow marker lost its place: {applied:?}"));
    }
    if hops != 3 {
        return Err(format!(
            "expected the batch, the overflow and the next batch as three hops, took {hops}"
        ));
    }
    Ok(())
}

/// Each notification in a batch keeps its handoff permit until its
/// own handler call starts, so the batch frees no permit ahead of the handler
/// and the handoff bound still holds while the first call runs.
#[tokio::test(flavor = "current_thread")]
async fn a_batched_notification_holds_its_permit_until_its_handler_call_starts()
-> Result<(), String> {
    let (started_tx, mut started_rx) = mpsc::unbounded_channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = StdMutex::new(release_rx);
    let handler: NotificationHandler = Arc::new(move |notification: Notification| {
        if notification_session_id(&notification).as_deref() == Some("first") {
            let _ = started_tx.send(());
            let _ = release_rx
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .recv();
        }
    });
    let (queue, capacity, dispatcher) = dispatcher_with(handler, Arc::new(|_| {}));
    for session_id in ["first", "second", "third"] {
        queue_notification(&queue, &capacity, "item/completed", session_id)?;
    }
    drop(queue);

    let while_first_runs = async {
        let started = started_rx.recv().await;
        let free = capacity.available_permits();
        let _ = release_tx.send(());
        (started, free)
    };
    let ((started, free_while_first_runs), ()) = tokio::join!(while_first_runs, dispatcher.run());

    if started.is_none() {
        return Err("the first handler call never started".to_owned());
    }
    if free_while_first_runs != NOTIFICATION_HANDLER_CAPACITY - 2 {
        return Err(format!(
            "{free_while_first_runs} permits free while the first call ran; the two later notifications must still hold theirs"
        ));
    }
    Ok(())
}

/// A panic in one handler call does not stop the rest of the batch,
/// the same containment the per-notification hop gave.
#[tokio::test(flavor = "current_thread")]
async fn a_panicking_handler_call_does_not_stop_the_rest_of_the_batch() -> Result<(), String> {
    let order = Arc::new(StdMutex::new(Vec::new()));
    let record = recording_handler(&order);
    let handler: NotificationHandler = Arc::new(move |notification: Notification| {
        if notification_session_id(&notification).as_deref() == Some("boom") {
            // Unwinds like a panicking handler, without the panic hook's output.
            std::panic::resume_unwind(Box::new("handler bug on one notification"));
        }
        record(notification);
    });
    let (queue, capacity, dispatcher) = dispatcher_with(handler, recording_handler(&order));
    for session_id in ["a", "boom", "b"] {
        queue_notification(&queue, &capacity, "item/completed", session_id)?;
    }
    drop(queue);

    dispatcher.run().await;

    let applied = order
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if applied != ["item/completed:a", "item/completed:b"] {
        return Err(format!("a panic dropped later notifications: {applied:?}"));
    }
    if capacity.available_permits() != NOTIFICATION_HANDLER_CAPACITY {
        return Err("a panic leaked a handoff permit".to_owned());
    }
    Ok(())
}

/// A batch takes waiting notifications from the dispatcher's ready
/// list before the channel, in one hop, and puts an overflow marker it meets
/// back at the front of that list, so the saturated drain keeps its order:
/// every item the drain moved still applies before a notification admitted
/// later.
#[tokio::test(flavor = "current_thread")]
async fn a_batch_keeps_the_saturated_drain_order() -> Result<(), String> {
    let order = Arc::new(StdMutex::new(Vec::new()));
    let (queue, notifications) = mpsc::channel(NOTIFICATION_DISPATCH_CAPACITY);
    let capacity = Arc::new(Semaphore::new(NOTIFICATION_HANDLER_CAPACITY));
    // The first overflow call admits one more notification, then closes the
    // queue, so it lands behind everything the saturated drain already moved.
    let late_sender = Arc::new(StdMutex::new(Some((queue.clone(), Arc::clone(&capacity)))));
    let overflow_order = Arc::clone(&order);
    let overflow: NotificationHandler = Arc::new(move |notification: Notification| {
        overflow_order
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(format!(
                "overflow:{}",
                notification_session_id(&notification).unwrap_or_default()
            ));
        let late = late_sender
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take();
        if let Some((late_queue, late_capacity)) = late
            && let Ok(permit) = late_capacity.try_acquire_owned()
        {
            let _ = late_queue.try_send(NotificationDispatchItem::Notification {
                notification: session_notification("item/completed", "c"),
                permit: SessionPermit {
                    session: None,
                    _permit: permit,
                },
            });
        }
    });
    let saturated_overflow = Arc::new(Mutex::new(SaturatedOverflow {
        queued: true,
        sessions: HashSet::from(["s1".to_owned(), "s2".to_owned()]),
        pending: VecDeque::from([session_notification("item/completed", "s2")]),
        refused: None,
    }));
    let (closed, _) = watch::channel(false);
    let dispatcher = NotificationDispatcher {
        queue: notifications,
        applied: watch::channel(0).0,
        handler: recording_handler(&order),
        overflow,
        queued_overflows: Arc::new(Mutex::new(HashSet::new())),
        saturated_overflow,
        closed,
    };
    queue
        .try_send(NotificationDispatchItem::Overflow {
            notification: session_notification("item/completed", "s1"),
            marker: OverflowMarker::Saturated,
        })
        .map_err(|_| "dispatch queue refused the saturated marker".to_owned())?;
    queue_notification(&queue, &capacity, "item/completed", "a")?;
    queue_notification(&queue, &capacity, "item/completed", "a2")?;
    queue
        .try_send(NotificationDispatchItem::Overflow {
            notification: session_notification("item/completed", "x"),
            marker: OverflowMarker::Session("x".to_owned()),
        })
        .map_err(|_| "dispatch queue refused the session marker".to_owned())?;
    queue_notification(&queue, &capacity, "item/completed", "b")?;
    drop(queue);

    let hops_before = blocking_hops();
    dispatcher.run().await;
    let hops = blocking_hops() - hops_before;

    let applied = order
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let expected = [
        "overflow:s1",
        "item/completed:a",
        "item/completed:a2",
        "overflow:x",
        "item/completed:b",
        "overflow:s2",
        "item/completed:c",
    ];
    if applied != expected {
        return Err(format!("the saturated drain lost its order: {applied:?}"));
    }
    // s1, then a and a2 together from the ready list, x, b, s2 and c.
    if hops != 6 {
        return Err(format!(
            "expected the drained a and a2 to share one hop, took {hops} hops"
        ));
    }
    Ok(())
}
