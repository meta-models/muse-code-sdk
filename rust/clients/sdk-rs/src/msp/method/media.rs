// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// `media/upload` params: one chunk of a client-minted upload. All members
/// required.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaUploadParams {
    /// The session owning the video store.
    pub session_id: String,
    /// One per call. While the host runs, replaying it with the same params
    /// returns the recorded receipt, and reusing it with different params is
    /// refused. After a host restart, start over under a new `uploadId`.
    pub command_id: String,
    /// The client-minted upload id (UUIDv7), sent on every chunk.
    pub upload_id: String,
    /// `video/mp4` or `video/quicktime`, matching `VideoInput`.
    pub media_type: String,
    /// The assembled byte count; must equal the bytes the chunks deliver.
    pub total_bytes: u64,
    /// This chunk's 0-based position.
    pub chunk_index: u64,
    /// The upload's chunk total; positive.
    pub chunk_count: u64,
    /// This chunk's bytes; each call's frame stays in the budget.
    pub chunk_base64: String,
}

/// `media/upload` result: echoes the client-minted id, on every chunk and
/// replay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct MediaUploadResult {
    /// The receipt the turn part references.
    pub upload_id: String,
}
