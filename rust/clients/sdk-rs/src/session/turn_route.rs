//! Per-turn notification routes: claiming a turn's route, feeding it items,
//! deltas and lifecycle events, and retiring it once the turn settles.

use std::sync::Arc;

use super::state::{SessionState, TurnRoute};
use super::{SessionInner, SessionOpening};
use crate::client::lock;
use crate::errors::ProtocolError;
use crate::msp::{Item, ItemDeltaParams, TurnCompletedParams, TurnUnqueuedParams};
use crate::turn::{Turn, TurnHandle, TurnWaitError};

impl SessionInner {
    pub(super) fn push_item(self: &Arc<Self>, item: Item) {
        let Some(turn_id) = item.turn_id.clone() else {
            return;
        };
        let Some(handle) = self.turn_handle(&turn_id) else {
            return;
        };
        let routed = {
            let mut state = lock(&self.state);
            let item_id = item.item_id.clone();
            if let Some(turn) = state.turns.get_mut(&turn_id) {
                turn.item_ids.insert(item_id.clone());
                state.item_turns.insert(item_id, turn_id.clone());
                true
            } else {
                false
            }
        };
        if routed {
            handle.push_item(item);
        }
    }

    pub(super) fn push_delta(self: &Arc<Self>, delta: ItemDeltaParams) {
        let state = lock(&self.state);
        let Some(turn_id) = state.item_turns.get(&delta.item_id) else {
            return;
        };
        if let Some(turn) = state.turns.get(turn_id) {
            turn.handle.push_delta(delta);
        }
    }

    pub(super) fn mark_started(self: &Arc<Self>, turn_id: &str) {
        if let Some(turn) = self.turn_handle(turn_id) {
            turn.mark_started();
        }
    }

    pub(super) fn settle_turn(self: &Arc<Self>, terminal: TurnCompletedParams) {
        let turn_id = terminal.turn_id.clone();
        self.settle_routed_turn(&turn_id, |turn| turn.settle_completed(terminal));
    }

    pub(super) fn settle_unqueued(self: &Arc<Self>, params: TurnUnqueuedParams) {
        let turn_id = params.turn_id.clone();
        self.settle_routed_turn(&turn_id, |turn| turn.settle_unqueued(params));
    }

    pub(super) fn fail_named_turn(self: &Arc<Self>, turn_id: Option<String>, error: ProtocolError) {
        if let Some(turn_id) = turn_id {
            self.settle_routed_turn(&turn_id, |turn| {
                turn.fail(TurnWaitError::EventSourceFailed {
                    message: error.to_string(),
                });
            });
        }
    }

    /// Opens `turn_id`'s route if needed, then settles and retires it under the
    /// lock that wakes its waiter, so a caller resuming from `completed()` never
    /// finds the ended turn still routed, and `pending()` never lists a turn
    /// whose `completed()` already failed.
    fn settle_routed_turn(&self, turn_id: &str, settle: impl FnOnce(&TurnHandle)) {
        let mut state = lock(&self.state);
        if !state.accepts_turn_notification(turn_id) {
            return;
        }
        self.open_route(&mut state, turn_id);
        state.settle_and_retire_turn(turn_id, settle);
    }

    pub(super) fn claim_turn(self: &Arc<Self>, turn_id: &str) -> Turn {
        let mut state = lock(&self.state);
        self.claim_turn_locked(&mut state, turn_id)
    }

    /// `claim_turn` under a session-state guard the caller already holds, so
    /// it can act on the claim before any notification lands.
    pub(super) fn claim_turn_locked(
        self: &Arc<Self>,
        state: &mut SessionState,
        turn_id: &str,
    ) -> Turn {
        if let Some(turn) = state.settled_turns.get(turn_id) {
            return turn.clone();
        }
        let failure = state.event_source_failure.clone().or_else(|| {
            state
                .retired_turns
                .contains_key(turn_id)
                .then(|| TurnWaitError::EventSourceFailed {
                    message: "turn terminal history expired before its acknowledgement".to_owned(),
                })
        });
        if let Some(error) = failure {
            let handle = TurnHandle::new(turn_id);
            handle.fail(error);
            return handle.turn_with_keepalive(Arc::clone(self));
        }
        if !state.accepts_turn_notification(turn_id) {
            // The caller sees this turn fail now, so its approvals get the
            // settled-turn answer.
            state.remember_cap_refused(turn_id);
            let handle = TurnHandle::new(turn_id);
            handle.fail(TurnWaitError::EventSourceFailed {
                message: "too many active turns to retain another notification route".to_owned(),
            });
            return handle.turn_with_keepalive(Arc::clone(self));
        }
        state.forget_cap_refused(turn_id);
        let handle = self.open_route(state, turn_id).handle.clone();
        handle.turn_with_keepalive(Arc::clone(self))
    }

    /// `claim_turn`, for the client's own ordering tests. A claim
    /// follows `close()` only when `close()` runs on another thread inside the
    /// poll that read the turn's reply, so those tests make it directly.
    #[cfg(test)]
    pub(crate) fn claim_turn_for_ordering_tests(self: &Arc<Self>, turn_id: &str) -> Turn {
        self.claim_turn(turn_id)
    }

    /// Whether approvals for `turn_id` already get the rejecting choice, for
    /// the client's own tests.
    #[cfg(test)]
    pub(crate) fn settled_for_approvals_for_tests(&self, turn_id: &str) -> bool {
        lock(&self.state).settled_for_approvals(turn_id)
    }

    pub(super) fn submitted_turn(self: &Arc<Self>, turn_id: &str, command_id: String) -> Turn {
        self.claim_turn(turn_id).with_discard(command_id)
    }

    pub(super) fn turn_handle(&self, turn_id: &str) -> Option<TurnHandle> {
        let mut state = lock(&self.state);
        if !state.accepts_turn_notification(turn_id) {
            return None;
        }
        Some(self.open_route(&mut state, turn_id).handle.clone())
    }

    /// Returns `turn_id`'s route, opening it if needed. Routes open only here,
    /// so the first open takes that turn's resume history and replays it once.
    fn open_route<'s>(&self, state: &'s mut SessionState, turn_id: &str) -> &'s mut TurnRoute {
        let history = state.history_turn_items.remove(turn_id).unwrap_or_default();
        let route = state
            .turns
            .entry(turn_id.to_owned())
            .or_insert_with(|| TurnRoute::new(turn_id));
        if let SessionOpening::Resume(result) = &self.opening
            && let Some(items) = super::served_history_items(&result.history)
        {
            for item in history.iter().filter_map(|&index| items.get(index)) {
                route.item_ids.insert(item.item_id.clone());
                state
                    .item_turns
                    .insert(item.item_id.clone(), turn_id.to_owned());
                route.handle.push_item(item.clone());
            }
        }
        route
    }
}
