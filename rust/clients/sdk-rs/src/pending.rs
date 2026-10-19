//! Locally pending command bookkeeping.
//!
//! Indexed lookup is expected O(1), ordered insert/retirement is O(log n),
//! and transport death visits each currently pending command once.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap};

use crate::errors::MspError;
use crate::msp::{CommandAcceptedResult, CommandAckStatus, ErrorKind};

/// Whether a call to [`PendingCommandSet::submit`] should reach the transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum Submission {
    /// A new command id and effect.
    New,
    /// The first same-id retry after the transport died.
    Retry,
    /// The command is already pending and no retry is due.
    Duplicate,
    /// The command id is already bound to different input.
    Conflict,
}

/// A fact that retired a pending entry.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum PendingSettlement<I> {
    /// The server acknowledged the command.
    Acknowledged {
        /// The command's id.
        command_id: String,
        /// The input the command was submitted with.
        input: I,
        /// The acknowledgement status the server returned.
        status: CommandAckStatus,
    },
    /// The server durably rejected the command (`commandRejected`).
    Refused {
        /// The command's id.
        command_id: String,
        /// The input the command was submitted with.
        input: I,
        /// The server's reason, when it gave one.
        reason: Option<String>,
    },
    /// Local cancellation or drop won before a server terminal was observed.
    Discarded {
        /// The command's id.
        command_id: String,
        /// The input the command was submitted with.
        input: I,
    },
}

/// An immutable view of one pending command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingCommand<I> {
    command_id: String,
    input: I,
    submission_index: u64,
    retry_ready: bool,
}

impl<I> PendingCommand<I> {
    /// The command's id.
    #[must_use]
    pub fn command_id(&self) -> &str {
        &self.command_id
    }

    /// The input the command was first submitted with.
    #[must_use]
    pub const fn input(&self) -> &I {
        &self.input
    }

    /// The command's submission number in this set: counted up from 0 and
    /// never reused, so it orders commands by first submission.
    #[must_use]
    pub const fn submission_index(&self) -> u64 {
        self.submission_index
    }

    /// Whether the transport died since the last send, so the next identical
    /// [`PendingCommandSet::submit`] is a [`Submission::Retry`].
    #[must_use]
    pub const fn retry_ready(&self) -> bool {
        self.retry_ready
    }
}

/// Client-local commands that have no server-authored settlement yet.
#[derive(Debug)]
pub struct PendingCommandSet<I> {
    entries: HashMap<String, PendingCommand<I>>,
    order: BTreeMap<u64, String>,
    next_submission_index: u64,
}

impl<I> Default for PendingCommandSet<I> {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            order: BTreeMap::new(),
            next_submission_index: 0,
        }
    }
}

impl<I> PendingCommandSet<I> {
    /// An empty set.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The pending command with this id, if any.
    #[must_use]
    pub fn get(&self, command_id: &str) -> Option<&PendingCommand<I>> {
        self.entries.get(command_id)
    }

    /// How many commands are pending.
    #[must_use]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether no command is pending.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Pending entries in first-submission order.
    pub fn iter(&self) -> impl Iterator<Item = &PendingCommand<I>> {
        self.order
            .values()
            .filter_map(|command_id| self.entries.get(command_id))
    }

    /// An ACK is a server-authored settlement and retires the matching entry.
    pub fn acknowledge(&mut self, ack: &CommandAcceptedResult) -> Option<PendingSettlement<I>> {
        let entry = self.take(&ack.command_id)?;
        Some(PendingSettlement::Acknowledged {
            command_id: entry.command_id,
            input: entry.input,
            status: ack.status,
        })
    }

    /// A durable `commandRejected` retires the exact command named in data.
    /// Takes the `MspError` callers hold: the copy's `ErrorObject` is
    /// `#[non_exhaustive]` and never reaches them.
    pub fn refuse(&mut self, error: &MspError) -> Option<PendingSettlement<I>> {
        let data = error.data();
        if data.kind != ErrorKind::CommandRejected {
            return None;
        }
        let command_id = data.command_id.as_deref()?;
        let entry = self.take(command_id)?;
        Some(PendingSettlement::Refused {
            command_id: entry.command_id,
            input: entry.input,
            reason: data.reason.clone(),
        })
    }

    /// Local cancellation or drop settles and retires the matching command.
    pub fn discard(&mut self, command_id: &str) -> Option<PendingSettlement<I>> {
        let entry = self.take(command_id)?;
        Some(PendingSettlement::Discarded {
            command_id: entry.command_id,
            input: entry.input,
        })
    }

    /// A server turn terminal retires pending intent without inventing a
    /// second pending-layer outcome.
    pub fn retire_server_terminal(&mut self, command_id: &str) -> bool {
        self.take(command_id).is_some()
    }

    /// Transport death is not a durable outcome: retain every entry and make
    /// exactly one same-id retry eligible on the next connection.
    pub fn transport_died(&mut self) {
        for entry in self.entries.values_mut() {
            entry.retry_ready = true;
        }
    }

    fn take(&mut self, command_id: &str) -> Option<PendingCommand<I>> {
        let entry = self.entries.remove(command_id)?;
        self.order.remove(&entry.submission_index);
        Some(entry)
    }
}

impl<I: PartialEq> PendingCommandSet<I> {
    /// Register a transport submission.
    ///
    /// An existing id never inserts a second entry. After transport death the
    /// first identical call returns [`Submission::Retry`]; another call is a
    /// duplicate until a later death makes one new retry eligible.
    pub fn submit(&mut self, command_id: impl Into<String>, input: I) -> Submission {
        let command_id = command_id.into();
        match self.entries.entry(command_id.clone()) {
            Entry::Vacant(slot) => {
                let submission_index = self.next_submission_index;
                slot.insert(PendingCommand {
                    command_id: command_id.clone(),
                    input,
                    submission_index,
                    retry_ready: false,
                });
                self.next_submission_index += 1;
                self.order.insert(submission_index, command_id);
                Submission::New
            }
            Entry::Occupied(slot) if slot.get().input != input => Submission::Conflict,
            Entry::Occupied(mut slot) if slot.get().retry_ready => {
                slot.get_mut().retry_ready = false;
                Submission::Retry
            }
            Entry::Occupied(_) => Submission::Duplicate,
        }
    }
}
