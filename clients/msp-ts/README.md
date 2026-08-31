# `@muse/msp`

Generated MSP wire types. **No hand-written protocol types, ever** (spec
`14990-muse-sdk` INV-001).

The package is one declaration file that re-exports
`schema/msp/msp.d.ts` **in place**. That artifact is rendered by
`crates/protocol` (spec 206) and byte-pinned on the required Rust path by
`generate_ts_reproduces_the_committed_declarations`
(`crates/cli/tests/msp_schema_export.rs`), so consuming it directly needs no
Rust toolchain and cannot drift from the binary that produced it.

Nothing is copied into this directory. A second copy of the declarations
would fork from the one #206 owns — the failure mode the fingerprint pin
(`@muse/sdk`'s `EXPECTED_SCHEMA_FINGERPRINT`) exists to catch.

## The loop

```sh
cd projects/tbh
npm ci          # installs the pinned workspace devDependencies from the lockfile
npm run check   # tsc --strict over both packages (this one has no tests of its own)
```

CI runs exactly this in the non-required, path-filtered `tbh-muse-sdk-ts`
workflow.

## Coverage today

The committed declarations render the **SS1 envelope plane** — handshake
(`initialize`/`initialized`), the four frame shapes, `RequestId`,
`SchemaInfo`, the SS1.6 error taxonomy — AND the **session-view plane**
(`Item`, the `item/*` and `turn/*` notification params, session-state
params), enrolled by [#14953](https://github.com/par-msl/tbh/pull/14953)
(merged 2026-08-13). `turn/unqueued` enrolled with spec 206 Phase 11
([#22772](https://github.com/mslsrc/tbh/issues/22772)) and `view/gap` with
[#24021](https://github.com/mslsrc/tbh/issues/24021); the ack and snapshot
shapes follow with their own enrollment slices. `@muse/sdk` binds to each as it lands.

## Nothing is published

Repo-build-only during 0.x (tdd D-013, #211 O-5). `private: true` is the
enforcement.
