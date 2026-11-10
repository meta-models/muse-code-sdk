//! Ephemeral fold. Params stay as JSON so newer open values survive verbatim.

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value};

use crate::msp::{Notification, ViewGapParams};

mod approvals;
mod items;
mod requests;
mod turns;
mod types;

pub use approvals::PendingApproval;
pub use items::{ItemOutcome, Items};
pub use types::{DeliveryGap, FoldOutcome, SessionState, Turn, TurnState};

use approvals::Approvals;
use requests::{Requests, in_observed_order, params_of, request, resolve};

/// A fold must be bound to one server session at construction.
///
/// ```compile_fail
/// use muse_code_sdk::fold::SessionFold;
///
/// let unbound = SessionFold::default();
/// ```
#[derive(Debug)]
pub struct SessionFold {
    session_id: String,
    items: Items,
    state: SessionState,
    turns: HashMap<String, Turn>,
    // Turn ids in first-seen order; turns are never removed.
    turn_order: Vec<String>,
    active_turn: Option<String>,
    approvals: Approvals,
    user_inputs: Requests,
    gap: Option<DeliveryGap>,
    // In a standalone fold, every `next` a `view/gap` named while `gap` is
    // pending, as the `Session` walk keeps its targets: a repeated one is a
    // stale frame, not a new target.
    gap_targets: HashSet<String>,
    // Set by the owning `Session` once an event was lost; nothing folds after.
    lost: bool,
    // Set once its id was opened again on the same client; only question
    // events fold after.
    reopened: bool,
}

impl SessionFold {
    /// An empty fold bound to `session_id`: events for any other session are
    /// ignored.
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            items: Items::default(),
            state: SessionState::default(),
            turns: HashMap::new(),
            turn_order: Vec::new(),
            active_turn: None,
            approvals: Approvals::default(),
            user_inputs: Requests::default(),
            gap: None,
            gap_targets: HashSet::new(),
            lost: false,
            reopened: false,
        }
    }
    /// The items the fold holds.
    pub const fn items(&self) -> &Items {
        &self.items
    }
    /// The latest params of each session-state notification the fold applied.
    pub const fn session_state(&self) -> &SessionState {
        &self.state
    }
    /// The turn whose `turn/started` the fold applied last, until that turn
    /// completes, is retracted or is unqueued.
    pub fn active_turn_id(&self) -> Option<&str> {
        self.active_turn.as_deref()
    }
    /// The record of turn `id`, or `None` when no turn event the fold applied
    /// named it.
    pub fn turn(&self, id: &str) -> Option<&Turn> {
        self.turns.get(id)
    }
    pub(crate) fn turn_ids(&self) -> &[String] {
        &self.turn_order
    }
    /// The delivery gap the fold has pending, or `None`. A stopped fold keeps
    /// its last gap, which nothing fills.
    pub const fn pending_gap(&self) -> Option<&DeliveryGap> {
        self.gap.as_ref()
    }
    /// False while a delivery gap is pending, and for good once the owning
    /// `Session` lost an event or its session id was opened again on the
    /// same client.
    pub const fn is_current(&self) -> bool {
        self.gap.is_none() && !self.is_stopped()
    }
    /// Clears the pending gap when `next` is its `next` cursor and returns
    /// true; any other cursor leaves the gap in place and returns false.
    pub fn gap_filled(&mut self, next: &str) -> bool {
        if self.gap.as_ref().map(|gap| gap.next.as_str()) != Some(next) {
            return false;
        }
        self.gap = None;
        self.gap_targets.clear();
        true
    }

    /// The latest params seen for a pending approval: its `approval/updated`
    /// refresh if any, else its request. `pending_approvals` keeps both.
    pub fn pending_approval(&self, id: &str) -> Option<&Value> {
        self.approvals.latest(id)
    }

    /// The first `approval/resolved` params of approval `id`; a later
    /// terminal never replaces it.
    pub fn resolved_approval(&self, id: &str) -> Option<&Value> {
        self.approvals.resolved(id)
    }

    /// Approvals awaiting a durable terminal, in the order they were first
    /// requested, each with its latest request and latest update.
    pub fn pending_approvals(&self) -> Vec<&PendingApproval> {
        self.approvals.pending_in_order()
    }

    /// The first durable terminal per approval, in the order those first
    /// terminals arrived.
    pub fn resolved_approvals(&self) -> Vec<&Value> {
        self.approvals.resolved_in_order()
    }

    /// The latest `userInput/requested` params of question `id` while it
    /// awaits its first settlement.
    pub fn pending_user_input(&self, id: &str) -> Option<&Value> {
        params_of(self.user_inputs.pending.get(id))
    }

    /// The first `userInput/settled` params of question `id`; a later
    /// settlement never replaces it.
    pub fn settled_user_input(&self, id: &str) -> Option<&Value> {
        params_of(self.user_inputs.resolved.get(id))
    }

    /// Questions awaiting a durable settlement, in the order they were first
    /// requested.
    pub fn pending_user_inputs(&self) -> Vec<&Value> {
        in_observed_order(&self.user_inputs.pending)
    }

    /// The first durable settlement per question, in the order those first
    /// settlements arrived.
    pub fn settled_user_inputs(&self) -> Vec<&Value> {
        in_observed_order(&self.user_inputs.resolved)
    }

    /// Folds one event and reports what it changed. Events for another
    /// session and malformed params change nothing. After the owning
    /// `Session` stops the fold it applies nothing, or only question events
    /// after a re-open.
    pub fn apply(&mut self, event: &Notification) -> FoldOutcome {
        if self.lost {
            return FoldOutcome::Ignored;
        }
        let method = event.method.as_str();
        // Question events are safe to see twice, and a turn that asks one
        // must stay answerable, so a re-opened fold still takes them.
        if self.reopened && !matches!(method, "userInput/requested" | "userInput/settled") {
            return FoldOutcome::Ignored;
        }
        let Some(params) = event.params.as_ref() else {
            return FoldOutcome::Ignored;
        };
        if string(params, "sessionId") != Some(self.session_id.as_str()) {
            return FoldOutcome::Ignored;
        }
        match method {
            "item/started" | "item/updated" | "item/completed" => self.item(method, params),
            "item/delta" => self.delta(params),
            "turn/started" | "turn/completed" | "turn/retracted" | "turn/unqueued" => {
                self.turn_event(method, params)
            }
            "approval/requested" => applied(
                string(params, "approvalId").is_some_and(|id| self.approvals.request(id, params)),
            ),
            "approval/updated" => applied(
                string(params, "approvalId").is_some_and(|id| self.approvals.update(id, params)),
            ),
            "approval/resolved" => {
                string(params, "approvalId").map_or(FoldOutcome::Ignored, |id| {
                    FoldOutcome::Resolution {
                        first: self.approvals.resolve(id, params),
                    }
                })
            }
            // A prompt for a turn this fold has already seen leave
            // `Running` is an orphan: no answer can settle it, so listing
            // it would pend forever. Guarded to KNOWN dead turns only — a
            // prompt naming a turn the fold has never seen (a fresh resume
            // re-sending a still-open question) still lists.
            "userInput/requested" => {
                let dead = string(params, "turnId").is_some_and(|turn_id| {
                    self.turns
                        .get(turn_id)
                        .is_some_and(|turn| turn.state() != TurnState::Running)
                });
                if dead {
                    FoldOutcome::Ignored
                } else {
                    request(&mut self.user_inputs, params, "userInputId")
                }
            }
            "userInput/settled" => resolve(&mut self.user_inputs, params, "userInputId"),
            "view/gap" => self.delivery_gap(params),
            family if is_state_family(family) => {
                self.state
                    .0
                    .insert(family.to_owned(), Value::Object(params.clone()));
                FoldOutcome::Applied
            }
            _ => FoldOutcome::Ignored,
        }
    }

    /// Seeds one raw resume-history item as of the resume cursor, keeping
    /// members this SDK does not know; an `inProgress` item stays open to the
    /// deltas that follow.
    pub(crate) fn seed_history_item(&mut self, item: &Map<String, Value>) {
        let method = if string(item, "status") == Some("inProgress") {
            "item/updated"
        } else {
            "item/completed"
        };
        self.item(
            method,
            &Map::from_iter([("item".to_owned(), Value::Object(item.clone()))]),
        );
    }

    /// Follows the owning session's gap fill: its pending hole is the one the
    /// walk fills, so currency tracks the walk rather than this fold's own
    /// `view/gap` coalescing. A stopped fold keeps its
    /// last currency.
    pub(crate) fn track_gap(&mut self, gap: Option<&ViewGapParams>) {
        if self.is_stopped() {
            return;
        }
        self.gap = gap.map(|gap| DeliveryGap {
            after: gap.after.clone(),
            next: gap.next.clone(),
        });
        // Only keeps the field consistent: a `Session`-owned fold never folds a
        // `view/gap` itself, so nothing reads these targets.
        self.gap_targets = gap.map(|gap| gap.next.clone()).into_iter().collect();
    }

    /// The owning session lost an event, or cannot prove it did not: stop
    /// folding and stay not current, so the fold never passes for complete.
    pub(crate) fn mark_lost(&mut self) {
        self.lost = true;
    }

    /// The owning session's id was opened again on the same client, so an
    /// event may reach it twice or reach another `Session` instead: stop
    /// everything but question events and stay not current.
    pub(crate) fn mark_reopened(&mut self) {
        self.reopened = true;
    }

    pub(crate) const fn is_stopped(&self) -> bool {
        self.lost || self.reopened
    }

    /// A pending hole that nothing can fill any more stops the fold.
    pub(crate) fn stop_if_gap_pending(&mut self) {
        if self.gap.is_some() {
            self.lost = true;
        }
    }

    fn delivery_gap(&mut self, params: &Map<String, Value>) -> FoldOutcome {
        let (Some(after), Some(next)) = (string(params, "after"), string(params, "next")) else {
            return FoldOutcome::Ignored;
        };
        match self.gap.as_mut() {
            None => {
                self.gap = Some(DeliveryGap {
                    after: after.to_owned(),
                    next: next.to_owned(),
                });
                self.gap_targets = HashSet::from([next.to_owned()]);
                FoldOutcome::Applied
            }
            // A later gap while one is pending keeps the first `after` and takes
            // the newest `next`, contiguous or not, as the `Session` gap walk
            // and the TypeScript fold do. Keeping only the first range would
            // report current while the later hole's events never arrived. A
            // `next` already named while this gap is pending is a stale frame
            // and changes nothing, as in the walk.
            Some(gap) if self.gap_targets.insert(next.to_owned()) => {
                gap.next = next.to_owned();
                FoldOutcome::Applied
            }
            Some(_) => FoldOutcome::Ignored,
        }
    }
}
const fn applied(applied: bool) -> FoldOutcome {
    if applied {
        FoldOutcome::Applied
    } else {
        FoldOutcome::Ignored
    }
}
fn string<'a>(params: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    params.get(key).and_then(Value::as_str)
}

fn is_state_family(method: &str) -> bool {
    matches!(
        method,
        "session/modelChanged"
            | "session/reasoningEffortChanged"
            | "session/goalChanged"
            | "session/todoListChanged"
            | "session/branchChanged"
            | "session/tokenUsage"
            | "session/contextUsage"
            | "session/approvalModeChanged"
            | "session/nameChanged"
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn event(method: &str, params: Value) -> Notification {
        Notification {
            jsonrpc: crate::msp::JsonRpcVersion::V2,
            method: method.to_owned(),
            params: params.as_object().cloned(),
            emitted_at_ms: None,
        }
    }

    /// A lost fold applies
    /// nothing, question events included, even after a re-open, so a frame
    /// that races past the router's failure check still cannot fold.
    #[test]
    fn a_lost_fold_applies_nothing_even_after_a_reopen() {
        let question = |id: &str| {
            event(
                "userInput/requested",
                json!({"sessionId": "session-1", "userInputId": id}),
            )
        };
        let mut fold = SessionFold::new("session-1");
        fold.mark_reopened();
        assert_ne!(fold.apply(&question("input-before")), FoldOutcome::Ignored);
        fold.mark_lost();
        assert_eq!(fold.apply(&question("input-after")), FoldOutcome::Ignored);
        assert_eq!(
            fold.apply(&event(
                "item/completed",
                json!({"sessionId": "session-1", "item": {"itemId": "item-1", "revision": 1}})
            )),
            FoldOutcome::Ignored
        );
        assert_eq!(fold.pending_user_inputs().len(), 1);
        assert!(fold.items().is_empty());
    }

    #[test]
    fn a_question_for_a_known_dead_turn_is_not_listed_but_an_unseen_turn_still_lists() {
        let question = |id: &str| {
            event(
                "userInput/requested",
                json!({"sessionId": "session-1", "userInputId": id, "turnId": "turn-1"}),
            )
        };
        let mut fold = SessionFold::new("session-1");
        fold.apply(&event(
            "turn/started",
            json!({"sessionId": "session-1", "turnId": "turn-1", "commandId": "cmd-1"}),
        ));
        fold.apply(&event(
            "turn/completed",
            json!({"sessionId": "session-1", "turnId": "turn-1", "terminal": "completed"}),
        ));
        assert_eq!(fold.apply(&question("input-dead")), FoldOutcome::Ignored);
        assert!(fold.pending_user_inputs().is_empty());

        let mut fresh = SessionFold::new("session-1");
        assert_ne!(fresh.apply(&question("input-fresh")), FoldOutcome::Ignored);
        assert_eq!(fresh.pending_user_inputs().len(), 1);
    }

    #[test]
    fn dead_turn_questions_and_listed_prompt_retirement_cover_every_turn_end() {
        let question = |id: &str| {
            event(
                "userInput/requested",
                json!({"sessionId": "session-1", "userInputId": id, "turnId": "turn-1"}),
            )
        };
        let started = || {
            event(
                "turn/started",
                json!({"sessionId": "session-1", "turnId": "turn-1", "commandId": "cmd-1"}),
            )
        };
        let ends: [(&str, Notification); 3] = [
            (
                "completed",
                event(
                    "turn/completed",
                    json!({"sessionId": "session-1", "turnId": "turn-1", "terminal": "completed"}),
                ),
            ),
            (
                "retracted",
                event(
                    "turn/retracted",
                    json!({"sessionId": "session-1", "turnId": "turn-1", "commandId": "cmd-1"}),
                ),
            ),
            (
                "unqueued",
                event(
                    "turn/unqueued",
                    json!({"sessionId": "session-1", "turnId": "turn-1", "commandId": "cmd-1"}),
                ),
            ),
        ];
        for (_, end) in &ends {
            // Arrival guard: a question first seen after the end never lists.
            let mut fold = SessionFold::new("session-1");
            fold.apply(&started());
            fold.apply(end);
            assert_eq!(fold.apply(&question("input-late")), FoldOutcome::Ignored);
            assert!(fold.pending_user_inputs().is_empty());

            // Reported order: listed while running, retired by the end,
            // with no settlement recorded.
            let mut fold = SessionFold::new("session-1");
            fold.apply(&started());
            assert_ne!(fold.apply(&question("input-1")), FoldOutcome::Ignored);
            assert_eq!(fold.pending_user_inputs().len(), 1);
            fold.apply(end);
            assert!(fold.pending_user_inputs().is_empty());
            assert!(fold.settled_user_inputs().is_empty());
        }

        // A declined retract leaves the turn running, so its prompt stays.
        let mut fold = SessionFold::new("session-1");
        fold.apply(&started());
        fold.apply(&question("input-1"));
        fold.apply(&event(
            "turn/retracted",
            json!({"sessionId": "session-1", "turnId": "turn-1", "commandId": "cmd-1", "outcome": "declined"}),
        ));
        assert_eq!(fold.pending_user_inputs().len(), 1);

        // Another turn ending retires only its own prompts.
        let question2 = event(
            "userInput/requested",
            json!({"sessionId": "session-1", "userInputId": "input-2", "turnId": "turn-2"}),
        );
        let mut fold = SessionFold::new("session-1");
        fold.apply(&started());
        fold.apply(&event(
            "turn/started",
            json!({"sessionId": "session-1", "turnId": "turn-2", "commandId": "cmd-2"}),
        ));
        fold.apply(&question("input-1"));
        fold.apply(&question2);
        fold.apply(&event(
            "turn/completed",
            json!({"sessionId": "session-1", "turnId": "turn-2", "terminal": "completed"}),
        ));
        assert_eq!(fold.pending_user_inputs().len(), 1);

        // Unseen turn: the prompt lists, then its end frame retires it
        // with no settlement recorded.
        let mut fold = SessionFold::new("session-1");
        fold.apply(&question("input-1"));
        assert_eq!(fold.pending_user_inputs().len(), 1);
        fold.apply(&event(
            "turn/completed",
            json!({"sessionId": "session-1", "turnId": "turn-1", "terminal": "completed"}),
        ));
        assert!(fold.pending_user_inputs().is_empty());
        assert!(fold.settled_user_inputs().is_empty());
    }

    /// A re-opened fold keeps applying question
    /// events only, so approvals stay stopped with items, turns and state: an
    /// approval pending at the re-open neither updates nor resolves.
    #[test]
    fn a_reopened_fold_ignores_approval_events() {
        let approval = |method: &str, id: &str| {
            event(method, json!({"sessionId": "session-1", "approvalId": id}))
        };
        let mut fold = SessionFold::new("session-1");
        assert_eq!(
            fold.apply(&approval("approval/requested", "approval-held")),
            FoldOutcome::Applied
        );
        fold.mark_reopened();
        for method in [
            "approval/requested",
            "approval/updated",
            "approval/resolved",
        ] {
            assert_eq!(
                fold.apply(&approval(method, "approval-new")),
                FoldOutcome::Ignored,
                "{method} for a new approval"
            );
        }
        assert_eq!(
            fold.apply(&approval("approval/updated", "approval-held")),
            FoldOutcome::Ignored
        );
        assert_eq!(
            fold.apply(&approval("approval/resolved", "approval-held")),
            FoldOutcome::Ignored
        );
        let pending = fold.pending_approvals();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].approval_id, "approval-held");
        assert!(pending[0].latest_update.is_none());
        assert!(fold.resolved_approvals().is_empty());
    }
}
