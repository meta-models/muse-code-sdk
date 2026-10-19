//! Reattach and delivery-gap recovery.

use std::collections::{HashSet, VecDeque};

use crate::errors::{ForeignSessionError, GapFillError, ProtocolError};
use crate::msp::{ViewGapParams, ViewPageDirection, ViewPageParams};

const PAGE_LIMIT: u32 = 200;

/// A lossless view event plus the generated base fields gap recovery needs.
///
/// `T` stays intact because the generated `UnframedViewNotificationParams`
/// contains only the common envelope fields. Deserializing a page into that
/// type would discard event-specific item and turn data before the fold sees it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GapEvent<T> {
    session_id: String,
    view_cursor: String,
    value: T,
}

impl<T> GapEvent<T> {
    /// Wraps one event with the session and view cursor it was delivered under.
    #[must_use]
    pub fn new(session_id: impl Into<String>, view_cursor: impl Into<String>, value: T) -> Self {
        Self {
            session_id: session_id.into(),
            view_cursor: view_cursor.into(),
            value,
        }
    }

    /// The session the event names.
    #[must_use]
    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The event's opaque view cursor.
    #[must_use]
    pub fn view_cursor(&self) -> &str {
        &self.view_cursor
    }

    /// The whole event.
    #[must_use]
    pub const fn value(&self) -> &T {
        &self.value
    }
}

/// The required nullable `nextCursor` member of one raw `view/page` result.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum PageCursor {
    /// More events follow; request the next page from this cursor.
    More(String),
    /// The page reached the end of the view.
    End,
}

/// One lossless page supplied by the connection layer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GapPage<T> {
    events: Vec<GapEvent<T>>,
    next_cursor: PageCursor,
}

impl<T> GapPage<T> {
    /// A page of events in view order, and the page's `nextCursor`.
    #[must_use]
    pub const fn new(events: Vec<GapEvent<T>>, next_cursor: PageCursor) -> Self {
        Self {
            events,
            next_cursor,
        }
    }

    /// The page's events, in view order.
    #[must_use]
    pub fn events(&self) -> &[GapEvent<T>] {
        &self.events
    }

    /// Whether more pages follow, and from which cursor.
    #[must_use]
    pub const fn next_cursor(&self) -> &PageCursor {
        &self.next_cursor
    }
}

/// What happened to one live event at the public apply boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApplyOutcome {
    /// No gap is pending, so the event went straight to the callback.
    Applied,
    /// A gap is pending, so the event waits behind it and reaches the callback
    /// once the gap fills.
    Buffered,
    /// The event repeats one a page already delivered, or one already held
    /// behind the gap, so it was dropped.
    IgnoredOverlap {
        /// The dropped event's view cursor.
        view_cursor: String,
    },
}

/// The next step after accepting a page.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum GapAdvance {
    /// Send this `view/page` request and pass its answer to
    /// [`GapFill::accept_page`].
    Request(ViewPageParams),
    /// The gap is closed: the paged events were delivered in order, followed
    /// by the live events held behind the gap.
    Current {
        /// The gap's `next` cursor. When the view ended before it (a streamed
        /// fragment, which pages never serve), the fill stops at the end of the
        /// view and those fragments are not recovered.
        filled_through: String,
    },
}

/// Synchronous splice-fill state for one session.
///
/// The facade's `Session` (its gap route) owns the `view/page` round trips
/// and calls [`Self::accept_page`] with the raw, lossless page. Every
/// delivered value reaches the same callback used by [`Self::apply`], so paged
/// and live events share one downstream path.
#[derive(Debug)]
pub struct GapFill<T> {
    session_id: String,
    pending_gap: Option<ViewGapParams>,
    walking: bool,
    page_cursor: Option<String>,
    // The target the in-flight page request was sent toward. An end-of-view
    // answer finishes only that range, never a target extended since.
    request_target: Option<String>,
    paged: Vec<GapEvent<T>>,
    buffered: Vec<GapEvent<T>>,
    paged_cursors: HashSet<String>,
    buffered_cursors: HashSet<String>,
    overlap_receipts: HashSet<String>,
    overlap_receipt_order: VecDeque<String>,
    // Cursors are opaque; equality with a target already seen is the only
    // safe way to recognize a delayed older bracket during this fill.
    seen_targets: HashSet<String>,
}

impl<T> GapFill<T> {
    /// Empty fill state for one session, with no gap pending.
    #[must_use]
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            pending_gap: None,
            walking: false,
            page_cursor: None,
            request_target: None,
            paged: Vec::new(),
            buffered: Vec::new(),
            paged_cursors: HashSet::new(),
            buffered_cursors: HashSet::new(),
            overlap_receipts: HashSet::new(),
            overlap_receipt_order: VecDeque::new(),
            seen_targets: HashSet::new(),
        }
    }

    /// Whether no gap is pending.
    #[must_use]
    pub const fn is_current(&self) -> bool {
        self.pending_gap.is_none()
    }

    /// The pending gap, with its `next` cursor extended by any later gap that
    /// arrived during the fill.
    #[must_use]
    pub const fn pending_gap(&self) -> Option<&ViewGapParams> {
        self.pending_gap.as_ref()
    }

    /// Live events held behind the pending hole, awaiting the splice.
    pub(crate) fn held(&self) -> usize {
        self.buffered.len()
    }

    /// Record a delivery gap and start, or extend, its single forward walk.
    pub fn begin_gap(
        &mut self,
        gap: ViewGapParams,
    ) -> Result<Option<ViewPageParams>, GapFillError> {
        if gap.session_id != self.session_id {
            return Err(self.foreign_session(gap.session_id, &gap.after, &gap.next));
        }

        if let Some(pending) = self.pending_gap.as_mut() {
            if self.seen_targets.insert(gap.next.clone()) {
                pending.next = gap.next;
            }
            if self.walking {
                return Ok(None);
            }
        } else {
            self.page_cursor = Some(gap.after.clone());
            self.seen_targets.clear();
            self.seen_targets.insert(gap.next.clone());
            self.pending_gap = Some(gap);
        }

        self.walking = true;
        Ok(self.page_request())
    }

    /// Reissue the page after a failed walk on a replacement transport.
    ///
    /// An already in-flight request returns `None` so reattach cannot create a
    /// redelivery race. This deliberately does not construct `session/resume`
    /// or reconcile commands; those are owned by the facade and pending-command
    /// layers.
    #[must_use]
    pub fn reattach(&mut self) -> Option<ViewPageParams> {
        self.pending_gap.as_ref()?;
        if self.walking {
            return None;
        }
        self.walking = true;
        self.page_request()
    }

    /// Feed one live event through the same application boundary used by a fill.
    pub fn apply(
        &mut self,
        event: GapEvent<T>,
        mut apply: impl FnMut(T),
    ) -> Result<ApplyOutcome, GapFillError> {
        if event.session_id != self.session_id {
            let (after, next) = self
                .pending_gap
                .as_ref()
                .map_or(("", ""), |gap| (gap.after.as_str(), gap.next.as_str()));
            return Err(self.foreign_session(event.session_id, after, next));
        }
        if self.overlap_receipts.contains(&event.view_cursor) {
            return Ok(ApplyOutcome::IgnoredOverlap {
                view_cursor: event.view_cursor,
            });
        }
        // A failed walk still owns a pending hole. Keep later live facts
        // behind its eventual retry instead of applying newer before older.
        if self.pending_gap.is_some() {
            if !self.buffered_cursors.insert(event.view_cursor.clone()) {
                return Ok(ApplyOutcome::IgnoredOverlap {
                    view_cursor: event.view_cursor,
                });
            }
            self.buffered.push(event);
            return Ok(ApplyOutcome::Buffered);
        }
        apply(event.value);
        Ok(ApplyOutcome::Applied)
    }

    /// Accept one raw page, advancing or atomically splicing it into the fold.
    pub fn accept_page(
        &mut self,
        page: GapPage<T>,
        mut apply: impl FnMut(T),
    ) -> Result<GapAdvance, GapFillError> {
        let Some(pending) = self.pending_gap.as_ref() else {
            return Err(GapFillError::PageFailed {
                after: String::new(),
                next: String::new(),
                source: Box::new(ProtocolError::Other {
                    message: "view/page arrived with no pending gap".to_owned(),
                    line: None,
                }),
            });
        };
        let after = pending.after.clone();
        let target = pending.next.clone();
        let cursor = self.page_cursor.clone().unwrap_or_else(|| after.clone());
        let page_was_empty = page.events.is_empty();

        let mut reached = false;
        let mut last_cursor = None;
        for event in page.events {
            if event.session_id != self.session_id {
                let error = self.foreign_session(event.session_id, &after, &target);
                self.fail_and_hold();
                return Err(error);
            }
            if event.view_cursor == target {
                reached = true;
            }
            last_cursor = Some(event.view_cursor.clone());
            if self.overlap_receipts.contains(&event.view_cursor)
                || !self.paged_cursors.insert(event.view_cursor.clone())
            {
                continue;
            }
            self.paged.push(event);
        }

        match page.next_cursor {
            // The server's end of the view finishes the fill even before the
            // target: `view/page` serves durable events only, so a hole whose
            // `next` is an ephemeral fragment cursor (an `item/delta` mid-stream)
            // ends here, and its fragments are unrecoverable by design (the
            // TypeScript and Python fillers do the same).
            // It finishes only the range this request was sent toward: if a
            // later `view/gap` extended the target mid-walk, page on toward it
            // from the last served cursor, or re-ask the current cursor when the
            // end page was empty (the TypeScript `gapFilled` refusal).
            PageCursor::End
                if reached || self.request_target.as_deref() == Some(target.as_str()) =>
            {
                Ok(self.finish(target, &mut apply))
            }
            PageCursor::End => {
                let next_cursor = last_cursor.unwrap_or(cursor);
                self.page_cursor = Some(next_cursor.clone());
                Ok(GapAdvance::Request(self.page_request_at(next_cursor)))
            }
            PageCursor::More(next_cursor) => {
                if page_was_empty || next_cursor == cursor {
                    let error = GapFillError::PageStalled {
                        after,
                        next: target,
                        cursor,
                    };
                    self.fail_and_hold();
                    return Err(error);
                }
                if reached {
                    Ok(self.finish(target, &mut apply))
                } else {
                    self.page_cursor = Some(next_cursor.clone());
                    Ok(GapAdvance::Request(self.page_request_at(next_cursor)))
                }
            }
        }
    }

    fn finish(&mut self, target: String, apply: &mut impl FnMut(T)) -> GapAdvance {
        self.pending_gap = None;
        self.walking = false;
        self.page_cursor = None;
        self.request_target = None;
        self.drain_success(apply);
        self.seen_targets.clear();
        GapAdvance::Current {
            filled_through: target,
        }
    }

    fn fail_and_hold(&mut self) {
        self.walking = false;
    }

    fn drain_success(&mut self, apply: &mut impl FnMut(T)) {
        let paged = std::mem::take(&mut self.paged);
        let buffered = std::mem::take(&mut self.buffered);
        let paged_cursors = std::mem::take(&mut self.paged_cursors);
        for event in paged {
            self.record_overlap_receipt(event.view_cursor);
            apply(event.value);
        }
        for event in buffered {
            if paged_cursors.contains(&event.view_cursor) {
                continue;
            }
            self.record_overlap_receipt(event.view_cursor);
            apply(event.value);
        }
        self.buffered_cursors.clear();
    }

    fn record_overlap_receipt(&mut self, cursor: String) {
        if !self.overlap_receipts.insert(cursor.clone()) {
            return;
        }
        self.overlap_receipt_order.push_back(cursor);
        // One page covers the only page/live overlap window. Older receipts
        // expire in FIFO order instead of accumulating for the session lifetime.
        if self.overlap_receipt_order.len() > PAGE_LIMIT as usize
            && let Some(oldest) = self.overlap_receipt_order.pop_front()
        {
            self.overlap_receipts.remove(&oldest);
        }
    }

    fn page_request(&mut self) -> Option<ViewPageParams> {
        let cursor = self.page_cursor.clone()?;
        Some(self.page_request_at(cursor))
    }

    fn page_request_at(&mut self, cursor: String) -> ViewPageParams {
        self.request_target = self.pending_gap.as_ref().map(|gap| gap.next.clone());
        ViewPageParams {
            session_id: self.session_id.clone(),
            cursor: Some(cursor),
            anchor: None,
            direction: Some(ViewPageDirection::Forward),
            limit: PAGE_LIMIT,
        }
    }

    fn foreign_session(&self, actual: String, after: &str, next: &str) -> GapFillError {
        GapFillError::PageFailed {
            after: after.to_owned(),
            next: next.to_owned(),
            source: Box::new(ForeignSessionError {
                expected: self.session_id.clone(),
                actual,
            }),
        }
    }
}
