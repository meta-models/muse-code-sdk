// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Serialize;

/// One ordered content part of a turn submission. File mentions are text, not a
/// part type: write `@relative/path` in a text part. A structured `mention`
/// part is reserved and currently rejected, and an unknown part type is
/// `invalidParams` — which is what closes [`TurnInputPartType`].
///
/// Modelled as a discriminated flat object rather than a Rust `enum`, the
/// convention [`crate::msp::view::approval::ApprovalSubject`] already established
/// for a wire union in this crate: the v1 schema model names no
/// object-variant union shape and fails closed on one. The serialized JSON is
/// the same either way; what a flat object cannot express is "`mediaType` is
/// required exactly when `type` is `image`".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnInputPart {
    /// The part type.
    #[serde(rename = "type")]
    pub part_type: TurnInputPartType,
    /// User prompt text, on a `text` part. Multiple text parts are joined in
    /// order into the turn's prompt.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Media type, required on an `image` part.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
    /// Base64 payload, required on an `image` part. Invalid base64 or an
    /// empty payload is rejected with invalid params.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64_data: Option<String>,
    /// Pixel width; must be provided together with `height` or not at all.
    /// Published as a `dependentRequired` pair.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u64>,
    /// Pixel height; must be provided together with `width` or not at all.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    /// The skill to invoke, required on a `skill` part: a bare or
    /// plugin-qualified shortcut token from `skill/list`. The HOST resolves and
    /// expands; an unknown selector is the typed `-32032 skillNotFound` request
    /// error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selector: Option<String>,
    /// Free-text skill arguments, optional on a `skill` part — the wire twin of
    /// what the TUI accepts after the shortcut token.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<String>,
    /// The picked copy's source, optional on a `skill` part: one of the catalog
    /// rows' `source` values. When present the host resolves the exact
    /// `(selector, source)` row; when absent it resolves the selector, bare or
    /// plugin-qualified, against the session's skill catalog, as the TUI
    /// shortcut does. Closed: an unknown value is `invalidParams`, never a
    /// fall-through.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<crate::msp::method::skill::SkillInvocationSource>,
    /// The upload receipt, required on a `video` part: the client-minted id
    /// `media/upload` echoed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    /// The client's own name for this image, optional on an `image` part: `{
    /// "name" }`, 1 to 256 bytes of UTF-8 with no character restriction; an
    /// empty or longer name is invalid params. Other part types ignore it.
    /// Returned verbatim in `session/resume.unavailableInputAssets` and the
    /// lost-image marker once the host records it. **Experimental**
    /// (`TurnInputPart.clientRef`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_ref: Option<crate::msp::method::lifecycle::ClientRef>,
}

/// The `type` discriminator of a turn input part. Closed: an unknown part type
/// is `invalidParams`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TurnInputPartType {
    /// A user prompt text part.
    Text,
    /// An inline image part, the runtime's native image intake shape. Inline
    /// base64 lives inside the frame cap, so an oversized submit fails
    /// `inputTooLarge` and must be shrunk client-side.
    Image,
    /// An explicit skill invocation the host expands. `turn/start` only; at
    /// most one per submission, combinable only with `image` and `video` parts.
    Skill,
    /// A video attachment by reference. The part carries the `uploadId` receipt
    /// only; the host joins metadata from the stored upload. An unknown or
    /// expired id fails the whole request `-32038 uploadNotFound`.
    Video,
}
