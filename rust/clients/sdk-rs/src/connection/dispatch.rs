//! The notification handoff: admission into the dispatch queue and the
//! dispatcher loop that applies queued notifications and overflow markers.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::Ordering;

use tokio::sync::mpsc;

use super::{
    NOTIFICATION_HANDLER_CAPACITY, NOTIFICATION_SESSION_SHARE, NotificationDispatch,
    NotificationDispatchItem, NotificationDispatcher, NotificationHandler, OverflowMarker,
    SessionPermit, lock_notification_overflows, lock_saturated_overflow, lock_session_permits,
    notification_session_id,
};
use crate::msp::Notification;

impl NotificationDispatch {
    pub(super) fn try_send(&self, notification: Notification) -> bool {
        let session_id = notification_session_id(&notification);
        if session_id.is_some_and(|session_id| {
            lock_saturated_overflow(&self.saturated_overflow)
                .sessions
                .contains(session_id)
        }) {
            // This session already lost an older frame. Suppress later frames
            // until its queued overflow fails only that affected session.
            return true;
        }
        let Some(permit) = self.try_acquire(session_id) else {
            return self.try_send_overflow(notification);
        };
        let sent = self.queue.try_send(NotificationDispatchItem::Notification {
            notification,
            permit,
        });
        if let Err(error) = &sent {
            debug_assert_dispatch_capacity(error);
        }
        // Counted before this frame's driver turn ends, so before any later
        // response resolves.
        if sent.is_ok() {
            self.accepted.fetch_add(1, Ordering::Release);
        }
        sent.is_ok()
    }

    // Under contention, a session holding its share gets no permit. A session
    // at its share plus another session holding a permit
    // already means more than the share is held in total, so only the
    // per-session counts are checked.
    fn try_acquire(&self, session_id: Option<&str>) -> Option<SessionPermit> {
        let Some(session_id) = session_id else {
            let permit = Arc::clone(&self.notification_capacity)
                .try_acquire_owned()
                .ok()?;
            return Some(SessionPermit {
                session: None,
                _permit: permit,
            });
        };
        let mut held = lock_session_permits(&self.session_permits);
        let session_held = held.get(session_id).copied().unwrap_or(0);
        // A session at its share has an entry, so any second entry is
        // another session holding a permit.
        if session_held >= NOTIFICATION_SESSION_SHARE && held.len() > 1 {
            return None;
        }
        let permit = Arc::clone(&self.notification_capacity)
            .try_acquire_owned()
            .ok()?;
        match held.get_mut(session_id) {
            Some(count) => *count += 1,
            None => {
                held.insert(session_id.to_owned(), 1);
            }
        }
        Some(SessionPermit {
            session: Some((session_id.to_owned(), Arc::clone(&self.session_permits))),
            _permit: permit,
        })
    }

    fn try_send_overflow(&self, notification: Notification) -> bool {
        let Some(session_id) = notification_session_id(&notification) else {
            // The router ignores notifications without a session identity, so
            // they must not occupy or overwrite an affected session's marker.
            return true;
        };
        let marker = {
            let mut queued = lock_notification_overflows(&self.queued_overflows);
            if queued.contains(session_id) {
                return true;
            }
            if queued.len() >= NOTIFICATION_HANDLER_CAPACITY {
                let session_id = session_id.to_owned();
                drop(queued);
                return self.try_send_saturated_overflow(notification, session_id);
            }
            let session_id = session_id.to_owned();
            queued.insert(session_id.clone());
            OverflowMarker::Session(session_id)
        };
        self.try_queue_overflow(notification, marker)
    }

    fn try_send_saturated_overflow(&self, notification: Notification, session_id: String) -> bool {
        {
            let mut saturated = lock_saturated_overflow(&self.saturated_overflow);
            // The dispatcher already owns at most one marker per session up
            // to the same global cap. Keep the overflow sidecar at that cap
            // too; a refusal closes the transport rather than losing a turn.
            if saturated.sessions.len() >= NOTIFICATION_HANDLER_CAPACITY {
                saturated.refused.get_or_insert(notification);
                return false;
            }
            // Only the driver task calls try_send, and it suppresses sessions
            // already in this set before admission, so each is inserted once.
            let inserted = saturated.sessions.insert(session_id);
            debug_assert!(
                inserted,
                "saturated session reached overflow admission twice"
            );
            if saturated.queued {
                saturated.pending.push_back(notification);
                return true;
            }
            saturated.queued = true;
        }
        self.try_queue_overflow(notification, OverflowMarker::Saturated)
    }

    fn try_queue_overflow(&self, notification: Notification, marker: OverflowMarker) -> bool {
        match self.queue.try_send(NotificationDispatchItem::Overflow {
            notification,
            marker,
        }) {
            Ok(()) => true,
            Err(error) => {
                debug_assert_dispatch_capacity(&error);
                if let NotificationDispatchItem::Overflow { marker, .. } = error.into_inner() {
                    self.release_overflow_marker(&marker);
                }
                false
            }
        }
    }

    fn release_overflow_marker(&self, marker: &OverflowMarker) {
        match marker {
            OverflowMarker::Session(session_id) => {
                lock_notification_overflows(&self.queued_overflows).remove(session_id);
            }
            OverflowMarker::Saturated => {
                let mut saturated = lock_saturated_overflow(&self.saturated_overflow);
                saturated.queued = false;
                saturated.sessions.clear();
                saturated.pending.clear();
            }
        }
    }
}

impl Drop for SessionPermit {
    fn drop(&mut self) {
        let Some((session_id, held)) = &self.session else {
            return;
        };
        let mut held = lock_session_permits(held);
        match held.get_mut(session_id) {
            Some(count) if *count > 1 => *count -= 1,
            _ => {
                held.remove(session_id);
            }
        }
    }
}

impl NotificationDispatcher {
    pub(crate) async fn run(mut self) {
        let mut ready = VecDeque::new();
        loop {
            let item = match ready.pop_front() {
                Some(item) => item,
                None => {
                    let Some(item) = self.queue.recv().await else {
                        break;
                    };
                    item
                }
            };
            match item {
                NotificationDispatchItem::Notification {
                    notification,
                    permit,
                } => {
                    // Every notification already waiting rides the same
                    // blocking-pool hop, up to the next overflow
                    // marker, so arrival order holds across both paths.
                    let mut batch = vec![(notification, permit)];
                    loop {
                        let next = match ready.pop_front() {
                            Some(item) => item,
                            None => match self.queue.try_recv() {
                                Ok(item) => item,
                                Err(_) => break,
                            },
                        };
                        match next {
                            NotificationDispatchItem::Notification {
                                notification,
                                permit,
                            } => batch.push((notification, permit)),
                            overflow => {
                                ready.push_front(overflow);
                                break;
                            }
                        }
                    }
                    let handler = Arc::clone(&self.handler);
                    let count = batch.len() as u64;
                    on_blocking_pool(move || apply_batch(&handler, batch)).await;
                    self.applied.send_modify(|applied| *applied += count);
                }
                NotificationDispatchItem::Overflow {
                    notification,
                    marker: OverflowMarker::Session(session_id),
                } => {
                    lock_notification_overflows(&self.queued_overflows).remove(&session_id);
                    apply_notification_handler(&self.overflow, notification).await;
                }
                NotificationDispatchItem::Overflow {
                    notification,
                    marker: OverflowMarker::Saturated,
                } => {
                    let next = {
                        let mut saturated = lock_saturated_overflow(&self.saturated_overflow);
                        if let Some(session_id) = notification_session_id(&notification) {
                            saturated.sessions.remove(session_id);
                        }
                        let next = saturated.pending.pop_front();
                        if next.is_none() {
                            saturated.queued = false;
                        }
                        next
                    };
                    if let Some(notification) = next {
                        // Move every item that was already queued into the
                        // bounded local ready list, then place the next marker
                        // behind them. Frames accepted later remain behind it.
                        while let Ok(item) = self.queue.try_recv() {
                            ready.push_back(item);
                        }
                        ready.push_back(NotificationDispatchItem::Overflow {
                            notification,
                            marker: OverflowMarker::Saturated,
                        });
                    }
                    apply_notification_handler(&self.overflow, notification).await;
                }
            }
        }
        // The refusal closes the transport, but the refused frame's session
        // still lost an event: fail it as overflowed before closure.
        let refused = lock_saturated_overflow(&self.saturated_overflow)
            .refused
            .take();
        if let Some(notification) = refused {
            apply_notification_handler(&self.overflow, notification).await;
        }
        let _ = self.closed.send(true);
    }
}

async fn apply_notification_handler(handler: &NotificationHandler, notification: Notification) {
    let handler = Arc::clone(handler);
    on_blocking_pool(move || handler(notification)).await;
}

// Applies one batch in order. Each permit is released as its notification
// starts, as before batching. A panic in one handler call (for example, a
// caller's executor waker panicking inside `session.apply`) does not stop the
// rest of the batch, the same containment the per-notification hop gave.
fn apply_batch(handler: &NotificationHandler, batch: Vec<(Notification, SessionPermit)>) {
    for (notification, permit) in batch {
        drop(permit);
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(notification)));
    }
}

// Blocking-pool hops taken on this thread; the batching tests count them.
#[cfg(test)]
pub(super) fn blocking_hops() -> &'static std::thread::LocalKey<std::cell::Cell<usize>> {
    thread_local! {
        static HOPS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
    }
    &HOPS
}

async fn on_blocking_pool(work: impl FnOnce() + Send + 'static) {
    #[cfg(test)]
    blocking_hops().with(|hops| hops.set(hops.get() + 1));
    let _ = tokio::task::spawn_blocking(work).await;
}

/// A failed send means the dispatcher is gone, never a full channel (see
/// `NOTIFICATION_DISPATCH_CAPACITY`); both callers refuse the frame.
fn debug_assert_dispatch_capacity(error: &mpsc::error::TrySendError<NotificationDispatchItem>) {
    debug_assert!(
        matches!(error, mpsc::error::TrySendError::Closed(_)),
        "notification dispatch channel full: NOTIFICATION_DISPATCH_CAPACITY must cover every permit and marker"
    );
}
