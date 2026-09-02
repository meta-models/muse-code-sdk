# MSP release baseline

The **previous release's** stable MSP bundle. It is the second of the drift
gate's two baselines (FR-005a, `specs/206-msp-wire-schema/spec.md`): the
committed bundle under `schema/msp/stable/` catches drift at the PR that causes
it, and this directory carries the compatibility verdict D-019 and SS1.9
describe, which is the one an acknowledgment is keyed to.

`scripts/check-msp-schema-drift.sh` compares this directory against
`schema/msp/stable/` on every run, with the acknowledgment ledger at
`schema/msp/changelog/acknowledgments.json`.

## Bootstrap

MSP has never shipped a release, so there is no previous release to copy. The
spec requires the first-run case to be an **explicit, named bootstrap path, not
an implicit pass** (`spec.md`, Edge Cases), so the baseline was seeded here with
the initial v1 stable bundle rather than left absent: an absent directory makes
the gate fail closed (exit 2), which is correct behaviour but not a state to
ship in.

Seeded by spec 206 Phase 6 (T061) from `schema/msp/stable/` at fingerprint
`sha256:28ef2488d457d2cd071a3d620ba3821711f0a5120b32dd7408fbf465c1500402`.

## Updating it

At each MSP release, replace both files with that release's stable bundle in
the same change that cuts the release. Nothing else may edit them: a baseline
that moves with the candidate compares a bundle against itself and reports
green forever, which is the failure the two-baseline rule exists to prevent.
