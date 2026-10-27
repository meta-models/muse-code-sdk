// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::view::SourceRange;
use serde::Deserialize;
use serde::Serialize;

/// `view/subscribe` params: attach this connection's live view subscription for
/// a session at an explicit cursor — the fine-grained counterpart of the
/// auto-subscribe, and the gap-free re-attachment path after
/// `view/unsubscribe`. It never loads a session, takes no lease, writes
/// nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewSubscribeParams {
    /// The session to follow.
    pub session_id: String,
    /// Resume cursor. When present, the server replays `(after, head]` as
    /// ordinary view notifications before any live event — one gapless cursor
    /// sequence. Omitted means "from now": no historical replay.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<String>,
}

/// `view/subscribe` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ViewSubscribeResult {
    /// The view head at subscribe time; the client knows it is live once
    /// cursors pass it.
    pub view_cursor: String,
}

/// `view/unsubscribe` params: remove this connection from the session's view
/// subscription set — the protocol's single unsubscribe operation, at the
/// altitude that owns subscriptions. It does not unload the session; unloading
/// is the idle policy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewUnsubscribeParams {
    /// The session to stop following.
    pub session_id: String,
}

/// `view/unsubscribe` result: the empty object. Idempotent — unsubscribing
/// while not subscribed returns `{}`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ViewUnsubscribeResult {}

/// `view/page` params: cursor-paged reads of the session view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPageParams {
    /// The session to page.
    pub session_id: String,
    /// The exclusive anchor. Forward: the page starts strictly after it;
    /// omitted means from the beginning of the view. Backward: the page ends
    /// strictly before it; omitted means from the head. Mutually exclusive with
    /// `anchor`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    /// The cold-client request mode, resolved at call time to the latest
    /// installed compaction boundary. The one named exception to the
    /// observed-only rule.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<ViewPageAnchor>,
    /// Paging direction; `forward` when omitted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<ViewPageDirection>,
    /// Maximum events to return, 1–1000. The server MAY return fewer.
    ///
    /// The 1–1000 range is ratified and **published**: the model carries the
    /// bound and the bundle renders `minimum`/`maximum` instead of a bare
    /// `integer`.
    pub limit: u32,
    /// The caller's page byte cap (kt-dvw5, additive-optional). The page
    /// serves under `min(server budget, maxBytes)`, so a Console page stays
    /// under its own budget without the server's frame cap alone deciding.
    /// Absent means the server budget governs. `0` is refused typed
    /// (`invalid_params`): a 0 cap admits no progress. A single event over
    /// the cap is truncated (marked) instead of erroring, except verbatim
    /// and fetch-key content (`item.args`, `structuredData`, `outputRef`/
    /// `patchRef`), which is never cut and still answers typed
    /// `PageEventTooLarge`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_bytes: Option<u64>,
}

/// The `view/page` request-mode anchor. Declared **open**: the protocol spells
/// it "open string enum, v1 value `latestCompaction`".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub enum ViewPageAnchor {
    /// Anchor at the latest installed compaction boundary.
    LatestCompaction,
}

/// The `view/page` paging direction. Closed: the protocol spells exactly two
/// values and a third would change the paging contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewPageDirection {
    /// The page starts strictly after `cursor`.
    Forward,
    /// The page ends strictly before `cursor`.
    Backward,
}

/// `item/readOutput` params: byte-ranged fetch of stored full output that the
/// view truncated, via the item's `outputRef`. Read-only; works on loaded and
/// unloaded sessions; no lease.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemReadOutputParams {
    /// The session the item belongs to.
    pub session_id: String,
    /// The item whose stored output is fetched.
    pub item_id: String,
    /// The `outputRef.id` from the item (never the `uri`; the uri is
    /// display/provenance).
    pub output_ref: String,
    /// STORED-byte offset to start from; 0 when omitted. STORED bytes are a
    /// property of the output, not of a transport.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub offset_bytes: Option<u64>,
    /// STORED bytes requested; default and max 6 MiB. A value above the max is
    /// served at the max.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_bytes: Option<u64>,
}

/// The `item/readOutput` content encoding. Closed: text media is ALWAYS `utf8`
/// and binary media `base64`; a third value would change the client's decode
/// contract.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemReadOutputEncoding {
    /// Text: `content` is the decoded string; ranges never split a UTF-8
    /// sequence (the served end shrinks to the previous boundary).
    Utf8,
    /// Binary media: `content` is base64 of the stored range.
    Base64,
}

/// `item/readOutput` result: one stored-byte page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ItemReadOutputResult {
    /// The served range, decoded per `encoding`.
    pub content: String,
    /// How `content` encodes the stored bytes.
    pub encoding: ItemReadOutputEncoding,
    /// STORED bytes served in THIS response (not the output's total; that is
    /// `outputRef.byteLen` on the item). The next page's `offsetBytes` is
    /// `offsetBytes + byteLen` — short-serving and advancing are separate, so
    /// paging never skips or double-reads a byte.
    pub byte_len: u64,
    /// The STORED-byte offset this response actually served from.
    pub offset_bytes: u64,
    /// `true` when this range reached the end of the stored output.
    pub eof: bool,
    /// The stored output's media type (e.g. `text/plain`).
    pub media_type: String,
}

/// One element of a `view/page` result's `events` array: an **unframed view
/// notification** — the nested pair `{"method", "params"}`, which is the live
/// notification minus `jsonrpc` and `emittedAtMs`, with nothing lifted out of
/// `params` and nothing spliced into it. `view/page` and `muse exec --json`
/// share this one definition, so the two surfaces cannot drift.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UnframedViewNotification {
    /// The event type — the live notification's method name, retained because
    /// the type lives only in the notification name and would otherwise be
    /// lost.
    pub method: String,
    /// The notification's params object, verbatim.
    pub params: UnframedViewNotificationParams,
}

/// The `params` of an unframed view notification.
///
/// Declares the base members every view notification carries, and stays
/// **open** for the event-specific fields each event type adds. The v1 schema
/// model names no method-correlated union (the `events` element's `params` arm
/// is selected by its sibling `method`), so the per-event arms cannot be
/// expressed here without one, and an uncorrelated union of them could reject a
/// real page element, which a published schema must not do.
///
/// `sourceRange` is required here and not optional: `view/page` serves
/// durable-sourced events only, and durable-sourced is *defined* as carrying a
/// `sourceRange` — the ephemeral-sourced exemption applies to `item/delta`,
/// which `view/page` never replays.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct UnframedViewNotificationParams {
    /// The owning session.
    pub session_id: String,
    /// The event's opaque, strictly monotonic view cursor. It stays **inside**
    /// `params`, where every live notification already carries it — nothing is
    /// spliced beside `method`.
    pub view_cursor: String,
    /// The durable records this event folded from.
    pub source_range: SourceRange,
}

/// `view/page` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ViewPageResult {
    /// The page's events, always ascending by `viewCursor` in both
    /// directions. Durable-sourced only; pages are contiguous and can never
    /// skip a cursor.
    pub events: Vec<UnframedViewNotification>,
    /// The anchor for the next page in the same direction: forward, the last
    /// event's cursor; backward, the first's. `null` at the end of the view
    /// in that direction — never omitted.
    pub next_cursor: Option<String>,
    /// The resolution echo, present exactly when the request used `anchor`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_anchor: Option<ViewPageResolvedAnchor>,
}

/// The `resolvedAnchor` echo: subsequent pages pass ordinary cursors, so the
/// anchor never needs re-resolving.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ViewPageResolvedAnchor {
    /// The view cursor of the resolved boundary's `compaction` event.
    pub boundary_cursor: String,
}
