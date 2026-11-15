//! Opening sessions over `session/start` and `session/resume`, including
//! the per-id open count behind the fold's re-open rule.

use std::future::Future;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;

use crate::approval::ApprovalDecisionInput;
use crate::msp::{
    ApprovalMode, ApprovalRequestParams, HistoryPreference, RecoveryMode, SessionConfig,
    SessionReadParams, SessionResumeParams, SessionResumeResult, SessionStartParams,
    SessionStartResult,
};
use crate::session::{Session, SessionOpening, drop_unreadable_snapshot, resume_history_items};

use super::{FacadeError, FacadeResult, MuseClient, invalid_frame, lock, protocol_error};

/// The committed profile id a session object reports; `None` when it reports
/// no permission state or a launch override with no id.
fn committed_profile_id(session: &crate::msp::Session) -> Option<String> {
    session.permission_state.as_ref()?.profile_id.clone()
}

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
    /// The permission profile to start under, by id; the host's default
    /// applies when `None`. The host may still commit another profile, so set
    /// `require_permission_profile` to refuse a start that did not apply it.
    pub permission_profile: Option<String>,
    /// When `true`, [`MuseClient::start_session`] proves the host committed
    /// `permission_profile` before returning the session: from the start
    /// result, else from one `session/read`. Any other committed profile, or
    /// none reported, fails with
    /// [`MuseError::PermissionProfileNotApplied`](crate::errors::MuseError::PermissionProfileNotApplied).
    /// Setting it without `permission_profile` is refused before anything is
    /// sent. This flag is never sent to the host.
    pub require_permission_profile: bool,
    /// Whether the session is built with recovery on or off; the host's
    /// default applies when `None`.
    pub recovery_mode: Option<RecoveryMode>,
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
    /// The model to resume with; when `None`, the session keeps the model it
    /// recorded.
    pub model_id: Option<String>,
    /// The permission profile to resume under, by id; when `None`, the
    /// session keeps the authority it recorded.
    pub permission_profile: Option<String>,
    /// Whether the resumed session is built with recovery on or off; the
    /// host's default applies when `None`.
    pub recovery_mode: Option<RecoveryMode>,
}

impl MuseClient {
    /// Starts a new session and returns its handle once the server accepts it.
    pub async fn start_session(&self, options: StartSessionOptions) -> FacadeResult<Session> {
        // A required selection names the profile it requires: refused before
        // anything is sent, so the start never proceeds on the host default.
        let required = match (
            options.require_permission_profile,
            &options.permission_profile,
        ) {
            (false, _) => None,
            (true, Some(profile)) => Some(profile.clone()),
            (true, None) => {
                return Err(protocol_error(
                    "require_permission_profile needs permission_profile: require the profile you pass",
                ));
            }
        };
        let command_id = self.shared.mint_command_id()?;
        // A start that names its id subscribes it too, so it is noted before
        // sending, like a resume.
        let named = options
            .session_id
            .clone()
            .map(|id| (self.shared.note_open(&id), id));
        let params = SessionStartParams {
            command_id,
            recovery_mode: options.recovery_mode,
            session_id: options.session_id,
            workspace_root: options.workspace_root,
            workspace_roots: options.workspace_roots,
            model_id: options.model_id,
            provider_id: options.provider_id,
            approval_mode: options.approval_mode,
            // Not exposed by the facade yet.
            approval_rules: None,
            config: options.config,
            // The facade does not expose a spawner yet.
            spawned_by: None,
            // The SDK starts plain sessions; worktree starts stay
            // an explicit experimental spelling the caller does not send.
            worktree: None,
            permission_profile: options.permission_profile,
            // Not exposed by the facade yet.
            limits: None,
            // The SDK starts plain sessions, with no predecessor.
            previous_session_id: None,
            // The SDK starts plain sessions, never a `/clear`.
            clear: None,
            // The SDK starts root sessions; the switch policy belongs to
            // a client that switches sessions.
            switch_policy: None,
            // The SDK starts sessions on the host's own machine.
            nodes: None,
            default_node: None,
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
        let started_profile = committed_profile_id(&result.session);
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
        match required {
            Some(requested) => {
                match self
                    .prove_profile(&session, started_profile, requested)
                    .await
                {
                    Ok(()) => Ok(session),
                    Err(error) => {
                        self.shared.retract_open(&session);
                        Err(error)
                    }
                }
            }
            None => Ok(session),
        }
    }

    /// Succeeds only when the host committed `requested`: the profile the
    /// start result reported, else one point-in-time `session/read`, which
    /// never subscribes. Only the committed profile id is compared. On refusal
    /// or a failed read-back the caller retracts the open and drops the
    /// handle; the error names the session so the caller can resume it or
    /// start again.
    async fn prove_profile(
        &self,
        session: &Session,
        started: Option<String>,
        requested: String,
    ) -> FacadeResult<()> {
        let served = match started {
            Some(started) => Some(started),
            None => {
                let read = self
                    .shared
                    .command::<_, Value>(
                        "session/read",
                        &SessionReadParams {
                            session_id: session.session_id().to_owned(),
                            exclude_items: None,
                        },
                    )
                    .await?;
                // Read structurally: a session shape this SDK cannot decode
                // proves nothing, so it reads as unknown, never as applied.
                read.get("session")
                    .and_then(|session| session.get("permissionState"))
                    .and_then(|state| state.get("profileId"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            }
        };
        if served.as_deref() == Some(requested.as_str()) {
            return Ok(());
        }
        Err(FacadeError::PermissionProfileNotApplied {
            requested,
            served,
            session_id: session.session_id().to_owned(),
        })
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
            recovery_mode: options.recovery_mode,
            session_id: options.session_id,
            cursor: options.cursor,
            exclude_items: options.exclude_items,
            history: options.history,
            config: options.config,
            permission_profile: options.permission_profile,
            model_id: options.model_id,
            // A facade resume is programmatic, never the user's explicit
            // Resume action, so it carries no explicit continuation.
            continue_paused_source: None,
            // Not exposed by the facade yet.
            approval_rules: None,
            // Not exposed by the facade yet.
            missing_input_assets: None,
            // Not exposed by the facade yet.
            limits: None,
            // Not exposed by the facade yet.
            auto_recover: None,
            // Not exposed by the facade yet.
            workspace_root: None,
            // Not exposed by the facade yet.
            workspace_roots: None,
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

/// Verify a spelled `config.allowedBuiltInTools` request against the echo
/// the open served: the post-intersection `appliedBuiltInTools` set on
/// the start/resume result (`Session::opening`). Returns the applied set
/// when the host echoed one that names no tool outside `requested`; the
/// echo may be a strict subset of the request (the host intersects with
/// the tools it serves), so subset — never equality — is the pass.
/// Fails loudly, with [`FacadeError::AppliedBuiltInToolsNotApplied`],
/// when the echo is absent on a spelled request (an absent echo means
/// unapplied, never success), when it is malformed, or when it still
/// names an excluded tool. A blank requested name is a usage error,
/// refused before any comparison. This check is opt-in and client-local:
/// `start_session`/`resume_session` never call it, so a session opened
/// without a spelled request — or without verification — behaves exactly
/// as before. **Experimental**: the field and the echo stay experimental
/// and are never filled until the host enforcement piece (P8) lands, so
/// on a pre-P8 host every spelled request fails this check.
pub fn verify_applied_built_in_tools(
    opening: &SessionOpening,
    requested: &[String],
) -> FacadeResult<Vec<String>> {
    if requested.iter().any(|tool| tool.trim().is_empty()) {
        return Err(protocol_error(
            "allowedBuiltInTools must be an array of non-empty strings",
        ));
    }
    let (session_id, applied) = match opening {
        SessionOpening::Start(result) => (
            result.session.session_id.clone(),
            result.applied_built_in_tools.clone(),
        ),
        SessionOpening::Resume(result) => (
            result.session.session_id.clone(),
            result.applied_built_in_tools.clone(),
        ),
    };
    let Some(applied) = applied else {
        return Err(FacadeError::AppliedBuiltInToolsNotApplied {
            requested: requested.to_vec(),
            applied: None,
            session_id,
        });
    };
    if applied.iter().any(|tool| tool.trim().is_empty()) {
        return Err(FacadeError::AppliedBuiltInToolsNotApplied {
            requested: requested.to_vec(),
            applied: None,
            session_id,
        });
    }
    if applied.iter().any(|tool| !requested.contains(tool)) {
        return Err(FacadeError::AppliedBuiltInToolsNotApplied {
            requested: requested.to_vec(),
            applied: Some(applied),
            session_id,
        });
    }
    Ok(applied)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::msp::{SessionResumeResult, SessionStartResult};

    fn session_json() -> serde_json::Value {
        json!({
            "sessionId": "s-1",
            "path": "/workspace/session.jsonl",
            "status": "idle",
            "activeTurnId": null,
            "createdAt": "2026-10-03T00:00:00Z",
            "updatedAt": "2026-10-03T00:00:00Z",
            "workspaceRoot": null,
            "providerId": null,
            "modelId": null,
            "turnCount": 0,
            "forkedFrom": null
        })
    }

    fn start_opening(applied: Option<Vec<&str>>) -> SessionOpening {
        let mut result = json!({
            "session": session_json(),
            "viewCursor": "cursor-1",
        });
        if let Some(applied) = applied {
            result["appliedBuiltInTools"] = json!(applied);
        }
        let result: SessionStartResult =
            serde_json::from_value(result).expect("test start fixture is invalid");
        SessionOpening::Start(Box::new(result))
    }

    fn resume_opening(applied: Option<Vec<&str>>) -> SessionOpening {
        let mut result = json!({
            "session": session_json(),
            "viewCursor": "cursor-1",
            "history": {"mode": "none", "items": null, "snapshot": null},
            "pendingRequests": [],
        });
        if let Some(applied) = applied {
            result["appliedBuiltInTools"] = json!(applied);
        }
        let result: SessionResumeResult =
            serde_json::from_value(result).expect("test resume fixture is invalid");
        SessionOpening::Resume(Box::new(result))
    }

    fn requested(tools: &[&str]) -> Vec<String> {
        tools.iter().map(ToString::to_string).collect()
    }

    #[test]
    fn config_serializes_allowed_built_in_tools_verbatim() {
        // `start_session`/`resume_session` forward `config` by serializing
        // the params struct as-is (no grant check, no rewriting in this
        // client), so the serialized form is what reaches the wire.
        let config = SessionConfig {
            allowed_built_in_tools: Some(vec!["read".to_owned(), "search".to_owned()]),
            ..SessionConfig::default()
        };
        let wire = serde_json::to_value(&config).expect("config serializes");
        assert_eq!(wire["allowedBuiltInTools"], json!(["read", "search"]));
        let omitted = serde_json::to_value(SessionConfig::default()).expect("config serializes");
        assert_eq!(omitted.get("allowedBuiltInTools"), None);
        let params: SessionStartParams = serde_json::from_value(json!({
            "commandId": "0198f0ab-9999-7000-8000-0000000000c1",
            "config": {"allowedBuiltInTools": ["read"]},
        }))
        .expect("params fixture is invalid");
        let wire = serde_json::to_value(&params).expect("params serialize");
        assert_eq!(wire["config"]["allowedBuiltInTools"], json!(["read"]));
    }

    #[test]
    fn echo_subset_of_requested_passes_on_start_and_resume() {
        let opening = start_opening(Some(vec!["read", "search"]));
        assert!(matches!(
            verify_applied_built_in_tools(&opening, &requested(&["read", "search", "edit"])),
            Ok(applied) if applied == vec!["read".to_owned(), "search".to_owned()]
        ));
        let opening = resume_opening(Some(vec!["read"]));
        assert!(matches!(
            verify_applied_built_in_tools(&opening, &requested(&["read", "edit"])),
            Ok(applied) if applied == vec!["read".to_owned()]
        ));
    }

    #[test]
    fn echo_absent_fails_as_unapplied() {
        let error = verify_applied_built_in_tools(&start_opening(None), &requested(&["read"]))
            .expect_err("an absent echo must fail, never pass");
        assert!(matches!(
            error,
            FacadeError::AppliedBuiltInToolsNotApplied {
                applied: None,
                session_id,
                ..
            } if session_id == "s-1"
        ));
    }

    #[test]
    fn echo_containing_an_excluded_tool_fails() {
        let error = verify_applied_built_in_tools(
            &start_opening(Some(vec!["read", "workflow"])),
            &requested(&["read"]),
        )
        .expect_err("an echo naming an excluded tool must fail");
        assert!(matches!(
            error,
            FacadeError::AppliedBuiltInToolsNotApplied {
                applied: Some(applied),
                ..
            } if applied == vec!["read".to_owned(), "workflow".to_owned()]
        ));
    }

    #[test]
    fn empty_request_passes_only_on_an_empty_echo() {
        let opening = start_opening(Some(vec![]));
        assert!(matches!(
            verify_applied_built_in_tools(&opening, &requested(&[])),
            Ok(applied) if applied.is_empty()
        ));
        assert!(matches!(
            verify_applied_built_in_tools(&start_opening(Some(vec!["workflow"])), &requested(&[])),
            Err(FacadeError::AppliedBuiltInToolsNotApplied { .. })
        ));
    }

    #[test]
    fn blank_names_fail_before_any_comparison() {
        assert!(matches!(
            verify_applied_built_in_tools(&start_opening(Some(vec!["read"])), &requested(&[""])),
            Err(FacadeError::Protocol(_))
        ));
        let error =
            verify_applied_built_in_tools(&start_opening(Some(vec![""])), &requested(&["read"]))
                .expect_err("a malformed echo must fail");
        assert!(matches!(
            error,
            FacadeError::AppliedBuiltInToolsNotApplied { applied: None, .. }
        ));
    }
}
