use super::*;

#[tokio::test(flavor = "current_thread")]
async fn saturated_notification_application_does_not_delay_response_correlation()
-> Result<(), String> {
    let (transport, mut peer) = test_transport();
    let applications = Arc::new(AtomicUsize::new(0));
    let handler_applications = Arc::clone(&applications);
    let handler_entries = Arc::new(AtomicUsize::new(0));
    let entered_handler = Arc::clone(&handler_entries);
    let event_order = Arc::new(StdMutex::new(Vec::new()));
    let handler_event_order = Arc::clone(&event_order);
    let overflow_event_order = Arc::clone(&event_order);
    let (application_started, mut started) = mpsc::unbounded_channel();
    let (overflowed_session, mut overflowed) = mpsc::unbounded_channel();
    let (permit_application, application_permit) = std::sync::mpsc::channel();
    let application_permit = Arc::new(StdMutex::new(application_permit));
    let handler_permit = Arc::clone(&application_permit);
    let (connection, driver, dispatcher) = Connection::with_notification_handler(
        transport,
        move |notification| {
            let entry = entered_handler.fetch_add(1, Ordering::Relaxed);
            if entry < 2 {
                let _ = application_started.send(());
                let permit = match handler_permit.lock() {
                    Ok(permit) => permit,
                    Err(poisoned) => poisoned.into_inner(),
                };
                let _ = permit.recv();
            };
            if notification.method == "turn/completed" {
                let mut order = match handler_event_order.lock() {
                    Ok(order) => order,
                    Err(poisoned) => poisoned.into_inner(),
                };
                order.push("terminal");
            }
            handler_applications.fetch_add(1, Ordering::Relaxed);
        },
        move |notification| {
            if let Some(session_id) = notification_session_id(&notification) {
                let mut order = match overflow_event_order.lock() {
                    Ok(order) => order,
                    Err(poisoned) => poisoned.into_inner(),
                };
                order.push("overflow");
                let _ = overflowed_session.send(session_id);
            }
        },
    );
    let mut protocol_errors = connection.subscribe_protocol_errors();
    let closed = connection.subscribe_closed();
    let driver_task = tokio::spawn(driver.run());
    let dispatcher_task = tokio::spawn(dispatcher.run());
    let mut request = Box::pin(connection.request("test/method", None));
    if poll_once(request.as_mut()).await.is_some() {
        return Err("request settled before submission".to_owned());
    }

    let frame = peer
        .outgoing
        .recv()
        .await
        .ok_or_else(|| "driver must submit the request".to_owned())?;
    let id = request_id(&frame).ok_or_else(|| "submitted request must carry an id".to_owned())?;
    let first = format!(
        "{}\n",
        json!({"jsonrpc":"2.0","method":"turn/started","params":{"sessionId":"session-1","turnId":"turn-1","commandId":"command-1"}}),
    );
    assert!(peer.incoming.send(first).is_ok());
    assert!(started.recv().await.is_some());

    let mut burst = String::new();
    for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
        burst.push_str(
            &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"session-1","sequence":sequence}})
                .to_string(),
        );
        burst.push('\n');
    }
    burst.push_str("not-json\n");
    burst.push_str(
        &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"session-1","sequence":NOTIFICATION_HANDLER_CAPACITY}})
            .to_string(),
    );
    burst.push('\n');
    burst.push_str(&json!({"jsonrpc":"2.0","id":id,"result":{"value":1}}).to_string());
    burst.push('\n');
    assert!(peer.incoming.send(burst).is_ok());
    protocol_errors
        .recv()
        .await
        .map_err(|error| format!("capacity receipt must arrive: {error}"))?;
    if overflowed.try_recv().is_ok() {
        return Err("overflow failed before older queued notifications applied".to_owned());
    }

    let early_response = poll_once(request.as_mut()).await;
    let settled_before_release = early_response.is_some();
    assert_eq!(applications.load(Ordering::Relaxed), 0);

    assert!(permit_application.send(()).is_ok());
    assert!(started.recv().await.is_some());
    let terminal = format!(
        "{}\nnot-json\n",
        json!({"jsonrpc":"2.0","method":"turn/completed","params":{"sessionId":"session-1","turnId":"turn-1","terminal":"completed","error":null}}),
    );
    assert!(peer.incoming.send(terminal).is_ok());
    protocol_errors
        .recv()
        .await
        .map_err(|error| format!("terminal receipt must arrive: {error}"))?;
    assert!(permit_application.send(()).is_ok());
    let response = match early_response {
        Some(response) => response,
        None => request.as_mut().await,
    }
    .map_err(|error| format!("later response must correlate: {error}"))?;
    assert_eq!(response.get("value"), Some(&json!(1)));
    drop(peer.incoming);
    assert!(driver_task.await.is_ok());
    assert!(*closed.borrow());
    assert!(dispatcher_task.await.is_ok());
    assert_eq!(
        applications.load(Ordering::Relaxed),
        2 + NOTIFICATION_HANDLER_CAPACITY
    );
    if overflowed.try_recv().ok().as_deref() != Some("session-1") {
        return Err(
            "overflow callback did not run after accepted notifications drained".to_owned(),
        );
    }
    let order = match event_order.lock() {
        Ok(order) => order,
        Err(poisoned) => poisoned.into_inner(),
    };
    if order.as_slice() != ["overflow", "terminal"] {
        return Err(format!(
            "overflow must precede a newer terminal notification: {order:?}"
        ));
    }
    drop(request);
    drop(connection);
    if !settled_before_release {
        return Err("notification queue saturation delayed response correlation".to_owned());
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn close_settles_request_without_draining_saturated_notification_dispatch()
-> Result<(), String> {
    let (transport, mut peer) = test_transport();
    let applications = Arc::new(AtomicUsize::new(0));
    let handler_applications = Arc::clone(&applications);
    let overflows = Arc::new(AtomicUsize::new(0));
    let handler_overflows = Arc::clone(&overflows);
    let (connection, driver, dispatcher) = Connection::with_notification_handler(
        transport,
        move |_| {
            handler_applications.fetch_add(1, Ordering::Relaxed);
        },
        move |_| {
            handler_overflows.fetch_add(1, Ordering::Relaxed);
        },
    );
    let closed = connection.subscribe_closed();
    let mut protocol_errors = connection.subscribe_protocol_errors();
    let mut driver = Box::pin(driver.run());
    let mut request = Box::pin(connection.request("test/method", None));
    if poll_once(request.as_mut()).await.is_some() {
        return Err("request settled before submission".to_owned());
    }
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("driver stopped after submitting the request".to_owned());
    }

    let _frame = peer
        .outgoing
        .recv()
        .await
        .ok_or_else(|| "driver must submit the request".to_owned())?;
    let mut inbound = String::new();
    for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
        inbound.push_str(
            &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"session-1","sequence":sequence}})
                .to_string(),
        );
        inbound.push('\n');
    }
    inbound.push_str(
        &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"session-1","sequence":NOTIFICATION_HANDLER_CAPACITY}})
            .to_string(),
    );
    inbound.push('\n');
    inbound.push_str("not-json\n");
    assert!(peer.incoming.send(inbound).is_ok());
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("driver stopped while accepting notifications".to_owned());
    }
    protocol_errors
        .recv()
        .await
        .map_err(|error| format!("capacity receipt must arrive: {error}"))?;
    assert_eq!(dispatcher.queue.len(), NOTIFICATION_HANDLER_CAPACITY + 1);

    connection.close().await;
    if poll_once(driver.as_mut()).await.is_none() {
        return Err("connection close waited for the notification dispatcher".to_owned());
    }
    let response = request.await;
    assert!(matches!(response, Err(ConnectionError::Closed)));
    if *closed.borrow() {
        return Err("connection closed before its accepted notifications drained".to_owned());
    }
    let dispatcher_task = tokio::spawn(dispatcher.run());
    assert!(dispatcher_task.await.is_ok());
    if !*closed.borrow() {
        return Err("notification dispatcher drained without closing the connection".to_owned());
    }
    assert_eq!(
        applications.load(Ordering::Relaxed),
        NOTIFICATION_HANDLER_CAPACITY
    );
    assert_eq!(overflows.load(Ordering::Relaxed), 1);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn close_interrupts_overflow_refusal_drain() -> Result<(), String> {
    let (transport, mut peer) = test_transport();
    let (connection, driver, dispatcher) =
        Connection::with_notification_handler(transport, |_| {}, |_| {});
    let closed = connection.subscribe_closed();
    let mut driver = Box::pin(driver.run());
    let mut request = Box::pin(connection.request("test/method", None));
    if poll_once(request.as_mut()).await.is_some() {
        return Err("request settled before submission".to_owned());
    }
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("driver stopped after submitting the request".to_owned());
    }
    peer.outgoing
        .recv()
        .await
        .ok_or_else(|| "driver did not submit the request".to_owned())?;

    let mut inbound = String::new();
    for stage in ["live", "queued", "saturated"] {
        for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
            inbound.push_str(
                &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":format!("{stage}-{sequence}")}})
                    .to_string(),
            );
            inbound.push('\n');
        }
    }
    inbound.push_str(
        &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"one-too-many"}})
            .to_string(),
    );
    inbound.push('\n');
    peer.incoming
        .send(inbound)
        .map_err(|_| "refusal fixture did not reach the driver".to_owned())?;
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("overflow refusal returned before accepted notifications drained".to_owned());
    }

    connection.close().await;
    if poll_once(driver.as_mut()).await.is_none() {
        return Err("connection close did not interrupt overflow refusal drain".to_owned());
    }
    if !matches!(request.await, Err(ConnectionError::Closed)) {
        return Err("connection close did not settle the pending request".to_owned());
    }
    if *closed.borrow() {
        return Err("connection closed before accepted notifications drained".to_owned());
    }
    let dispatcher_task = tokio::spawn(dispatcher.run());
    dispatcher_task
        .await
        .map_err(|error| format!("notification dispatcher task did not join: {error}"))?;
    if !*closed.borrow() {
        return Err("notification dispatcher drained without closing the connection".to_owned());
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn close_interrupts_eof_notification_drain() -> Result<(), String> {
    let (transport, mut peer) = test_transport();
    let applications = Arc::new(AtomicUsize::new(0));
    let handler_applications = Arc::clone(&applications);
    let (connection, driver, dispatcher) = Connection::with_notification_handler(
        transport,
        move |_| {
            handler_applications.fetch_add(1, Ordering::Relaxed);
        },
        |_| {},
    );
    let closed = connection.subscribe_closed();
    let mut driver = Box::pin(driver.run());
    let mut request = Box::pin(connection.request("test/method", None));
    if poll_once(request.as_mut()).await.is_some() {
        return Err("request settled before submission".to_owned());
    }
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("driver stopped after submitting the request".to_owned());
    }
    peer.outgoing
        .recv()
        .await
        .ok_or_else(|| "driver did not submit the request".to_owned())?;

    peer.incoming
        .send(format!(
            "{}\n",
            json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"session-1"}})
        ))
        .map_err(|_| "accepted notification did not reach the driver".to_owned())?;
    drop(peer.incoming);
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("EOF returned before the accepted notification drained".to_owned());
    }

    connection.close().await;
    if poll_once(driver.as_mut()).await.is_none() {
        return Err("connection close did not interrupt the EOF drain".to_owned());
    }
    if !matches!(request.await, Err(ConnectionError::Closed)) {
        return Err("connection close did not settle the pending request".to_owned());
    }
    if *closed.borrow() {
        return Err("connection closed before the accepted notification drained".to_owned());
    }
    let dispatcher_task = tokio::spawn(dispatcher.run());
    dispatcher_task
        .await
        .map_err(|error| format!("notification dispatcher task did not join: {error}"))?;
    if !*closed.borrow() {
        return Err("notification dispatcher drained without closing the connection".to_owned());
    }
    if applications.load(Ordering::Relaxed) != 1 {
        return Err("notification dispatcher lost the accepted notification".to_owned());
    }
    Ok(())
}
