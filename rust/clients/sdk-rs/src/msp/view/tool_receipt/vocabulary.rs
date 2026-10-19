// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// Which operation within the family the receipt describes. Open — registered
/// per family, never derived from the tool name.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ToolReceiptOperation {
    /// `cron_create`.
    Create,
    /// `cron_delete`.
    Delete,
    /// `cron_list`.
    List,
    /// `code_exec` and its legacy alias `code.exec`.
    Execute,
    /// `code_wait` and its legacy alias `code.wait`.
    Wait,
    /// A value minted by a newer decision than this build knows. Preserved
    /// verbatim so a client falls back **only for the part it does not
    /// recognize** and can still read the discriminators and family fields it
    /// does understand. Not a value any family registered, so it is excluded
    /// from the generated schema while the enum stays declared open — the
    /// `SessionDurability::Unknown` shape.
    ///
    /// **Never construct this with a registered word.** Decoding never
    /// produces it for one, so `Unknown("create")` does not survive a
    /// round-trip: it re-decodes as the named variant and the two values
    /// compare unequal. Producers build the named variant.
    Unknown(String),
}

/// What the operation did. Open, and a **single shared vocabulary**: a value
/// appearing in two families means the same thing in both, which is why the
/// permitted `status` values are bound to the value here rather than per
/// family.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum ToolReceiptOutcome {
    /// A job was created.
    Created,
    /// The create matched an existing job.
    Duplicate,
    /// A job was deleted.
    Deleted,
    /// The delete matched no job.
    Missing,
    /// The list was served.
    Listed,
    /// The call was refused before it ran — by a human at approval or by the
    /// policy engine with no human in the loop. Bound by the governing rules to
    /// `status` `rejected` or `failed`, never `completed` — the first such
    /// binding, published as v1 contract text by the` amendment.
    Rejected,
    /// The Code Mode cell ran to its own completion; status `completed`.
    Completed,
    /// The Code Mode call returned while its cell was still running; the item
    /// is `completed` — the cell's state, not the call's.
    Pending,
    /// The Code Mode cell or call failed; status `failed`.
    Failed,
    /// The Code Mode cell or wait timed out; status `timedOut`.
    TimedOut,
    /// The Code Mode cell or call was cancelled; status `cancelled`.
    Cancelled,
    /// A value minted by a newer decision than this build knows. Preserved
    /// verbatim so a client falls back **only for the part it does not
    /// recognize** and can still read the discriminators and family fields it
    /// does understand. Not a value any family registered, so it is excluded
    /// from the generated schema while the enum stays declared open — the
    /// `SessionDurability::Unknown` shape.
    ///
    /// **Never construct this with a registered word.** Decoding never
    /// produces it for one, so `Unknown("create")` does not survive a
    /// round-trip: it re-decodes as the named variant and the two values
    /// compare unequal. Producers build the named variant.
    Unknown(String),
}

impl ToolReceiptOperation {
    /// The exact wire spelling, including a value this build does not know.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Create => "create",
            Self::Delete => "delete",
            Self::List => "list",
            Self::Execute => "execute",
            Self::Wait => "wait",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ToolReceiptOperation {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ToolReceiptOperation {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "create" => Self::Create,
            "delete" => Self::Delete,
            "list" => Self::List,
            "execute" => Self::Execute,
            "wait" => Self::Wait,
            _ => Self::Unknown(value),
        })
    }
}

impl ToolReceiptOutcome {
    /// The exact wire spelling, including a value this build does not know.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Created => "created",
            Self::Duplicate => "duplicate",
            Self::Deleted => "deleted",
            Self::Missing => "missing",
            Self::Listed => "listed",
            Self::Rejected => "rejected",
            Self::Completed => "completed",
            Self::Pending => "pending",
            Self::Failed => "failed",
            Self::TimedOut => "timedOut",
            Self::Cancelled => "cancelled",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for ToolReceiptOutcome {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ToolReceiptOutcome {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "created" => Self::Created,
            "duplicate" => Self::Duplicate,
            "deleted" => Self::Deleted,
            "missing" => Self::Missing,
            "listed" => Self::Listed,
            "rejected" => Self::Rejected,
            "completed" => Self::Completed,
            "pending" => Self::Pending,
            "failed" => Self::Failed,
            "timedOut" => Self::TimedOut,
            "cancelled" => Self::Cancelled,
            _ => Self::Unknown(value),
        })
    }
}
