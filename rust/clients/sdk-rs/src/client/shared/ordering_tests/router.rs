use super::*;

#[tokio::test(flavor = "current_thread")]
async fn session_snapshot_preserves_a_live_route_and_its_backlog() -> Result<(), String> {
    let (client, mut peer, _, _, _) = paused_client(0);
    let live_session = start_session(&client, &mut peer, "session-1").await?;
    let live_notification = serde_json::from_value::<crate::msp::Notification>(notification(
        "item/completed",
        json!({"sessionId": "session-1", "sequence": 7}),
    ))
    .map_err(|error| format!("live notification fixture is invalid: {error}"))?;
    let dead_notification = serde_json::from_value::<crate::msp::Notification>(notification(
        "item/completed",
        json!({"sessionId": "dead", "sequence": 9}),
    ))
    .map_err(|error| format!("dead notification fixture is invalid: {error}"))?;

    let router = Arc::clone(&client.shared.router);
    {
        let mut state = lock(&router.state);
        let Some(live_route) = state.sessions.get_mut("session-1") else {
            return Err("registered live route is missing".to_owned());
        };
        live_route
            .notifications
            .push_back(RoutedNotification::Notification(live_notification));
        live_route.draining = true;
        state.sessions.insert(
            "dead".to_owned(),
            ActiveRoute {
                session: Weak::new(),
                notifications: VecDeque::from([RoutedNotification::Notification(
                    dead_notification,
                )]),
                draining: false,
                overflowed: false,
            },
        );
    }

    let snapshot = router.sessions();
    let snapshot_ids = snapshot
        .iter()
        .map(|session| session.session_id())
        .collect::<Vec<_>>();
    if snapshot_ids != ["session-1"] {
        return Err(format!(
            "snapshot lost or duplicated the live route: {snapshot_ids:?}"
        ));
    }

    let mut state = lock(&router.state);
    let Some(live_route) = state.sessions.get("session-1") else {
        return Err("snapshot retired the live route".to_owned());
    };
    if live_route.session.upgrade().is_none() {
        return Err("snapshot replaced the live route with a dead weak handle".to_owned());
    }
    if !live_route.draining
        || live_route.overflowed
        || !matches!(
            live_route.notifications.front(),
            Some(RoutedNotification::Notification(notification))
                if notification.params.as_ref()
                    .and_then(|params| params.get("sequence"))
                    .and_then(Value::as_u64) == Some(7)
        )
        || live_route.notifications.len() != 1
    {
        return Err("snapshot changed the live route backlog state".to_owned());
    }
    if state.sessions.contains_key("dead") {
        return Err("snapshot retained the dead route".to_owned());
    }
    let dead_pending = state.take_pending("dead");
    let dead_sequences = dead_pending
        .notifications
        .into_iter()
        .filter_map(|notification| {
            notification
                .params
                .and_then(|params| params.get("sequence").cloned())
                .and_then(|value| value.as_u64())
        })
        .collect::<Vec<_>>();
    if dead_sequences != [9] {
        return Err(format!(
            "snapshot did not preserve the retired backlog: {dead_sequences:?}"
        ));
    }
    drop(state);
    drop(live_session);
    Ok(())
}

#[tokio::test(flavor = "current_thread")]
async fn live_router_overflow_precedes_a_newer_terminal() -> Result<(), String> {
    let (client, mut peer, mut application_started, release, mut overflow_observed) =
        paused_client(2);
    let mut protocol_errors = client.shared.connection.subscribe_protocol_errors();
    let session = start_session(&client, &mut peer, "session-1").await?;
    let turn = start_turn(&session, &mut peer, "turn-1").await?;

    peer.send(notification("test/held", json!({"sessionId": "session-1"})))?;
    if application_started.recv().await != Some(0) {
        return Err("first notification did not pause application".to_owned());
    }

    let mut burst = String::new();
    for sequence in 0..=NOTIFICATION_HANDLER_CAPACITY {
        burst.push_str(
            &notification(
                "test/burst",
                json!({"sessionId": "session-1", "sequence": sequence}),
            )
            .to_string(),
        );
        burst.push('\n');
    }
    burst.push_str("not-json\n");
    peer.send_raw(burst)?;
    protocol_errors
        .recv()
        .await
        .map_err(|error| format!("overflow receipt was not observed: {error}"))?;

    release
        .send(())
        .map_err(|_| "first paused handler closed".to_owned())?;
    if application_started.recv().await != Some(1) {
        return Err("second notification did not pause application".to_owned());
    }
    peer.send_raw(format!("{}\nnot-json\n", terminal("session-1", "turn-1")))?;
    protocol_errors
        .recv()
        .await
        .map_err(|error| format!("terminal receipt was not observed: {error}"))?;
    release
        .send(())
        .map_err(|_| "second paused handler closed".to_owned())?;
    let applied_before_overflow = overflow_observed
        .recv()
        .await
        .ok_or_else(|| "overflow callback was not observed".to_owned())?;
    if applied_before_overflow != 1 + NOTIFICATION_HANDLER_CAPACITY {
        return Err(format!(
            "overflow ran after {applied_before_overflow} applied notifications; expected all {} accepted notifications first",
            1 + NOTIFICATION_HANDLER_CAPACITY
        ));
    }

    match turn.completed().await {
        Err(error)
            if matches!(
                error.to_string().as_str(),
                "notification backlog exceeded for this session; close this client, then resume the session on a new client to continue"
                    | "turn event source failed before a terminal outcome: notification backlog exceeded for this session; close this client, then resume the session on a new client to continue"
            ) => {}
        Ok(outcome) => return Err(format!("newer terminal displaced overflow: {outcome:?}")),
        Err(error) => return Err(format!("overflow settled unexpectedly: {error}")),
    }
    Ok(())
}
