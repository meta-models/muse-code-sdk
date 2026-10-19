use super::*;

fn overflow_notification() -> Result<crate::msp::Notification, String> {
    serde_json::from_value(notification(
        "test/overflow",
        json!({"sessionId": "session-1"}),
    ))
    .map_err(|error| format!("overflow notification did not decode: {error}"))
}

#[tokio::test(flavor = "current_thread")]
async fn same_id_replacement_stays_pending_until_its_own_overflow() -> Result<(), String> {
    let (client, mut peer, _, _, _) = paused_client(0);
    let original = start_session(&client, &mut peer, "session-1").await?;
    let original_turn = start_turn(&original, &mut peer, "turn-1").await?;
    let router = Arc::clone(&client.shared.router);

    router.overflow(overflow_notification()?);
    expect_overflow_failure(original_turn.completed(), "original session").await?;
    drop(original_turn);
    drop(original);

    let replacement = start_session(&client, &mut peer, "session-1").await?;
    let replacement_turn = start_turn(&replacement, &mut peer, "turn-1").await?;
    let mut replacement_completed = Box::pin(replacement_turn.completed());
    if let Some(result) = poll_once(replacement_completed.as_mut()).await {
        return Err(format!(
            "same-id replacement inherited retired overflow before its own overflow: {result:?}"
        ));
    }

    router.overflow(overflow_notification()?);
    expect_overflow_failure(replacement_completed.as_mut(), "replacement session").await?;
    Ok(())
}
