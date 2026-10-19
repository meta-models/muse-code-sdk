//! Quickstart for driving Muse Code from a caller-owned Tokio runtime.

use muse_code_sdk::client::{MuseClient, StartSessionOptions};
use muse_code_sdk::msp::{
    Item, ItemKind, ItemStatus, TurnInputPart, TurnInputPartType, TurnTerminal,
};
use muse_code_sdk::session::SendUserTurnOptions;
use muse_code_sdk::spawn::SpawnOptions;
use muse_code_sdk::turn::TurnOutcome;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let connection = MuseClient::spawn(SpawnOptions::default()).await?;
    if let Some(warning) = &connection.fingerprint_warning {
        eprintln!(
            "schema fingerprint mismatch: expected {}, host reported {}",
            warning.expected, warning.actual
        );
    }

    let client = connection.client;
    let workspace_root = std::env::current_dir()?.to_string_lossy().into_owned();
    let session = client
        .start_session(quickstart_session_options(workspace_root))
        .await?;
    let turn = session
        .send_user_turn(user_turn("Summarize this repository."))
        .await?;

    let mut items = turn.items();
    while let Some(item) = items.recv().await? {
        print_item(&item);
    }

    let terminal = turn.completed().await?;
    print_terminal(&terminal);

    let completed = matches!(
        terminal,
        TurnOutcome::Completed { ref params, .. } if params.terminal == TurnTerminal::Completed
    );
    client.close().await;
    if !completed {
        std::process::exit(1);
    }
    Ok(())
}

fn quickstart_session_options(workspace_root: String) -> StartSessionOptions {
    StartSessionOptions {
        workspace_root: Some(workspace_root),
        ..StartSessionOptions::default()
    }
}

fn user_turn(prompt: impl Into<String>) -> SendUserTurnOptions {
    SendUserTurnOptions {
        input: vec![text_part(prompt)],
        ..SendUserTurnOptions::default()
    }
}

/// The model's answer text: a completed agent message. Reasoning,
/// reminder-child and other items carry text too, and `items()` also yields an
/// answer's in-progress revisions (empty text) and a retried attempt's failed
/// partial text; none of it is the reply, so the example does not print it.
fn answer_text(item: &Item) -> Option<&str> {
    match (&item.kind, &item.status) {
        (ItemKind::AgentMessage, ItemStatus::Completed) => item.text.as_deref(),
        _ => None,
    }
}

fn print_item(item: &Item) {
    if let Some(text) = answer_text(item) {
        println!("{text}");
    }
}

fn print_terminal(outcome: &TurnOutcome) {
    match outcome {
        TurnOutcome::Completed { params, .. } => match &params.terminal {
            TurnTerminal::Completed => println!("turn completed"),
            TurnTerminal::Cancelled => println!("turn cancelled"),
            TurnTerminal::Failed => {
                if let Some(error) = &params.error {
                    println!("turn failed: {}", error.message);
                } else if let Some(reason) = &params.reason {
                    println!("turn failed: {reason}");
                } else {
                    println!("turn failed");
                }
            }
            // An open enum: a newer host can send a terminal this SDK does not name.
            other => println!("turn ended: {}", other.as_str()),
        },
        TurnOutcome::Unqueued(params) => {
            println!("turn {} was unqueued before launch", params.turn_id);
        }
        // The SDK's outcome enums are open: a later release may add one.
        _ => println!("turn ended"),
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn item(kind: &str, status: &str, text_member: &str, text: &str) -> Result<Item, String> {
        let mut value = serde_json::json!({
            "itemId": "item-1",
            "kind": kind,
            "turnId": "turn-1",
            "revision": 1,
            "status": status,
        });
        value[text_member] = serde_json::Value::from(text);
        serde_json::from_value(value)
            .map_err(|error| format!("{kind} item did not decode: {error}"))
    }

    #[test]
    fn quickstart_prints_only_the_answer() -> Result<(), String> {
        let answer = item(
            "agentMessage",
            "completed",
            "text",
            "The repository holds a CLI.",
        )?;
        assert_eq!(answer_text(&answer), Some("The repository holds a CLI."));
        let reasoning = item(
            "reasoning",
            "completed",
            "text",
            "First I should list the files.",
        )?;
        assert_eq!(answer_text(&reasoning), None, "reasoning is not the answer");
        let reminder = item(
            "reminderChild",
            "completed",
            "fallbackText",
            "Reminder child session",
        )?;
        assert_eq!(
            answer_text(&reminder),
            None,
            "a reminder child is not the answer"
        );
        let opening = item("agentMessage", "inProgress", "text", "")?;
        assert_eq!(
            answer_text(&opening),
            None,
            "an answer still in progress is not printed"
        );
        let burned = item("agentMessage", "failed", "text", "The repository hol")?;
        assert_eq!(
            answer_text(&burned),
            None,
            "a failed attempt's partial text is not the answer"
        );
        Ok(())
    }

    #[test]
    fn quickstart_opens_the_requested_workspace() {
        let options = quickstart_session_options("/workspace/project".to_owned());

        assert_eq!(
            options.workspace_root.as_deref(),
            Some("/workspace/project")
        );
    }
}
