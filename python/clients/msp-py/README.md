# `muse-code-msp`

Generated Python wire types for the Muse Session Protocol (MSP) — the
protocol a Muse Code agent host speaks over stdio.

**Every type in this package is generated from the MSP JSON Schema; nothing
is written by hand, ever.** A machine check keeps the generated code in
lockstep with the schema, so the types cannot drift from the protocol.

- `muse_code_msp` — the stable surface: a `TypedDict` for every schema
  definition (open enums stay `str`, each with a `*_KNOWN_VALUES` tuple so
  unknown values pass through instead of failing), plus the
  method/notification/error tables and the schema-bundle fingerprint
  constants.
- `muse_code_msp.experimental` — the experimental surface: explicit import
  only, no stability promise.

Zero runtime dependencies. Python 3.10+. Fully typed (`py.typed`).

The hand-written client built on these types is
[`muse-code-sdk`](https://pypi.org/project/muse-code-sdk/).

## Install

```sh
pip install muse-code-msp
```

## Use

```python
from muse_code_msp import (
    NOTIFICATIONS,
    REQUIRED_HOST_VERSION,
    SCHEMA_FINGERPRINT,
    TURN_TERMINAL_KNOWN_VALUES,
)

print(REQUIRED_HOST_VERSION)          # the muse host version this build pairs with
print(SCHEMA_FINGERPRINT)             # the stable-surface schema fingerprint
print(sorted(NOTIFICATIONS)[:3])      # wire notification methods
print(TURN_TERMINAL_KNOWN_VALUES)       # an open enum's known values
```

## Documentation

- Guides, cookbook recipes, and the protocol reference:
  <https://meta-models.github.io/muse-code-sdk/>
- Python API reference:
  <https://meta-models.github.io/muse-code-sdk/next/generated/python/>
- Source and issues: <https://github.com/meta-models/muse-code-sdk>
