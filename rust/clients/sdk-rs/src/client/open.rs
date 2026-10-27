//! Opening sessions over `session/start` and `session/resume`, including
//! the per-id open count behind the fold's re-open rule.

use std::future::Future;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::approval::ApprovalDecisionInput;
use crate::msp::{
    ApprovalMode, ApprovalRequestParams, HistoryPreference, SessionConfig, SessionResumeParams,
    SessionResumeResult, SessionStartParams, SessionStartResult,
};
use crate::session::{Session, SessionOpening, drop_unreadable_snapshot, resume_history_items};

use super::{FacadeError, FacadeResult, MuseClient, invalid_frame, lock};

/// Options for [`MuseClient::start_session`]. A field left `None` takes the
/// server's default, except the workspace: with neither `workspace_root` nor
/// `workspace_roots` set, the session has no workspace.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StartSessionOptions {
    /// The new session's id; the server mints one when `None`. This never
    /// opens an existing session: an id the host already holds or has reserved
    /// is refused.
    pub session_id: Option<String>,
    /// The session's working folder, as an absolute path.
    pub workspace_root: Option<String>,
    /// The session's workspace roots, as absolute paths; the first one is the
    /// working folder. When `workspace_root` is also set, both must name the
    /// same folder.
    pub workspace_roots: Option<Vec<String>>,
    /// The starting model.
    pub model_id: Option<String>,
    /// The starting provider.
    pub provider_id: Option<String>,
    /// The starting approval mode, one the host's configuration defines.
    pub approval_mode: Option<ApprovalMode>,
    /// Per-session configuration.
    pub config: Option<SessionConfig>,
}

/// Options for [`MuseClient::resume_session`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResumeSessionOptions {
    /// The session to load.
    pub session_id: String,
    /// A view cursor this client observed earlier. When set, the server
    /// returns only what follows it.
    pub cursor: Option<String>,
    /// When `true`, return the session's metadata and live state without its
    /// history; page the history separately. Defaults to `false`.
    pub exclude_items: Option<bool>,
    /// Which form of history to return; the server chooses when `None`. It is
    /// a preference: the server falls back to another form when this one does
    /// not fit its budget. Ignored when `cursor` is set or `exclude_items` is
    /// `Some(true)`.
    pub history: Option<HistoryPreference>,
    /// Per-session configuration, as at start.
    pub config: Option<SessionConfig>,
}

impl MuseClient {
    /// Starts a new session and returns its handle once the server accepts it.
    pub async fn start_session(&self, options: StartSessionOptions) -> FacadeResult<Session> {
        let command_id = self.shared.mint_command_id()?;
        // A start that names its id subscribes it too, so it is noted before
        // sending, like a resume.
        let named = options
            .session_id
            .clone()
            .map(|id| (self.shared.note_open(&id), id));
        let params = SessionStartParams {
            command_id,
            // Not exposed by the facade yet.
            recovery_mode: None,
            session_id: options.session_id,
            workspace_root: options.workspace_root,
            workspace_roots: options.workspace_roots,
            model_id: options.model_id,
            provider_id: options.provider_id,
            approval_mode: options.approval_mode,
            config: options.config,
            // The facade does not expose a spawner yet.
            spawned_by: None,
            // The SDK starts plain sessions; worktree starts stay
            // an explicit experimental spelling the caller does not send.
            worktree: None,
            // The Rust SDK does not expose the start-time profile
            // selection yet; the session starts under the
            // host's default.
            permission_profile: None,
            // Not exposed by the facade yet.
            limits: None,
            // The SDK starts plain sessions, with no predecessor.
            previous_session_id: None,
        };
        let result = match self
            .shared
            .command::<_, SessionStartResult>("session/start", &params)
            .await
        {
            Ok(result) => result,
            Err(error) => {
                if let Some((_, id)) = &named
                    && matches!(error, FacadeError::Msp(_))
                {
                    self.shared.forget_open(id);
                }
                return Err(error);
            }
        };
        let session = Session::from_opening(
            Arc::clone(&self.shared),
            SessionOpening::Start(Box::new(result)),
            &[],
            None,
        );
        // The server names the session. A requested id it did not keep was
        // never subscribed, so its count is undone before the real id's.
        let reopened = match named {
            Some((reopened, id)) if id == session.session_id() => reopened,
            Some((_, id)) => {
                self.shared.forget_open(&id);
                self.shared.note_open(session.session_id())
            }
            None => self.shared.note_open(session.session_id()),
        };
        self.shared.register(&session, reopened);
        Ok(session)
    }

    /// Approvals the resume result lists as pending keep the no-handler path
    /// fixed at handoff: each is denied when its payload arrives, and a later
    /// `Session::on_approval` handles only other requests.
    pub async fn resume_session(&self, options: ResumeSessionOptions) -> FacadeResult<Session> {
        self.resume_with(options, |_| {}).await
    }

    /// Installs `handler` before route handoff, so it also answers approvals
    /// the resume result lists as pending, even if `Session::on_approval`
    /// replaces it later, unless the session has since settled
    /// that approval's turn, which gets the rejecting choice.
    pub async fn resume_session_with_approval_handler<Handler, HandlerFuture>(
        &self,
        options: ResumeSessionOptions,
        handler: Handler,
    ) -> FacadeResult<Session>
    where
        Handler: Fn(ApprovalRequestParams) -> HandlerFuture + Send + Sync + 'static,
        HandlerFuture: Future<Output = ApprovalDecisionInput> + Send + 'static,
    {
        self.resume_with(options, |session| session.on_approval(handler))
            .await
    }

    async fn resume_with(
        &self,
        options: ResumeSessionOptions,
        before_handoff: impl FnOnce(&Session),
    ) -> FacadeResult<Session> {
        if lock(&self.shared.discarded_session_ids).contains(&options.session_id) {
            return Err(FacadeError::SessionDiscarded(options.session_id));
        }
        let command_id = self.shared.mint_command_id()?;
        // Recorded before sending: an abandoned resume may still have subscribed.
        let reopened = self.shared.note_open(&options.session_id);
        let params = SessionResumeParams {
            command_id,
            // Not exposed by the facade yet.
            recovery_mode: None,
            session_id: options.session_id,
            cursor: options.cursor,
            exclude_items: options.exclude_items,
            history: options.history,
            config: options.config,
            // The Rust SDK does not expose the resume-time profile
            // pick yet (same as the start selection
            // above); the resume restores retained authority only.
            permission_profile: None,
            // The Rust SDK does not expose the resume-time model
            // override yet; the resume resolves by recorded origin.
            model_id: None,
        };
        // Kept raw too: the fold seeds history from the raw item objects.
        let mut raw = match self
            .shared
            .command::<_, Value>("session/resume", &params)
            .await
        {
            Ok(raw) => raw,
            Err(error) => {
                if matches!(error, FacadeError::Msp(_)) {
                    self.shared.forget_open(&params.session_id);
                }
                return Err(error);
            }
        };
        let dropped_snapshot = drop_unreadable_snapshot(&mut raw);
        let result = SessionResumeResult::deserialize(&raw).map_err(invalid_frame)?;
        let history = resume_history_items(&raw, &result.history.mode);
        let session = Session::from_opening(
            Arc::clone(&self.shared),
            SessionOpening::Resume(Box::new(result)),
            history,
            dropped_snapshot,
        );
        before_handoff(&session);
        session.fix_resume_approval_routing();
        self.shared.register(&session, reopened);
        Ok(session)
    }
}
