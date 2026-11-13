# `muse-code-sdk`

The Python SDK for Muse Code: an asyncio-first client for driving a Muse
Code agent over the Muse Session Protocol (MSP), with a thin synchronous
wrapper for scripts and notebooks.

- Open and resume sessions against a spawned `muse serve` host, or attach to
  one you already run.
- Stream a turn's items and text deltas as async iterators; await the turn's
  server-authored outcome.
- Stream what each incoming event changed in a session with
  `session.events()`, to update a view incrementally.
- Answer tool-approval requests with a handler you register, or pass it as
  `ResumeSessionOptions(on_approval=...)`, with `on_approval_error=...` for
  its failures, so approvals still pending at resume reach it.
- Answer the agent's questions: list them with
  `session.fold.pending_user_inputs()` and answer with
  `session.answer_user_input`.
- A client-side fold keeps a live, typed view of the session — items, session
  state, pending commands — with gap recovery after reconnects, and safe
  same-command retry that can never double-submit.
- Observe the connection itself: every notification the host sends (including
  ones that name no session, such as `usage/changed`), messages the SDK
  rejects as malformed, and the connection closing.
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

from muse_code import MuseClient, MuseClientSpawnOptions, StartSessionOptions

async def main() -> None:
    client = await MuseClient.spawn(MuseClientSpawnOptions(
        muse_bin=None,  # None finds `muse` on PATH; or pass a path
        args=["serve"],
        client_info={"name": "my-app", "version": "1.0.0"},
    ))
    session = await client.start_session(StartSessionOptions(workspace_root="."))
    result = await session.run("Summarize this repository.")
    print(result.final_text)
    await client.close()

asyncio.run(main())
```

`session.run` sends one turn and returns when the turn has ended, with the
outcome, the final answer text, the turn's items, and its token usage. A turn
that failed or was cancelled still returns; read `result.outcome` to tell. The
final answer is the last completed agent message that is not commentary. Pass a
list of input parts instead of a string, and turn options as keywords:
`await session.run(parts, reasoning_effort="high")`.

To stop it, cancel the task that awaits it, for example with
`asyncio.timeout(60)` on Python 3.11 or newer. A turn still waiting in the
queue is taken back, and a running turn is cancelled; `run` then waits for
the turn to end and re-raises `CancelledError`. `SyncSession.run` is the
blocking version, with no way to cancel.

To follow a turn as it runs, send it yourself and read its items (paste
inside `main()` above, before `await client.close()`; add
`SendUserTurnOptions` to the import):

```python
turn = await session.send_user_turn(SendUserTurnOptions(
    input=[{"type": "text", "text": "Summarize this repository."}],
    composer_input="Summarize this repository.",
))
async for item in turn.items():
    print(item)
await turn.completed
```

To stop a running turn, `await turn.interrupt()` (the stop gesture; pass
`retract=True` to also take the prompt back) or `await turn.cancel()`. Both are
requests: the turn is over when `turn.completed` settles. `turn.steer(...)`
adds input to the running turn, and `turn.unqueue()` takes back a queued one.
The session itself can `fork`, `compact`, `rename`, and `leave`, and switch its
model, reasoning effort, or approval mode (`set_model`, `set_reasoning_effort`,
`set_approval_mode`); `client.list_models()` lists the models it accepts.

To render incrementally, read `session.events()`: every event the session
folds from then on, with what it changed. Read the current state first, then
subscribe before the next `await`, and nothing is missed, including the events
that arrived before `start_session` or `resume_session` returned:

```python
import contextlib

render_all(session.fold)  # the state so far
async with contextlib.aclosing(session.events()) as events:
    async for event in events:
        # `event.item` is the item as of this event; `session.fold` may be ahead.
        render(event.frame["method"], event.outcome.fold, event.item)
```

Each event arrives once, in order, including events the SDK fetches to fill a
gap in delivery. `aclosing` stops listening when the loop ends or breaks (or
call `aclose()`). The stream ends when an ephemeral host dies and raises
`MuseHostDiedError` when a durable one does, as `turn.items()` does. Reading
it changes nothing else: `turn.unqueue()` still returns the queued input it
takes back, and that input is not repeated on an event. `SyncSession.events()`
is the blocking version: `for event in session.events(): ...`.

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

## Observe the connection

The client routes each event to its session, and also lets you listen to the
raw feed. Each `on_*` call returns a function that removes that one listener:

```python
unsubscribe = client.on_notification(
    lambda notification: print(notification["method"], notification.get("params"))
)
client.on_notification_error(lambda error, notification: print("listener failed:", error))
client.on_protocol_error(lambda error: print("rejected frame:", error.line))
await client.closed  # resolves when the connection closes, for any reason
unsubscribe()
```

A notification for a session you opened reaches your listener after the
session has applied it, except during a gap fill (the event is folded when
the fill completes) or while `start_session`/`resume_session` is still running
(it is folded before the call returns). Listeners run as frames are read, so keep them quick;
an `async def` listener runs as a task. An exception from a listener goes to
`on_notification_error` and never disconnects the client. `SyncMuseClient`
has the same three `on_*` methods (listeners run while a blocking call is in
progress) and `wait_closed()` in place of `closed`.

## Documentation

- Guides, cookbook recipes, and the protocol reference:
  <https://meta-models.github.io/muse-code-sdk/>
- Python API reference:
  <https://meta-models.github.io/muse-code-sdk/next/generated/python/>
- Source and issues: <https://github.com/meta-models/muse-code-sdk>
