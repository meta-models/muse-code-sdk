# MSP protocol changelog acknowledgments

The machine-validated artifact that lets a non-additive MSP wire change through
`scripts/check-msp-schema-drift.sh` (FR-006a, FR-006b,
`specs/206-msp-wire-schema/data-model.md` §5.5).

`acknowledgments.json` is the ledger the gate reads. Its first instance is
empty: no non-additive change has been waived, and the human-readable protocol
changelog line is generated from these entries, so the two cannot disagree.

A PR label is explicitly **not** an acknowledgment. A label is invisible in repo
history, which is the one thing a changelog is for.

## Ledger shape

```json
{
  "kind": "mspChangelog",
  "schemaVersion": 1,
  "acknowledgments": []
}
```

Every element of `acknowledgments` is one of the two entries below. The gate
fails **closed** (exit 2) on any malformation, in any entry: a broken waiver
means the gate is broken, not that the change passed (FM-003).

## `changelogAcknowledgment` — the 0.x waiver (FR-006a)

```json
{
  "kind": "changelogAcknowledgment",
  "fingerprintFrom": "sha256:<the baseline manifest's fingerprint>",
  "fingerprintTo": "sha256:<the candidate manifest's fingerprint>",
  "changes": ["/$defs/Widget/properties/note"],
  "rationale": "at least eight characters saying why",
  "trackingIssue": "#206"
}
```

- `changes` must name **every** non-additive change in the diff. A waiver that
  covers one of two changes does not license the other — it is a violation
  (exit 1), not a pass. The gate prints the exact pointers to paste in.
- `fingerprintFrom` / `fingerprintTo` bind the waiver to one comparison. A
  waiver written for a different step does not carry over.
- `rationale` has an 8-character floor and `trackingIssue` must carry `#NNN` or
  a GitHub issue URL, matching the `check-test-only-safety-knobs.sh:70-90`
  waiver rule.

## `completedDeprecation` — the 1.0-and-later valve (FR-006b)

From 1.0 onward a changelog waiver never passes (FM-004). The only artifact
that does is a record of a **completed** SS1.5 deprecation window:

```json
{
  "kind": "completedDeprecation",
  "identifier": "/$defs/Widget/properties/note",
  "descriptor": "Widget.note",
  "firstNoticedRelease": "0.9.0",
  "decisionRecord": "docs/adr/<issue>-<slug>.md",
  "trackingIssue": "#206"
}
```

`identifier` is the schema pointer the record covers, `descriptor` is the
`deprecationNotice` descriptor that announced it, `firstNoticedRelease` is the
release that first carried the notice, and `decisionRecord` links the decision.
The protocol is 0.x today (D-013), so no entry of this kind is expected yet.
