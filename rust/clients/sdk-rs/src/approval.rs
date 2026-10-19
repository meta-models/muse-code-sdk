//! Approval handler routing.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::msp::ApprovalRequestParams;

/// The caller's answer to one server-authored approval request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalDecisionInput {
    /// One of the choice ids the request offers. Any other is refused: the
    /// session sends the offered `Denied` choice, else the offered `Abort`
    /// choice, and fails the approval's turn with a `MuseError::Protocol`
    /// carrying the [`ApprovalRoutingError::UnofferedChoice`] message once the
    /// host accepts that answer, or at once when neither is offered. For a
    /// stage the session already knows the host resolved or moved past, it
    /// sends nothing and fails no turn, and a `-32051` or `-32053` reply to
    /// the rejecting choice fails none either. An approval the session already
    /// retired for its own fault is not one the host moved past: its turn
    /// fails at once, unless the session has already received the host's
    /// resolution, and if that fault comes while the rejecting choice is out,
    /// a `-32053` reply fails it too.
    pub choice_id: String,
    /// Free-text guidance delivered to the model with the decision, never
    /// stored durably. Set it only on a choice whose `accepts_feedback` is
    /// true: on any other choice the SDK refuses the decision before sending
    /// it, as it does an unoffered choice. The session sends the offered
    /// `Denied` choice, else the offered `Abort` choice, and nothing when
    /// neither is offered, and the approval's turn fails with a
    /// `MuseError::Protocol` carrying the
    /// [`ApprovalRoutingError::FeedbackNotAccepted`] message when and as
    /// `choice_id` says an unoffered choice's turn fails.
    pub feedback: Option<String>,
}

type ApprovalHandlerFuture = Pin<Box<dyn Future<Output = ApprovalDecisionInput> + Send + 'static>>;
type ApprovalHandler =
    Arc<dyn Fn(ApprovalRequestParams) -> ApprovalHandlerFuture + Send + Sync + 'static>;

/// A local approval decision that cannot be submitted safely.
///
/// New refusals may be added, so a `match` on this enum needs a catch-all arm.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum ApprovalRoutingError {
    /// The handler picked a choice the request did not offer.
    #[error(
        "approval {approval_id} handler selected unoffered choice {choice_id}; offered choices: {available_choice_ids:?}"
    )]
    UnofferedChoice {
        /// The approval the handler answered.
        approval_id: String,
        /// The choice the handler picked.
        choice_id: String,
        /// The choices the request offered.
        available_choice_ids: Vec<String>,
    },
    /// The handler attached feedback to a choice that does not accept it.
    #[error(
        "{}",
        feedback_not_accepted(approval_id, choice_id, feedback_choice_ids)
    )]
    FeedbackNotAccepted {
        /// The approval the handler answered.
        approval_id: String,
        /// The choice the handler picked.
        choice_id: String,
        /// The offered choices that accept feedback.
        feedback_choice_ids: Vec<String>,
    },
}

/// Says what happened and what the handler can do instead: the host refuses
/// feedback on this choice, so the SDK never sends the decision.
fn feedback_not_accepted(approval_id: &str, choice_id: &str, accepting: &[String]) -> String {
    let instead = if accepting.is_empty() {
        "answer without feedback; no offered choice accepts it".to_owned()
    } else {
        format!("answer without feedback, or put it on one of {accepting:?}")
    };
    format!(
        "approval {approval_id}: the handler's choice {choice_id} does not accept feedback, so the SDK did not send that decision and the session answers with the offered rejecting choice, if any; next time, {instead}"
    )
}

/// Routes approval requests to one replaceable caller handler.
#[derive(Default, Clone)]
pub struct ApprovalRouter {
    handler: Option<ApprovalHandler>,
}

impl ApprovalRouter {
    /// A router with no handler yet: [`Self::route`] answers `Ok(None)`.
    pub fn new() -> Self {
        Self::default()
    }

    /// Replaces the current handler. One request must never race two answers.
    pub fn on_approval<Handler, HandlerFuture>(&mut self, handler: Handler)
    where
        Handler: Fn(ApprovalRequestParams) -> HandlerFuture + Send + Sync + 'static,
        HandlerFuture: Future<Output = ApprovalDecisionInput> + Send + 'static,
    {
        self.handler = Some(Arc::new(move |request| Box::pin(handler(request))));
    }

    /// Returns a validated caller decision, or `None` when no handler is registered.
    /// The session then sends the server-offered `Denied` choice, else the offered
    /// `Abort` choice, or fails only that turn when neither is offered.
    pub async fn route(
        &self,
        request: &ApprovalRequestParams,
    ) -> Result<Option<ApprovalDecisionInput>, ApprovalRoutingError> {
        let Some(handler) = &self.handler else {
            return Ok(None);
        };

        let decision = handler(request.clone()).await;
        let Some(choice) = request
            .available_choices
            .iter()
            .find(|choice| choice.choice_id == decision.choice_id)
        else {
            let available_choice_ids = request
                .available_choices
                .iter()
                .map(|choice| choice.choice_id.clone())
                .collect();
            return Err(ApprovalRoutingError::UnofferedChoice {
                approval_id: request.approval_id.clone(),
                choice_id: decision.choice_id,
                available_choice_ids,
            });
        };
        // The host refuses feedback on any other choice and keeps its approval
        // open, so refuse it here, where the session can still answer.
        if decision.feedback.is_some() && !choice.accepts_feedback {
            let feedback_choice_ids = request
                .available_choices
                .iter()
                .filter(|choice| choice.accepts_feedback)
                .map(|choice| choice.choice_id.clone())
                .collect();
            return Err(ApprovalRoutingError::FeedbackNotAccepted {
                approval_id: request.approval_id.clone(),
                choice_id: decision.choice_id,
                feedback_choice_ids,
            });
        }
        Ok(Some(decision))
    }
}
