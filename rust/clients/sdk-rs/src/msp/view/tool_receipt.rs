// @generated from the MSP stable schema and protocol sources; do not edit by hand.

pub use code_mode::CodeModeReceipt;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;
pub use vocabulary::ToolReceiptOperation;
pub use vocabulary::ToolReceiptOutcome;

pub(crate) mod code_mode;
pub(crate) mod vocabulary;

/// One row of the Cron `list` receipt's `jobs` array.
///
/// Server order, and **`active` + `firing` rows only** — the owner's `Serve
/// active+firing only` directive. A small fixed-shape array of scalars, which
/// is what keeps it inside the governing rules bounded-machine-fact rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CronReceiptJob {
    /// The job's server-owned id.
    pub job_id: String,
    /// Absolute epoch-milliseconds of the job's next scheduled fire.
    pub next_fire_at_ms: i64,
}

/// Cron's `details` payload.
///
/// Every field a family owns lives here, under the container's one `details`
/// key, rather than flat beside the discriminators — the governing rules as
/// amended. Each is a **bounded machine fact**: scalars, short identifiers and
/// a small fixed-shape array of those.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct CronReceipt {
    /// Cron `create` and `delete`: the job id. On `delete`'s `missing` arm this
    /// is the caller's own id echoed back under the governing rules declared
    /// echo — that arm has no server-side subject to name.
    ///
    /// Also the field governing rules declaration names as conveying the hidden
    /// fact on the declared `created` + `cancelled` pairing: a job row was
    /// committed and will fire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    /// Cron `create` (`created`, `duplicate`): absolute epoch-milliseconds of
    /// the job's next scheduled fire.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_fire_at_ms: Option<i64>,
    /// Cron `list`: the served jobs in server order, `active` and `firing`
    /// rows only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub jobs: Option<Vec<CronReceiptJob>>,
}

/// The family-selected body of a receipt: the `family` discriminator and the
/// one `details` object whose shape that discriminator chooses.
///
/// Adjacently tagged in spirit — `tag = "family"`, `content = "details"` — but
/// written by hand rather than derived, for one reason: serde's
/// `#[serde(other)]` fallback admits only a **unit** variant, which would
/// discard both the unrecognized family word and its `details`. the governing
/// rules openness requires the opposite: an unknown value is preserved verbatim
/// so a client falls back only for the part it does not recognize. The
/// `Unknown` arm therefore keeps both.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub enum ToolReceiptBody {
    /// `family: "cron"`.
    Cron(CronReceipt),
    /// `family: "codeMode"`.
    CodeMode(CodeModeReceipt),
    /// A family minted by a newer decision than this build knows. Both the
    /// word and its `details` are kept exactly as served; nothing about the
    /// payload is assumed, because only the owning family's decision defines
    /// it.
    ///
    /// **Never construct this with a registered word.** A producer serving cron
    /// builds [`Self::Cron`]; `Unknown { family: "cron",.. }` encodes to the
    /// same wire bytes but does **not** survive a round-trip — decoding selects
    /// the typed arm, so a payload outside `CronReceipt`'s members is silently
    /// dropped. The arm exists only to carry words from newer builds, and
    /// decoding never produces it for a word this build knows.
    Unknown {
        /// The family word, verbatim.
        family: String,
        /// Whatever that family put under `details`, if anything. A family
        /// with no fields omits the key.
        ///
        /// A `Map`, not a `Value`: the schema's open arm types `details` as
        /// an object, so accepting `[1]` or `null` here would let this type
        /// re-encode a frame the published bundle calls invalid. A
        /// non-object fails at decode instead.
        details: Option<serde_json::Map<String, serde_json::Value>>,
    },
}

/// The shared `toolReceipt` container.
///
/// `family`, `operation` and `outcome` are required together and sit at the
/// top level; `body` is flattened, so `family` and `details` are emitted
/// beside the other two rather than nested.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[non_exhaustive]
pub struct ToolReceipt {
    /// Which operation it describes. Required with the other two.
    pub operation: ToolReceiptOperation,
    /// What the operation did. Required with the other two.
    pub outcome: ToolReceiptOutcome,
    /// The `family` discriminator and its `details` payload.
    #[serde(flatten)]
    pub body: ToolReceiptBody,
}

impl Serialize for ToolReceiptBody {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            Self::Cron(cron) => {
                let empty = cron == &CronReceipt::default();
                let mut map = serializer.serialize_map(Some(1 + usize::from(!empty)))?;
                map.serialize_entry("family", "cron")?;
                if !empty {
                    map.serialize_entry("details", cron)?;
                }
                map.end()
            }
            Self::CodeMode(code_mode) => {
                let empty = code_mode.serializes_empty();
                let mut map = serializer.serialize_map(Some(1 + usize::from(!empty)))?;
                map.serialize_entry("family", "codeMode")?;
                if !empty {
                    map.serialize_entry("details", code_mode)?;
                }
                map.end()
            }
            Self::Unknown { family, details } => {
                let mut map = serializer.serialize_map(Some(1 + usize::from(details.is_some())))?;
                map.serialize_entry("family", family)?;
                if let Some(details) = details {
                    map.serialize_entry("details", details)?;
                }
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for ToolReceiptBody {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct BodyVisitor;

        impl<'de> serde::de::Visitor<'de> for BodyVisitor {
            type Value = ToolReceiptBody;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("a toolReceipt body with a `family` discriminator")
            }

            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Self::Value, M::Error> {
                let mut family: Option<String> = None;
                let mut details: Option<serde_json::Map<String, serde_json::Value>> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "family" => {
                            if family.is_some() {
                                return Err(serde::de::Error::duplicate_field("family"));
                            }
                            family = Some(map.next_value()?);
                        }
                        "details" => {
                            if details.is_some() {
                                return Err(serde::de::Error::duplicate_field("details"));
                            }
                            details = Some(map.next_value()?);
                        }
                        _ => {
                            let _ = map.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                let family = family.ok_or_else(|| serde::de::Error::missing_field("family"))?;
                if family == "cron" {
                    let cron = match details {
                        Some(value) => serde_json::from_value(serde_json::Value::Object(value))
                            .map_err(serde::de::Error::custom)?,
                        None => CronReceipt::default(),
                    };
                    return Ok(ToolReceiptBody::Cron(cron));
                }
                if family == "codeMode" {
                    let code_mode = match details {
                        Some(value) => serde_json::from_value(serde_json::Value::Object(value))
                            .map_err(serde::de::Error::custom)?,
                        None => CodeModeReceipt::default(),
                    };
                    return Ok(ToolReceiptBody::CodeMode(code_mode));
                }
                Ok(ToolReceiptBody::Unknown { family, details })
            }
        }

        deserializer.deserialize_map(BodyVisitor)
    }
}
