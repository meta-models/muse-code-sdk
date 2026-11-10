//! Pending and resolved request params (approvals' user-input twin):
//! each entry keeps the sequence at which it entered its set, so pending
//! entries list in first-request order and resolved entries in
//! first-resolution order, as the TS/Py folds do.

use std::collections::{HashMap, HashSet, hash_map::Entry};

use serde_json::{Map, Value};

use super::{FoldOutcome, applied, string};

/// Request params keyed by id; each entry keeps the sequence at which it
/// entered its set, so pending entries list in first-request order and resolved
/// entries in first-resolution order, as the TS/Py folds do.
#[derive(Debug, Default)]
pub(super) struct Requests {
    observed: u64,
    pub(super) pending: HashMap<String, (u64, Value)>,
    /// Pending ids by turn, so retiring a turn's prompts costs that
    /// turn's count, not every pending prompt.
    pending_by_turn: HashMap<String, HashSet<String>>,
    pub(super) resolved: HashMap<String, (u64, Value)>,
}

impl Requests {
    pub(super) fn request(&mut self, id: &str, params: &Map<String, Value>) -> bool {
        if self.resolved.contains_key(id) {
            return false;
        }
        self.unindex(id);
        if let Some(turn_id) = string(params, "turnId") {
            self.pending_by_turn
                .entry(turn_id.to_owned())
                .or_default()
                .insert(id.to_owned());
        }
        let params = Value::Object(params.clone());
        match self.pending.entry(id.to_owned()) {
            Entry::Occupied(mut slot) => slot.get_mut().1 = params,
            Entry::Vacant(slot) => {
                slot.insert((self.observed, params));
                self.observed += 1;
            }
        }
        true
    }

    fn unindex(&mut self, id: &str) {
        let Some((_, Value::Object(map))) = self.pending.get(id) else {
            return;
        };
        let Some(turn_id) = string(map, "turnId").map(str::to_owned) else {
            return;
        };
        if let Some(ids) = self.pending_by_turn.get_mut(&turn_id) {
            ids.remove(id);
            if ids.is_empty() {
                self.pending_by_turn.remove(&turn_id);
            }
        }
    }

    pub(super) fn resolve(&mut self, id: &str, params: &Map<String, Value>) -> bool {
        self.unindex(id);
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

    /// Drops every pending entry naming `turn_id`, recording no resolution:
    /// the prompt was never answered (see `turn_event`).
    pub(super) fn retire_turn(&mut self, turn_id: &str) {
        if let Some(ids) = self.pending_by_turn.remove(turn_id) {
            for id in &ids {
                self.pending.remove(id);
            }
        }
    }
}

pub(super) fn params_of(entry: Option<&(u64, Value)>) -> Option<&Value> {
    entry.map(|(_, params)| params)
}

pub(super) fn in_observed_order(entries: &HashMap<String, (u64, Value)>) -> Vec<&Value> {
    let mut ordered: Vec<_> = entries.values().collect();
    ordered.sort_unstable_by_key(|(observed, _)| *observed);
    ordered.into_iter().map(|(_, params)| params).collect()
}

pub(super) fn request(store: &mut Requests, params: &Map<String, Value>, key: &str) -> FoldOutcome {
    applied(string(params, key).is_some_and(|id| store.request(id, params)))
}
pub(super) fn resolve(store: &mut Requests, params: &Map<String, Value>, key: &str) -> FoldOutcome {
    string(params, key).map_or(FoldOutcome::Ignored, |id| FoldOutcome::Resolution {
        first: store.resolve(id, params),
    })
}
