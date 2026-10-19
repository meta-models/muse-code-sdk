//! Approvals as the TS and Python folds hold them: a
//! pending entry keeps its latest request and its latest update apart, and
//! both sets list in the order their entries first arrived.
//!
//! Downstream code cannot build `PendingApproval` with a struct literal and
//! must destructure it with `..`, so a later field stays additive.
//!
//! ```compile_fail,E0639
//! use muse_code_sdk::fold::PendingApproval;
//!
//! fn rebuild(approval: PendingApproval) {
//!     let _ = PendingApproval { ..approval };
//! }
//! ```
//!
//! ```no_run
//! use muse_code_sdk::fold::PendingApproval;
//!
//! fn inspect(approval: PendingApproval) {
//!     let PendingApproval { approval_id, .. } = approval;
//!     println!("{approval_id}");
//! }
//! ```

use std::collections::{HashMap, hash_map::Entry};

use serde_json::{Map, Value};

/// An approval awaiting its first durable terminal.
///
/// Callers only receive it, so it is `#[non_exhaustive]`: a later field
/// breaks no caller (as for the received wire structs).
#[derive(Clone, Debug, PartialEq)]
#[non_exhaustive]
pub struct PendingApproval {
    /// The `approvalId` the host minted for this approval.
    pub approval_id: String,
    /// The latest `approval/requested` params, verbatim.
    pub requested: Value,
    /// The most recent `approval/updated` refresh since that request, if any.
    pub latest_update: Option<Value>,
}

/// Each entry keeps the sequence at which it entered its set, so pending
/// approvals list in first-request order and resolved ones in
/// first-resolution order.
#[derive(Debug, Default)]
pub(super) struct Approvals {
    observed: u64,
    pending: HashMap<String, (u64, PendingApproval)>,
    resolved: HashMap<String, (u64, Value)>,
}

impl Approvals {
    /// A request for an approval that already has its terminal never re-opens
    /// it. A re-request replaces the entry, update included: a re-issued
    /// request already embodies the latest refresh.
    pub(super) fn request(&mut self, id: &str, params: &Map<String, Value>) -> bool {
        if self.resolved.contains_key(id) {
            return false;
        }
        let entry = PendingApproval {
            approval_id: id.to_owned(),
            requested: Value::Object(params.clone()),
            latest_update: None,
        };
        match self.pending.entry(id.to_owned()) {
            Entry::Occupied(mut slot) => slot.get_mut().1 = entry,
            Entry::Vacant(slot) => {
                slot.insert((self.observed, entry));
                self.observed += 1;
            }
        }
        true
    }

    /// An update refreshes a pending entry; it never opens one.
    pub(super) fn update(&mut self, id: &str, params: &Map<String, Value>) -> bool {
        match self.pending.get_mut(id) {
            Some((_, entry)) => {
                entry.latest_update = Some(Value::Object(params.clone()));
                true
            }
            None => false,
        }
    }

    /// The first durable terminal stands; a later one is an echo, never an
    /// overwrite.
    pub(super) fn resolve(&mut self, id: &str, params: &Map<String, Value>) -> bool {
        self.pending.remove(id);
        match self.resolved.entry(id.to_owned()) {
            Entry::Vacant(slot) => {
                slot.insert((self.observed, Value::Object(params.clone())));
                self.observed += 1;
                true
            }
            Entry::Occupied(_) => false,
        }
    }

    /// The latest params seen for a pending approval: its update if any, else
    /// its request.
    pub(super) fn latest(&self, id: &str) -> Option<&Value> {
        self.pending
            .get(id)
            .map(|(_, entry)| entry.latest_update.as_ref().unwrap_or(&entry.requested))
    }

    pub(super) fn resolved(&self, id: &str) -> Option<&Value> {
        super::params_of(self.resolved.get(id))
    }

    pub(super) fn pending_in_order(&self) -> Vec<&PendingApproval> {
        let mut ordered: Vec<_> = self.pending.values().collect();
        ordered.sort_unstable_by_key(|(observed, _)| *observed);
        ordered.into_iter().map(|(_, entry)| entry).collect()
    }

    pub(super) fn resolved_in_order(&self) -> Vec<&Value> {
        super::in_observed_order(&self.resolved)
    }
}
