// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use crate::msp::error::ErrorObject;
use serde::Deserialize;
use serde::Serialize;

/// A JSON object payload whose member set is method-specific rather than part
/// of the envelope grammar (`params`, `result`). Kept order-preserving-free:
/// `serde_json::Map` is a `BTreeMap` under the workspace's default features, so
/// serialization order is deterministic.
pub type JsonObject = serde_json::Map<String, serde_json::Value>;

/// The literal `"2.0"` every frame carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum JsonRpcVersion {
    /// The only value; a different string is not an MSP frame.
    #[serde(rename = "2.0")]
    V2,
}

/// A request id: client-chosen string or integer. `1` and `"1"` do not compare
/// equal; each direction owns its own id space.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum RequestId {
    /// Integer form; server-initiated requests always use this form, from a
    /// monotonically increasing per-process counter.
    Integer(i64),
    /// String form (client-initiated only).
    String(String),
}

/// Optional W3C trace context, on requests in both directions only — never on
/// responses or notifications.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct TraceContext {
    /// W3C `traceparent` string; receivers that do not trace ignore it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traceparent: Option<String>,
    /// W3C `tracestate` string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracestate: Option<String>,
}

/// A request frame, either direction.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Request {
    /// The literal `"2.0"`.
    pub jsonrpc: JsonRpcVersion,
    /// Client-chosen id, unique among that client's in-flight requests.
    pub id: RequestId,
    /// Slash-namespaced camelCase method name.
    pub method: String,
    /// Method-specific parameters; omitted entirely when empty, never `null`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<JsonObject>,
    /// W3C trace passthrough; requests only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trace: Option<TraceContext>,
}

/// A success response frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct SuccessResponse {
    /// The literal `"2.0"`.
    pub jsonrpc: JsonRpcVersion,
    /// Echo of the request id.
    pub id: RequestId,
    /// Always a JSON object, possibly `{}`, never a bare scalar — so every
    /// result can grow additive-optional members.
    pub result: JsonObject,
}

/// An error response frame. Exactly one of `result` or `error` appears on a
/// response; this type is the `error` half.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ErrorResponse {
    /// The literal `"2.0"`.
    pub jsonrpc: JsonRpcVersion,
    /// Echo of the request id; `null` **only** for an unrecoverable parse error
    /// whose offending id could not be recovered. Always serialized, so `None`
    /// renders as `null` rather than being omitted — required-but-nullable (see
    /// [`require_nullable_id`]).
    pub id: Option<RequestId>,
    /// The error payload.
    pub error: ErrorObject,
}

/// A notification frame, either direction. No `id`; a notification is never
/// answered.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct Notification {
    /// The literal `"2.0"`.
    pub jsonrpc: JsonRpcVersion,
    /// Notification method name.
    pub method: String,
    /// Method-specific parameters; omitted entirely when empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<JsonObject>,
    /// Emission time in Unix milliseconds, recorded once at emission;
    /// server→client notifications only. Optional on the wire so decoders
    /// tolerate older servers.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emitted_at_ms: Option<i64>,
}
