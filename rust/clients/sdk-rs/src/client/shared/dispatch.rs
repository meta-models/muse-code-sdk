//! How notifications reach `NotificationRouter` routes: live delivery, the
//! loss marker on overflow, and the drain that applies a route's queue.

use serde_json::Value;

use super::{ActiveRoute, NotificationRouter, PendingRoute, RoutedNotification, lock};
use crate::msp::{Notification, SessionDurability};
use crate::turn::TurnWaitError;

impl ActiveRoute {
    pub(super) fn enqueue(&mut self, notification: Notification) -> bool {
        self.notifications
            .push_back(RoutedNotification::Notification(notification));
        if self.draining {
            false
        } else {
            self.draining = true;
            true
        }
    }

    pub(super) fn mark_overflowed(&mut self) -> bool {
        if self.overflowed {
            return false;
        }
        self.notifications.push_back(RoutedNotification::Overflow);
        self.overflowed = true;
        if self.draining {
            false
        } else {
            self.draining = true;
            true
        }
    }
}

impl PendingRoute {
    pub(super) fn record_overflow(&mut self) {
        if self.overflow_at.is_none() {
            self.overflow_at = Some(self.notifications.len());
        }
    }

    pub(super) fn record_prior_overflow(&mut self) {
        self.overflow_at = Some(0);
    }

    pub(super) fn record_unconfirmed_prior_overflow(&mut self) {
        // A loss already recorded here is certain; keep reporting it as one.
        if self.overflow_at.is_none() {
            self.overflow_unconfirmed = true;
        }
        self.overflow_at = Some(0);
    }
}

impl NotificationRouter {
    pub(crate) fn route(&self, notification: Notification) {
        let Some(session_id) = notification
            .params
            .as_ref()
            .and_then(|params| params.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return;
        };
        let should_drain = {
            let mut state = lock(&self.state);
            let active = state
                .sessions
                .get(&session_id)
                .and_then(|route| route.session.upgrade())
                .is_some();
            if !active {
                state.demote_dead_session_route(&session_id);
                state.enqueue_pending(session_id, notification);
                return;
            }
            let Some(route) = state.sessions.get_mut(&session_id) else {
                return;
            };
            route.enqueue(notification)
        };
        if should_drain {
            self.drain(&session_id);
        }
    }

    pub(crate) fn overflow(&self, notification: Notification) {
        let Some(session_id) = notification
            .params
            .as_ref()
            .and_then(|params| params.get("sessionId"))
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return;
        };
        let should_drain = {
            let mut state = lock(&self.state);
            let active = state
                .sessions
                .get(&session_id)
                .and_then(|route| route.session.upgrade())
                .is_some();
            if !active {
                state.demote_dead_session_route(&session_id);
                state.record_session_overflow(&session_id);
                return;
            }
            state
                .sessions
                .get_mut(&session_id)
                .is_some_and(ActiveRoute::mark_overflowed)
        };
        if should_drain {
            self.drain(&session_id);
        }
    }

    // The overflow failure names the caller's next step, chosen by the
    // client's durability. On a durable host, the host
    // that loaded the session holds its writer lease (one this client spawned
    // holds it until close() ends it), and a resume on this client keeps the
    // fold stopped, so the session resumes on a new
    // client after this one closes. Any other durability guarantees no session
    // to resume. Both steps name a new client because at the overflow-marker
    // cap this connection closes.
    fn overflow_message(&self) -> &'static str {
        match self.durability.get() {
            Some(SessionDurability::Durable) => {
                "notification backlog exceeded for this session; close this client, then resume the session on a new client to continue"
            }
            _ => {
                "notification backlog exceeded for this session; this host does not guarantee a resumable session, so start a new session on a new client to continue"
            }
        }
    }

    pub(super) fn drain(&self, session_id: &str) {
        loop {
            let next = {
                let mut state = lock(&self.state);
                let Some(session) = state
                    .sessions
                    .get(session_id)
                    .and_then(|route| route.session.upgrade())
                else {
                    state.demote_dead_session_route(session_id);
                    return;
                };
                let Some(route) = state.sessions.get_mut(session_id) else {
                    return;
                };
                match route.notifications.pop_front() {
                    Some(notification) => Some((session, notification)),
                    None => {
                        route.draining = false;
                        None
                    }
                }
            };
            let Some((session, notification)) = next else {
                return;
            };
            match notification {
                RoutedNotification::Notification(notification) => session.apply(notification),
                RoutedNotification::Overflow => {
                    session.fail_event_source(TurnWaitError::EventSourceFailed {
                        message: self.overflow_message().to_owned(),
                    })
                }
                RoutedNotification::UnconfirmedOverflow => {
                    session.fail_event_source(TurnWaitError::EventSourceFailed {
                        message: "a notification for this session may have been lost; the SDK cannot rule it out until this connection closes".to_owned(),
                    })
                }
            }
        }
    }
}
