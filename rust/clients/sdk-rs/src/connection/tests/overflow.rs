use super::*;

#[tokio::test(flavor = "current_thread")]
async fn coalesced_overflow_stays_behind_an_older_queued_terminal() -> Result<(), String> {
    let event_order = Arc::new(StdMutex::new(Vec::new()));
    let handler_order = Arc::clone(&event_order);
    let overflow_order = Arc::clone(&event_order);
    let (handler_started, mut started) = mpsc::unbounded_channel();
    let (release_handler, handler_release) = std::sync::mpsc::channel();
    let handler_release = Arc::new(StdMutex::new(handler_release));
    let release = Arc::clone(&handler_release);
    let handler: NotificationHandler = Arc::new(move |notification| {
        if notification.method == "test/blocker" {
            let _ = handler_started.send(());
            let receiver = match release.lock() {
                Ok(receiver) => receiver,
                Err(poisoned) => poisoned.into_inner(),
            };
            let _ = receiver.recv();
        }
        if notification.method == "turn/completed" {
            let mut order = match handler_order.lock() {
                Ok(order) => order,
                Err(poisoned) => poisoned.into_inner(),
            };
            order.push("terminal-b".to_owned());
        }
    });
    let overflow: NotificationHandler = Arc::new(move |notification| {
        let Some(session_id) = notification_session_id(&notification) else {
            return;
        };
        let mut order = match overflow_order.lock() {
            Ok(order) => order,
            Err(poisoned) => poisoned.into_inner(),
        };
        order.push(format!("overflow-{session_id}"));
    });
    let queued_overflows = Arc::new(Mutex::new(
        (0..NOTIFICATION_HANDLER_CAPACITY)
            .map(|sequence| format!("queued-{sequence}"))
            .collect(),
    ));
    let saturated_overflow = Arc::new(Mutex::new(SaturatedOverflow::default()));
    let (queue, notifications) = mpsc::channel(4);
    let dispatch = NotificationDispatch {
        queue,
        accepted: Arc::new(AtomicU64::new(0)),
        notification_capacity: Arc::new(Semaphore::new(1)),
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
        saturated_overflow,
        closed,
    };

    if !dispatch.try_send(notification_without_session("test/blocker")) {
        return Err("blocking notification was not queued".to_owned());
    }
    if !dispatch.try_send(session_notification("item/completed", "a")) {
        return Err("first saturated overflow was not queued".to_owned());
    }
    let dispatcher_task = tokio::spawn(dispatcher.run());
    if started.recv().await.is_none() {
        return Err("blocking handler did not start".to_owned());
    }
    if !dispatch.try_send(session_notification("turn/completed", "b")) {
        return Err("terminal behind the saturated marker was not queued".to_owned());
    }
    if !dispatch.try_send(session_notification("item/completed", "b")) {
        return Err("coalesced overflow was not accepted".to_owned());
    }
    drop(dispatch);
    if release_handler.send(()).is_err() {
        return Err("blocking handler could not be released".to_owned());
    }
    if dispatcher_task.await.is_err() {
        return Err("notification dispatcher task did not join".to_owned());
    }

    let order = match event_order.lock() {
        Ok(order) => order,
        Err(poisoned) => poisoned.into_inner(),
    };
    let expected = ["overflow-a", "terminal-b", "overflow-b"];
    if order.iter().map(String::as_str).collect::<Vec<_>>() != expected {
        return Err(format!(
            "coalesced overflow ran ahead of the older terminal: {order:?}"
        ));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn parked_overflow_suppresses_a_later_terminal_for_the_same_session() -> Result<(), String> {
    let event_order = Arc::new(StdMutex::new(Vec::new()));
    let handler_order = Arc::clone(&event_order);
    let overflow_order = Arc::clone(&event_order);
    let (handler_started, mut started) = mpsc::unbounded_channel();
    let (release_handler, handler_release) = std::sync::mpsc::channel();
    let handler_release = Arc::new(StdMutex::new(handler_release));
    let release = Arc::clone(&handler_release);
    let handler: NotificationHandler = Arc::new(move |notification| {
        if notification.method == "test/blocker" {
            let _ = handler_started.send(());
            let receiver = match release.lock() {
                Ok(receiver) => receiver,
                Err(poisoned) => poisoned.into_inner(),
            };
            let _ = receiver.recv();
        }
        if notification.method == "turn/completed" {
            let mut order = match handler_order.lock() {
                Ok(order) => order,
                Err(poisoned) => poisoned.into_inner(),
            };
            order.push("terminal-b".to_owned());
        }
    });
    let overflow: NotificationHandler = Arc::new(move |notification| {
        let Some(session_id) = notification_session_id(&notification) else {
            return;
        };
        let mut order = match overflow_order.lock() {
            Ok(order) => order,
            Err(poisoned) => poisoned.into_inner(),
        };
        order.push(format!("overflow-{session_id}"));
    });
    let queued_overflows = Arc::new(Mutex::new(
        (0..NOTIFICATION_HANDLER_CAPACITY)
            .map(|sequence| format!("queued-{sequence}"))
            .collect(),
    ));
    let saturated_overflow = Arc::new(Mutex::new(SaturatedOverflow::default()));
    let (queue, notifications) = mpsc::channel(4);
    let dispatch = NotificationDispatch {
        queue,
        accepted: Arc::new(AtomicU64::new(0)),
        notification_capacity: Arc::new(Semaphore::new(1)),
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
        saturated_overflow,
        closed,
    };

    if !dispatch.try_send(notification_without_session("test/blocker")) {
        return Err("blocking notification was not queued".to_owned());
    }
    if !dispatch.try_send(session_notification("item/completed", "a")) {
        return Err("first saturated overflow was not queued".to_owned());
    }
    if !dispatch.try_send(session_notification("item/completed", "b")) {
        return Err("parked overflow was not accepted".to_owned());
    }
    let dispatcher_task = tokio::spawn(dispatcher.run());
    if started.recv().await.is_none() {
        return Err("blocking handler did not start".to_owned());
    }
    if !dispatch.try_send(session_notification("turn/completed", "b")) {
        return Err("later terminal was not accepted".to_owned());
    }
    drop(dispatch);
    if release_handler.send(()).is_err() {
        return Err("blocking handler could not be released".to_owned());
    }
    if dispatcher_task.await.is_err() {
        return Err("notification dispatcher task did not join".to_owned());
    }

    let order = match event_order.lock() {
        Ok(order) => order,
        Err(poisoned) => poisoned.into_inner(),
    };
    let expected = ["overflow-a", "overflow-b"];
    if order.iter().map(String::as_str).collect::<Vec<_>>() != expected {
        return Err(format!(
            "a later terminal overtook its session's parked overflow: {order:?}"
        ));
    }
    Ok(())
}

#[test]
fn saturated_overflow_cap_refuses_a_new_session() -> Result<(), String> {
    let queued_overflows = Arc::new(Mutex::new(
        (0..NOTIFICATION_HANDLER_CAPACITY)
            .map(|sequence| format!("queued-{sequence}"))
            .collect(),
    ));
    let saturated_overflow = Arc::new(Mutex::new(SaturatedOverflow::default()));
    let (queue, notifications) = mpsc::channel(NOTIFICATION_DISPATCH_CAPACITY);
    let dispatch = NotificationDispatch {
        queue,
        accepted: Arc::new(AtomicU64::new(0)),
        notification_capacity: Arc::new(Semaphore::new(0)),
        session_permits: SessionPermits::default(),
        queued_overflows,
        saturated_overflow: Arc::clone(&saturated_overflow),
    };

    for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
        if !dispatch.try_send(session_notification(
            "item/completed",
            &format!("saturated-{sequence}"),
        )) {
            return Err(format!("saturated session {sequence} was refused"));
        }
    }
    if dispatch.try_send(session_notification("item/completed", "one-too-many")) {
        return Err("new session beyond the saturated cap was accepted".to_owned());
    }
    let saturated = lock_saturated_overflow(&saturated_overflow);
    if saturated.sessions.len() != NOTIFICATION_HANDLER_CAPACITY {
        return Err(format!(
            "saturated session cap changed: {}",
            saturated.sessions.len()
        ));
    }
    if saturated.pending.len() + usize::from(saturated.queued) != NOTIFICATION_HANDLER_CAPACITY {
        return Err(format!(
            "saturated marker storage changed: {} pending, queued={}",
            saturated.pending.len(),
            saturated.queued
        ));
    }
    if notifications.len() != 1 {
        return Err(format!(
            "saturated sidecar queued more than one marker: {}",
            notifications.len()
        ));
    }
    Ok(())
}

#[test]
fn saturated_overflow_inserts_each_session_once() -> Result<(), String> {
    let queued_overflows = Arc::new(Mutex::new(
        (0..NOTIFICATION_HANDLER_CAPACITY)
            .map(|sequence| format!("queued-{sequence}"))
            .collect(),
    ));
    let saturated_overflow = Arc::new(Mutex::new(SaturatedOverflow::default()));
    let (queue, _notifications) = mpsc::channel(NOTIFICATION_DISPATCH_CAPACITY);
    let dispatch = NotificationDispatch {
        queue,
        accepted: Arc::new(AtomicU64::new(0)),
        notification_capacity: Arc::new(Semaphore::new(0)),
        session_permits: SessionPermits::default(),
        queued_overflows,
        saturated_overflow: Arc::clone(&saturated_overflow),
    };

    if !dispatch.try_send(session_notification("item/started", "session-1")) {
        return Err("first saturated overflow was refused".to_owned());
    }
    if !dispatch.try_send(session_notification("item/completed", "session-1")) {
        return Err("later frame for the saturated session was refused".to_owned());
    }

    let saturated = lock_saturated_overflow(&saturated_overflow);
    if saturated.sessions.len() != 1 || !saturated.pending.is_empty() {
        return Err(format!(
            "saturated session was admitted more than once: {} sessions, {} pending",
            saturated.sessions.len(),
            saturated.pending.len()
        ));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn dispatcher_retires_saturated_session_after_delivery() -> Result<(), String> {
    let (overflowed_session, mut overflowed) = mpsc::unbounded_channel();
    let overflow: NotificationHandler = Arc::new(move |notification| {
        if let Some(session_id) = notification_session_id(&notification) {
            let _ = overflowed_session.send(session_id);
        }
    });
    let queued_overflows = Arc::new(Mutex::new(
        (0..NOTIFICATION_HANDLER_CAPACITY)
            .map(|sequence| format!("queued-{sequence}"))
            .collect(),
    ));
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
        queued_overflows,
        saturated_overflow: Arc::clone(&saturated_overflow),
        closed,
    };
    let dispatcher_task = tokio::spawn(dispatcher.run());

    for round in 1..=2 {
        if !dispatch.try_send(session_notification("item/completed", "session-1")) {
            return Err(format!("saturated overflow round {round} was refused"));
        }
        if overflowed.recv().await.as_deref() != Some("session-1") {
            return Err(format!(
                "saturated overflow round {round} was not delivered"
            ));
        }
        if lock_saturated_overflow(&saturated_overflow)
            .sessions
            .contains("session-1")
        {
            return Err(format!(
                "delivered saturated session remained tracked after round {round}"
            ));
        }
    }

    drop(dispatch);
    if dispatcher_task.await.is_err() {
        return Err("notification dispatcher task did not join".to_owned());
    }
    Ok(())
}
