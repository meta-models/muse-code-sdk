//! Session queries and commands the host serves directly: task, skill and
//! hook lists, workflow pause and resume, recaps, feedback, and side chats.
//!
//! Each refuses before sending on a discarded session or a closed client, and
//! a failure fails only its own call.

use serde::Serialize;
use serde::de::DeserializeOwned;

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

/// What [`Session::submit_feedback`] sends; the session id is this session's.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SubmitFeedbackOptions {
    /// The kind of report.
    pub classification: FeedbackClassification,
    /// The report text; the host requires it non-empty for a bug.
    pub note: String,
    /// Whether the report may include files.
    pub with_files: bool,
    /// Whether to attach this session's record. The host accepts `true` only
    /// for a bug or a bad result, with `with_files` set.
    pub attach_session_record: bool,
    /// An absolute path, on the host's machine, to a bundle of extra files the
    /// client packed.
    pub client_artifacts_path: Option<String>,
}

impl Session {
    /// Lists this session's running tasks, background and foreground
    /// (`task/list`).
    pub async fn list_tasks(&self) -> FacadeResult<TaskListResult> {
        let params = TaskListParams {
            session_id: self.inner.session_id.clone(),
        };
        self.query("task/list", &params).await
    }

    /// Lists the skills a user can invoke in this session (`skill/list`).
    pub async fn list_skills(&self) -> FacadeResult<SkillListResult> {
        let params = SkillListParams {
            session_id: self.inner.session_id.clone(),
        };
        self.query("skill/list", &params).await
    }

    /// Lists this session's installed hooks, one row per handler and event
    /// (`hook/list`).
    pub async fn list_hooks(&self) -> FacadeResult<HookListResult> {
        let params = HookListParams {
            session_id: self.inner.session_id.clone(),
        };
        self.query("hook/list", &params).await
    }

    /// Pauses a running workflow (`workflow/pause`). The result is admission
    /// only: the pause shows on the workflow item's later events. Pass
    /// `workflow_run_id` exactly as the workflow item names it.
    pub async fn pause_workflow(
        &self,
        workflow_run_id: impl Into<String>,
    ) -> FacadeResult<WorkflowControlResult> {
        let command_id = self.mint_command_id()?;
        let params = WorkflowPauseParams {
            session_id: self.inner.session_id.clone(),
            command_id: command_id.clone(),
            workflow_run_id: workflow_run_id.into(),
        };
        let result: WorkflowControlResult = self.query("workflow/pause", &params).await?;
        require_echo("workflow/pause", &result.command_id, &command_id)?;
        require_accepted("workflow/pause", &result.status)?;
        Ok(result)
    }

    /// Resumes a paused workflow (`workflow/resume`). The host drives a turn
    /// for it, a fresh one on an idle session or the running one otherwise,
    /// and the result names that turn. Pass `workflow_run_id` exactly as the
    /// workflow item names it.
    pub async fn resume_workflow(
        &self,
        workflow_run_id: impl Into<String>,
    ) -> FacadeResult<WorkflowResumeResult> {
        let command_id = self.mint_command_id()?;
        let params = WorkflowResumeParams {
            session_id: self.inner.session_id.clone(),
            command_id: command_id.clone(),
            workflow_run_id: workflow_run_id.into(),
        };
        let result: WorkflowResumeResult = self.query("workflow/resume", &params).await?;
        require_echo("workflow/resume", &result.command_id, &command_id)?;
        require_accepted("workflow/resume", &result.status)?;
        Ok(result)
    }

    /// Asks the host for a recap of this session (`recap/request`). The
    /// result is admission only, never the recap itself.
    pub async fn request_recap(&self) -> FacadeResult<RecapRequestResult> {
        let command_id = self.mint_command_id()?;
        let params = RecapRequestParams {
            session_id: self.inner.session_id.clone(),
            command_id: command_id.clone(),
        };
        let result: RecapRequestResult = self.query("recap/request", &params).await?;
        require_echo("recap/request", &result.command_id, &command_id)?;
        require_accepted("recap/request", &result.status)?;
        Ok(result)
    }

    /// Submits feedback about this session (`feedback/submit`). The host
    /// serves it only on a connection granted the `feedback` capability.
    /// [`MuseClient`](crate::client::MuseClient) requests no capabilities yet,
    /// so a real host refuses this call with `capabilityRequired`
    /// ([`MuseError::Msp`](crate::errors::MuseError::Msp)).
    pub async fn submit_feedback(
        &self,
        options: SubmitFeedbackOptions,
    ) -> FacadeResult<FeedbackSubmitResult> {
        let params = FeedbackSubmitParams {
            classification: options.classification,
            note: options.note,
            with_files: options.with_files,
            attach_session_record: options.attach_session_record,
            session_id: Some(self.inner.session_id.clone()),
            client_artifacts_path: options.client_artifacts_path,
        };
        self.query("feedback/submit", &params).await
    }

    /// Opens a side chat from this session (`session/sideChat`) and returns
    /// the opening the host served for the new side session: its session,
    /// view cursor and history. It returns no [`Session`] for the side chat.
    pub async fn open_side_chat(&self) -> FacadeResult<SessionSideChatResult> {
        let params = SessionSideChatParams {
            command_id: self.mint_command_id()?,
            session_id: self.inner.session_id.clone(),
        };
        self.query("session/sideChat", &params).await
    }

    /// Mints a command id for this session's next command. The discard check
    /// comes first, so a discarded session names its discard, not the
    /// transport end behind it.
    fn mint_command_id(&self) -> FacadeResult<String> {
        self.inner.ensure_available()?;
        self.inner.client.mint_command_id()
    }

    /// Sends one request for this session, refused before sending on a
    /// discarded session (and, inside the client, on a closed one).
    async fn query<P, R>(&self, method: &str, params: &P) -> FacadeResult<R>
    where
        P: Serialize,
        R: DeserializeOwned,
    {
        self.inner.ensure_available()?;
        self.inner.client.command(method, params).await
    }
}

fn require_echo(method: &str, echoed: &str, sent: &str) -> Result<(), ProtocolError> {
    if echoed == sent {
        Ok(())
    } else {
        Err(ProtocolError::new(
            format!("{method} echoed command id {echoed}, expected {sent}"),
            None,
        ))
    }
}
