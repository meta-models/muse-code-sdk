# muse-code-sdk cookbook twins (Python)

Python twins of every `@muse-code/sdk-cookbook` recipe — same recipe ids,
same docs pages, run in CI against the same release-built `muse` host and
`muse-conformance` fixture host as the TypeScript cookbook. The recipe set
is discovered from the TypeScript tree by
`tests/test_cookbook_twins.py`; a new TS recipe with no twin here fails
that suite.

This is a test-lane harness, never installed or published. It consumes only
the shipped `muse-code-sdk` public surface and shares the quickstart
harness's kit (`clients/sdk-quickstart-py`).

Run everything (from the repository root, with the SDK packages importable — see
`clients/sdk-quickstart-py/README.md` for the environment):

```sh
MUSE_BIN=$(command -v muse) \
MUSE_CONFORMANCE_BIN=$PWD/target/release/muse-conformance \
  python3 -m pytest clients/sdk-cookbook-py/tests
```

Run one recipe by id:

```sh
PYTHONPATH=clients/sdk-cookbook-py/src \
MUSE_CONFORMANCE_BIN=$PWD/target/release/muse-conformance \
  python3 -m cookbook_recipes --only stream-a-turn
```

One deliberate divergence from the TypeScript cookbook, owner-directed:
the `fingerprint-mismatch` twin teaches the Python
SDK's STRICT posture — a fingerprint mismatch fails `initialize` with
`MuseHostMismatchError` — where the TS recipe teaches the warning value.
