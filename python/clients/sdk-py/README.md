# `muse-code-sdk`

The Python SDK for Muse Code: an asyncio-first client for driving a Muse
Code agent over the Muse Session Protocol (MSP), with a thin synchronous
wrapper for scripts and notebooks.

- Open and resume sessions against a spawned `muse serve` host, or attach to
  one you already run.
- Stream a turn's items and text deltas as async iterators; await the turn's
  server-authored outcome.
- Answer tool-approval requests with a handler you register.
- A client-side fold keeps a live, typed view of the session — items, session
  state, pending commands — with gap recovery after reconnects, and safe
  same-command retry that can never double-submit.
- `SyncMuseClient` mirrors the same surface with blocking verbs.

Status: developer preview. Experimental protocol surfaces may change.

The generated MSP wire types live in the companion package
[`muse-code-msp`](https://pypi.org/project/muse-code-msp/) and are never
restated here. One runtime dependency: `pydantic`, exact-pinned.
Python 3.10+. Fully typed (`py.typed`).

## Install

```sh
pip install muse-code-sdk muse-code-msp
```

You also need the Muse Code CLI: a `muse` binary on `PATH`, or an explicit
path passed at spawn time.

## Use

```python
import asyncio

from muse_code import (
    MuseClient, MuseClientSpawnOptions, SendUserTurnOptions, StartSessionOptions,
)

async def main() -> None:
    client = await MuseClient.spawn(MuseClientSpawnOptions(
        muse_bin="muse",
        args=["serve"],
        client_info={"name": "my-app", "version": "1.0.0"},
    ))
    session = await client.start_session(StartSessionOptions(workspace_root="."))
    turn = await session.send_user_turn(SendUserTurnOptions(
        input=[{"type": "text", "text": "Summarize this repository."}],
        composer_input="Summarize this repository.",
    ))
    async for item in turn.items():
        print(item)
    await turn.completed
    await client.close()

asyncio.run(main())
```

## Documentation

- Guides, cookbook recipes, and the protocol reference:
  <https://meta-models.github.io/muse-code-sdk/>
- Python API reference:
  <https://meta-models.github.io/muse-code-sdk/next/generated/python/>
- Source and issues: <https://github.com/meta-models/muse-code-sdk>
