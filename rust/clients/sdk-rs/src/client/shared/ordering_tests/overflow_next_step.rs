use super::*;

/// Without a durable host the SDK cannot count on a session to resume, so the
/// overflow failure's next step is a new session on a new client; an
/// unrecognized durability gets the same conservative step.
#[tokio::test(flavor = "current_thread")]
async fn overflow_without_a_durable_host_says_to_start_a_new_session() -> Result<(), String> {
    for durability in [
        SessionDurability::Ephemeral,
        SessionDurability::Unknown("future".to_owned()),
    ] {
        let label = format!("{durability:?} session");
        let (client, mut peer, _application_started, _release, _overflow_observed) =
            paused_client_with(0, durability);
        let router = Arc::clone(&client.shared.router);
        let session = start_session(&client, &mut peer, "affected").await?;
        let turn = start_turn(&session, &mut peer, "turn-affected").await?;

        router.overflow(routed_notification(notification(
            "test/overflow",
            json!({"sessionId": "affected"}),
        ))?);
        expect_event_source_failure(
            turn.completed(),
            "notification backlog exceeded for this session; this host does not guarantee a resumable session, so start a new session on a new client to continue",
            &label,
        )
        .await?;
        client.close().await;
    }
    Ok(())
}
