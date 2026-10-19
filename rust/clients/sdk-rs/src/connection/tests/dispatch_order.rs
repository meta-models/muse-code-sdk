use super::*;

#[tokio::test(flavor = "current_thread")]
async fn full_overflow_marker_set_preserves_dispatch_fifo() -> Result<(), String> {
    let event_order = Arc::new(StdMutex::new(Vec::new()));
    let handler_order = Arc::clone(&event_order);
    let overflow_order = Arc::clone(&event_order);
    let handler: NotificationHandler = Arc::new(move |notification| {
        if notification.method == "turn/completed" {
            let mut order = match handler_order.lock() {
                Ok(order) => order,
                Err(poisoned) => poisoned.into_inner(),
            };
            order.push("terminal");
        }
    });
    let overflow: NotificationHandler = Arc::new(move |notification| {
        let label = match notification_session_id(&notification).as_deref() {
            Some("extra-session-1") => "overflow-1",
            Some("extra-session-2") => "overflow-2",
            Some("extra-session-3") => "overflow-3",
            _ => return,
        };
        {
            let mut order = match overflow_order.lock() {
                Ok(order) => order,
                Err(poisoned) => poisoned.into_inner(),
            };
            order.push(label);
        }
    });
    let queued_overflows = Arc::new(Mutex::new(HashSet::new()));
    let saturated_overflow = Arc::new(Mutex::new(SaturatedOverflow::default()));
    let (queue, notifications) = mpsc::channel(NOTIFICATION_DISPATCH_CAPACITY);
    let dispatch = NotificationDispatch {
        queue,
        accepted: Arc::new(AtomicU64::new(0)),
        notification_capacity: Arc::new(Semaphore::new(NOTIFICATION_HANDLER_CAPACITY)),
        session_permits: SessionPermits::default(),
        queued_overflows: Arc::clone(&queued_overflows),
        saturated_overflow: Arc::clone(&saturated_overflow),
    };
    let (closed, _) = watch::channel(false);
    let dispatcher = NotificationDispatcher {
        queue: notifications,
        applied: watch::channel(0).0,
        handler,
        overflow,
        queued_overflows,
        saturated_overflow: Arc::clone(&saturated_overflow),
        closed,
    };

    if !dispatch.try_send(session_notification("turn/completed", "extra-session-1")) {
        return Err("terminal notification was not queued".to_owned());
    }
    for sequence in 1..NOTIFICATION_HANDLER_CAPACITY {
        if !dispatch.try_send(session_notification(
            "item/completed",
            &format!("normal-{sequence}"),
        )) {
            return Err(format!("normal notification {sequence} was not queued"));
        }
    }
    for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
        if !dispatch.try_send(session_notification(
            "item/completed",
            &format!("overflow-{sequence}"),
        )) {
            return Err(format!("overflow marker {sequence} was not queued"));
        }
    }
    if !dispatch.try_send(session_notification("item/completed", "extra-session-1")) {
        return Err("saturated overflow marker was not accepted".to_owned());
    }
    for session_id in ["extra-session-2", "extra-session-3"] {
        if !dispatch.try_send(session_notification("item/completed", session_id)) {
            return Err(format!(
                "coalesced overflow for {session_id} was not accepted"
            ));
        }
    }
    if !dispatch.try_send(notification_without_session("server/status")) {
        return Err("sessionless notification was not accepted".to_owned());
    }
    let saturated_pending = lock_saturated_overflow(&saturated_overflow).pending.len();
    if saturated_pending != 2 {
        return Err(format!(
            "sessionless notification entered the saturated overflow sidecar: {saturated_pending} pending markers"
        ));
    }
    if dispatcher.queue.len() != NOTIFICATION_DISPATCH_CAPACITY {
        return Err(format!(
            "coalesced overflows changed the bounded dispatch queue length: {}",
            dispatcher.queue.len()
        ));
    }
    {
        let order = match event_order.lock() {
            Ok(order) => order,
            Err(poisoned) => poisoned.into_inner(),
        };
        if !order.is_empty() {
            return Err(format!(
                "overflow ran on the transport path before dispatch: {order:?}"
            ));
        }
    }

    drop(dispatch);
    dispatcher.run().await;
    let order = match event_order.lock() {
        Ok(order) => order,
        Err(poisoned) => poisoned.into_inner(),
    };
    if order.as_slice() != ["terminal", "overflow-1", "overflow-2", "overflow-3"] {
        return Err(format!(
            "each saturated session must remain behind the older terminal: {order:?}"
        ));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn dispatcher_retires_overflow_marker_after_delivery() -> Result<(), String> {
    let (overflowed_session, mut overflowed) = mpsc::unbounded_channel();
    let overflow: NotificationHandler = Arc::new(move |notification| {
        if let Some(session_id) = notification_session_id(&notification) {
            let _ = overflowed_session.send(session_id);
        }
    });
    let queued_overflows = Arc::new(Mutex::new(HashSet::new()));
    let saturated_overflow = Arc::new(Mutex::new(SaturatedOverflow::default()));
    let (queue, notifications) = mpsc::channel(4);
    let dispatch = NotificationDispatch {
        queue,
        accepted: Arc::new(AtomicU64::new(0)),
        notification_capacity: Arc::new(Semaphore::new(0)),
        session_permits: SessionPermits::default(),
        queued_overflows: Arc::clone(&queued_overflows),
        saturated_overflow: Arc::clone(&saturated_overflow),
    };
    let (closed, _) = watch::channel(false);
    let dispatcher = NotificationDispatcher {
        queue: notifications,
        applied: watch::channel(0).0,
        handler: Arc::new(|_| {}),
        overflow,
        queued_overflows: Arc::clone(&queued_overflows),
        saturated_overflow,
        closed,
    };
    let dispatcher_task = tokio::spawn(dispatcher.run());

    if !dispatch.try_send(session_notification("item/completed", "session-1")) {
        return Err("first overflow marker was not queued".to_owned());
    }
    if overflowed.recv().await.as_deref() != Some("session-1") {
        return Err("first overflow marker was not delivered".to_owned());
    }
    if lock_notification_overflows(&queued_overflows).contains("session-1") {
        return Err("delivered overflow marker remained queued".to_owned());
    }

    if !dispatch.try_send(session_notification("item/completed", "session-1")) {
        return Err("second overflow marker was not queued".to_owned());
    }
    if overflowed.recv().await.as_deref() != Some("session-1") {
        return Err("second overflow marker was not delivered".to_owned());
    }
    drop(dispatch);
    if dispatcher_task.await.is_err() {
        return Err("notification dispatcher task did not join".to_owned());
    }
    if !lock_notification_overflows(&queued_overflows).is_empty() {
        return Err("overflow markers remained queued after dispatch".to_owned());
    }
    Ok(())
}
