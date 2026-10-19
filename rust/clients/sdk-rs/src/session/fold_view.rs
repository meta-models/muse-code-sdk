//! The session-owned fold: its read
//! view, its resume-history seed, and the loss marker that ends its currency.

use serde_json::Value;

use super::{Session, SessionInner};
use crate::client::lock;
use crate::fold::{DeliveryGap, PendingApproval, SessionFold, Turn};
use crate::msp::{Notification, ViewGapParams};

impl Session {
    /// A read view of this session's fold.
    ///
    /// The fold holds every event this session applied, in order, plus the
    /// items its resume history served. A resume seeds
    /// items only: turns, approvals, user inputs and session state show the
    /// events that arrive after it, and the turn still running at resume is
    /// named by [`Session::opening`]. The fold is complete only while
    /// [`SessionFoldView::is_current`] holds: after a lost event, or once this
    /// session id is opened again on the same client, it stops applying and
    /// stays not current, which [`SessionFoldView::is_stopped`] reports. A
    /// re-opened fold still lists its questions until its event source fails.
    pub fn fold(&self) -> SessionFoldView<'_> {
        SessionFoldView { inner: &self.inner }
    }

    pub(crate) fn mark_fold_reopened(&self) {
        self.inner.mark_fold_reopened();
    }
}

/// One `Session`'s fold, read one value at a time.
///
/// Each getter takes the fold's lock briefly and returns an owned copy of one
/// value, so an event waits at most for one getter's copy, never for caller
/// code, and no event copies the whole fold. No read spans several values
/// atomically: an event can land between two calls.
pub struct SessionFoldView<'a> {
    inner: &'a SessionInner,
}

impl SessionFoldView<'_> {
    fn read<R>(&self, read: impl FnOnce(&SessionFold) -> R) -> R {
        read(&lock(&self.inner.fold))
    }

    /// Item `id` at its latest revision, with the deltas since that revision
    /// appended, or `None` when the fold holds no such item.
    pub fn item(&self, id: &str) -> Option<Value> {
        self.read(|fold| fold.items().get(id).cloned())
    }

    /// How many items the fold holds; items are never removed.
    pub fn item_count(&self) -> usize {
        self.read(|fold| fold.items().len())
    }

    /// Item ids in first-seen order (resume history first, in served order).
    pub fn item_ids(&self) -> Vec<String> {
        self.read(|fold| fold.items().ids().to_vec())
    }

    /// The `item/delta` text appended to item `id`'s `field` since its latest
    /// revision arrived, or `None` when none has.
    pub fn accumulated(&self, id: &str, field: &str) -> Option<String> {
        self.read(|fold| fold.items().accumulated(id, field).map(str::to_owned))
    }

    /// The latest params of the session-state notification `family` (for
    /// example `session/modelChanged`), or `None` when the fold applied none.
    pub fn session_state(&self, family: &str) -> Option<Value> {
        self.read(|fold| fold.session_state().get(family).cloned())
    }

    /// The turn whose `turn/started` the fold applied last, until that turn
    /// completes, is retracted or is unqueued. On a resumed session the turn
    /// running at resume shows here only if the resume's streamed events
    /// replay its `turn/started`; [`Session::opening`] names that turn.
    pub fn active_turn_id(&self) -> Option<String> {
        self.read(|fold| fold.active_turn_id().map(str::to_owned))
    }

    /// The fold's record of turn `id`, or `None` when no turn event the fold
    /// applied named it (a declined `turn/retracted` for a turn it has not
    /// seen adds none).
    pub fn turn(&self, id: &str) -> Option<Turn> {
        self.read(|fold| fold.turn(id).cloned())
    }

    /// Turn ids in first-seen order.
    pub fn turn_ids(&self) -> Vec<String> {
        self.read(|fold| fold.turn_ids().to_vec())
    }

    /// The delivery gap the fold has pending, or `None`. A stopped fold keeps
    /// its last gap, which nothing fills (see [`Self::is_stopped`]).
    pub fn pending_gap(&self) -> Option<DeliveryGap> {
        self.read(|fold| fold.pending_gap().cloned())
    }

    /// False while a delivery gap is pending, and for good once the session
    /// lost an event or its id was opened again on the same client.
    pub fn is_current(&self) -> bool {
        self.read(SessionFold::is_current)
    }

    /// True for good once the fold stopped applying events: the session lost
    /// an event (nothing applies after), or its id was opened again on the
    /// same client (only question events still apply, until its event source
    /// fails). A stopped fold can keep the gap it had
    /// pending, so this, not [`Self::is_current`], tells it apart from a fill
    /// still running.
    pub fn is_stopped(&self) -> bool {
        self.read(SessionFold::is_stopped)
    }

    /// The params of the latest `approval/requested` or `approval/updated`
    /// for approval `id`, while it awaits its first terminal.
    pub fn pending_approval(&self, id: &str) -> Option<Value> {
        self.read(|fold| fold.pending_approval(id).cloned())
    }

    /// The first `approval/resolved` params of approval `id`; a later
    /// terminal never replaces it.
    pub fn resolved_approval(&self, id: &str) -> Option<Value> {
        self.read(|fold| fold.resolved_approval(id).cloned())
    }

    /// Pending approvals in first-request order, each with its latest request
    /// and latest update.
    pub fn pending_approvals(&self) -> Vec<PendingApproval> {
        self.read(|fold| fold.pending_approvals().into_iter().cloned().collect())
    }

    /// The first durable terminal per approval, in first-resolution order.
    pub fn resolved_approvals(&self) -> Vec<Value> {
        self.read(|fold| fold.resolved_approvals().into_iter().cloned().collect())
    }

    /// The latest `userInput/requested` params of question `id` while it
    /// awaits its first settlement.
    pub fn pending_user_input(&self, id: &str) -> Option<Value> {
        self.read(|fold| fold.pending_user_input(id).cloned())
    }

    /// The first `userInput/settled` params of question `id`; a later
    /// settlement never replaces it.
    pub fn settled_user_input(&self, id: &str) -> Option<Value> {
        self.read(|fold| fold.settled_user_input(id).cloned())
    }

    /// Pending user-input requests in first-request order.
    pub fn pending_user_inputs(&self) -> Vec<Value> {
        self.read(|fold| fold.pending_user_inputs().into_iter().cloned().collect())
    }

    /// Settled user-input requests in first-settlement order.
    pub fn settled_user_inputs(&self) -> Vec<Value> {
        self.read(|fold| fold.settled_user_inputs().into_iter().cloned().collect())
    }
}

impl SessionInner {
    /// Folds one event ahead of its turn route, so while the fold applies
    /// events a turn never yields one it lacks.
    pub(super) fn fold_event(&self, notification: &Notification) {
        // A routed `userInput/request` folds as its `userInput/requested` twin:
        // they share their params.
        if notification.method == "userInput/request" {
            let mut twin = notification.clone();
            twin.method = "userInput/requested".to_owned();
            lock(&self.fold).apply(&twin);
            return;
        }
        lock(&self.fold).apply(notification);
    }

    /// Mirrors the gap route's pending hole into the fold.
    pub(super) fn mirror_gap(&self, gap: Option<&ViewGapParams>) {
        lock(&self.fold).track_gap(gap);
    }

    pub(crate) fn mark_fold_lost(&self) {
        lock(&self.fold).mark_lost();
    }

    pub(crate) fn mark_fold_reopened(&self) {
        lock(&self.fold).mark_reopened();
    }

    /// A gap fill cut off by client close or transport end can never finish,
    /// so it stops the fold like a failed fill, whichever runs first.
    /// `fail_event_source` and `transport_ended` themselves
    /// stop a cut fill, before they wake the failed turns.
    pub(super) fn stop_fold_on_cut_fill(&self) {
        lock(&self.fold).stop_if_gap_pending();
    }
}

/// A fold seeded with every history item a resume served, finished turns
/// included.
pub(super) fn seeded_fold(session_id: &str, history: &[Value]) -> SessionFold {
    let mut fold = SessionFold::new(session_id);
    for item in history.iter().filter_map(Value::as_object) {
        fold.seed_history_item(item);
    }
    fold
}

/// The snapshot schema version, the view fold's version, that this SDK's fold
/// understands.
pub(crate) const SNAPSHOT_SCHEMA_VERSION: u64 = 1;

/// Drops a resume snapshot newer than this SDK's fold before the result is
/// decoded, so a changed snapshot shape cannot fail the resume and nothing
/// reads it as the old shape. The resume then uses none of the snapshot's
/// state; events after its cursor still stream and apply, and `history.mode`
/// still names what the host served.
/// Returns the dropped snapshot's `schemaVersion`.
pub(crate) fn drop_unreadable_snapshot(result: &mut Value) -> Option<u64> {
    let version = result
        .pointer("/history/snapshot/schemaVersion")
        .and_then(Value::as_u64)
        .filter(|version| *version > SNAPSHOT_SCHEMA_VERSION)?;
    *result.pointer_mut("/history/snapshot")? = Value::Null;
    Some(version)
}

/// The raw items a resume served, inline or in its snapshot. Seeding from
/// the raw objects keeps members this SDK does not know.
pub(crate) fn resume_history_items(result: &Value) -> &[Value] {
    ["/history/items", "/history/snapshot/state/items"]
        .iter()
        .find_map(|pointer| result.pointer(pointer).and_then(Value::as_array))
        .map_or(&[], Vec::as_slice)
}
