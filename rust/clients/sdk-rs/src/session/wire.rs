//! Wire-present query and command helpers: `task/list`, `skill/list`,
//! `hook/list`, `workflow/pause`, `workflow/resume`, `recap/request`,
//! `feedback/submit` and `session/sideChat`.

use crate::client::FacadeResult;
use crate::errors::ProtocolError;
use crate::msp::{
    FeedbackClassification, FeedbackSubmitParams, FeedbackSubmitResult, HookListParams,
    HookListResult, RecapRequestParams, RecapRequestResult, SessionSideChatParams,
    SessionSideChatResult, SkillListParams, SkillListResult, TaskListParams, TaskListResult,
    WorkflowControlResult, WorkflowPauseParams, WorkflowResumeParams, WorkflowResumeResult,
};

use super::Session;
use super::submit::require_accepted;

/// What one `feedback/submit` sends, apart from the session it is about:
/// [`Session::submit_feedback`] supplies that from the session itself.
///
/// `#[non_exhaustive]`: new wire members must be addable without breaking
/// callers, so build one with [`SubmitFeedbackOptions::new`] and set the
/// optional members on the result. Divergence note: unlike the TS/Python
/// helpers, the Rust workflow/feedback commands reject a non-`accepted`
/// ack status and a `commandId` echo mismatch (the crate's existing
/// `require_accepted` pattern), and send no minted `commandId` on the
/// list queries, matching the generated params.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct SubmitFeedbackOptions {
    /// The report class.
    pub classification: FeedbackClassification,
    /// The user report text; non-empty for a bug report.
    pub note: String,
    /// The files-consent decision.
    pub with_files: bool,
    /// Consent to attach the session record.
    pub attach_session_record: bool,
    /// An absolute same-host path to a client-packed bundle.
    pub client_artifacts_path: Option<String>,
}

impl SubmitFeedbackOptions {
    /// The required members; optional members default off/absent.
    pub fn new(
        classification: FeedbackClassification,
        note: impl Into<String>,
        with_files: bool,
    ) -> Self {
        Self {
            classification,
            note: note.into(),
            with_files,
            attach_session_record: false,
            client_artifacts_path: None,
        }
    }
}

impl Session {
    /// Lists this session's live background and foreground tasks (`task/list`).
    pub async fn list_tasks(&self) -> FacadeResult<TaskListResult> {
        self.inner.ensure_available()?;
        let params = TaskListParams {
            session_id: self.inner.session_id.clone(),
        };
        self.inner
            .client
            .command::<_, TaskListResult>("task/list", &params)
            .await
    }

    /// Lists this session's user-invocable skills (`skill/list`).
    pub async fn list_skills(&self) -> FacadeResult<SkillListResult> {
        self.inner.ensure_available()?;
        let params = SkillListParams {
            session_id: self.inner.session_id.clone(),
        };
        self.inner
            .client
            .command::<_, SkillListResult>("skill/list", &params)
            .await
    }

    /// Lists this session's installed hook rows (`hook/list`).
    pub async fn list_hooks(&self) -> FacadeResult<HookListResult> {
        self.inner.ensure_available()?;
        let params = HookListParams {
            session_id: self.inner.session_id.clone(),
        };
        self.inner
            .client
            .command::<_, HookListResult>("hook/list", &params)
            .await
    }

    /// Pauses a live workflow run (`workflow/pause`).
    pub async fn pause_workflow(
        &self,
        workflow_run_id: &str,
    ) -> FacadeResult<WorkflowControlResult> {
        self.inner.ensure_available()?;
        let command_id = self.inner.client.mint_command_id()?;
        let params = WorkflowPauseParams {
            session_id: self.inner.session_id.clone(),
            command_id: command_id.clone(),
            workflow_run_id: workflow_run_id.to_owned(),
        };
        let result = self
            .inner
            .client
            .command::<_, WorkflowControlResult>("workflow/pause", &params)
            .await?;
        require_echo("workflow/pause", &result.command_id, &command_id)?;
        require_accepted("workflow/pause", &result.status)?;
        Ok(result)
    }

    /// Resumes a paused workflow run (`workflow/resume`).
    pub async fn resume_workflow(
        &self,
        workflow_run_id: &str,
    ) -> FacadeResult<WorkflowResumeResult> {
        self.inner.ensure_available()?;
        let command_id = self.inner.client.mint_command_id()?;
        let params = WorkflowResumeParams {
            session_id: self.inner.session_id.clone(),
            command_id: command_id.clone(),
            workflow_run_id: workflow_run_id.to_owned(),
        };
        let result = self
            .inner
            .client
            .command::<_, WorkflowResumeResult>("workflow/resume", &params)
            .await?;
        require_echo("workflow/resume", &result.command_id, &command_id)?;
        require_accepted("workflow/resume", &result.status)?;
        Ok(result)
    }

    /// Requests a recap of this session (`recap/request`); admission only.
    pub async fn request_recap(&self) -> FacadeResult<RecapRequestResult> {
        self.inner.ensure_available()?;
        let command_id = self.inner.client.mint_command_id()?;
        let params = RecapRequestParams {
            session_id: self.inner.session_id.clone(),
            command_id: command_id.clone(),
        };
        let result = self
            .inner
            .client
            .command::<_, RecapRequestResult>("recap/request", &params)
            .await?;
        require_echo("recap/request", &result.command_id, &command_id)?;
        require_accepted("recap/request", &result.status)?;
        Ok(result)
    }

    /// Submits feedback about this session (`feedback/submit`).
    pub async fn submit_feedback(
        &self,
        options: SubmitFeedbackOptions,
    ) -> FacadeResult<FeedbackSubmitResult> {
        self.inner.ensure_available()?;
        let params = FeedbackSubmitParams {
            classification: options.classification,
            note: options.note,
            with_files: options.with_files,
            attach_session_record: options.attach_session_record,
            session_id: Some(self.inner.session_id.clone()),
            client_artifacts_path: options.client_artifacts_path,
        };
        self.inner
            .client
            .command::<_, FeedbackSubmitResult>("feedback/submit", &params)
            .await
    }

    /// Opens a side chat from this session (`session/sideChat`). Returns the
    /// wire result; opening a wired [`Session`] for the new side session is
    /// the caller's composition.
    pub async fn open_side_chat(&self) -> FacadeResult<SessionSideChatResult> {
        self.inner.ensure_available()?;
        let command_id = self.inner.client.mint_command_id()?;
        let params = SessionSideChatParams {
            command_id,
            session_id: self.inner.session_id.clone(),
        };
        self.inner
            .client
            .command::<_, SessionSideChatResult>("session/sideChat", &params)
            .await
    }
}

fn require_echo(method: &str, echoed: &str, expected: &str) -> FacadeResult<()> {
    if echoed != expected {
        return Err(ProtocolError::new(
            format!("{method} echoed command id {echoed}, expected {expected}"),
            None,
        )
        .into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io;
    use std::pin::Pin;
    use std::sync::{Arc, Mutex};

    use tokio::sync::mpsc;

    use super::*;
    use crate::DuplexTransport;
    use crate::client::{MuseClient, StartSessionOptions};
    use crate::msp::{FeedbackClassification, SessionDurability};

    /// Records every written frame and hands each scripted reply out only
    /// when its request is written, re-keyed to that request's id.
    struct ScriptedTransport {
        inbound: mpsc::UnboundedReceiver<String>,
        outbound: mpsc::UnboundedSender<String>,
        replies: std::collections::VecDeque<(&'static str, serde_json::Value)>,
        writes: Arc<Mutex<Vec<String>>>,
    }

    impl DuplexTransport for ScriptedTransport {
        fn read_chunk(
            &mut self,
        ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
            Box::pin(async { Ok(self.inbound.recv().await) })
        }

        fn write(
            &mut self,
            frame: &str,
        ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
            if let Ok(guard) = self.writes.lock() {
                let mut writes = guard;
                writes.push(frame.to_owned());
            }
            if let Ok(request) = serde_json::from_str::<serde_json::Value>(frame.trim())
                && self
                    .replies
                    .front()
                    .is_some_and(|(method, _)| request["method"] == *method)
                && let Some((_, mut reply)) = self.replies.pop_front()
            {
                reply["id"] = request["id"].clone();
                let _ = self.outbound.send(format!("{reply}\n"));
            }
            Box::pin(async { Ok(()) })
        }
    }

    fn session_start_result() -> serde_json::Value {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": 0,
            "result": {
                "session": {
                    "sessionId": "s-1",
                    "path": "/tmp/s-1.jsonl",
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
                "viewCursor": "v"
            }
        })
    }

    async fn wired_session(
        later: Vec<(&'static str, serde_json::Value)>,
    ) -> (MuseClient, Session, Arc<Mutex<Vec<String>>>) {
        let (outbound, inbound) = mpsc::unbounded_channel();
        let writes = Arc::new(Mutex::new(Vec::new()));
        let mut replies =
            std::collections::VecDeque::from([("session/start", session_start_result())]);
        replies.extend(later);
        let client = MuseClient::with_command_id_minter(
            ScriptedTransport {
                inbound,
                outbound,
                replies,
                writes: Arc::clone(&writes),
            },
            SessionDurability::Durable,
            || "command-1".to_owned(),
        );
        let session = client
            .start_session(StartSessionOptions::default())
            .await
            .expect("session opens");
        if let Ok(mut guard) = writes.lock() {
            guard.clear();
        }
        (client, session, writes)
    }

    fn sent(writes: &Arc<Mutex<Vec<String>>>) -> serde_json::Value {
        let guard = writes.lock().expect("writes lock");
        assert_eq!(guard.len(), 1, "one frame written: {:?}", *guard);
        serde_json::from_str(guard[0].trim()).expect("frame is json")
    }

    #[tokio::test(flavor = "current_thread")]
    async fn list_tasks_sends_task_list_for_this_session_and_returns_rows() {
        let (client, session, writes) = wired_session(vec![(
            "task/list",
            serde_json::json!({"jsonrpc": "2.0", "id": 0, "result": {"tasks": [{"taskId": "t-1", "kind": "tool", "status": "inProgress"}]}}),
        )])
        .await;
        let result = session.list_tasks().await.expect("list_tasks");
        let frame = sent(&writes);
        assert_eq!(frame["method"], "task/list");
        assert_eq!(frame["params"]["sessionId"], "s-1");
        assert_eq!(result.tasks[0].task_id, "t-1");
        client.close().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn list_skills_and_list_hooks_send_their_wire_methods() {
        for (method, result) in [
            ("skill/list", serde_json::json!({"skills": []})),
            ("hook/list", serde_json::json!({"hooks": []})),
        ] {
            let (client, session, writes) = wired_session(vec![(
                method,
                serde_json::json!({"jsonrpc": "2.0", "id": 0, "result": result}),
            )])
            .await;
            if method == "skill/list" {
                session.list_skills().await.expect("list_skills");
            } else {
                session.list_hooks().await.expect("list_hooks");
            }
            let frame = sent(&writes);
            assert_eq!(frame["method"], method);
            assert_eq!(frame["params"]["sessionId"], "s-1");
            client.close().await;
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn workflow_recap_feedback_and_side_chat_send_their_wire_methods() {
        // workflow/pause
        let (client, session, writes) = wired_session(vec![(
            "workflow/pause",
            serde_json::json!({"jsonrpc": "2.0", "id": 0, "result": {"commandId": "command-1", "status": "accepted"}}),
        )])
        .await;
        session.pause_workflow("run-1").await.expect("pause");
        let frame = sent(&writes);
        assert_eq!(frame["method"], "workflow/pause");
        assert_eq!(frame["params"]["sessionId"], "s-1");
        assert_eq!(frame["params"]["workflowRunId"], "run-1");
        client.close().await;

        // workflow/resume
        let (client, session, writes) = wired_session(vec![(
            "workflow/resume",
            serde_json::json!({"jsonrpc": "2.0", "id": 0, "result": {"commandId": "command-1", "status": "accepted", "turnId": "t-9"}}),
        )])
        .await;
        let resumed = session.resume_workflow("run-1").await.expect("resume");
        assert_eq!(resumed.turn_id, "t-9");
        assert_eq!(sent(&writes)["method"], "workflow/resume");
        client.close().await;

        // recap/request
        let (client, session, writes) = wired_session(vec![(
            "recap/request",
            serde_json::json!({"jsonrpc": "2.0", "id": 0, "result": {"commandId": "command-1", "status": "accepted"}}),
        )])
        .await;
        session.request_recap().await.expect("recap");
        assert_eq!(sent(&writes)["method"], "recap/request");
        client.close().await;

        // feedback/submit
        let (client, session, writes) = wired_session(vec![(
            "feedback/submit",
            serde_json::json!({"jsonrpc": "2.0", "id": 0, "result": {"bundlePath": "/b", "outcome": "recorded", "sessionRecordAttached": false, "sessionRecordTruncated": false}}),
        )])
        .await;
        session
            .submit_feedback(SubmitFeedbackOptions {
                classification: FeedbackClassification::Bug,
                note: "n".to_owned(),
                with_files: false,
                attach_session_record: false,
                client_artifacts_path: None,
            })
            .await
            .expect("feedback");
        let frame = sent(&writes);
        assert_eq!(frame["method"], "feedback/submit");
        assert_eq!(frame["params"]["sessionId"], "s-1");
        assert_eq!(frame["params"]["classification"], "bug");
        client.close().await;

        // session/sideChat
        let (client, session, writes) = wired_session(vec![(
            "session/sideChat",
            serde_json::json!({"jsonrpc": "2.0", "id": 0, "result": {"session": {"sessionId": "side-1", "path": "/tmp/side-1.jsonl", "status": "idle", "activeTurnId": null, "createdAt": "2026-09-29T00:00:00Z", "updatedAt": "2026-09-29T00:00:00Z", "workspaceRoot": null, "providerId": null, "modelId": null, "turnCount": 0, "forkedFrom": null}, "history": {"mode": "none", "items": [], "snapshot": null}, "pendingRequests": [], "viewCursor": "v"}}),
        )])
        .await;
        let side = session.open_side_chat().await.expect("side chat");
        assert_eq!(side.session.session_id, "side-1");
        let frame = sent(&writes);
        assert_eq!(frame["method"], "session/sideChat");
        assert_eq!(frame["params"]["sessionId"], "s-1");
        client.close().await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn discarded_session_refuses_wire_queries() {
        let (client, session, _writes) = wired_session(vec![]).await;
        session.inner.transport_ended(true);
        assert!(session.list_tasks().await.is_err());
        client.close().await;
    }
}
