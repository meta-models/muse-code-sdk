#!/usr/bin/env bash
# MSP TypeScript typecheck (issue #14099, specs/206-msp-wire-schema TEST-019).
#
# Proves the committed MSP declarations (`schema/msp/msp.d.ts`) compile under
# `tsc --strict --noEmit` with no hand edits (spec Scenario 7.4). The required
# test `generate_ts_reproduces_the_committed_declarations` byte-pins that file
# to the generator's stable render, so typechecking the committed file is
# typechecking the emitted stable render.
#
# This runs in the non-required, path-filtered
# `.github/workflows/tbh-muse-sdk-ts.yml` (it absorbed the former
# tbh-msp-ts-typecheck lane) — NOT in the required `tbh-rs`
# run: no required job ships a TypeScript compiler (research.md §R2, spike U4),
# and the Rust build never invokes `tsc`. It is also runnable locally anywhere
# Node/npm are installed.
#
# Supply-chain rule (research.md §R2): NEVER bare `npx tsc` — that resolves to
# the unrelated, deprecated npm package literally named `tsc`, not Microsoft's
# `typescript`. The compiler here is the `typescript` package pinned to an
# exact version, and the resolved version is asserted before it is trusted.
#
# Exit: 0 clean / 1 the declarations fail to typecheck / 2 fail-closed
# (missing file, no npx, or the pinned compiler cannot be resolved or reports
# the wrong version — a typecheck that silently no-ops is a green light that
# checked nothing).
set -uo pipefail

# The single source of the pin. Bump deliberately; CI and local runs share it.
TYPESCRIPT_VERSION="7.0.2"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || {
  echo "FAIL: cannot enter $ROOT — failing closed."
  exit 2
}

DECLS="schema/msp/msp.d.ts"

if [ ! -f "$DECLS" ]; then
  echo "FAIL: $DECLS is missing — nothing to typecheck, failing closed."
  exit 2
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "FAIL: npx not found — cannot run the pinned TypeScript compiler, failing closed."
  echo "Install Node.js (any recent version; CI uses Node 22) and re-run."
  exit 2
fi

# Resolve the pinned compiler and prove it is the version we asked for before
# trusting anything it says about the declarations.
reported="$(npx --yes --package "typescript@${TYPESCRIPT_VERSION}" tsc --version 2>&1)"
if [ "$?" -ne 0 ] || [ "$reported" != "Version ${TYPESCRIPT_VERSION}" ]; then
  echo "FAIL: could not resolve typescript@${TYPESCRIPT_VERSION} (got: ${reported}) — failing closed."
  exit 2
fi

if output="$(npx --yes --package "typescript@${TYPESCRIPT_VERSION}" tsc --strict --noEmit "$DECLS" 2>&1)"; then
  echo "OK: ${DECLS} typechecks under tsc ${TYPESCRIPT_VERSION} --strict --noEmit."
  exit 0
fi

echo "FAIL: ${DECLS} does not typecheck under tsc ${TYPESCRIPT_VERSION} --strict --noEmit:"
echo "$output"
echo "The file is generated (crates/protocol, spec 206) — fix the renderer and"
echo "regenerate; never hand-edit the declarations."
exit 1
