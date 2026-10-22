// The per-session approval worker: routes each queued approval in order and
// sends its decision.
use super::*;

pub(super) async fn route_requests(session: Weak<SessionInner>, mut woken: mpsc::Receiver<()>) {
    loop {
        let Some(inner) = session.upgrade() else {
            return;
        };
        // Owed answers go before queued approvals. Release the
        // session before any await, so dropping its last handle still aborts
        // this worker.
        let next = inner.approval.take_next();
        drop(inner);
        let Some((request, router)) = next else {
            match woken.recv().await {
                Some(()) => continue,
                None => return,
            }
        };
        let live = router.is_some();
        let Some(inner) = session.upgrade() else {
            return;
        };
        // While among the recently retired, an approval its own fault, or its
        // settled turn with no reject to send, retired reaches no handler and
        // owes a settled-turn answer for each unanswered stage at or above its
        // routed one.
        let current = live && inner.approval.is_current(&request);
        if !current && !inner.approval.owes(&request) {
            continue;
        }
        let settled = turn_settled(&inner, &request.turn_id);
        if !current && !settled {
            continue;
        }
        drop(inner);
        // The caller has already seen this turn end, so its handler may not
        // approve more work in it.
        let routed = match router {
            Some(router) if !settled => router.route(&request).await,
            _ => Ok(None),
        };
        // A worker `close()` did not abort (the closing handler's own, or one
        // no longer routed) stops once its handler returns on a closed client,
        // whatever that handler answered: nothing can be sent now, and an
        // approval routed to the session meanwhile must reach no handler.
        if client_closed(&session) {
            return;
        }
        // An unoffered answer's fault, held until the host replies to the
        // reject sent for it, unless the approval's own fault already retired
        // it.
        let mut unoffered = None;
        let decision = match routed {
            Ok(Some(decision)) => decision,
            Ok(None) => match deny_decision(&request) {
                Ok(decision) => decision,
                Err(_) if settled => {
                    retire_owing(&session, &request);
                    continue;
                }
                Err(message) => {
                    fail_request(&session, &request, message);
                    continue;
                }
            },
            Err(error) => match deny_decision(&request) {
                // The check after this match drops the reject, and with it the
                // fault, for a stage the host already moved past, and fails the
                // turn at once for one its own fault retired.
                Ok(denial) => {
                    unoffered = Some(error.to_string());
                    denial
                }
                // Nothing to send, so no reply can show the host moved on.
                Err(_) => {
                    // The server resolved the approval, or moved it past this
                    // stage, while the handler decided: it answers nothing. One
                    // its own fault retired meanwhile is owed, not moved past,
                    // at whatever stage, and a broken frame may have failed
                    // another turn, so its own turn still fails here.
                    let Some(inner) = session.upgrade() else {
                        return;
                    };
                    let owed = inner.approval.is_current(&request)
                        || inner.approval.has_owed(&request.approval_id);
                    drop(inner);
                    if owed {
                        fail_turn(&session, &request, error.to_string());
                        retire_owing(&session, &request);
                    }
                    continue;
                }
            },
        };
        let Some(inner) = session.upgrade() else {
            return;
        };
        let current = live && inner.approval.is_current(&request);
        let owes = inner.approval.owes(&request);
        // One its own fault retired is owed, not moved past, so an unoffered
        // answer for it fails its turn now, whatever the host does next. Read
        // after `owes`, so a mark added in between is seen; one the host
        // settled in between counts as resolved first.
        if unoffered.is_some()
            && inner.approval.has_owed(&request.approval_id)
            && let Some(message) = unoffered.take()
        {
            fail_turn(&session, &request, message);
        }
        if !current && !owes {
            continue;
        }
        let decision = if turn_settled(&inner, &request.turn_id) {
            match deny_decision(&request) {
                Ok(denial) => denial,
                Err(_) => {
                    drop(inner);
                    retire_owing(&session, &request);
                    continue;
                }
            }
        } else if current {
            decision
        } else {
            continue;
        };
        // Sending answers the stage, so a copy of it that arrives meanwhile
        // owes nothing; a terminal reply or `approval/resolved` then resolves
        // the approval. Record it while `inner` is held: after the
        // last-reference check below, the worker takes no session reference
        // again before the decide returns.
        inner.approval.note_answered(&request);
        let Some(client) = detach_client(&session, inner) else {
            return;
        };
        // Minting fails only on a closing client or an ended transport, and
        // each settles the session itself; failing the turn first would name
        // the wrong cause.
        let Ok(command_id) = client.mint_command_id() else {
            return;
        };
        let params = ApprovalDecideParams {
            session_id: request.session_id.clone(),
            command_id: command_id.clone(),
            approval_id: request.approval_id.clone(),
            requirement_id: request.current_requirement_id.clone(),
            choice_id: decision.choice_id,
            feedback: decision.feedback,
        };
        let result = match client
            .command::<_, ApprovalDecideResult>("approval/decide", &params)
            .await
        {
            Ok(result) => result,
            // A client close or a transport end, clean or a read or write
            // error that breaks the connection, settles the turn itself;
            // don't fail it here.
            Err(
                FacadeError::ClientClosed | FacadeError::TransportEnded | FacadeError::Transport(_),
            ) => return,
            // The server resolved it first (its own policy denial, or a turn
            // interrupt); the turn's own terminal settles it.
            Err(FacadeError::Msp(error)) if error.matches(ErrorCode::ApprovalAlreadyResolved) => {
                retire_request(&session, &request);
                continue;
            }
            // The server moved the approval past this stage first; its next
            // stage routes forward as usual. If its own fault retired it while
            // the reject was out, the held fault still fails its turn: that
            // next stage is owed, and only a settled turn answers it.
            Err(FacadeError::Msp(error)) if error.matches(ErrorCode::ApprovalRequirementStale) => {
                if let Some(message) = unoffered
                    && has_owed(&session, &request)
                {
                    fail_turn(&session, &request, message);
                }
                continue;
            }
            // Any other error fails the approval's turn as a decide error,
            // held answer or not.
            Err(error) => {
                fail_request(&session, &request, error.to_string());
                continue;
            }
        };
        if result.command_id != command_id || result.approval_id != request.approval_id {
            fail_request(
                &session,
                &request,
                "approval/decide response did not match its request",
            );
            continue;
        }
        if let Err(error) =
            crate::session::submit::require_accepted("approval/decide", &result.status)
        {
            fail_request(&session, &request, error.to_string());
            continue;
        }
        // The host took the reject, so the unoffered answer fails its turn.
        if let Some(message) = unoffered {
            fail_turn(&session, &request, message);
        }
        if result.terminal
            && let Some(inner) = session.upgrade()
        {
            inner.approval.retire(&request.approval_id);
        }
    }
}

fn client_closed(session: &Weak<SessionInner>) -> bool {
    session.upgrade().is_none_or(|inner| inner.client_closed())
}

fn has_owed(session: &Weak<SessionInner>, request: &ApprovalRequestParams) -> bool {
    session
        .upgrade()
        .is_some_and(|inner| inner.approval.has_owed(&request.approval_id))
}

fn turn_settled(inner: &SessionInner, turn_id: &str) -> bool {
    lock(&inner.state).settled_for_approvals(turn_id)
}

// Prefer an offered `Denied`; hosts offer only `abort` ("Reject") today, which
// rejects just this tool call.
fn deny_decision(request: &ApprovalRequestParams) -> Result<ApprovalDecisionInput, String> {
    let offered = |decision: ApprovalDecision| {
        request
            .available_choices
            .iter()
            .find(move |choice| choice.decision == decision)
    };
    let Some(choice) =
        offered(ApprovalDecision::Denied).or_else(|| offered(ApprovalDecision::Abort))
    else {
        return Err(format!(
            "approval {} offered no deny choice",
            request.approval_id
        ));
    };
    Ok(ApprovalDecisionInput {
        choice_id: choice.choice_id.clone(),
        feedback: None,
    })
}

fn fail_request(
    session: &Weak<SessionInner>,
    request: &ApprovalRequestParams,
    message: impl Into<String>,
) {
    retire_owing(session, request);
    fail_turn(session, request, message);
}

fn retire_owing(session: &Weak<SessionInner>, request: &ApprovalRequestParams) {
    if let Some(inner) = session.upgrade() {
        inner.approval.retire_owing(
            &request.approval_id,
            &request.turn_id,
            request.current_requirement_id.source_index,
        );
    }
}

fn retire_request(session: &Weak<SessionInner>, request: &ApprovalRequestParams) {
    if let Some(inner) = session.upgrade() {
        inner.approval.retire(&request.approval_id);
    }
}

fn fail_turn(
    session: &Weak<SessionInner>,
    request: &ApprovalRequestParams,
    message: impl Into<String>,
) {
    if let Some(inner) = session.upgrade() {
        inner.fail_named_turn(
            Some(request.turn_id.clone()),
            ProtocolError::new(message, None),
        );
    }
}
