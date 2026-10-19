//! Per-notification param decoding for the session's live wire: one decoder
//! that names the frame it failed on, and the two
//! envelope reads that locate the turn a malformed frame belongs to.

use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::errors::ProtocolError;

/// Decode one notification's params. The decoder's own text (`missing
/// field ...`) does not say which frame failed and the turn error is all a
/// consumer sees, so every failure is named after its `method` (`view/gap`,
/// and the turn and approval frames).
pub(super) fn decode<T: DeserializeOwned>(
    method: &str,
    params: Option<serde_json::Map<String, Value>>,
) -> Result<T, ProtocolError> {
    let malformed =
        |cause: &str| ProtocolError::new(format!("{method} is malformed: {cause}"), None);
    let params = params.ok_or_else(|| malformed("notification params are missing"))?;
    serde_json::from_value(Value::Object(params)).map_err(|error| malformed(&error.to_string()))
}

pub(super) fn turn_id(params: &Option<serde_json::Map<String, Value>>) -> Option<String> {
    params
        .as_ref()
        .and_then(|params| params.get("turnId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

pub(super) fn approval_id(params: &Option<serde_json::Map<String, Value>>) -> Option<String> {
    params
        .as_ref()
        .and_then(|params| params.get("approvalId"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::decode;
    use crate::msp::TurnStartedParams;

    /// The missing-params arm is named like the serde arm; no turn error can
    /// show it (a frame with no `params` names no turn), so it is pinned here.
    #[test]
    fn a_frame_with_no_params_is_named_after_its_method() {
        let error = decode::<TurnStartedParams>("turn/started", None).unwrap_err();
        assert_eq!(
            error.to_string(),
            "turn/started is malformed: notification params are missing"
        );
    }
}
