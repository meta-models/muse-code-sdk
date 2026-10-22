// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::method::session::Session;
use serde::Deserialize;
use serde::Serialize;

/// `session/list` params. Read-only; never touches leases.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListParams {
    /// Opaque page cursor from a prior result. Page cursors are a distinct
    /// opaque-string family from view cursors and stream cursors, valid only
    /// for re-issuing the same listing. Omitted and explicit `null` both mean
    /// "first page".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// Page size; default 50, max 200 — the schema publishes the cap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    /// Only sessions whose metadata workspace root equals this path.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_root: Option<String>,
    /// Only sessions with log activity after this RFC3339 instant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_after: Option<String>,
    /// Optional structured selection applied inside the bounded index query
    /// before paging. Present — including `{}` — makes a supporting server echo
    /// its canonical form as `appliedFilter`; omitted keeps the earlier
    /// behavior.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<SessionListFilter>,
}

/// `session/list` result. Ordering is `updatedAt` descending.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SessionListResult {
    /// The page of stored sessions.
    pub sessions: Vec<Session>,
    /// The next page's cursor; `null` on the last page.
    pub next_cursor: Option<String>,
    /// The canonical filter the server applied, present exactly when the
    /// request carried `filter`. The probe is per-predicate PRESENCE: a client
    /// that requires filtering checks that every predicate it sent comes back
    /// as a member here, and treats a missing member as unsupported. Value
    /// equality is the wrong test — canonicalization trims, lowercases,
    /// NFC-normalizes, dedupes and sorts, so the echoed values often differ
    /// from the sent ones on a correctly filtered page.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_filter: Option<SessionListFilter>,
}

/// The `session/list` filter. Members are ANDed with each other and with the
/// top-level `workspaceRoot` and `updatedAfter`; values inside each `anyOf` are
/// ORed. The canonical form the server echoes deduplicates and sorts every set,
/// spells session IDs as canonical UUIDs, lowercases text terms, and orders
/// `text.fields` `name` then `title`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListFilter {
    /// Only sessions whose ID is one of these.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<SessionListSessionIdFilter>,
    /// Only sessions whose branch is one of these.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<SessionListBranchFilter>,
    /// Only sessions whose served name or title matches these token prefixes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<SessionListTextFilter>,
}

/// Exact session-ID selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListSessionIdFilter {
    /// 1–200 session UUIDs, counted before deduplication.
    pub any_of: Vec<String>,
}

/// Exact branch selection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListBranchFilter {
    /// 1–32 nonempty branch names, each 1–256 UTF-8 bytes, counted before
    /// deduplication; `null` selects sessions with no branch.
    pub any_of: Vec<Option<String>>,
}

/// Name/title token-prefix search. Each term is trimmed, lowercased with
/// ordinary Unicode lowercase, then NFC- normalized, and matches the beginning
/// of an alphanumeric token, accent-sensitively (`check` matches `Checkout`;
/// `eck` does not). NFC means a decomposed and a precomposed spelling of one
/// term are the same term, and the echo returns the composed form. Matching
/// never reorders rows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListTextFilter {
    /// The 1–2 unique served fields searched.
    pub fields: Vec<SessionListTextField>,
    /// Every term must match at least one selected field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub all_of: Option<Vec<String>>,
    /// At least one term must match a selected field. `allOf` plus `anyOf`
    /// carry 1–16 terms in total, each 1–128 UTF-8 bytes in its canonical
    /// form (trimmed, lowercased, NFC) — the bytes `appliedFilter` echoes.
    /// Lowercasing and NFC can both lengthen a term, so a term inside the
    /// bound raw may still exceed it canonically.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub any_of: Option<Vec<String>>,
}

/// A served session field `session/list` text search reads. The client selects
/// it, so the set is closed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SessionListTextField {
    /// The session's current served `name`.
    Name,
    /// The session's current served `title`.
    Title,
}
