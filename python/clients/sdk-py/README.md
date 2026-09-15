# `muse-code-sdk`

The MSP Python facade (spec `specs/638-muse-sdk-python`; the Python tier of
tdd SS7.3, chartered by issue #638). Mirrors `@muse-code/sdk`
(`clients/sdk-ts`): asyncio-first — async iterators for turn streams,
awaitable approvals — with a thin sync loop-runner for scripts and
notebooks.

**One runtime dependency**: `pydantic`, exact-pinned (the ADR 638 D2
supply-chain exception, #211 O-3 form). The generated wire types live in
`muse-code-msp` (`clients/msp-py`) and are never restated here.

**Status: S0 skeleton.** The facade surface lands slice by slice
(`specs/638-muse-sdk-python/plan.md` S1–S4); the first acceptance milestone
is the quickstart journey against a release-built host. Python 3.10+.

## The loop

```sh
cd projects/tbh
python3 -m pip install -r clients/py-dev-requirements.txt
python3 -m pip install -e clients/msp-py -e clients/sdk-py
pytest clients/sdk-py/tests
mypy --strict clients/msp-py/src clients/sdk-py/src
```

CI runs exactly this in the non-required, path-filtered `tbh-muse-sdk-py`
workflow, on the floor Python (3.10) and a current one.
