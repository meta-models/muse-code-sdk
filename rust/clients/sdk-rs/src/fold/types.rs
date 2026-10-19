use std::collections::HashMap;

use serde_json::Value;

use super::ItemOutcome;

/// What [`SessionFold::apply`](super::SessionFold::apply) did with one event.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum FoldOutcome {
    /// The fold took the event (a redelivery may leave it unchanged).
    Applied,
    /// An `item/started`, `item/updated` or `item/completed`: the item was
    /// inserted, replaced, or ignored as stale.
    Item(ItemOutcome),
    /// A terminal for an approval or a question.
    Resolution {
        /// False when an earlier terminal already stands; this one changed
        /// nothing.
        first: bool,
    },
    /// The event changed nothing: another session's, malformed, a method the
    /// fold does not fold, a repeat or out-of-order event the fold drops, or
    /// arriving after the fold stopped (a re-opened fold still takes question
    /// events).
    Ignored,
}

/// Where a turn stands in the fold.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum TurnState {
    /// No `turn/completed`, accepted `turn/retracted` or `turn/unqueued`
    /// applied yet.
    Running,
    /// Ended with a `turn/completed` terminal.
    Settled,
    /// Ended by an accepted `turn/retracted`, in any state. A declined
    /// retract (the submission stood) never sets it: the turn keeps its state.
    Retracted,
    /// Reclaimed from the queue before it launched (`turn/unqueued`, which the
    /// fold applies in any state).
    Unqueued,
}

/// The fold's record of one turn, built from its turn events.
#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub(super) state: TurnState,
    pub(super) command_id: Option<String>,
    pub(super) terminal: Option<String>,
    pub(super) completion: Option<Value>,
}

impl Turn {
    /// Where the turn stands.
    pub const fn state(&self) -> TurnState {
        self.state
    }

    /// The `commandId` the fold took from the turn's events: set by
    /// `turn/started` while the turn runs, by `turn/unqueued` in any state,
    /// and by `turn/retracted` in any state (a declined one only on a turn the
    /// fold already holds). `None` before the fold applied one of them.
    pub fn command_id(&self) -> Option<&str> {
        self.command_id.as_deref()
    }

    /// The `terminal` of the `turn/completed` the fold applied, verbatim, so
    /// a newer host's value survives; `None` until then. A retract or reclaim
    /// keeps a terminal the turn already carries, so a `Retracted` or
    /// `Unqueued` turn has one when its completion came first. A
    /// `turn/completed` after an accepted retract or a reclaim is dropped; a
    /// declined retract leaves a running turn for its completion to settle.
    pub fn terminal(&self) -> Option<&str> {
        self.terminal.as_deref()
    }

    /// The full params of that `turn/completed`, or `None` until the fold
    /// applied one.
    pub const fn completion(&self) -> Option<&Value> {
        self.completion.as_ref()
    }
}

/// Sealed state read view: mutation is available only through `SessionFold`.
#[derive(Debug, Default)]
pub struct SessionState(pub(super) HashMap<String, Value>);

impl SessionState {
    /// The latest params of the session-state notification `family` (for
    /// example `session/modelChanged`), or `None` when the fold applied none.
    pub fn get(&self, family: &str) -> Option<&Value> {
        self.0.get(family)
    }

    /// How many state families the fold has applied.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// True until the fold applies its first state notification.
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// A pending hole in the session's event stream: every undelivered event lies
/// between view cursors `after` and `next`, both exclusive. A later
/// `view/gap` can move `next` further, so a joined gap can also span
/// delivered cursors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryGap {
    pub(super) after: String,
    pub(super) next: String,
}

impl DeliveryGap {
    /// The last cursor delivered before the hole (opaque: relay it, never
    /// parse it).
    pub fn after(&self) -> &str {
        &self.after
    }

    /// The first cursor delivered after the hole, where delivery continues.
    pub fn next(&self) -> &str {
        &self.next
    }
}
