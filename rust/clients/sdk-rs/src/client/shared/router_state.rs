//! `NotificationRouter` bookkeeping: pending notifications, loss markers, the
//! past-the-cap tombstone table, and route install/demotion.

use std::collections::VecDeque;
use std::sync::{Arc, Weak};

use super::{
    ActiveRoute, MAX_OVERFLOWED_SESSIONS, MAX_PENDING_NOTIFICATIONS_PER_SESSION,
    MAX_PENDING_NOTIFICATIONS_TOTAL, OVERFLOW_TOMBSTONE_WORDS, PendingRoute, RoutedNotification,
    RouterState, overflow_tombstone_slot,
};
use crate::msp::Notification;
use crate::session::SessionInner;

impl RouterState {
    /// The sessions with a live route. One snapshot visits each live route
    /// and each newly dead route once. Dead routes are removed here, so later
    /// snapshots cannot rescan them.
    pub(super) fn live_sessions(&mut self) -> Vec<Arc<SessionInner>> {
        let mut sessions = Vec::with_capacity(self.sessions.len());
        let mut dead_session_ids = Vec::new();
        for (session_id, route) in &self.sessions {
            if let Some(session) = route.session.upgrade() {
                sessions.push(session);
            } else {
                dead_session_ids.push(session_id.clone());
            }
        }
        for session_id in dead_session_ids {
            self.demote_dead_session_route(&session_id);
        }
        sessions
    }

    /// The live sessions a terminal path settles, with every pending fact
    /// cleared.
    pub(super) fn terminal_snapshot(&mut self) -> Vec<Arc<SessionInner>> {
        let sessions = self.live_sessions();
        // Snapshot first: it demotes dead-route facts into pending state, which
        // the terminal clear must retire in the same lifecycle transition.
        self.clear_pending();
        sessions
    }

    pub(super) fn clear_pending(&mut self) {
        self.pending.clear();
        self.pending_total = 0;
        self.overflowed_sessions.clear();
        self.overflow_tombstones = None;
    }

    pub(super) fn enqueue_pending(&mut self, session_id: String, notification: Notification) {
        if self.pending_total >= MAX_PENDING_NOTIFICATIONS_TOTAL {
            self.record_session_overflow(&session_id);
            return;
        }
        let pending = self.pending.entry(session_id).or_default();
        if pending.notifications.len() >= MAX_PENDING_NOTIFICATIONS_PER_SESSION
            || self.pending_total >= MAX_PENDING_NOTIFICATIONS_TOTAL
        {
            pending.record_overflow();
            return;
        }
        pending.notifications.push_back(notification);
        self.pending_total += 1;
    }

    pub(super) fn take_pending(&mut self, session_id: &str) -> PendingRoute {
        let mut pending = self.pending.remove(session_id).unwrap_or_default();
        self.pending_total = self
            .pending_total
            .saturating_sub(pending.notifications.len());
        if self.overflowed_sessions.remove(session_id) {
            pending.record_prior_overflow();
        } else if self.has_overflow_tombstone(session_id) {
            pending.record_unconfirmed_prior_overflow();
        }
        pending
    }

    pub(super) fn record_session_overflow(&mut self, session_id: &str) {
        if let Some(pending) = self.pending.get_mut(session_id) {
            pending.record_overflow();
        } else {
            // A global marker predates every pending item retained later.
            self.mark_overflowed(session_id.to_owned());
        }
    }

    pub(super) fn mark_overflowed(&mut self, session_id: String) {
        if self.overflowed_sessions.contains(&session_id) {
            return;
        }
        if self.overflowed_sessions.len() < MAX_OVERFLOWED_SESSIONS {
            self.overflowed_sessions.insert(session_id);
            return;
        }
        // Evicting an older marker would let that session register as complete.
        let (word, bit) = overflow_tombstone_slot(&session_id);
        let table = self
            .overflow_tombstones
            .get_or_insert_with(|| Box::new([0; OVERFLOW_TOMBSTONE_WORDS]));
        table[word] |= bit;
    }

    fn has_overflow_tombstone(&self, session_id: &str) -> bool {
        let (word, bit) = overflow_tombstone_slot(session_id);
        self.overflow_tombstones
            .as_ref()
            .is_some_and(|table| table[word] & bit != 0)
    }

    pub(super) fn install_session_route(
        &mut self,
        session_id: String,
        session: Weak<SessionInner>,
        pending: PendingRoute,
    ) -> bool {
        let mut route = self
            .sessions
            .remove(&session_id)
            .unwrap_or_else(|| ActiveRoute {
                session: Weak::new(),
                notifications: VecDeque::new(),
                draining: false,
                overflowed: false,
            });
        if !Weak::ptr_eq(&route.session, &session) {
            route.overflowed = false;
        }
        route.session = session;
        let mut overflow_at = if route.overflowed {
            None
        } else {
            pending.overflow_at
        };
        let overflow_marker = || {
            if pending.overflow_unconfirmed {
                RoutedNotification::UnconfirmedOverflow
            } else {
                RoutedNotification::Overflow
            }
        };
        for (index, notification) in pending.notifications.into_iter().enumerate() {
            if overflow_at == Some(index) {
                route.notifications.push_back(overflow_marker());
                route.overflowed = true;
                overflow_at = None;
            }
            route
                .notifications
                .push_back(RoutedNotification::Notification(notification));
        }
        if overflow_at.is_some() {
            route.notifications.push_back(overflow_marker());
            route.overflowed = true;
        }
        let mut should_drain = false;
        if !route.draining && !route.notifications.is_empty() {
            route.draining = true;
            should_drain = true;
        }
        self.sessions.insert(session_id, route);
        should_drain
    }

    pub(super) fn demote_dead_session_route(&mut self, session_id: &str) {
        let Some(route) = self.sessions.remove(session_id) else {
            return;
        };
        for event in route.notifications {
            match event {
                RoutedNotification::Notification(notification) => {
                    self.enqueue_pending(session_id.to_owned(), notification);
                }
                RoutedNotification::Overflow => {
                    self.record_session_overflow(session_id);
                }
                // The tombstone bit stays set, so the next registration is
                // refused again without re-recording anything.
                RoutedNotification::UnconfirmedOverflow => {}
            }
        }
    }
}
