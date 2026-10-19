use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Weak};

use super::{
    MAX_ACTIVE_TURNS, MAX_RETIRED_TURNS, MAX_SETTLED_TURN_ALIASES, PendingTurn,
    SendUserTurnOptions, SessionInner,
};
use crate::client::ClientShared;
use crate::turn::{Turn, TurnHandle, TurnWaitError};

/// The client a background route needs for its next command, taken from a
/// session reference it upgraded and now releases. `None` when that release was
/// the session's last strong reference: the session's Drop then ran on the
/// route's own task, where it cannot abort the route, so the route must stop
/// rather than hold the client, and a spawned host, on its own.
pub(super) fn detach_client(
    session: &Weak<SessionInner>,
    live: Arc<SessionInner>,
) -> Option<Arc<ClientShared>> {
    let client = Arc::clone(&live.client);
    drop(live);
    (session.strong_count() > 0).then_some(client)
}

/// One in-flight `turn/start`: its routing alias window and its pending record.
pub(super) struct PendingCommandGuard {
    session: Weak<SessionInner>,
    command_id: String,
    retain: bool,
    keep_submission: bool,
}

impl PendingCommandGuard {
    pub(super) fn begin(
        session: &Arc<SessionInner>,
        command_id: String,
        options: SendUserTurnOptions,
    ) -> Self {
        {
            let mut state = crate::client::lock(&session.state);
            state.pending_commands.insert(command_id.clone());
            state.record_submission(command_id.clone(), options);
        }
        Self {
            session: Arc::downgrade(session),
            command_id,
            retain: false,
            keep_submission: false,
        }
    }

    pub(super) fn retain_for_retry(&mut self) {
        self.retain = true;
        self.keep_submission = true;
    }

    /// The outcome is still unknown (an answer arrived, or the client closed),
    /// so the submission stays in `Session::pending` past this guard.
    pub(super) fn keep_submission(&mut self) {
        self.keep_submission = true;
    }

    /// Until `keep_submission` runs again, dropping this guard is the caller's
    /// cancel, which takes the submission with it.
    pub(super) fn forget_submission_on_cancel(&mut self) {
        self.keep_submission = false;
    }
}

impl Drop for PendingCommandGuard {
    fn drop(&mut self) {
        let Some(session) = self.session.upgrade() else {
            return;
        };
        if !self.keep_submission {
            crate::client::lock(&session.state).forget_submission(&self.command_id);
        }
        if !self.retain {
            session.finish_command(&self.command_id);
        }
    }
}

/// A `send_user_turn` submission whose outcome this session has not observed.
struct Submission {
    sequence: u64,
    options: SendUserTurnOptions,
    turn_id: Option<String>,
    route: Option<TurnHandle>,
}

#[derive(Default)]
pub(super) struct SessionState {
    pub(super) turns: HashMap<String, TurnRoute>,
    pub(super) item_turns: HashMap<String, String>,
    pub(super) pending_commands: HashSet<String>,
    pub(super) discarded: bool,
    pub(super) event_source_failure: Option<TurnWaitError>,
    pub(super) settled_turns: HashMap<String, Turn>,
    pub(super) settled_turn_order: VecDeque<String>,
    pub(super) retired_turns: HashMap<String, Option<String>>,
    pub(super) retired_turn_order: VecDeque<String>,
    submissions: HashMap<String, Submission>,
    submission_turns: HashMap<String, Vec<String>>,
    next_submission: u64,
    pub(super) hold_settled_aliases: bool,
    // The turn a resume restates as `lastTurn`, and its handle once its route
    // retires here. Kept for the session's life, past the alias hold, so a
    // same-command retry of it finds the terminal this session applied, or,
    // after a local fault, settles `Ended` from `lastTurn`.
    pub(super) last_turn_id: Option<String>,
    pub(super) last_turn_settled: Option<TurnHandle>,
    // Positions of each turn's items in the served resume history (inline
    // items, else the snapshot's items), taken when that turn's route first
    // opens.
    pub(super) history_turn_items: HashMap<String, Vec<usize>>,
}

pub(super) struct TurnRoute {
    pub(super) handle: TurnHandle,
    pub(super) item_ids: HashSet<String>,
}

impl TurnRoute {
    pub(super) fn new(turn_id: &str) -> Self {
        Self {
            handle: TurnHandle::new(turn_id),
            item_ids: HashSet::new(),
        }
    }
}

impl SessionState {
    pub(super) fn settle_source_failure(&mut self, failure: TurnWaitError) {
        let failure = self.event_source_failure.get_or_insert(failure).clone();
        self.fail_and_retire_active_turns(failure);
    }

    pub(super) fn accepts_turn_notification(&self, turn_id: &str) -> bool {
        self.event_source_failure.is_none()
            && !self.retired_turns.contains_key(turn_id)
            && (self.turns.contains_key(turn_id) || self.turns.len() < MAX_ACTIVE_TURNS)
    }

    /// Settles `turn_id`'s routed handle with `settle`, then retires the route,
    /// in one `&mut self` call. Whatever the settle wakes can look only after the
    /// caller releases its guard, by which time the turn is retired.
    /// Only `fail_and_retire_active_turns` retires routes besides
    /// this, failing and retiring each in the same call. Returns whether the
    /// route was retired.
    pub(super) fn settle_and_retire_turn(
        &mut self,
        turn_id: &str,
        settle: impl FnOnce(&TurnHandle),
    ) -> bool {
        let Some(turn) = self.turns.get(turn_id) else {
            return false;
        };
        settle(&turn.handle);
        self.retire_settled_turn(turn_id)
    }

    fn retire_settled_turn(&mut self, turn_id: &str) -> bool {
        let should_retire = self
            .turns
            .get(turn_id)
            .is_some_and(|turn| turn.handle.is_settled());
        if !should_retire {
            return false;
        }
        let Some(turn) = self.turns.remove(turn_id) else {
            return false;
        };
        // This turn's own terminal or named fault answered its submissions.
        for command_id in self.submission_turns.remove(turn_id).unwrap_or_default() {
            self.submissions.remove(&command_id);
        }
        self.retire_turn(turn_id.to_owned(), turn);
        true
    }

    pub(super) fn fail_and_retire_active_turns(&mut self, failure: TurnWaitError) {
        // A lost event source answers nothing: the submissions stay pending.
        self.submission_turns.clear();
        for (turn_id, turn) in std::mem::take(&mut self.turns) {
            turn.handle.fail(failure.clone());
            self.retire_turn(turn_id, turn);
        }
    }

    fn record_submission(&mut self, command_id: String, options: SendUserTurnOptions) {
        let sequence = self.next_submission;
        self.next_submission += 1;
        self.submissions.insert(
            command_id,
            Submission {
                sequence,
                options,
                turn_id: None,
                route: None,
            },
        );
    }

    /// Retires one in-flight command; settled aliases go once none remain,
    /// unless a resumed session still holds them for `resolve_reconnect`.
    pub(super) fn finish_pending_command(&mut self, command_id: &str) {
        self.pending_commands.remove(command_id);
        if self.pending_commands.is_empty() && !self.hold_settled_aliases {
            self.settled_turns.clear();
            self.settled_turn_order.clear();
        }
    }

    pub(super) fn release_settled_alias_hold(&mut self) {
        self.hold_settled_aliases = false;
        if self.pending_commands.is_empty() {
            self.settled_turns.clear();
            self.settled_turn_order.clear();
        }
    }

    pub(super) fn forget_submission(&mut self, command_id: &str) {
        self.submissions.remove(command_id);
    }

    pub(super) fn forget_submissions(&mut self) {
        self.submissions.clear();
        self.submission_turns.clear();
    }

    /// Binds an answered submission to the live route its turn now follows.
    pub(super) fn acknowledge_submission(&mut self, command_id: &str, turn_id: &str) {
        let route = self.turns.get(turn_id).map(|route| route.handle.clone());
        // Forget it only when the turn already settled here. A lost event
        // source or a refused route (the active-turn cap) proves nothing about
        // the server's turn, so the submission stays pending for a reconnect.
        let settled_here = route.is_none()
            && self.event_source_failure.is_none()
            && self.retired_turns.contains_key(turn_id);
        if settled_here {
            self.submissions.remove(command_id);
            return;
        }
        let Some(submission) = self.submissions.get_mut(command_id) else {
            return;
        };
        submission.turn_id = Some(turn_id.to_owned());
        submission.route = route;
        // Indexed even without a route: a cap-refused turn can still be routed
        // and retired here later, and its own terminal answers the submission.
        self.submission_turns
            .entry(turn_id.to_owned())
            .or_default()
            .push(command_id.to_owned());
    }

    pub(super) fn pending_turns(&self, session_id: &str) -> Vec<PendingTurn> {
        let mut pending: Vec<(u64, PendingTurn)> = self
            .submissions
            .iter()
            .filter(|(command_id, submission)| {
                submission.route.as_ref().is_none_or(|handle| {
                    !handle.has_server_outcome() && !handle.is_command_discarded(command_id)
                })
            })
            .map(|(command_id, submission)| {
                let entry = PendingTurn {
                    session_id: session_id.to_owned(),
                    command_id: command_id.clone(),
                    options: submission.options.clone(),
                    turn_id: submission.turn_id.clone(),
                };
                (submission.sequence, entry)
            })
            .collect();
        pending.sort_by_key(|(sequence, _)| *sequence);
        pending.into_iter().map(|(_, entry)| entry).collect()
    }

    fn retire_turn(&mut self, turn_id: String, turn: TurnRoute) {
        self.remember_retired(&turn_id, turn.handle.discarded_command_id());
        if self.last_turn_id.as_deref() == Some(turn_id.as_str()) {
            self.last_turn_settled = Some(turn.handle.clone());
        }
        if !self.pending_commands.is_empty() || self.hold_settled_aliases {
            self.insert_settled_alias(&turn_id, turn.handle.turn());
        }
        for item_id in turn.item_ids {
            self.item_turns.remove(&item_id);
        }
    }

    fn insert_settled_alias(&mut self, turn_id: &str, turn: Turn) {
        if !self.settled_turns.contains_key(turn_id) {
            while self.settled_turns.len() >= MAX_SETTLED_TURN_ALIASES {
                let Some(oldest) = self.settled_turn_order.pop_front() else {
                    break;
                };
                if self.settled_turns.remove(&oldest).is_some() {
                    break;
                }
            }
            self.settled_turn_order.push_back(turn_id.to_owned());
        }
        self.settled_turns.insert(turn_id.to_owned(), turn);
    }

    fn remember_retired(&mut self, turn_id: &str, discarded_command_id: Option<String>) {
        if self.retired_turns.contains_key(turn_id) {
            return;
        }
        while self.retired_turns.len() >= MAX_RETIRED_TURNS {
            let Some(oldest) = self.retired_turn_order.pop_front() else {
                break;
            };
            if self.retired_turns.remove(&oldest).is_some() {
                break;
            }
        }
        self.retired_turns
            .insert(turn_id.to_owned(), discarded_command_id);
        self.retired_turn_order.push_back(turn_id.to_owned());
    }

    pub(super) fn is_command_discarded(&self, command_id: &str) -> bool {
        self.turns
            .values()
            .any(|turn| turn.handle.is_command_discarded(command_id))
            || self
                .retired_turns
                .values()
                .any(|discarded| discarded.as_deref() == Some(command_id))
    }
}

#[cfg(test)]
pub(super) mod tests {
    use std::future::Future;
    use std::io;
    use std::pin::Pin;
    use std::sync::Arc;

    use serde_json::{Value, json};
    use tokio::sync::mpsc;

    use super::detach_client;
    use crate::DuplexTransport;
    use crate::client::{MuseClient, StartSessionOptions};
    use crate::msp::SessionDurability;

    /// Answers `session/start` with the request's own id; nothing else.
    pub(in crate::session) struct StartsOneSession {
        inbound: mpsc::UnboundedReceiver<String>,
        replies: mpsc::UnboundedSender<String>,
    }

    impl StartsOneSession {
        pub(in crate::session) fn new() -> Self {
            let (replies, inbound) = mpsc::unbounded_channel();
            Self { inbound, replies }
        }
    }

    impl DuplexTransport for StartsOneSession {
        fn read_chunk(
            &mut self,
        ) -> Pin<Box<dyn Future<Output = io::Result<Option<String>>> + Send + '_>> {
            Box::pin(async { Ok(self.inbound.recv().await) })
        }

        fn write(
            &mut self,
            frame: &str,
        ) -> Pin<Box<dyn Future<Output = io::Result<()>> + Send + '_>> {
            if let Ok(request) = serde_json::from_str::<Value>(frame.trim())
                && request["method"] == "session/start"
            {
                let reply = json!({
                    "jsonrpc": "2.0",
                    "id": request["id"],
                    "result": {
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
                    }
                });
                let _ = self.replies.send(format!("{reply}\n"));
            }
            Box::pin(async { Ok(()) })
        }
    }

    /// A gap walk or approval worker upgrades its session, takes the
    /// client and releases the upgrade before its next command. If that release
    /// was the session's last strong reference (the caller dropped every handle
    /// meanwhile), the session's Drop ran on the route's own task and could not
    /// abort it, so the route must get no client to hold.
    #[tokio::test(flavor = "current_thread")]
    async fn detach_client_refuses_when_the_route_held_the_last_session_reference()
    -> Result<(), String> {
        let client = MuseClient::new(StartsOneSession::new(), SessionDurability::Durable);
        let session = client
            .start_session(StartSessionOptions::default())
            .await
            .map_err(|error| error.to_string())?;
        let weak = Arc::downgrade(&session.inner);
        let client_state = Arc::downgrade(&session.inner.client);

        let live = weak.upgrade().ok_or("the session is alive")?;
        assert!(
            detach_client(&weak, live).is_some(),
            "control: while the caller still holds the session, the route keeps its client"
        );

        let live = weak.upgrade().ok_or("the session is alive")?;
        drop(session);
        drop(client);
        assert!(
            detach_client(&weak, live).is_none(),
            "a route whose own reference was the session's last must get no client"
        );
        assert!(
            client_state.upgrade().is_none(),
            "the client's shared state is released once that route lets go"
        );
        Ok(())
    }
}
