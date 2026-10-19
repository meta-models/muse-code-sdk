use std::collections::{HashMap, hash_map::Entry};

use serde_json::{Map, Value};

use super::{FoldOutcome, SessionFold, string};

/// What one item event did to the item it names.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ItemOutcome {
    /// The first revision of an item the fold did not hold.
    Inserted,
    /// A newer revision, or the completed form of the held revision,
    /// replaced the held one and dropped its accumulated deltas.
    Replaced {
        /// The revision held before.
        from: u64,
        /// The revision held now.
        to: u64,
    },
    /// The offered revision is older, or repeats the held one without
    /// completing an open item, so the held one stays.
    IgnoredStale {
        /// The revision the fold keeps.
        held: u64,
        /// The revision the event carried.
        offered: u64,
    },
}

#[derive(Debug, Clone)]
struct StoredItem {
    revision: u64,
    value: Value,
    open: bool,
}

/// Sealed item read view: mutation is available only through `SessionFold`.
#[derive(Debug, Default)]
pub struct Items {
    values: HashMap<String, StoredItem>,
    deltas: HashMap<String, HashMap<String, String>>,
    // Item ids in first-seen order; items are never removed.
    order: Vec<String>,
}

impl Items {
    /// Item `id` at its latest revision, with the deltas since that revision
    /// appended, or `None` when the fold holds no such item.
    pub fn get(&self, id: &str) -> Option<&Value> {
        self.values.get(id).map(|item| &item.value)
    }

    /// How many items the fold holds; items are never removed.
    pub fn len(&self) -> usize {
        self.values.len()
    }

    /// True until the fold holds an item.
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }

    /// The `item/delta` text appended to item `id`'s `field` since its latest
    /// revision arrived, or `None` when none has.
    pub fn accumulated(&self, id: &str, field: &str) -> Option<&str> {
        self.deltas.get(id)?.get(field).map(String::as_str)
    }

    pub(crate) fn ids(&self) -> &[String] {
        &self.order
    }
}

impl SessionFold {
    pub(super) fn item(&mut self, method: &str, params: &Map<String, Value>) -> FoldOutcome {
        let Some(item) = params.get("item").and_then(Value::as_object) else {
            return FoldOutcome::Ignored;
        };
        let (Some(id), Some(revision)) = (
            string(item, "itemId"),
            item.get("revision").and_then(Value::as_u64),
        ) else {
            return FoldOutcome::Ignored;
        };
        let value = Value::Object(item.clone());
        let open = method != "item/completed";
        let outcome = match self.items.values.entry(id.to_owned()) {
            Entry::Vacant(slot) => {
                self.items.order.push(id.to_owned());
                slot.insert(StoredItem {
                    revision,
                    value,
                    open,
                });
                ItemOutcome::Inserted
            }
            Entry::Occupied(mut slot)
                if revision > slot.get().revision
                    || (revision == slot.get().revision && !open && slot.get().open) =>
            {
                let from = slot.get().revision;
                slot.insert(StoredItem {
                    revision,
                    value,
                    open,
                });
                ItemOutcome::Replaced { from, to: revision }
            }
            Entry::Occupied(slot) => ItemOutcome::IgnoredStale {
                held: slot.get().revision,
                offered: revision,
            },
        };
        if !matches!(outcome, ItemOutcome::IgnoredStale { .. }) {
            self.items.deltas.remove(id);
        }
        FoldOutcome::Item(outcome)
    }

    pub(super) fn delta(&mut self, params: &Map<String, Value>) -> FoldOutcome {
        let (Some(id), Some(delta)) = (string(params, "itemId"), string(params, "delta")) else {
            return FoldOutcome::Ignored;
        };
        let field = string(params, "field").unwrap_or("text");
        let Some(item) = self.items.values.get_mut(id) else {
            return FoldOutcome::Ignored;
        };
        if !item.open || !append_delta(&mut item.value, field, delta) {
            return FoldOutcome::Ignored;
        }
        self.items
            .deltas
            .entry(id.to_owned())
            .or_default()
            .entry(field.to_owned())
            .or_default()
            .push_str(delta);
        FoldOutcome::Applied
    }
}

fn append_delta(value: &mut Value, field: &str, delta: &str) -> bool {
    let mut segments = field.split('.').peekable();
    let Some(first) = segments.next().filter(|segment| !segment.is_empty()) else {
        return false;
    };
    let Value::Object(root) = value else {
        return false;
    };
    let mut target = match root.get_mut(first) {
        Some(value) => value,
        None if segments.peek().is_none() => {
            root.insert(first.to_owned(), Value::String(delta.to_owned()));
            return true;
        }
        None => return false,
    };
    while let Some(segment) = segments.next() {
        if segment.is_empty() {
            return false;
        }
        let is_last = segments.peek().is_none();
        if let Ok(index) = segment.parse::<usize>() {
            let Value::Array(values) = target else {
                return false;
            };
            if index > values.len() {
                return false;
            }
            if index == values.len() {
                if !is_last {
                    return false;
                }
                values.push(Value::String(delta.to_owned()));
                return true;
            }
            target = &mut values[index];
        } else {
            let Value::Object(object) = target else {
                return false;
            };
            if object.contains_key(segment) {
                target = &mut object[segment];
            } else if is_last {
                object.insert(segment.to_owned(), Value::String(delta.to_owned()));
                return true;
            } else {
                return false;
            }
        }
    }
    match target {
        Value::Null => {
            *target = Value::String(delta.to_owned());
            true
        }
        Value::String(text) => {
            text.push_str(delta);
            true
        }
        _ => false,
    }
}
