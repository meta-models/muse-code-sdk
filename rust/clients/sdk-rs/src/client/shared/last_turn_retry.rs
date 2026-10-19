//! A same-command retry answered with the turn the resume restates as
//! `lastTurn`: a terminal received before the answer settles it `Completed`,
//! whatever order the SDK applies them in, unless a pending view-gap fill holds
//! that terminal back; with no terminal applied first it settles `Ended`.

use std::future::Future;

use serde_json::{Value, json};

use super::ordering_tests::{
    TestPeer, paused_client, poll_once, session_value, terminal, turn_started_reply,
};
use crate::client::{MuseClient, ResumeSessionOptions};
use crate::msp::TurnTerminal;
use crate::session::{SendUserTurnOptions, Session};
use crate::turn::TurnOutcome;

mod claims;
mod limits;
mod ordering;

const SESSION: &str = "session-1";

const ENDED_TURN: &str = "turn-ended";

/// Bounds a step these tests expect to finish, so a regression fails by name
/// instead of hanging.
async fn capped<T>(step: &str, future: impl Future<Output = T>) -> Result<T, String> {
    // antipattern-ok(timeout-wrapper): failure-only cap; success ends when the awaited step completes
    tokio::time::timeout(std::time::Duration::from_secs(5), future)
        .await
        .map_err(|_| format!("{step} did not finish"))
}

#[derive(Clone, Copy)]
enum History {
    Inline,
    Snapshot,
    AnchoredSnapshot,
    // A `cursorSuffix` resume: it serves no held items.
    None,
}

/// The served history, holding the ended turn's userMessage in every mode that
/// serves items.
fn served_history(history: History) -> Value {
    let items = json!([{
        "itemId": "item-ended",
        "kind": "userMessage",
        "turnId": ENDED_TURN,
        "commandId": "command-0",
        "revision": 1,
        "status": "completed",
        "text": "retry me"
    }]);
    let (mode, anchor) = match history {
        History::Inline => return json!({"mode": "inline", "items": items, "snapshot": null}),
        History::None => {
            return json!({
                "mode": "none",
                "items": null,
                "snapshot": null,
                "noneReason": "cursorSuffix"
            });
        }
        History::Snapshot => ("snapshot", Value::Null),
        History::AnchoredSnapshot => (
            "anchoredSnapshot",
            json!({"boundaryCursor": "cursor-0", "summarizedThrough": "anchor-0"}),
        ),
    };
    json!({
        "mode": mode,
        "items": null,
        "snapshot": {
            "schemaVersion": 1,
            "viewCursor": "cursor-1",
            "anchor": anchor,
            "state": {
                "items": items,
                "activeTurn": null,
                "queuedTurns": [],
                "pendingApprovals": [],
                "pendingUserInputs": [],
                "approvalMode": {"mode": "promptUnmatched", "source": "replay", "lastCommandId": null},
                "effectiveModel": null,
                "goal": null,
                "todoList": null,
                "branch": null,
                "tokenUsage": {"promptTokens": 0, "outputTokens": 0, "totalTokens": 0},
                "turnCount": 1
            }
        }
    })
}

/// Resumes `SESSION` with no active turn and the ended turn restated as a
/// completed `lastTurn`.
async fn resume_after_the_turn_ended(
    client: &MuseClient,
    peer: &mut TestPeer,
    history: History,
) -> Result<Session, String> {
    let mut opening = Box::pin(client.resume_session(ResumeSessionOptions {
        session_id: SESSION.to_owned(),
        ..ResumeSessionOptions::default()
    }));
    if poll_once(opening.as_mut()).await.is_some() {
        return Err("session/resume settled before submission".to_owned());
    }
    let request = capped("session/resume submission", peer.request("session/resume")).await??;
    let id = request
        .get("id")
        .cloned()
        .ok_or_else(|| "session/resume request has no id".to_owned())?;
    peer.send(json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": {
            "session": session_value(SESSION),
            "viewCursor": "cursor-1",
            "history": served_history(history),
            "lastTurn": {"turnId": ENDED_TURN, "terminal": "completed"},
            "pendingRequests": []
        }
    }))?;
    capped("session/resume", opening)
        .await?
        .map_err(|error| format!("session/resume failed: {error}"))
}

/// Submits a retry and answers it with `reply`.
async fn answered_retry(
    session: &Session,
    peer: &mut TestPeer,
    reply: impl FnOnce(&Value) -> Result<Value, String>,
) -> Result<crate::turn::Turn, String> {
    let mut retry = Box::pin(session.send_user_turn(SendUserTurnOptions::default()));
    if poll_once(retry.as_mut()).await.is_some() {
        return Err("turn/start settled before submission".to_owned());
    }
    let request = capped("turn/start submission", peer.request("turn/start")).await??;
    peer.send(reply(&request)?)?;
    capped("the same-command retry", retry)
        .await?
        .map_err(|error| format!("the same-command retry failed: {error}"))
}

/// Answers a throwaway `turn/unqueue` with an error, so every frame sent before
/// that answer has been read: frames are read in order.
async fn read_fence(session: &Session, peer: &mut TestPeer) -> Result<(), String> {
    let mut fence = Box::pin(session.unqueue_turn("turn-fence"));
    if poll_once(fence.as_mut()).await.is_some() {
        return Err("turn/unqueue settled before submission".to_owned());
    }
    let fence_request = capped("turn/unqueue submission", peer.request("turn/unqueue")).await??;
    let fence_id = fence_request
        .get("id")
        .cloned()
        .ok_or_else(|| "turn/unqueue request has no id".to_owned())?;
    peer.send(json!({
        "jsonrpc": "2.0",
        "id": fence_id,
        "error": {"code": -32000, "message": "fence"}
    }))?;
    let _ = capped("turn/unqueue", fence).await?;
    Ok(())
}

/// `read_fence`, then waits until the router has taken those frames.
async fn read_and_apply_earlier_frames(
    client: &MuseClient,
    session: &Session,
    peer: &mut TestPeer,
) -> Result<(), String> {
    read_fence(session, peer).await?;
    capped(
        "the notification handoff",
        client.shared.notifications_received_applied(),
    )
    .await
}

/// A live `turn/started` for `turn_id`.
fn turn_started(turn_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "turn/started",
        "params": {
            "sessionId": SESSION,
            "viewCursor": "cursor-started",
            "sourceRange": {
                "stream": {"kind": "run", "id": turn_id},
                "first": {"id": "event-0", "sequence": 0},
                "last": {"id": "event-0", "sequence": 0}
            },
            "turnId": turn_id,
            "commandId": "command-0"
        }
    })
}

/// A `turn/completed` naming `turn_id` whose params do not decode: a local
/// fault that retires the turn's route with no terminal applied.
fn malformed_terminal(turn_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "turn/completed",
        "params": {"sessionId": SESSION, "turnId": turn_id}
    })
}

/// A live `item/completed` for `turn_id`.
fn live_item(turn_id: &str, item_id: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "item/completed",
        "params": {
            "sessionId": SESSION,
            "viewCursor": format!("cursor-{item_id}"),
            "sourceRange": {
                "stream": {"kind": "run", "id": turn_id},
                "first": {"id": "event-1", "sequence": 1},
                "last": {"id": "event-1", "sequence": 1}
            },
            "item": {
                "itemId": item_id,
                "kind": "agentMessage",
                "turnId": turn_id,
                "revision": 1,
                "status": "completed",
                "text": "reply"
            }
        }
    })
}
