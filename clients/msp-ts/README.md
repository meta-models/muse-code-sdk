# `@muse-code/msp`

Generated MSP wire types. Protocol types are never hand-written: a type
the generated layer lacks is a gap in the published schema, not a local
interface.

The package is one declaration file that re-exports
`schema/msp/msp.d.ts` **in place**. That artifact is rendered from the
protocol schema model and byte-pinned by a reproduction test (the committed
file must equal the generator's output byte for byte), so consuming it
directly needs no Rust toolchain and cannot drift from the binary that
produced it.

Nothing is copied into this directory. A second copy of the declarations
would fork from the generator-owned original — the failure mode the
fingerprint pin (`@muse-code/sdk`'s `EXPECTED_SCHEMA_FINGERPRINT`) exists
to catch.

## The loop

From a `muse-code-sdk` checkout:

```sh
npm ci          # installs the pinned workspace devDependencies from the lockfile
npm run check   # tsc --strict over both packages (this one has no tests of its own)
```

The SDK continuous-integration job runs exactly these commands.

## Coverage today

The committed declarations render the **envelope plane** — handshake
(`initialize`/`initialized`), the four frame shapes, `RequestId`,
`SchemaInfo`, the error taxonomy — AND the **session-view plane**
(`Item`, the `item/*` and `turn/*` notification params, session-state
params). `turn/unqueued` and `view/gap` are enrolled too; the ack and
snapshot shapes follow as they land. `@muse-code/sdk` binds to each as it
lands.

## Nothing is published

This package is not published during 0.x. `private: true` is the
enforcement. Only `@muse-code/sdk` may publish at 0.x: this package is
types-only and re-exports a declaration file from outside its own root, so
publishing it would ship a dangling type reference. The SDK tarball
carries the declarations it needs instead.
