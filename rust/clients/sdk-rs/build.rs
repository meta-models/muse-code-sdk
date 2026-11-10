//! Derive `GENERATED_FINGERPRINT` at build time: the stable bundle's
//! fingerprint is computed from schema bytes during the build, never
//! stamped into the generated root by the renderer.
//!
//! Schema source, in order: the vendored release bytes (under `build/`,
//! written by the publish flow and never committed) win, so a crates.io
//! build derives from its own release; otherwise the producing tree's live
//! stable bundle. Both missing fails the build — there is no default digest.

#[path = "build/fingerprint.rs"]
mod fingerprint;

use std::path::PathBuf;

/// The vendored release bytes, present only in release staging and the
/// packaged crate. They live under `build/` (never committed) so the
/// anchor digest, which resolves directory entries to tracked files
/// only, skips them silently — the same staged-bytes shape as the
/// wire-types wheel's `_schema/` directory.
const VENDORED_SCHEMA: &str = "build/msp.schema.json";

/// The producing tree's live stable bundle, relative to the crate dir.
const LIVE_SCHEMA: &str = "../../schema/msp/stable/msp.schema.json";

/// The `OUT_DIR` file the generated root `include_str!`s as
/// `GENERATED_FINGERPRINT` — no trailing newline.
const FINGERPRINT_EMBED: &str = "msp-stable-fingerprint.txt";

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").expect(
            "CARGO_MANIFEST_DIR is unset; refusing to fingerprint schema bytes from nowhere",
        ));
    let vendored = manifest_dir.join(VENDORED_SCHEMA);
    let live = manifest_dir.join(LIVE_SCHEMA);
    for watched in fingerprint::rerun_watch_paths(&vendored, &live, &manifest_dir.join("build")) {
        println!("cargo::rerun-if-changed={}", watched.display());
    }

    let (schema_path, schema_bytes) = [vendored, live]
        .into_iter()
        .filter_map(|path| std::fs::read(&path).ok().map(|bytes| (path, bytes)))
        .next()
        .unwrap_or_else(|| {
            panic!(
                "cannot derive GENERATED_FINGERPRINT: no schema bytes at \
                 {VENDORED_SCHEMA} (vendored release bytes) or {LIVE_SCHEMA} \
                 (producing tree); refusing a default digest"
            )
        });

    let fingerprint = fingerprint::stable_fingerprint_of_bundle_bytes(&schema_bytes)
        .unwrap_or_else(|error| {
            panic!(
                "cannot derive GENERATED_FINGERPRINT from {}: {error}",
                schema_path.display()
            )
        });

    let out_dir = PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR is unset"))
        .join(FINGERPRINT_EMBED);
    std::fs::write(&out_dir, fingerprint.as_bytes())
        .unwrap_or_else(|error| panic!("cannot write {}: {error}", out_dir.display()));
}
