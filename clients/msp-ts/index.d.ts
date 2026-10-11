// @muse-code/msp — the generated MSP wire types, consumed IN PLACE.
//
// This file is the whole package. It re-exports the committed declarations
// the protocol renderer emits (byte-pinned by the required Rust reproduction
// test `generate_ts_reproduces_the_committed_declarations`). The artifact is
// NOT copied or vendored here: a second copy would drift from the
// generator-owned original, which is exactly what the fingerprint-pinning
// discipline exists to prevent.
//
// Hand-writing a protocol type anywhere in this workspace is forbidden. A
// type the generated layer lacks is a gap in the published schema, not a
// local interface.

export type * from "../../schema/msp/msp.js";
