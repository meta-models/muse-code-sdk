# `muse-code-sdk`

The Python SDK for Muse Code: an asyncio-first client for driving a Muse
Code agent over the Muse Session Protocol (MSP), with a thin synchronous
wrapper for scripts and notebooks.

- Open and resume sessions against a spawned `muse serve` host, or attach to
  one you already run.
- Stream a turn's items and text deltas as async iterators; await the turn's
  server-authored outcome.
- Answer tool-approval requests with a handler you register, or pass it as
  `ResumeSessionOptions(on_approval=...)`, with `on_approval_error=...` for
  its failures, so approvals still pending at resume reach it.
- Answer the agent's questions: list them with
  `session.fold.pending_user_inputs()` and answer with
  `session.answer_user_input`.
- A client-side fold keeps a live, typed view of the session — items, session
  state, pending commands — with gap recovery after reconnects, and safe
  same-command retry that can never double-submit.
- `SyncMuseClient` mirrors the same surface with blocking verbs.

Status: developer preview. Experimental protocol surfaces may change.

The generated MSP wire types live in the companion package
[`muse-code-msp`](https://pypi.org/project/muse-code-msp/) and are never
restated here; it is installed with this package, pinned to the same version.
One further runtime dependency: `pydantic`, exact-pinned.
Python 3.10+. Fully typed (`py.typed`).

## Install

```sh
pip install muse-code-sdk
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

To run a session and the child agents it starts without approval prompts,
start it under the built-in `:unrestricted` permission profile. Current
releases admit every child of such a session without prompts; a child admitted
with a narrower authority would stay gated at it.

That profile is described, verbatim, as "No filesystem sandbox or approval
prompts; local commands have direct network access; project trust is
unchanged." It also sets the approval reviewer to none. Use it only for a
trusted workspace and trusted prompts. Never use it where the prompts or the
sandbox are what protects you.

Start it with that profile, and pass the same profile when you resume it.
Paste inside `main()` above, indented, before `await client.close()`, with the same client:

```python
from muse_code import ResumeSessionOptions, StartSessionOptions

session = await client.start_session(StartSessionOptions(
    workspace_root="/path/to/repo",  # an absolute path
    permission_profile=":unrestricted",
))
saved_session_id = session.session_id
# ... later, in the same client:
session = await client.resume_session(ResumeSessionOptions(
    session_id=saved_session_id,
    permission_profile=":unrestricted",
))
```

On start, `require_permission_profile=True` makes the client prove that the
pick was applied, and raise `PermissionProfileNotApplied` if it cannot (a
failed `session/read` read-back raises its own error). A host
that does not report the committed selection fails that proof even when the
pick was applied (seen with Muse Code 1.4.12). Resume has no
`require_permission_profile`, so the client never verifies the pick there.

`approval_mode` alone is not enough: it changes the session's own approval
mode, but its child agents are capped by the session's permission profile.
Under a prompting profile (such as `:ask-me`, whose approval is `on_request`),
the children still ask.

## Documentation

- Guides, cookbook recipes, and the protocol reference:
  <https://meta-models.github.io/muse-code-sdk/>
- Python API reference:
  <https://meta-models.github.io/muse-code-sdk/next/generated/python/>
- Source and issues: <https://github.com/meta-models/muse-code-sdk>
