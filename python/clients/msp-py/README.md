# `muse-code-msp`

Generated MSP wire types for Python. **No hand-written protocol types, ever**
(spec `638-muse-sdk-python` INV-638-01, carrying spec `14990-muse-sdk`
INV-001).

The package is rendered from the committed MSP JSON Schema bundles
(`schema/msp/{stable,experimental}/msp.schema.json`, themselves exported by
the binary's `muse schema generate-json-schema`, spec 206) by
`scripts/gen-msp-py.sh`. Never edit a generated file: the required Rust test
`crates/devtools/tests/msp_py_codegen.rs` reds on any hand edit or stale
rendering and names that script.

- `muse_code_msp` — the stable surface: typed declarations for every `$defs`
  entry (TypedDicts and enum aliases; open enums stay `str` with a
  `*_KNOWN_VALUES` tuple, SS1.5.4), plus the method/notification/error tables
  and the bundle fingerprint constants.
- `muse_code_msp.experimental` — the experimental surface, explicit import
  only, no stability promise.

Zero runtime dependencies (INV-638-03). Python 3.10+. The hand-written
facade is `muse-code-sdk` (`clients/sdk-py`).
