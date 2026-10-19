//! Turn submission: `send_user_turn`, `unqueue_turn`, and the shared
//! `turn/start` path that `resolve_reconnect` also resends through.

use std::sync::Arc;

use super::{PendingCommandGuard, Session, SessionInner, SessionOpening};
use crate::client::{FacadeError, FacadeResult, lock};
use crate::errors::ProtocolError;
use crate::msp::{
    CommandStatus, IfBusy, LastTurn, ReasoningEffort, TurnInputPart, TurnStartDisposition,
    TurnStartParams, TurnStartResult, TurnUnqueueParams, TurnUnqueueResult,
};
use crate::turn::{Turn, TurnHandle};

/// What one `turn/start` sends.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SendUserTurnOptions {
    /// The prompt as ordered content parts; the server requires at least one.
    pub input: Vec<TurnInputPart>,
    /// What to do when a turn is already running; `None` sends nothing, and
    /// the server queues the turn.
    pub if_busy: Option<IfBusy>,
    /// The prompt's transcript form, never shown to the model.
    pub display_text: Option<String>,
    /// This turn's reasoning tier; `None` uses the session's current tier.
    pub reasoning_effort: Option<ReasoningEffort>,
    // No `tokenBudget`: the member is experimental-gated (v1
    // membership unruled) and this SDK serves the stable surface only.
    /// Replaces the session's workspace roots from this turn on; `None` keeps
    /// them.
    pub workspace_roots: Option<Vec<String>>,
}

impl Session {
    /// Sends one `turn/start` under a fresh command id and returns the turn
    /// it started or queued, or the running turn it steered into. A call
    /// refused at entry (session discarded, client closed, transport
    /// already ended) records nothing, so [`Session::pending`] does not
    /// list it. Once recorded, on a durable client only a server refusal
    /// ([`MuseError::Msp`](crate::errors::MuseError::Msp)) drops the
    /// submission; any other failure, a `TransportEnded` included, keeps it
    /// listed, since the server may have taken the turn. A call the caller
    /// cancels keeps nothing.
    ///
    /// A same-command retry (a command id minted again after a reconnect)
    /// that the server answers with the turn the resume restates as
    /// `lastTurn` returns once every notification received before that
    /// answer has been handed to the session. Its `Turn` settles on that
    /// turn's terminal if this session applied it before the claim, as it
    /// does one received before the answer unless a pending view-gap fill
    /// holds that one back; otherwise it replays the turn's held history and
    /// settles as [`TurnOutcome::Ended`](crate::turn::TurnOutcome::Ended).
    pub async fn send_user_turn(&self, options: SendUserTurnOptions) -> FacadeResult<Turn> {
        self.inner.ensure_available()?;
        let command_id = self.inner.client.mint_command_id()?;
        let mut pending_command =
            PendingCommandGuard::begin(&self.inner, command_id.clone(), options.clone());
        let result = self
            .inner
            .submit_turn(&command_id, options, &mut pending_command)
            .await?;
        let ended = self.inner.restated_last_turn(&result.turn_id);
        if ended.is_some() {
            // The answer names a turn that ended before the resume. Its own
            // terminal, if one arrived before this answer, settles the retry,
            // so every notification received first is handed over before the
            // claim looks for it. A cancel while waiting keeps nothing, like
            // any other cancel of this call.
            pending_command.forget_submission_on_cancel();
            self.inner.client.notifications_received_applied().await;
            pending_command.keep_submission();
        }
        Ok(self
            .inner
            .follow_submitted_turn(&command_id, &result, ended))
    }

    /// Reclaims a queued turn before it launches (`turn/unqueue`).
    ///
    /// The result is admission only: the queued [`Turn`] settles as
    /// [`TurnOutcome::Unqueued`](crate::turn::TurnOutcome::Unqueued) when the
    /// server's `turn/unqueued` arrives. A turn that already launched is
    /// refused with [`MuseError::Msp`](crate::errors::MuseError::Msp) and keeps
    /// running to its terminal. Pass `turn_id` exactly as the server minted it
    /// ([`Turn::turn_id`] or snapshot `queuedTurns`): the echoed id is compared
    /// byte for byte.
    pub async fn unqueue_turn(&self, turn_id: &str) -> FacadeResult<TurnUnqueueResult> {
        self.inner.ensure_available()?;
        let command_id = self.inner.client.mint_command_id()?;
        let params = TurnUnqueueParams {
            session_id: self.inner.session_id.clone(),
            command_id: command_id.clone(),
            turn_id: turn_id.to_owned(),
        };
        let result = self
            .inner
            .client
            .command::<_, TurnUnqueueResult>("turn/unqueue", &params)
            .await?;
        if result.command_id != command_id {
            return Err(ProtocolError::new(
                format!(
                    "turn/unqueue echoed command id {}, expected {command_id}",
                    result.command_id
                ),
                None,
            )
            .into());
        }
        if result.turn_id != turn_id {
            return Err(ProtocolError::new(
                format!(
                    "turn/unqueue echoed turn id {}, expected {turn_id}",
                    result.turn_id
                ),
                None,
            )
            .into());
        }
        require_accepted("turn/unqueue", &result.status)?;
        Ok(result)
    }
}

impl SessionInner {
    pub(super) fn ensure_available(&self) -> FacadeResult<()> {
        if lock(&self.state).discarded {
            Err(FacadeError::SessionDiscarded(self.session_id.clone()))
        } else {
            Ok(())
        }
    }

    /// Sends one `turn/start` under `command_id` and checks the answer's echo.
    pub(super) async fn submit_turn(
        self: &Arc<Self>,
        command_id: &str,
        options: SendUserTurnOptions,
        pending_command: &mut PendingCommandGuard,
    ) -> FacadeResult<TurnStartResult> {
        let params = TurnStartParams {
            session_id: self.session_id.clone(),
            command_id: command_id.to_owned(),
            input: options.input,
            if_busy: options.if_busy,
            display_text: options.display_text,
            reasoning_effort: options.reasoning_effort,
            // Experimental-gated: never sent by this SDK.
            token_budget: None,
            // No shell submit in SendUserTurnOptions: this SDK never
            // sends a `turn/start.userShell` member.
            user_shell: None,
            workspace_roots: options.workspace_roots,
        };
        let result = self
            .client
            .command::<_, TurnStartResult>("turn/start", &params)
            .await;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                match error {
                    FacadeError::TransportEnded | FacadeError::Transport(_) => {
                        pending_command.retain_for_retry();
                    }
                    // Only a server refusal answers the submission; any other
                    // failure may follow a written intake.
                    FacadeError::Msp(_) => {}
                    _ => pending_command.keep_submission(),
                }
                return Err(error);
            }
        };
        pending_command.keep_submission();
        if result.command_id != command_id {
            return Err(ProtocolError::new(
                format!(
                    "turn/start echoed command id {}, expected {command_id}",
                    result.command_id
                ),
                None,
            )
            .into());
        }
        require_accepted("turn/start", &result.status)?;
        Ok(result)
    }

    /// Follows an answered `turn/start`. `ended` is the resume's `lastTurn`
    /// when the answer names it and the caller has waited for the
    /// notifications received before the answer; `resolve_reconnect`, which
    /// answers that case itself, passes `None`.
    pub(super) fn follow_submitted_turn(
        self: &Arc<Self>,
        command_id: &str,
        result: &TurnStartResult,
        ended: Option<LastTurn>,
    ) -> Turn {
        if let Some(last_turn) = ended {
            return self.follow_ended_turn(command_id, result, last_turn);
        }
        let turn = match &result.disposition {
            TurnStartDisposition::Started | TurnStartDisposition::Queued => {
                self.submitted_turn(&result.turn_id, command_id.to_owned())
            }
            TurnStartDisposition::Steered => self.claim_turn(&result.turn_id),
            // A disposition this build does not know: follow the turn the
            // server named, as the submission's own only when it says it
            // started a new one; otherwise join it the way `Steered` does.
            TurnStartDisposition::Unknown(_) if result.started_new_turn => {
                self.submitted_turn(&result.turn_id, command_id.to_owned())
            }
            TurnStartDisposition::Unknown(_) => self.claim_turn(&result.turn_id),
        };
        lock(&self.state).acknowledge_submission(command_id, &result.turn_id);
        turn
    }

    /// Follows an answer that names the turn the resume restates as `lastTurn`,
    /// under one session-state guard, so no notification can land between
    /// reading the kept route, the claim and the settle.
    fn follow_ended_turn(
        self: &Arc<Self>,
        command_id: &str,
        result: &TurnStartResult,
        last_turn: LastTurn,
    ) -> Turn {
        let mut state = lock(&self.state);
        if let Some(handle) = state.last_turn_settled.clone() {
            // This session already retired the turn's route and keeps it past
            // the alias hold. Its own terminal settles the retry, even after
            // a failed event source. A local fault that retired it applies no
            // terminal, so the retry settles from the resume's restatement,
            // unless the event source has failed: then it keeps a failure,
            // through the claim below, as for any turn.
            let turn = if handle.has_server_outcome() {
                Some(handle.turn_with_keepalive(Arc::clone(self)))
            } else if state.event_source_failure.is_none() {
                Some(self.ended_turn(&handle, last_turn.clone()))
            } else {
                None
            };
            if let Some(turn) = turn {
                // Settled from server evidence, however long ago its route
                // retired.
                state.forget_submission(command_id);
                return turn;
            }
        }
        let turn = self.claim_turn_locked(&mut state, &result.turn_id);
        let turn = match &result.disposition {
            TurnStartDisposition::Started | TurnStartDisposition::Queued => {
                turn.with_discard(command_id.to_owned())
            }
            TurnStartDisposition::Steered | TurnStartDisposition::Unknown(_) => turn,
        };
        // No terminal for it was applied before this claim, and the resume says
        // it already ended: settle the route the claim opened from the resume's
        // own restatement. A claim the session refused opens no route, so its
        // failure stands.
        state.settle_and_retire_turn(&result.turn_id, |handle| handle.settle_ended(last_turn));
        state.acknowledge_submission(command_id, &result.turn_id);
        turn
    }

    /// A turn settled `Ended` from `last_turn`, carrying what `retired` held:
    /// its items, in order, and whether it saw `turn/started`.
    fn ended_turn(self: &Arc<Self>, retired: &TurnHandle, last_turn: LastTurn) -> Turn {
        let ended = TurnHandle::new(&last_turn.turn_id);
        if retired.observed_start() {
            ended.mark_started();
        }
        for item in retired.held_items() {
            ended.push_item(item);
        }
        ended.settle_ended(last_turn);
        ended.turn_with_keepalive(Arc::clone(self))
    }

    /// The resume's `lastTurn`, when it names `turn_id`.
    pub(super) fn restated_last_turn(&self, turn_id: &str) -> Option<LastTurn> {
        match &self.opening {
            SessionOpening::Resume(result) => result
                .last_turn
                .as_ref()
                .filter(|last_turn| last_turn.turn_id == turn_id)
                .cloned(),
            SessionOpening::Start(_) => None,
        }
    }

    pub(super) fn finish_command(&self, command_id: &str) {
        lock(&self.state).finish_pending_command(command_id);
    }
}

/// An ack whose status is not `accepted` does not say the host took the
/// command, so the call fails as a protocol error. Only a newer host's word
/// reaches the `Unknown` arm, so its message says to update the SDK, because
/// an app may show it as the turn's failure; the match is exhaustive, so a
/// status this SDK learns later cannot fall into that message.
pub(in crate::session) fn require_accepted(
    method: &str,
    status: &CommandStatus,
) -> Result<(), ProtocolError> {
    match status {
        CommandStatus::Accepted => Ok(()),
        CommandStatus::Unknown(word) => Err(ProtocolError::new(
            format!(
                "{method} answered status {word:?}, which this SDK does not know: the host is \
                 newer than this SDK, so update the SDK"
            ),
            None,
        )),
    }
}
