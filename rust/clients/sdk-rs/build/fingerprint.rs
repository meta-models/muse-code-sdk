//! The MSP bundle fingerprint, ported from the canonical host implementation.
//!
//! Both the crate's build script and the vector test include this file
//! (`#[path]`), so it is dependency-only: it names no item outside itself
//! plus `serde`/`serde_json`/`sha2`, and it holds no `fn main`.
//!
//! The algorithm is a line-for-line port of the canonical one (same strip,
//! same normalization, same preimage struct and field order, same domain
//! tag), and the shared vector fixture proves the two agree. Any
//! intentional divergence must update the port, the canonical
//! implementation, and the vectors together.

use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// Domain separator: this digest fingerprints an MSP schema bundle and
/// nothing else (canonical `FINGERPRINT_DOMAIN`).
const FINGERPRINT_DOMAIN: &str = "muse.msp.schema-bundle";

/// Version of the normalization algorithm (canonical
/// `NORMALIZATION_VERSION`).
const NORMALIZATION_VERSION: u16 = 1;

/// The canonical stability key, restated: this file cannot see the
/// protocol crate (the published SDK depends on nothing in the producing
/// tree), so the key is a contract string, pinned by the vector suite.
const STABILITY_KEY: &str = "x-msp-stability";

/// Canonical `OPENNESS_KEY`, restated for the same reason.
const OPENNESS_KEY: &str = "x-msp-openness";

/// The typed, closed preimage. Field order is part of the digest contract.
#[derive(Serialize)]
struct FingerprintMaterialV1<'a> {
    normalization_version: u16,
    domain: &'static str,
    experimental: bool,
    document: &'a Value,
}

/// Which bundle surface to fingerprint.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
// The build target derives stable only; the vector suite constructs both.
#[allow(dead_code)]
pub enum BundleVariant {
    /// Strip experimental-marked surface first; this is the value the SDK
    /// derives at build time.
    Stable,
    /// Hash the full surface, stripped of nothing.
    Experimental,
}

impl BundleVariant {
    fn is_experimental(self) -> bool {
        matches!(self, Self::Experimental)
    }
}

/// A fingerprint input the algorithm refuses (fail closed, never a default
/// digest).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FingerprintError {
    /// The document bytes are not valid JSON.
    UnparseableDocument {
        /// Parser detail.
        detail: String,
    },
    /// Stripping experimental surface left a reference to a removed type,
    /// so the stable document is broken and is refused rather than hashed.
    DanglingReference {
        /// The removed `$defs` name still referenced.
        target: String,
    },
    /// Stripping experimental surface emptied an enum's `oneOf`, leaving a
    /// branch no value can satisfy.
    EmptiedEnum {
        /// The `$defs` entry left with no branches.
        owner: String,
    },
    /// The preimage could not be encoded.
    UnencodablePreimage {
        /// Encoder detail.
        detail: String,
    },
}

impl std::fmt::Display for FingerprintError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnparseableDocument { detail } => {
                write!(
                    f,
                    "bundle document is not valid JSON, refusing to fingerprint: {detail}"
                )
            }
            Self::UnencodablePreimage { detail } => {
                write!(f, "fingerprint preimage could not be encoded: {detail}")
            }
            Self::EmptiedEnum { owner } => write!(
                f,
                "refusing to fingerprint: stripping experimental surface left \
                 `{owner}` with an empty `oneOf`, which no value can satisfy"
            ),
            Self::DanglingReference { target } => write!(
                f,
                "refusing to fingerprint: stripping experimental surface left a \
                 reference to `{target}`, which the stable document no longer \
                 defines"
            ),
        }
    }
}

impl std::error::Error for FingerprintError {}

/// The stable-surface fingerprint of schema bytes: parse, strip
/// experimental-marked surface, normalize, hash.
///
/// # Errors
///
/// Fails closed on unparseable, dangling, emptied, or unencodable input
/// ([`FingerprintError`]).
pub fn stable_fingerprint_of_bundle_bytes(bytes: &[u8]) -> Result<String, FingerprintError> {
    bundle_fingerprint(BundleVariant::Stable, bytes)
}

/// The build script's `rerun-if-changed` watch set for the schema inputs.
///
/// Only existing paths are watched: Cargo treats a watched path that does
/// not exist as permanently stale and rebuilds on every invocation, which
/// trips the test-rest archive's no-recompile guard. When the vendored
/// release bytes are absent, the `build/` directory is watched instead,
/// so vendoring them later still reruns the build rather than serving a
/// stale digest.
pub fn rerun_watch_paths(vendored: &Path, live: &Path, build_dir: &Path) -> Vec<PathBuf> {
    let mut watched = Vec::with_capacity(2);
    if vendored.is_file() {
        watched.push(vendored.to_path_buf());
    } else {
        watched.push(build_dir.to_path_buf());
    }
    if live.is_file() {
        watched.push(live.to_path_buf());
    }
    watched
}

/// A bundle's own fingerprint. The stable variant strips
/// experimental-marked surface first; the experimental variant hashes the
/// full surface.
///
/// # Errors
///
/// Fails closed on unparseable, dangling, emptied, or unencodable input
/// ([`FingerprintError`]).
pub fn bundle_fingerprint(
    variant: BundleVariant,
    bytes: &[u8],
) -> Result<String, FingerprintError> {
    let mut document: Value =
        serde_json::from_slice(bytes).map_err(|error| FingerprintError::UnparseableDocument {
            detail: error.to_string(),
        })?;
    if !variant.is_experimental() {
        let removed = strip_experimental_surface(&mut document);
        if let Some(target) = first_dangling_reference(&document, &removed) {
            return Err(FingerprintError::DanglingReference { target });
        }
        if let Some(owner) = first_emptied_enum(&document) {
            return Err(FingerprintError::EmptiedEnum { owner });
        }
    }
    let document = sorted_value(&document);
    let material = FingerprintMaterialV1 {
        normalization_version: NORMALIZATION_VERSION,
        domain: FINGERPRINT_DOMAIN,
        experimental: variant.is_experimental(),
        document: &document,
    };
    let encoded =
        serde_json::to_vec(&material).map_err(|error| FingerprintError::UnencodablePreimage {
            detail: error.to_string(),
        })?;
    Ok(render_sha256(&Sha256::digest(&encoded)))
}

/// `sha256:<64 lower hex>`.
fn render_sha256(digest: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut rendered = String::with_capacity(7 + digest.len() * 2);
    rendered.push_str("sha256:");
    for byte in digest {
        let _ = write!(rendered, "{byte:02x}");
    }
    rendered
}

/// Is this JSON value an experimental-marked schema element?
fn is_experimental(value: &Value) -> bool {
    value.get(STABILITY_KEY).and_then(Value::as_str) == Some("experimental")
}

/// Remove every experimental-marked element, then collapse lone surviving
/// enum branches the way the model-level renderer emits them. Returns the
/// `$defs` names it removed, so the caller can reject a surviving reference
/// to one.
fn strip_experimental_surface(value: &mut Value) -> BTreeSet<String> {
    let removed = removed_definition_names(value);
    remove_experimental_elements(value);
    collapse_single_branch_enums(value);
    removed
}

/// The `$defs` entries an experimental strip will delete.
fn removed_definition_names(value: &Value) -> BTreeSet<String> {
    value
        .get("$defs")
        .and_then(Value::as_object)
        .map(|defs| {
            defs.iter()
                .filter(|(_, node)| is_experimental(node))
                .map(|(name, _)| name.clone())
                .collect()
        })
        .unwrap_or_default()
}

/// The first `#/$defs/<name>` reference in `value` naming a removed type.
fn first_dangling_reference(value: &Value, removed: &BTreeSet<String>) -> Option<String> {
    if removed.is_empty() {
        return None;
    }
    match value {
        Value::Object(map) => {
            if let Some(target) = map
                .get("$ref")
                .and_then(Value::as_str)
                .and_then(|reference| reference.strip_prefix("#/$defs/"))
                && removed.contains(target)
            {
                return Some(target.to_owned());
            }
            map.values()
                .find_map(|member| first_dangling_reference(member, removed))
        }
        Value::Array(items) => items
            .iter()
            .find_map(|item| first_dangling_reference(item, removed)),
        _ => None,
    }
}

/// The removal half of [`strip_experimental_surface`].
fn remove_experimental_elements(value: &mut Value) {
    match value {
        Value::Object(map) => {
            let mut removed_properties: Vec<String> = Vec::new();
            for (key, member) in map.iter_mut() {
                match member {
                    Value::Object(children) => {
                        if key == "properties" {
                            removed_properties.extend(
                                children
                                    .iter()
                                    .filter(|(_, child)| is_experimental(child))
                                    .map(|(name, _)| name.clone()),
                            );
                        }
                        children.retain(|_, child| !is_experimental(child));
                    }
                    Value::Array(items) => items.retain(|item| !is_experimental(item)),
                    _ => {}
                }
            }
            if !removed_properties.is_empty()
                && let Some(Value::Array(required)) = map.get_mut("required")
            {
                required.retain(|entry| {
                    entry
                        .as_str()
                        .is_none_or(|name| !removed_properties.iter().any(|gone| gone == name))
                });
                // An emptied list is DROPPED, not left as `[]`: the
                // model-level renderer omits `required` entirely when nothing
                // is required, so keeping the empty array here would hash a
                // different document for the same stable surface.
                if required.is_empty() {
                    map.remove("required");
                }
            }
            for (_, member) in map.iter_mut() {
                remove_experimental_elements(member);
            }
        }
        Value::Array(items) => {
            items.retain(|item| !is_experimental(item));
            for item in items {
                remove_experimental_elements(item);
            }
        }
        _ => {}
    }
}

/// Collapse an enum node whose `oneOf` has exactly ONE surviving branch back
/// to the flat `type`/`enum` form the model-level renderer emits when no
/// variant is experimental. The branch's own openness key is dropped — the
/// container already carries the declaration, and the flat form has only one
/// place for it.
fn collapse_single_branch_enums(value: &mut Value) {
    match value {
        Value::Object(map) => {
            if let Some(collapsed) = lone_string_enum_branch(map) {
                map.remove("oneOf");
                for (key, entry) in collapsed {
                    map.insert(key, entry);
                }
            }
            for (_, member) in map.iter_mut() {
                collapse_single_branch_enums(member);
            }
        }
        Value::Array(items) => {
            for item in items {
                collapse_single_branch_enums(item);
            }
        }
        _ => {}
    }
}

/// The `type`/`enum` pair to hoist when `map`'s `oneOf` is exactly one
/// string-`enum` branch carrying nothing but `type`, `enum`, and (optionally)
/// the openness declaration; `None` otherwise.
fn lone_string_enum_branch(map: &Map<String, Value>) -> Option<Vec<(String, Value)>> {
    let branches = map.get("oneOf")?.as_array()?;
    let [branch] = branches.as_slice() else {
        return None;
    };
    let branch = branch.as_object()?;
    let familiar = branch
        .keys()
        .all(|key| matches!(key.as_str(), "type" | "enum" | OPENNESS_KEY));
    if !familiar || branch.get("type")?.as_str()? != "string" {
        return None;
    }
    let entries = branch.get("enum")?.as_array()?;
    Some(vec![
        ("type".to_owned(), Value::String("string".to_owned())),
        ("enum".to_owned(), Value::Array(entries.clone())),
    ])
}

/// The name of the first `$defs` entry the strip left with an empty `oneOf`.
fn first_emptied_enum(document: &Value) -> Option<String> {
    let defs = document.get("$defs")?.as_object()?;
    defs.iter()
        .find(|(_, node)| {
            node.get("oneOf")
                .and_then(Value::as_array)
                .is_some_and(|branches| branches.is_empty())
        })
        .map(|(name, _)| name.clone())
}

/// Recursively key-sorted copy: the preimage is a function of the surface,
/// not of map iteration order.
fn sorted_value(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(&String, &Value)> = map.iter().collect();
            entries.sort_by(|a, b| a.0.cmp(b.0));
            let mut sorted = Map::new();
            for (key, child) in entries {
                sorted.insert(key.clone(), sorted_value(child));
            }
            Value::Object(sorted)
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted_value).collect()),
        other => other.clone(),
    }
}
