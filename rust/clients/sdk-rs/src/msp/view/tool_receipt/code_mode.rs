// @generated from the MSP stable schema and protocol sources; do not edit by hand.

use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;

/// The language a Code Mode cell ran in. Open: values are lowercase VS Code
/// language identifiers, and only `javascript` (the V8 engine) is minted today.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CodeModeLanguage {
    /// The V8 engine's language.
    Javascript,
    /// A value minted by a newer decision than this build knows, preserved
    /// verbatim. **Never construct this with a registered word.**
    Unknown(String),
}

/// What a Code Mode output span's bytes are. Open: each engine mints its own
/// values.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum CodeModeOutputStream {
    /// The V8 engine's one interleaved, source-labelled output transcript.
    Transcript,
    /// A value minted by a newer decision than this build knows, preserved
    /// verbatim. **Never construct this with a registered word.**
    Unknown(String),
}

/// One public-output span inside the item's `visibleOutput`.
///
/// Offsets index the UTF-8 encoding of the **decoded** `visibleOutput`
/// string, never the JSON-escaped wire text; both ends fall on code-point
/// boundaries; named and measured like `item/readOutput`'s byte range.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CodeModeOutputSpan {
    /// What the bytes are.
    pub stream: CodeModeOutputStream,
    /// Start of the span, in bytes.
    pub offset_bytes: u64,
    /// Length of the span, in bytes.
    pub length_bytes: u64,
}

/// Code Mode's `details` payload.
///
/// Every member is absent when it does not apply, never `null`; an empty
/// `outputSpans` list is never served.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CodeModeReceipt {
    /// `execute`, and `wait` when the producer resolved the originating
    /// execute: the language the cell ran in.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<CodeModeLanguage>,
    /// `execute` only: the top-level key of the item's `args` object whose
    /// value is the cell source. A pointer, never source bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_arg: Option<String>,
    /// `wait` only, when the producer resolved it: the `itemId` of the
    /// `execute` item that started the cell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cell_item_id: Option<String>,
    /// The public cell-output spans, ascending and non-overlapping; absent
    /// when there is no cell body or a hook rewrote the served body.
    #[serde(default, skip_serializing_if = "spans_absent")]
    pub output_spans: Option<Vec<CodeModeOutputSpan>>,
}

fn spans_absent(spans: &Option<Vec<CodeModeOutputSpan>>) -> bool {
    spans.as_ref().is_none_or(Vec::is_empty)
}

impl CodeModeReceipt {
    /// True when no member would be serialized, so the receipt omits `details`
    /// entirely.
    #[must_use]
    pub fn serializes_empty(&self) -> bool {
        self.language.is_none()
            && self.source_arg.is_none()
            && self.cell_item_id.is_none()
            && spans_absent(&self.output_spans)
    }
}

impl CodeModeLanguage {
    /// The exact wire spelling, including a value this build does not know.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Javascript => "javascript",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for CodeModeLanguage {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CodeModeLanguage {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "javascript" => Self::Javascript,
            _ => Self::Unknown(value),
        })
    }
}

impl CodeModeOutputStream {
    /// The exact wire spelling, including a value this build does not know.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Transcript => "transcript",
            Self::Unknown(value) => value,
        }
    }
}

impl Serialize for CodeModeOutputStream {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for CodeModeOutputStream {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Ok(match value.as_str() {
            "transcript" => Self::Transcript,
            _ => Self::Unknown(value),
        })
    }
}
