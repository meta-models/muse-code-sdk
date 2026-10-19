use muse_code_sdk::client::{MuseClient, StartSessionOptions};
use muse_code_sdk::msp::{TurnInputPart, TurnInputPartType};
use muse_code_sdk::session::SendUserTurnOptions;
use muse_code_sdk::spawn::SpawnOptions;
use muse_code_sdk::turn::TurnOutcome;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let connection = MuseClient::spawn(SpawnOptions::default()).await?;
    let client = connection.client;
    let session = client.start_session(StartSessionOptions::default()).await?;
    let turn = session
        .send_user_turn(SendUserTurnOptions {
            input: vec![text_part("Summarize this repository.")],
            ..SendUserTurnOptions::default()
        })
        .await?;

    let mut items = turn.items();
    while let Some(item) = items.recv().await? {
        println!("{:?}", item.kind);
    }
    match turn.completed().await? {
        TurnOutcome::Completed { params, .. } => println!("turn ended as {:?}", params.terminal),
        TurnOutcome::Unqueued(params) => println!("turn {} was unqueued", params.turn_id),
        _ => println!("turn ended"),
    }
    client.close().await;
    Ok(())
}

fn text_part(text: impl Into<String>) -> TurnInputPart {
    TurnInputPart {
        part_type: TurnInputPartType::Text,
        text: Some(text.into()),
        media_type: None,
        base64_data: None,
        width: None,
        height: None,
        selector: None,
        arguments: None,
        upload_id: None,
        source: None,
    }
}
