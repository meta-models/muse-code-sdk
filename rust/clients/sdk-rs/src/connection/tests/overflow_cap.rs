use super::*;

/// The frame refused at the overflow-marker cap still
/// reaches the overflow handler after the accepted drain and before closure,
/// so its session fails with a lost event instead of only seeing the
/// transport end.
#[tokio::test(flavor = "current_thread")]
async fn saturated_overflow_cap_reports_the_refused_frame_before_closing() -> Result<(), String> {
    let (transport, peer) = test_transport();
    // Each overflow call records its session and whether closure was already
    // published, so a refusal reported only after closing fails here.
    let overflowed = Arc::new(StdMutex::new(Vec::new()));
    let closed = Arc::new(StdMutex::new(None::<tokio::sync::watch::Receiver<bool>>));
    let (connection, driver, dispatcher) =
        Connection::with_notification_handler(transport, |_| {}, {
            let overflowed = Arc::clone(&overflowed);
            let closed = Arc::clone(&closed);
            move |notification: Notification| {
                let was_closed = closed
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .as_ref()
                    .is_some_and(|closed| *closed.borrow());
                overflowed
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push((notification_session_id(&notification), was_closed));
            }
        });
    *closed
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(connection.subscribe_closed());
    let mut inbound = String::new();
    for prefix in ["live", "queued", "saturated"] {
        for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
            inbound.push_str(
                &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":format!("{prefix}-{sequence}")}})
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
        .map_err(|_| "capacity fixture could not reach the driver".to_owned())?;

    let driver = tokio::spawn(driver.run());
    tokio::spawn(dispatcher.run())
        .await
        .map_err(|error| format!("notification dispatcher task did not join: {error}"))?;
    driver
        .await
        .map_err(|error| format!("driver task did not join: {error}"))?;

    let overflowed = overflowed
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    if overflowed.last() != Some(&(Some("one-too-many".to_owned()), false)) {
        return Err(format!(
            "the refused frame must reach the overflow handler before closure; last: {:?}",
            overflowed.last()
        ));
    }
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn saturated_overflow_cap_closes_the_driver() -> Result<(), String> {
    close_on_saturated_frame(
        json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":"one-too-many"}}),
    )
    .await
}

// At the overflow cap the connection closes before it can reply, so a routed
// approval gets no receipt.
#[tokio::test(flavor = "current_thread")]
async fn saturated_overflow_cap_refuses_a_routed_approval_without_a_receipt() -> Result<(), String>
{
    close_on_saturated_frame(
        json!({"jsonrpc":"2.0","id":7,"method":"approval/request","params":{"sessionId":"one-too-many"}}),
    )
    .await
}

// A routed question gets no receipt at the overflow cap either.
#[tokio::test(flavor = "current_thread")]
async fn saturated_overflow_cap_refuses_a_routed_question_without_a_receipt() -> Result<(), String>
{
    close_on_saturated_frame(
        json!({"jsonrpc":"2.0","id":7,"method":"userInput/request","params":{"sessionId":"one-too-many"}}),
    )
    .await
}

/// Saturates the handler, dispatch queue and overflow sidecar, then sends
/// `last`, which the full sidecar must refuse by closing the driver unanswered.
async fn close_on_saturated_frame(last: Value) -> Result<(), String> {
    let (transport, mut peer) = test_transport();
    let (connection, driver, dispatcher) =
        Connection::with_notification_handler(transport, |_| {}, |_| {});
    let closed = connection.subscribe_closed();
    let mut inbound = String::new();
    for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
        inbound.push_str(
            &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":format!("live-{sequence}")}})
                .to_string(),
        );
        inbound.push('\n');
    }
    for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
        inbound.push_str(
            &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":format!("queued-{sequence}")}})
                .to_string(),
        );
        inbound.push('\n');
    }
    for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
        inbound.push_str(
            &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":format!("saturated-{sequence}")}})
                .to_string(),
        );
        inbound.push('\n');
    }
    inbound.push_str(&last.to_string());
    inbound.push('\n');
    peer.incoming
        .send(inbound)
        .map_err(|_| "capacity fixture could not reach the driver".to_owned())?;

    let mut driver = Box::pin(driver.run());
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("driver returned before accepted notifications drained".to_owned());
    }
    if dispatcher.queue.len() != NOTIFICATION_DISPATCH_CAPACITY {
        return Err(format!(
            "driver stopped at the wrong dispatch depth: {}",
            dispatcher.queue.len()
        ));
    }
    if *closed.borrow() {
        return Err("driver published closure before dispatch drained".to_owned());
    }
    // A driver that kept reading would already have written its reply.
    if let Ok(frame) = peer.outgoing.try_recv() {
        return Err(format!("driver answered the refused frame: {frame}"));
    }

    let dispatcher_task = tokio::spawn(dispatcher.run());
    dispatcher_task
        .await
        .map_err(|error| format!("notification dispatcher task did not join: {error}"))?;
    driver.await;
    if !*closed.borrow() {
        return Err("dispatcher drained without publishing the closed receipt".to_owned());
    }
    Ok(())
}

// Below the overflow cap, a routed approval the full handler queue drops goes
// to its session's overflow marker and still gets its receipt.
#[tokio::test(flavor = "current_thread")]
async fn queue_full_routed_approval_overflows_its_session_and_still_gets_a_receipt()
-> Result<(), String> {
    overflow_routed_request_with_a_receipt("approval/request").await
}

// A routed question takes the same overflow path.
#[tokio::test(flavor = "current_thread")]
async fn queue_full_routed_question_overflows_its_session_and_still_gets_a_receipt()
-> Result<(), String> {
    overflow_routed_request_with_a_receipt("userInput/request").await
}

/// Fills the handler queue, then sends a routed `method` request that the full
/// queue must drop to its session's overflow marker and still receipt.
async fn overflow_routed_request_with_a_receipt(method: &str) -> Result<(), String> {
    let (transport, mut peer) = test_transport();
    let (overflowed_session, mut overflowed) = mpsc::unbounded_channel();
    let (_connection, driver, dispatcher) = Connection::with_notification_handler(
        transport,
        |_| {},
        move |notification| {
            if let Some(session_id) = notification_session_id(&notification) {
                let _ = overflowed_session.send(session_id);
            }
        },
    );
    let mut inbound = String::new();
    for sequence in 0..NOTIFICATION_HANDLER_CAPACITY {
        inbound.push_str(
            &json!({"jsonrpc":"2.0","method":"item/completed","params":{"sessionId":format!("live-{sequence}")}})
                .to_string(),
        );
        inbound.push('\n');
    }
    inbound.push_str(
        &json!({"jsonrpc":"2.0","id":7,"method":method,"params":{"sessionId":"dropped"}})
            .to_string(),
    );
    inbound.push('\n');
    peer.incoming
        .send(inbound)
        .map_err(|_| "capacity fixture could not reach the driver".to_owned())?;

    let mut driver = Box::pin(driver.run());
    if poll_once(driver.as_mut()).await.is_some() {
        return Err("driver returned before its input ended".to_owned());
    }
    let reply = peer
        .outgoing
        .try_recv()
        .map_err(|error| format!("dropped {method} got no receipt: {error}"))?;
    if serde_json::from_str::<Value>(&reply).ok()
        != Some(json!({"jsonrpc":"2.0","id":7,"result":{}}))
    {
        return Err(format!("dropped {method} got the wrong reply: {reply}"));
    }

    drop(peer);
    let dispatcher_task = tokio::spawn(dispatcher.run());
    driver.await;
    dispatcher_task
        .await
        .map_err(|error| format!("notification dispatcher task did not join: {error}"))?;
    match overflowed.try_recv() {
        Ok(session_id) if session_id == "dropped" => Ok(()),
        Ok(session_id) => Err(format!("the wrong session overflowed: {session_id}")),
        Err(error) => Err(format!(
            "the dropped {method}'s session never overflowed: {error}"
        )),
    }
}
