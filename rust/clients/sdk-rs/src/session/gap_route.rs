//! Live `view/gap` recovery for one session: the splice-fill that
//! `crate::gap::GapFill` implements, driven here with the session's own
//! `view/page` round trips.

use std::sync::{Arc, Mutex, Weak};

use serde_json::Value;

use super::SessionInner;
use super::state::detach_client;
use crate::client::{FacadeError, lock};
use crate::errors::{GapFillError, ProtocolError};
use crate::gap::{GapAdvance, GapEvent, GapFill, GapPage, PageCursor};
use crate::msp::{JsonRpcVersion, Notification, ViewGapParams, ViewPageParams};
use crate::turn::TurnWaitError;

/// The hold's own bound, independent of the connection's notification
/// bound: a hole still unpaged after this many live frames will not be
/// paged, so the session fails loudly rather than holding without bound.
pub(super) const MAX_HELD_GAP_FRAMES: usize = 1_024;

pub(super) struct GapRoute {
    fill: Mutex<GapFill<Notification>>,
    walker: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl GapRoute {
    pub(super) fn new(session_id: &str) -> Self {
        Self {
            fill: Mutex::new(GapFill::new(session_id)),
            walker: Mutex::new(None),
        }
    }

    /// Route one live notification: a `view/gap` starts (or extends) a page
    /// walk and is consumed; any other view event goes through the fill, which
    /// applies it now, holds it behind a pending hole, or refuses a twin the
    /// walk already served. A notification without a view cursor is not a
    /// view event and applies directly.
    pub(super) fn route(&self, session: &Arc<SessionInner>, notification: Notification) {
        // A failed event source accepts nothing more: the frame is a
        // late frame, so it never folds (a twin a page already served could
        // repeat), and the retired routes drop it instead of holding it behind
        // a hole that will never fill. The handoff accepted it, so dropping it
        // stops the fold, like a cut-off fill.
        if lock(&session.state).event_source_failure.is_some() {
            session.mark_fold_lost();
            session.route_now(notification);
            return;
        }
        if notification.method == "view/gap" {
            match super::decode::<ViewGapParams>(&notification.method, notification.params) {
                Ok(gap) => self.begin(session, gap),
                // `decode` names the frame (`view/gap is malformed: ...`).
                Err(error) => fail(session, error),
            }
            return;
        }
        let Some(cursor) = view_cursor(notification.params.as_ref()) else {
            session.apply_now(notification);
            return;
        };
        let event = GapEvent::new(session.session_id(), cursor, notification);
        // Applied under the fill lock so a splice and a live frame cannot
        // interleave; `apply_now` never re-enters this lock.
        let mut fill = lock(&self.fill);
        // A hole the host never pages must not hold frames without limit: at
        // the hold's bound the session fails loudly instead.
        if fill.pending_gap().is_some() && fill.held() >= MAX_HELD_GAP_FRAMES {
            drop(fill);
            fail(
                session,
                ProtocolError::new(
                    "notification backlog exceeded for this session behind a pending delivery gap",
                    None,
                ),
            );
            return;
        }
        let outcome = fill.apply(event, |notification| session.apply_now(notification));
        drop(fill);
        if let Err(error) = outcome {
            fail(
                session,
                gap_failure("live view event rejected during gap recovery", &error),
            );
        }
    }

    fn begin(&self, session: &Arc<SessionInner>, gap: ViewGapParams) {
        let request = {
            let mut fill = lock(&self.fill);
            let request = fill.begin_gap(gap);
            // The fold names the hole before its first page is requested.
            session.mirror_gap(fill.pending_gap());
            request
        };
        match request {
            Ok(Some(first_page)) => {
                let walker = session
                    .runtime()
                    .spawn(walk(Arc::downgrade(session), first_page));
                if let Some(previous) = lock(&self.walker).replace(walker) {
                    abort_unless_current(&previous);
                }
            }
            // A walk is already in flight; the hole's target was extended.
            Ok(None) => {}
            Err(error) => fail(session, gap_failure("view/gap rejected", &error)),
        }
    }

    pub(super) fn abort(&self) {
        if let Some(walker) = lock(&self.walker).as_ref() {
            abort_unless_current(walker);
        }
    }
}

// A dropped session must not leave its walk holding the client, and with it a
// spawned host, while an unanswered `view/page` is pending.
impl Drop for GapRoute {
    fn drop(&mut self) {
        if let Some(walker) = lock(&self.walker).take() {
            abort_unless_current(&walker);
        }
    }
}

/// Page forward from the hole until the fill is current. Every page is
/// spliced through the same `apply_now` path as a live frame; a page that
/// cannot be fetched or does not advance fails the session's event source
/// (a closing client leaves that to `close()`, and an ended transport to the
/// transport-end sweep), never leaves a silent hole.
async fn walk(session: Weak<SessionInner>, mut request: ViewPageParams) {
    loop {
        let Some(live) = session.upgrade() else {
            return;
        };
        let Some(client) = detach_client(&session, live) else {
            return;
        };
        let page = client.command::<_, Value>("view/page", &request).await;
        let Some(live) = session.upgrade() else {
            return;
        };
        let page = match page {
            Ok(page) => page,
            // `close()` settles the session as `ClientClosed` itself; failing
            // it first would name the wrong cause and abort the approval
            // worker, which may be the handler calling `close()`. A transport
            // end is the same, whether clean or a read or write error that
            // breaks the connection: its sweep settles the session as
            // transport ended, the real cause.
            Err(
                FacadeError::ClientClosed | FacadeError::TransportEnded | FacadeError::Transport(_),
            ) => return,
            Err(error) => {
                fail(
                    &live,
                    ProtocolError::new(
                        format!("view/page for the delivery gap failed: {error}"),
                        None,
                    ),
                );
                return;
            }
        };
        let page = match decode_page(page) {
            Ok(page) => page,
            Err(error) => {
                fail(&live, error);
                return;
            }
        };
        let advance = {
            let mut fill = lock(&live.gaps.fill);
            let advance = fill.accept_page(page, |notification| live.apply_now(notification));
            // Under the fill lock, so a newer `view/gap` cannot be cleared here.
            live.mirror_gap(fill.pending_gap());
            advance
        };
        match advance {
            Ok(GapAdvance::Request(next)) => request = next,
            Ok(GapAdvance::Current { .. }) => return,
            Err(error) => {
                fail(&live, gap_failure("view/page did not fill the gap", &error));
                return;
            }
        }
    }
}

/// The turn error message is the only channel a consumer sees, so append the
/// source text (`#[source]`), which `GapFillError`'s own Display omits.
fn gap_failure(context: &str, error: &GapFillError) -> ProtocolError {
    let message = match std::error::Error::source(error) {
        Some(source) => format!("{context}: {error}: {source}"),
        None => format!("{context}: {error}"),
    };
    ProtocolError::new(message, None)
}

fn fail(session: &Arc<SessionInner>, error: ProtocolError) {
    session.fail_event_source(TurnWaitError::EventSourceFailed {
        message: error.to_string(),
    });
}

fn view_cursor(params: Option<&serde_json::Map<String, Value>>) -> Option<String> {
    params?
        .get("viewCursor")
        .and_then(Value::as_str)
        .map(str::to_owned)
}

/// Decode a raw `view/page` result losslessly: the generated params type
/// keeps only the envelope fields, and the fold needs every event-specific
/// member, so each paged event becomes the live notification it would have
/// been.
fn decode_page(page: Value) -> Result<GapPage<Notification>, ProtocolError> {
    let invalid = |message: &str| ProtocolError::new(format!("view/page result {message}"), None);
    let events = page
        .get("events")
        .and_then(Value::as_array)
        .ok_or_else(|| invalid("has no events array"))?;
    let mut paged = Vec::with_capacity(events.len());
    for event in events {
        let method = event
            .get("method")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("event has no method"))?;
        let params = event
            .get("params")
            .and_then(Value::as_object)
            .ok_or_else(|| invalid("event has no params object"))?;
        let event_session = params
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("event names no sessionId"))?;
        let cursor = params
            .get("viewCursor")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("event carries no viewCursor"))?;
        paged.push(GapEvent::new(
            event_session,
            cursor,
            Notification {
                jsonrpc: JsonRpcVersion::V2,
                method: method.to_owned(),
                params: Some(params.clone()),
                emitted_at_ms: None,
            },
        ));
    }
    let next_cursor = match page.get("nextCursor") {
        Some(Value::Null) => PageCursor::End,
        Some(Value::String(cursor)) => PageCursor::More(cursor.clone()),
        _ => return Err(invalid("has no nextCursor member")),
    };
    Ok(GapPage::new(paged, next_cursor))
}

fn abort_unless_current(worker: &tokio::task::JoinHandle<()>) {
    if !tokio::task::try_id().is_some_and(|current| current == worker.id()) {
        worker.abort();
    }
}

#[cfg(test)]
mod tests;
