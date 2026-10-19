//! Recipes for the current Rust SDK API.

use std::future::{Future, pending};
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use muse_code_sdk::DuplexTransport;
use muse_code_sdk::approval::ApprovalDecisionInput;
use muse_code_sdk::client::{MuseClient, ResumeSessionOptions, StartSessionOptions};
use muse_code_sdk::errors::MuseError;
use muse_code_sdk::msp::{
    ApprovalDecision, ApprovalMode, ApprovalRequestParams, Item, ItemKind, ItemStatus,
    PlatformFamily, PlatformOs, SessionDurability, TurnInputPart, TurnInputPartType, TurnTerminal,
};
use muse_code_sdk::session::{ReconnectResolution, Reconnected, SendUserTurnOptions};
use muse_code_sdk::spawn::SpawnOptions;
use muse_code_sdk::turn::{Turn, TurnOutcome};
use serde_json::Value;

const MISMATCHED_FINGERPRINT: &str =
    "sha256:0000000000000000000000000000000000000000000000000000000000000000";

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    match std::env::args().nth(1).as_deref() {
        Some("approve-deny") => approve_deny().await?,
        Some("retry-safe") => retry_safe().await?,
        Some("cancel") => cancel_with_close().await?,
        Some("fingerprint-mismatch") => fingerprint_mismatch().await?,
        _ => stream_turn().await?,
    }
    Ok(())
}

async fn stream_turn() -> Result<(), Box<dyn std::error::Error>> {
    let connection = MuseClient::spawn(SpawnOptions::default()).await?;
    let client = connection.client;
    report_fingerprint(connection.fingerprint_warning.as_ref());

    let session = client.start_session(StartSessionOptions::default()).await?;
    let turn = session
        .send_user_turn(user_turn("Stream the answer as item revisions arrive."))
        .await?;

    let terminal = drain_turn(&turn).await?;
    print_terminal(&terminal);
    client.close().await;
    Ok(())
}

async fn approve_deny() -> Result<(), Box<dyn std::error::Error>> {
    let workspace_root = std::env::current_dir()?.to_string_lossy().into_owned();
    let connection = MuseClient::spawn(SpawnOptions::default()).await?;
    let client = connection.client;
    let result = run_approve_deny(&client, workspace_root).await;
    client.close().await;
    result
}

async fn run_approve_deny(
    client: &MuseClient,
    workspace_root: String,
) -> Result<(), Box<dyn std::error::Error>> {
    let session = client
        .start_session(approve_session_options(workspace_root.clone()))
        .await?;
    let approval_seen = Arc::new(AtomicBool::new(false));
    let approval_seen_by_handler = Arc::clone(&approval_seen);
    session.on_approval(move |request| {
        approval_seen_by_handler.store(true, Ordering::Release);
        async move {
            choose(
                &request,
                ApprovalDecision::ApprovedForSession,
                Some("approved by recipe".to_owned()),
            )
        }
    });
    let turn = session
        .send_user_turn(user_turn(
            "Use the shell to print the current directory, then summarize it.",
        ))
        .await?;
    let terminal = drain_turn(&turn).await?;
    print_terminal(&terminal);
    match check_approved_turn(&terminal, approval_seen.load(Ordering::Acquire)) {
        Ok(()) => run_default_deny_turn(client, workspace_root).await,
        Err(error) => Err(Box::new(error) as Box<dyn std::error::Error>),
    }
}

async fn run_default_deny_turn(
    client: &MuseClient,
    workspace_root: String,
) -> Result<(), Box<dyn std::error::Error>> {
    let session = client
        .start_session(default_deny_session_options(workspace_root))
        .await?;
    // No handler is registered; denyUnmatched makes the server reject unmatched requests.
    let turn = session
        .send_user_turn(user_turn(
            "Try to use the shell; this session leaves approval to server default-deny.",
        ))
        .await?;
    let (terminal, items) = drain_turn_items(&turn).await?;
    print_terminal(&terminal);
    check_default_deny_turn(&terminal, &items)?;
    Ok(())
}

fn approval_session_options(
    workspace_root: String,
    approval_mode: ApprovalMode,
) -> StartSessionOptions {
    StartSessionOptions {
        workspace_root: Some(workspace_root),
        approval_mode: Some(approval_mode),
        ..StartSessionOptions::default()
    }
}

fn approve_session_options(workspace_root: String) -> StartSessionOptions {
    approval_session_options(workspace_root, ApprovalMode::PromptUnmatched)
}

fn default_deny_session_options(workspace_root: String) -> StartSessionOptions {
    approval_session_options(workspace_root, ApprovalMode::DenyUnmatched)
}

fn check_approved_turn(terminal: &TurnOutcome, approval_seen: bool) -> io::Result<()> {
    // Check the turn first so a dead turn is not blamed on a missing workspace.
    require_completed_turn("approved", terminal)
        .and_then(|()| require_approval_request(approval_seen))
}

fn check_default_deny_turn(terminal: &TurnOutcome, items: &[Item]) -> io::Result<()> {
    // A denied tool call reaches the model as a typed denial, so the turn still
    // completes. Check the turn first so a dead turn is not blamed on the model.
    require_completed_turn("default-deny", terminal)
        .and_then(|()| require_rejected_tool_call(items))
}

fn require_rejected_tool_call(items: &[Item]) -> io::Result<()> {
    let rejected = items.iter().any(|item| {
        matches!(item.kind, ItemKind::ToolCall) && matches!(item.status, ItemStatus::Rejected)
    });
    if rejected {
        Ok(())
    } else {
        Err(io::Error::other(
            "approve-deny expected the default-deny turn to reject a tool call, but none settled rejected; with no tool call the model never tried the shell, and a completed one means the host ran it",
        ))
    }
}

fn turn_completed(outcome: &TurnOutcome) -> bool {
    matches!(
        outcome,
        TurnOutcome::Completed { params, .. } if params.terminal == TurnTerminal::Completed
    )
}

fn require_completed_turn(label: &str, outcome: &TurnOutcome) -> io::Result<()> {
    if turn_completed(outcome) {
        Ok(())
    } else {
        Err(io::Error::other(format!(
            "approve-deny expected the {label} turn to complete; see the terminal printed above"
        )))
    }
}

fn require_approval_request(approval_seen: bool) -> io::Result<()> {
    if approval_seen {
        Ok(())
    } else {
        Err(io::Error::other(
            "approve-deny expected an approval request, but the host sent none; verify that the session workspace exposes shell tools",
        ))
    }
}

async fn retry_safe() -> Result<(), Box<dyn std::error::Error>> {
    let connection = MuseClient::spawn(SpawnOptions::default()).await?;
    let client = connection.client;
    let session = client.start_session(StartSessionOptions::default()).await?;
    // Keep the handle: dropping it would discard the command locally, and a
    // discarded command is not carried across the reconnect.
    let first_attempt = session
        .send_user_turn(user_turn(
            "Start idempotent work; this spawned client will close before reconnecting.",
        ))
        .await?;
    println!(
        "submitted turn {}; reconnecting by session id",
        first_attempt.turn_id()
    );
    // Closing a spawned client also stops the host it launched; resume only
    // reattaches to whatever session state the next host can serve.
    client.close().await;
    let carried = session.pending();
    let session_id = session.session_id().to_owned();

    let reconnected = MuseClient::spawn(SpawnOptions::default()).await?;
    let resumed = reconnected
        .client
        .resume_session(ResumeSessionOptions {
            session_id,
            ..ResumeSessionOptions::default()
        })
        .await?;
    // The original command ids make this a retry: a written intake replays its
    // first decision instead of running the work a second time.
    let result = retry_result(resumed.resolve_reconnect(carried).await).await;
    drop(first_attempt);
    reconnected.client.close().await;
    result
}

/// The recipe's result: the reconnect's own error, or its first failed retry.
async fn retry_result(
    reconnect: Result<Vec<ReconnectResolution>, MuseError>,
) -> Result<(), Box<dyn std::error::Error>> {
    match reconnect {
        Ok(resolutions) => match settle_retries(resolutions).await.into_iter().next() {
            Some(failure) => Err(Box::new(failure)),
            None => Ok(()),
        },
        Err(error) => Err(Box::new(error)),
    }
}

/// Handles each entry on its own: a refusal does not stop the later entries,
/// and every live turn stays held until it settles. Returns every failed
/// retry, in order.
async fn settle_retries(resolutions: Vec<ReconnectResolution>) -> Vec<io::Error> {
    let mut failures = Vec::new();
    for resolution in resolutions {
        let failure = match resolution.result {
            Ok(Reconnected::Live(turn)) => {
                live_retry_failure(turn.turn_id(), drain_turn(&turn).await)
            }
            // The resend replayed a turn that had already ended, so the work
            // did not run twice. That turn's terminal is the first attempt's,
            // usually the cancellation this recipe's own close caused.
            Ok(Reconnected::Ended { last_turn, .. }) => {
                print_last_turn_terminal(
                    &last_turn.turn_id,
                    &last_turn.terminal,
                    last_turn.reason.as_deref(),
                    last_turn.error.as_ref().map(|error| error.message.as_str()),
                );
                None
            }
            Err(error) => Some(io::Error::other(format!(
                "retry-safe: resending {} failed: {error}",
                resolution.command_id
            ))),
            // `Reconnected` is open: a later release may add a resolution.
            Ok(_) => {
                println!("resent {}", resolution.command_id);
                None
            }
        };
        if let Some(failure) = failure {
            println!("{failure}");
            failures.push(failure);
        }
    }
    failures
}

/// Why a retried live turn failed, if it did: it did not settle, or it settled
/// without completing.
fn live_retry_failure(
    turn_id: &str,
    drained: Result<TurnOutcome, Box<dyn std::error::Error>>,
) -> Option<io::Error> {
    match drained {
        Ok(terminal) => {
            print_terminal(&terminal);
            (!turn_completed(&terminal)).then(|| {
                io::Error::other(format!(
                    "retry-safe: retried turn {turn_id} did not complete; see the terminal printed above"
                ))
            })
        }
        Err(error) => Some(io::Error::other(format!(
            "retry-safe: turn {turn_id} did not settle: {error}"
        ))),
    }
}

async fn cancel_with_close() -> Result<(), Box<dyn std::error::Error>> {
    let connection = MuseClient::spawn(SpawnOptions::default()).await?;
    let client = connection.client;
    let session = client.start_session(StartSessionOptions::default()).await?;
    let turn = session
        .send_user_turn(user_turn(
            "Start a long-running task, then close the client.",
        ))
        .await?;

    println!("closing client while turn {} is pending", turn.turn_id());
    client.close().await;
    report_close_settlement(turn.completed().await)?;
    Ok(())
}

fn report_close_settlement(result: Result<TurnOutcome, MuseError>) -> Result<(), MuseError> {
    match result {
        Ok(outcome) => print_terminal(&outcome),
        Err(error) if is_expected_close_error(&error) => {
            println!("turn settled locally by close: {error}");
        }
        Err(error) => return Err(error),
    }
    Ok(())
}

fn is_expected_close_error(error: &MuseError) -> bool {
    matches!(error, MuseError::ClientClosed)
}

async fn fingerprint_mismatch() -> Result<(), Box<dyn std::error::Error>> {
    let transport = ScriptedAttachTransport::fingerprint_mismatch();
    let connection = MuseClient::attach(transport).await?;
    report_fingerprint(connection.fingerprint_warning.as_ref());
    connection.client.close().await;
    Ok(())
}

async fn drain_turn(turn: &Turn) -> Result<TurnOutcome, Box<dyn std::error::Error>> {
    Ok(drain_turn_items(turn).await?.0)
}

/// Drains the turn like `drain_turn` and also keeps every item revision it read.
async fn drain_turn_items(
    turn: &Turn,
) -> Result<(TurnOutcome, Vec<Item>), Box<dyn std::error::Error>> {
    let mut items = turn.items();
    let mut drained = Vec::new();
    while let Some(item) = items.recv().await? {
        print_item(&item);
        drained.push(item);
    }
    Ok((turn.completed().await?, drained))
}

fn choose(
    request: &ApprovalRequestParams,
    decision: ApprovalDecision,
    feedback: Option<String>,
) -> ApprovalDecisionInput {
    let requested_choice = request
        .available_choices
        .iter()
        .find(|choice| choice.decision == decision)
        .or_else(|| {
            (decision == ApprovalDecision::ApprovedForSession).then(|| {
                request
                    .available_choices
                    .iter()
                    .find(|choice| choice.decision == ApprovalDecision::Approved)
            })?
        });

    if let Some(choice) = requested_choice {
        return ApprovalDecisionInput {
            choice_id: choice.choice_id.clone(),
            feedback: feedback.filter(|_| choice.accepts_feedback),
        };
    }

    if let Some(choice) = request
        .available_choices
        .iter()
        .find(|choice| choice.decision == ApprovalDecision::Denied && choice.rule_preview.is_none())
        .or_else(|| {
            request
                .available_choices
                .iter()
                .find(|choice| choice.decision == ApprovalDecision::Abort)
        })
    {
        return ApprovalDecisionInput {
            choice_id: choice.choice_id.clone(),
            feedback: None,
        };
    };

    ApprovalDecisionInput {
        choice_id: "no_offered_choice".to_owned(),
        feedback: None,
    }
}

/// The model's answer text: a completed agent message. Reasoning,
/// reminder-child and other items carry text too, and `items()` also yields an
/// answer's in-progress revisions (empty text) and a retried attempt's failed
/// partial text; none of it is the reply, so the recipes do not print it.
fn answer_text(item: &Item) -> Option<&str> {
    match (&item.kind, &item.status) {
        (ItemKind::AgentMessage, ItemStatus::Completed) => item.text.as_deref(),
        _ => None,
    }
}

fn print_item(item: &Item) {
    if let Some(text) = answer_text(item) {
        println!("[{}] {text}", item.item_id);
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

fn print_last_turn_terminal(
    turn_id: &str,
    terminal: &TurnTerminal,
    reason: Option<&str>,
    error_message: Option<&str>,
) {
    match terminal {
        TurnTerminal::Completed => println!("prior turn {turn_id} completed before reconnect"),
        TurnTerminal::Cancelled => println!("prior turn {turn_id} was cancelled before reconnect"),
        TurnTerminal::Failed => {
            if let Some(message) = error_message {
                println!("prior turn {turn_id} failed before reconnect: {message}");
            } else if let Some(reason) = reason {
                println!("prior turn {turn_id} failed before reconnect: {reason}");
            } else {
                println!("prior turn {turn_id} failed before reconnect");
            }
        }
        other => println!(
            "prior turn {turn_id} ended before reconnect: {}",
            other.as_str()
        ),
    }
}

fn report_fingerprint(warning: Option<&muse_code_sdk::fingerprint::FingerprintWarning>) {
    match warning {
        Some(warning) => println!(
            "continuing after schema warning: expected {}, host reported {}",
            warning.expected, warning.actual
        ),
        None => println!("schema fingerprint matches"),
    }
}

fn user_turn(prompt: impl Into<String>) -> SendUserTurnOptions {
    SendUserTurnOptions {
        input: vec![text_part(prompt)],
        ..SendUserTurnOptions::default()
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

struct ScriptedAttachTransport {
    fingerprint: String,
    response: Option<String>,
    initialize_written: bool,
}

impl ScriptedAttachTransport {
    fn fingerprint_mismatch() -> Self {
        Self {
            fingerprint: MISMATCHED_FINGERPRINT.to_owned(),
            response: None,
            initialize_written: false,
        }
    }
}

impl DuplexTransport for ScriptedAttachTransport {
    fn read_chunk(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
        if self.initialize_written
            && let Some(response) = self.response.take()
        {
            Box::pin(async move { Ok(Some(response)) })
        } else {
            Box::pin(pending::<io::Result<Option<String>>>())
        }
    }

    fn write(&mut self, frame: &str) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
        if let Some(id) = serde_json::from_str::<Value>(frame)
            .ok()
            .filter(|message| message.get("method").and_then(Value::as_str) == Some("initialize"))
            .and_then(|message| message.get("id").cloned())
        {
            self.response = Some(initialize_response(&self.fingerprint, id));
            self.initialize_written = true;
        }
        Box::pin(async { Ok(()) })
    }
}

fn initialize_response(fingerprint: &str, id: Value) -> String {
    // A fake host answers with wire JSON; received MSP structs are
    // `#[non_exhaustive]`, so a client never builds them by hand.
    let result = serde_json::json!({
        "serverInfo": {"name": "muse", "version": env!("CARGO_PKG_VERSION")},
        "userAgent": "muse/sdk-example",
        "museHome": "/tmp/muse-home",
        "platformFamily": PlatformFamily::Unix,
        "platformOs": PlatformOs::Linux,
        "schema": {"version": 1, "fingerprint": fingerprint},
        "grantedCapabilities": [],
        "experimentalApi": false,
        "sessionDurability": SessionDurability::Durable,
    });
    let response = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    });
    format!("{response}\n")
}

#[cfg(test)]
mod tests {
    use std::task::{Context, Poll, Waker};

    use serde_json::json;

    use super::*;

    fn ready<F: Future>(future: F) -> Option<F::Output> {
        let waker = Waker::noop();
        let mut context = Context::from_waker(waker);
        let mut future = std::pin::pin!(future);
        match future.as_mut().poll(&mut context) {
            Poll::Ready(output) => Some(output),
            Poll::Pending => None,
        }
    }

    fn item(kind: &str, status: &str, text_member: &str, text: &str) -> Result<Item, String> {
        let mut value = json!({
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
    fn recipes_print_only_the_answer() -> Result<(), String> {
        let answer = item("agentMessage", "completed", "text", "Two files changed.")?;
        assert_eq!(answer_text(&answer), Some("Two files changed."));
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

    fn approval_request(
        available_choices: serde_json::Value,
    ) -> Result<ApprovalRequestParams, String> {
        serde_json::from_value(json!({
            "sessionId": "session-1",
            "approvalId": "approval-1",
            "turnId": "turn-1",
            "taskId": "task-1",
            "itemId": "item-1",
            "toolCallId": "call-1",
            "toolName": "shell",
            "rawArgs": "{\"command\":\"pwd\"}",
            "viewCursor": "cursor-1",
            "sourceRange": {
                "stream": { "kind": "session", "id": "session-1" },
                "first": { "id": "event-1", "sequence": 1 },
                "last": { "id": "event-1", "sequence": 1 }
            },
            "subject": {
                "kind": "shell",
                "command": "pwd"
            },
            "currentRequirementId": {
                "approvalId": "approval-1",
                "sourceIndex": 0
            },
            "availableChoices": available_choices,
            "protectedWrite": false,
            "judgeEscalated": false
        }))
        .map_err(|error| format!("approval fixture did not decode: {error}"))
    }

    #[test]
    fn approve_recipe_uses_normal_approving_choice_without_unsupported_feedback()
    -> Result<(), String> {
        let request = approval_request(json!([
            {
                "choiceId": "allow_once",
                "label": "Allow once",
                "decision": "approved",
                "scope": "once"
            },
            {
                "choiceId": "deny",
                "label": "Deny",
                "decision": "denied",
                "scope": "once"
            }
        ]))?;

        let decision = choose(
            &request,
            ApprovalDecision::ApprovedForSession,
            Some("approved by recipe".to_owned()),
        );
        assert_eq!(decision.choice_id, "allow_once");
        assert_eq!(decision.feedback, None);
        Ok(())
    }

    #[test]
    fn approve_recipe_keeps_feedback_when_the_choice_accepts_it() -> Result<(), String> {
        let request = approval_request(json!([
            {
                "choiceId": "allow_session",
                "label": "Allow for session",
                "decision": "approvedForSession",
                "scope": "session",
                "acceptsFeedback": true
            },
            {
                "choiceId": "deny",
                "label": "Deny",
                "decision": "denied",
                "scope": "once"
            }
        ]))?;

        let decision = choose(
            &request,
            ApprovalDecision::ApprovedForSession,
            Some("approved by recipe".to_owned()),
        );
        assert_eq!(decision.choice_id, "allow_session");
        assert_eq!(decision.feedback.as_deref(), Some("approved by recipe"));
        Ok(())
    }

    #[test]
    fn approve_recipe_uses_real_abort_choice_when_no_approval_is_offered() -> Result<(), String> {
        let request = approval_request(json!([
            {
                "choiceId": "abort",
                "label": "Reject",
                "decision": "abort",
                "scope": "once",
                "acceptsFeedback": true
            }
        ]))?;

        let decision = choose(
            &request,
            ApprovalDecision::ApprovedForSession,
            Some("approved by recipe".to_owned()),
        );
        assert_eq!(decision.choice_id, "abort");
        assert_eq!(decision.feedback, None);
        Ok(())
    }

    #[test]
    fn approve_recipe_uses_server_denial_when_no_approval_is_offered() -> Result<(), String> {
        let request = approval_request(json!([
            {
                "choiceId": "abort",
                "label": "Reject",
                "decision": "abort",
                "scope": "once"
            },
            {
                "choiceId": "deny",
                "label": "Deny",
                "decision": "denied",
                "scope": "once",
                "acceptsFeedback": true
            }
        ]))?;

        let decision = choose(
            &request,
            ApprovalDecision::ApprovedForSession,
            Some("approved by recipe".to_owned()),
        );
        assert_eq!(decision.choice_id, "deny");
        assert_eq!(decision.feedback, None);
        Ok(())
    }

    #[test]
    fn approve_recipe_aborts_instead_of_persisting_a_deny_rule() -> Result<(), String> {
        let request = approval_request(json!([
            {
                "choiceId": "deny_computer_use_app",
                "label": "Always deny this app",
                "decision": "denied",
                "scope": "once",
                "rulePreview": "com.apple.Safari"
            },
            {
                "choiceId": "abort",
                "label": "Reject",
                "decision": "abort",
                "scope": "once"
            }
        ]))?;

        let decision = choose(
            &request,
            ApprovalDecision::ApprovedForSession,
            Some("approved by recipe".to_owned()),
        );
        assert_eq!(decision.choice_id, "abort");
        assert_eq!(decision.feedback, None);
        Ok(())
    }

    /// Hands every frame the client writes to the test and answers
    /// `initialize` like the scripted attach host, with the SDK's own
    /// fingerprint.
    struct RecordingTransport {
        attach: ScriptedAttachTransport,
        written: tokio::sync::mpsc::UnboundedSender<String>,
    }

    impl DuplexTransport for RecordingTransport {
        fn read_chunk(
            &mut self,
        ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
            self.attach.read_chunk()
        }

        fn write(
            &mut self,
            frame: &str,
        ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
            let _ = self.written.send(frame.to_owned());
            self.attach.write(frame)
        }
    }

    async fn session_start_params(
        frames: &mut tokio::sync::mpsc::UnboundedReceiver<String>,
    ) -> Result<muse_code_sdk::msp::SessionStartParams, String> {
        while let Some(frame) = frames.recv().await {
            let message: Value = serde_json::from_str(&frame)
                .map_err(|error| format!("client wrote a frame that is not json: {error}"))?;
            if message["method"] == "session/start" {
                return serde_json::from_value(message["params"].clone())
                    .map_err(|error| format!("session/start params did not decode: {error}"));
            }
        }
        Err("the client closed its transport before writing session/start".to_owned())
    }

    fn current_thread_runtime() -> Result<tokio::runtime::Runtime, String> {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("failed to build the test runtime: {error}"))
    }

    /// Attaches a client over a `RecordingTransport` and returns it with the
    /// receiver of every frame it writes.
    async fn attach_recording()
    -> Result<(MuseClient, tokio::sync::mpsc::UnboundedReceiver<String>), String> {
        let (written, frames) = tokio::sync::mpsc::unbounded_channel();
        let transport = RecordingTransport {
            attach: ScriptedAttachTransport {
                fingerprint: muse_code_sdk::fingerprint::EXPECTED.to_owned(),
                response: None,
                initialize_written: false,
            },
            written,
        };
        let client = MuseClient::attach(transport)
            .await
            .map_err(|error| format!("attach failed: {error}"))?
            .client;
        Ok((client, frames))
    }

    #[test]
    fn default_deny_recipe_starts_its_session_with_deny_unmatched() -> Result<(), String> {
        current_thread_runtime()?.block_on(async {
            let (client, mut frames) = attach_recording().await?;
            // The scripted host never answers `session/start`, so the recipe
            // waits there; the frame it wrote is the evidence.
            let start = tokio::select! {
                result = run_default_deny_turn(&client, "/workspace/project".to_owned()) => {
                    return Err(format!(
                        "the recipe finished with no session/start answer: {result:?}"
                    ));
                }
                start = session_start_params(&mut frames) => start,
            };
            client.close().await;
            let start = start?;
            if start.approval_mode != Some(ApprovalMode::DenyUnmatched) {
                return Err(format!(
                    "the default-deny recipe started its session with {:?}, not denyUnmatched",
                    start.approval_mode
                ));
            }
            if start.workspace_root.as_deref() != Some("/workspace/project") {
                return Err(format!(
                    "the default-deny recipe started in {:?}",
                    start.workspace_root
                ));
            }
            Ok(())
        })
    }

    #[test]
    fn approve_recipe_starts_its_session_with_prompt_unmatched() -> Result<(), String> {
        current_thread_runtime()?.block_on(async {
            let (client, mut frames) = attach_recording().await?;
            // As above: the recipe waits on the unanswered `session/start`.
            let start = tokio::select! {
                result = run_approve_deny(&client, "/workspace/project".to_owned()) => {
                    return Err(format!(
                        "the recipe finished with no session/start answer: {result:?}"
                    ));
                }
                start = session_start_params(&mut frames) => start,
            };
            client.close().await;
            let start = start?;
            if start.approval_mode != Some(ApprovalMode::PromptUnmatched) {
                return Err(format!(
                    "the approve recipe started its session with {:?}, not promptUnmatched",
                    start.approval_mode
                ));
            }
            if start.workspace_root.as_deref() != Some("/workspace/project") {
                return Err(format!(
                    "the approve recipe started in {:?}",
                    start.workspace_root
                ));
            }
            Ok(())
        })
    }

    #[test]
    fn approve_recipe_fails_when_no_approval_request_arrives() {
        assert!(require_approval_request(false).is_err());
    }

    fn finished_turn(terminal: &str) -> Result<TurnOutcome, String> {
        let params = serde_json::from_value(json!({
            "sessionId": "session-1",
            "viewCursor": "cursor-1",
            "sourceRange": {
                "stream": {"kind": "run", "id": "turn-1"},
                "first": {"id": "event-1", "sequence": 1},
                "last": {"id": "event-1", "sequence": 1}
            },
            "turnId": "turn-1",
            "terminal": terminal
        }))
        .map_err(|error| format!("turn/completed fixture did not decode: {error}"))?;
        Ok(TurnOutcome::Completed {
            params,
            observed_start: true,
        })
    }

    #[test]
    fn approve_recipe_reports_a_dead_turn_before_the_workspace_hint() -> Result<(), String> {
        let error = match check_approved_turn(&finished_turn("failed")?, false) {
            Ok(()) => return Err("a failed turn with no approval passed the recipe".to_owned()),
            Err(error) => error.to_string(),
        };
        if !error.contains("expected the approved turn to complete") {
            return Err(format!(
                "a dead turn was not reported as an incomplete turn: {error}"
            ));
        }
        Ok(())
    }

    #[test]
    fn approve_deny_recipe_fails_when_a_turn_does_not_complete() -> Result<(), String> {
        require_completed_turn("approved", &finished_turn("completed")?)
            .map_err(|error| format!("a completed turn was refused: {error}"))?;
        for terminal in ["failed", "cancelled"] {
            if require_completed_turn("approved", &finished_turn(terminal)?).is_ok() {
                return Err(format!("a {terminal} approved turn passed the recipe"));
            }
        }
        let unqueued = TurnOutcome::Unqueued(
            serde_json::from_value(json!({
                "sessionId": "session-1",
                "viewCursor": "cursor-1",
                "sourceRange": {
                    "stream": {"kind": "session", "id": "session-1"},
                    "first": {"id": "event-1", "sequence": 1},
                    "last": {"id": "event-1", "sequence": 1}
                },
                "turnId": "turn-1",
                "commandId": "turn-1"
            }))
            .map_err(|error| format!("turn/unqueued fixture did not decode: {error}"))?,
        );
        if require_completed_turn("approved", &unqueued).is_ok() {
            return Err("an unqueued approved turn passed the recipe".to_owned());
        }
        Ok(())
    }

    fn ended_retry(terminal: &str) -> Result<ReconnectResolution, String> {
        let ack = serde_json::from_value(json!({
            "commandId": "command-1",
            "status": "accepted",
            "turnId": "turn-1",
            "startedNewTurn": true,
            "disposition": "started"
        }))
        .map_err(|error| format!("turn/start result fixture did not decode: {error}"))?;
        let last_turn = serde_json::from_value(json!({"turnId": "turn-1", "terminal": terminal}))
            .map_err(|error| format!("lastTurn fixture did not decode: {error}"))?;
        Ok(ReconnectResolution {
            command_id: "command-1".to_owned(),
            result: Ok(Reconnected::Ended { ack, last_turn }),
        })
    }

    fn refused_retry(command_id: &str) -> ReconnectResolution {
        ReconnectResolution {
            command_id: command_id.to_owned(),
            result: Err(MuseError::TransportEnded),
        }
    }

    fn settled(resolutions: Vec<ReconnectResolution>) -> Result<Vec<String>, String> {
        ready(settle_retries(resolutions))
            .map(|failures| failures.iter().map(ToString::to_string).collect())
            .ok_or_else(|| "settling entries with no live turn stayed pending".to_owned())
    }

    /// Every entry is handled, so a refusal does not stop the ones after it;
    /// an `Ended` entry is a replay of a turn that already ended, whatever its
    /// terminal, so it is not a failed retry.
    #[test]
    fn retry_safe_recipe_reports_each_refused_resend_and_passes_a_replayed_end()
    -> Result<(), String> {
        let failures = settled(vec![
            refused_retry("command-a"),
            ended_retry("cancelled")?,
            ended_retry("failed")?,
            ended_retry("completed")?,
            refused_retry("command-c"),
        ])?;
        let expected = ["resending command-a failed", "resending command-c failed"];
        if failures.len() != expected.len()
            || !failures
                .iter()
                .zip(expected)
                .all(|(failure, expected)| failure.contains(expected))
        {
            return Err(format!("unexpected failed retries: {failures:?}"));
        }
        let failures = settled(vec![ended_retry("cancelled")?])?;
        if !failures.is_empty() {
            return Err(format!("a replayed end was a failed retry: {failures:?}"));
        }
        Ok(())
    }

    #[test]
    fn retry_safe_recipe_fails_a_live_retry_that_does_not_complete() -> Result<(), String> {
        if let Some(failure) = live_retry_failure("turn-1", Ok(finished_turn("completed")?)) {
            return Err(format!("a completed live retry failed: {failure}"));
        }
        for terminal in ["failed", "cancelled"] {
            match live_retry_failure("turn-1", Ok(finished_turn(terminal)?)) {
                Some(failure)
                    if failure
                        .to_string()
                        .contains("retried turn turn-1 did not complete") => {}
                other => return Err(format!("a {terminal} live retry gave {other:?}")),
            }
        }
        let unsettled: Box<dyn std::error::Error> = Box::new(MuseError::TransportEnded);
        match live_retry_failure("turn-1", Err(unsettled)) {
            Some(failure) if failure.to_string().contains("turn turn-1 did not settle") => Ok(()),
            other => Err(format!("an unsettled live retry gave {other:?}")),
        }
    }

    #[test]
    fn retry_safe_recipe_returns_its_first_failed_retry() -> Result<(), String> {
        let failed = ready(retry_result(Ok(vec![
            refused_retry("command-a"),
            ended_retry("cancelled")?,
            refused_retry("command-c"),
        ])))
        .ok_or("the result of entries with no live turn stayed pending")?;
        match failed {
            Err(error) if error.to_string().contains("resending command-a failed") => {}
            other => return Err(format!("a failed retry did not fail the recipe: {other:?}")),
        }
        let replayed = ready(retry_result(Ok(vec![ended_retry("cancelled")?])))
            .ok_or("the result of a replayed end stayed pending")?;
        if let Err(error) = replayed {
            return Err(format!("a replayed end failed the recipe: {error}"));
        }
        match ready(retry_result(Err(MuseError::TransportEnded))) {
            Some(Err(error)) if error.to_string().contains("transport ended") => Ok(()),
            other => Err(format!(
                "a failed reconnect did not fail the recipe: {other:?}"
            )),
        }
    }

    /// Answers `initialize`, `session/start` and `turn/start` like a host, and
    /// sends each frame the test hands it once those replies are read.
    struct ScriptedTurnTransport {
        attach: ScriptedAttachTransport,
        replies: std::collections::VecDeque<String>,
        later: tokio::sync::mpsc::UnboundedReceiver<String>,
    }

    impl DuplexTransport for ScriptedTurnTransport {
        fn read_chunk(
            &mut self,
        ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
            if self.attach.initialize_written && self.attach.response.is_some() {
                return self.attach.read_chunk();
            }
            if let Some(reply) = self.replies.pop_front() {
                return Box::pin(async move { Ok(Some(reply)) });
            }
            Box::pin(async move {
                match self.later.recv().await {
                    Some(frame) => Ok(Some(frame)),
                    None => pending::<io::Result<Option<String>>>().await,
                }
            })
        }

        fn write(
            &mut self,
            frame: &str,
        ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
            let message: Value = serde_json::from_str(frame).unwrap_or(Value::Null);
            let id = message.get("id").cloned();
            let result = match message.get("method").and_then(Value::as_str) {
                Some("session/start") => Some(json!({
                    "session": {
                        "sessionId": "session-1",
                        "path": "/tmp/session.jsonl",
                        "status": "idle",
                        "activeTurnId": null,
                        "createdAt": "2026-09-29T00:00:00Z",
                        "updatedAt": "2026-09-29T00:00:00Z",
                        "workspaceRoot": null,
                        "providerId": null,
                        "modelId": null,
                        "turnCount": 0,
                        "forkedFrom": null
                    },
                    "viewCursor": "cursor-1"
                })),
                Some("turn/start") => Some(json!({
                    "commandId": message["params"]["commandId"],
                    "status": "accepted",
                    "turnId": "turn-1",
                    "startedNewTurn": true,
                    "disposition": "started"
                })),
                _ => None,
            };
            if let (Some(id), Some(result)) = (id, result) {
                self.replies.push_back(format!(
                    "{}\n",
                    json!({"jsonrpc": "2.0", "id": id, "result": result})
                ));
            }
            self.attach.write(frame)
        }
    }

    #[test]
    fn retry_safe_recipe_fails_a_live_retry_whose_turn_fails() -> Result<(), String> {
        current_thread_runtime()?.block_on(async {
            let (later, frames) = tokio::sync::mpsc::unbounded_channel();
            let transport = ScriptedTurnTransport {
                attach: ScriptedAttachTransport {
                    fingerprint: muse_code_sdk::fingerprint::EXPECTED.to_owned(),
                    response: None,
                    initialize_written: false,
                },
                replies: std::collections::VecDeque::new(),
                later: frames,
            };
            let client = MuseClient::attach(transport)
                .await
                .map_err(|error| format!("attach failed: {error}"))?
                .client;
            let session = client
                .start_session(StartSessionOptions::default())
                .await
                .map_err(|error| format!("session/start failed: {error}"))?;
            let turn = session
                .send_user_turn(user_turn("retried work"))
                .await
                .map_err(|error| format!("turn/start failed: {error}"))?;
            let completed = json!({
                "jsonrpc": "2.0",
                "method": "turn/completed",
                "params": {
                    "sessionId": "session-1",
                    "viewCursor": "cursor-2",
                    "sourceRange": {
                        "stream": {"kind": "run", "id": "turn-1"},
                        "first": {"id": "event-1", "sequence": 1},
                        "last": {"id": "event-1", "sequence": 1}
                    },
                    "turnId": "turn-1",
                    "terminal": "failed"
                }
            });
            later
                .send(format!("{completed}\n"))
                .map_err(|_| "the scripted host stopped reading".to_owned())?;
            let failures = settle_retries(vec![ReconnectResolution {
                command_id: "command-1".to_owned(),
                result: Ok(Reconnected::Live(turn)),
            }])
            .await;
            client.close().await;
            match failures.as_slice() {
                [failure]
                    if failure
                        .to_string()
                        .contains("retried turn turn-1 did not complete") =>
                {
                    Ok(())
                }
                other => Err(format!("a failed live retry was not reported: {other:?}")),
            }
        })
    }

    fn tool_call(status: &str) -> Result<Item, String> {
        item("toolCall", status, "fallbackText", "shell: pwd")
    }

    #[test]
    fn default_deny_recipe_requires_a_rejected_tool_call() -> Result<(), String> {
        let completed = finished_turn("completed")?;
        check_default_deny_turn(
            &completed,
            &[tool_call("inProgress")?, tool_call("rejected")?],
        )
        .map_err(|error| format!("a turn with a rejected tool call was refused: {error}"))?;
        for (case, items) in [
            (
                "no tool call",
                vec![item("agentMessage", "completed", "text", "I could not")?],
            ),
            ("a tool call the host ran", vec![tool_call("completed")?]),
            (
                "a tool call that failed on its own",
                vec![tool_call("failed")?],
            ),
            (
                "only a rejected subagent spawn",
                vec![item(
                    "subagent",
                    "rejected",
                    "fallbackText",
                    "spawn: helper",
                )?],
            ),
        ] {
            if check_default_deny_turn(&completed, &items).is_ok() {
                return Err(format!("a default-deny turn with {case} passed the recipe"));
            }
        }
        // A dead turn with no items is reported as incomplete, not as a model
        // that never tried the shell.
        let error = match check_default_deny_turn(&finished_turn("failed")?, &[]) {
            Ok(()) => return Err("a failed default-deny turn passed the recipe".to_owned()),
            Err(error) => error.to_string(),
        };
        if !error.contains("expected the default-deny turn to complete") {
            return Err(format!(
                "a dead default-deny turn was not reported as incomplete: {error}"
            ));
        }
        Ok(())
    }

    #[test]
    fn cancel_recipe_accepts_typed_client_closed_result() {
        assert!(is_expected_close_error(&MuseError::ClientClosed));
        assert!(!is_expected_close_error(&MuseError::TransportEnded));
    }

    #[test]
    fn cancel_recipe_propagates_non_close_errors() {
        assert!(report_close_settlement(Err(MuseError::ClientClosed)).is_ok());
        assert!(matches!(
            report_close_settlement(Err(MuseError::TransportEnded)),
            Err(MuseError::TransportEnded)
        ));
    }

    #[test]
    fn scripted_transport_uses_initialize_request_id() -> Result<(), String> {
        let mut transport = ScriptedAttachTransport::fingerprint_mismatch();
        let frame = json!({
            "jsonrpc": "2.0",
            "id": "initialize-42",
            "method": "initialize",
            "params": {}
        })
        .to_string();

        match ready(transport.write(&frame)) {
            Some(Ok(())) => {}
            Some(Err(error)) => return Err(format!("write failed: {error}")),
            None => return Err("write stayed pending".to_owned()),
        }
        let response = match ready(transport.read_chunk()) {
            Some(Ok(Some(response))) => response,
            Some(Ok(None)) => return Err("transport closed instead of responding".to_owned()),
            Some(Err(error)) => return Err(format!("read failed: {error}")),
            None => return Err("read stayed pending".to_owned()),
        };
        let response: serde_json::Value = serde_json::from_str(response.trim())
            .map_err(|error| format!("initialize response was not json: {error}"))?;
        assert_eq!(response["id"], json!("initialize-42"));
        assert_eq!(
            response["result"]["schema"]["fingerprint"],
            json!(MISMATCHED_FINGERPRINT)
        );
        Ok(())
    }
}
