// @muse/msp — the generated MSP wire types, consumed IN PLACE.
//
// This file is the whole package. It re-exports the committed declarations
// that `crates/protocol` renders (spec 206, byte-pinned by the required Rust
// test `generate_ts_reproduces_the_committed_declarations`). The artifact is
// NOT copied or vendored here: a second copy would drift from the one #206
// owns, which is exactly what the fingerprint-pinning discipline exists to
// prevent (spec 14990 INV-008).
//
// Hand-writing a protocol type anywhere in this workspace is forbidden
// (INV-001). A type the generated layer lacks is a #206 request, not a local
// interface.

export type * from "../../schema/msp/msp.js";
