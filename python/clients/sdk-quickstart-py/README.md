# Quickstart: your first Muse session from Python

This is the shortest complete path from nothing to a working `muse-code-sdk`
program: start the agent, run a turn, answer its permission request, cancel
it, reload the session later, and shut down. Follow it top to bottom. You do
not need to read the SDK source.

Everything below is executed by `src/quickstart_journey/journey.py` in this
directory. The code you read here is the code that runs — a test holds every
snippet on this page to the program's own source — so it cannot go stale.

## What you need

- Python 3.10 or newer, with the SDK importable (`pip install muse-code-sdk`,
  which brings the wire-types package `muse-code-msp` with it, or editable
  installs of `clients/msp-py` and `clients/sdk-py` from this tree).
- A `muse` binary: an installed Muse Code CLI, or a release build of the
  host. Its MSP surface is what your program talks to.

## Run it

From the repository root:

```sh
PYTHONPATH=clients/sdk-quickstart-py/src \
MUSE_BIN=$(command -v muse) \
python3 -m quickstart_journey
```

You get one line per step, then a verdict:

```
PASS  spawn                            43ms  Spawn the release-built host and keep it alive
PASS  handshake                         0ms  The handshake result describes the host and matches the SDK's schema pin
PASS  session-new                      14ms  Start a new session in the workspace
...
journey OK (passed=12 expectBlocked=0 unblocked=0 failed=0)
```

You do **not** need an API key or a live provider to run that. The journey
starts its own loopback fake model endpoint on `127.0.0.1` and hands the host
a `HOME` configured to use it, so the turn, approval and cancel steps run for
real and nothing leaves the machine. Pass `--no-provider` for the
credential-free degradation mode (the model-dependent steps then fail for
real and say so), or `--sync` for the same twelve steps on the blocking
`SyncMuseClient` wrapper.

## The journey, step by step

The steps below are the journey's twelve segments, at step parity with the
TypeScript quickstart (`clients/sdk-quickstart`): same ids, same order.

### 1. Spawn the host (`spawn`)

`MuseClient.spawn` starts your own `muse serve` child and completes the MSP
handshake in one call. You cannot send anything before the handshake
completes; the client you get back is ready to use. These are the options an
application needs:

```python
    options = MuseClientSpawnOptions(
        muse_bin=None,  # None runs the first `muse` on your PATH
        args=["serve"],
        client_info=QUICKSTART_CLIENT_INFO,
    )
```

`args=["serve"]` starts the protocol host: a bare `muse` is the interactive
app. The journey then sets `muse_bin` to the build it tests, a working
directory, and an `env` with its own `HOME`, so it never touches your real
sessions. A host that dies on launch raises `MuseHostStartError` with its exit
and stderr instead of hanging:

```python
    context.client = await within(
        "the host's spawn and handshake",
        HANDSHAKE_BUDGET_MS,
        MuseClient.spawn(_spawn_options(context)),
    )
```

`within` is the journey's own bounded wait, so a stuck step fails with a
sentence instead of hanging the run; your application may not need it.

### 2. Check the handshake (`handshake`)

`client.initialize_result` names the server, your `museHome`, the session
durability profile, and the schema fingerprint. The Python SDK's fingerprint
posture is the STRICT gate: a host serving a different schema than the SDK was
built against fails `initialize` with an exact error, so if you got here, they
match.

```python
    schema = _object_at(result, "schema", "initialize result")
    # The Python SDK's fingerprint posture is the STRICT gate: a
    # mismatch fails `initialize`, so reaching here proves the gate passed —
    # the explicit equality keeps the fact readable in the report.
    _equals(
        _string_at(schema, "fingerprint", "initialize schema"),
        muse_code.EXPECTED_SCHEMA_FINGERPRINT,
        "the served schema fingerprint vs the fingerprint muse-code-sdk pins",
    )
```

### 3. Start a session (`session-new`)

```python
    session = await within(
        "the session/start reply",
        COMMAND_BUDGET_MS,
        client.start_session(StartSessionOptions(workspace_root=context.workspace_root)),
    )
```

The client owns the connection: it sends each state-changing call with an id
it mints, and routes every event the host pushes to the session it belongs
to. The host's reply is on `session.opening.result`. A default start has
written no durable fact yet, so its view cursor is exactly the before-genesis
`""`.

### 4. Read the effective model (`session-effective-model`)

A session always names the provider and model it will actually use: read
`providerId` and `modelId` off the session in `session.opening.result`.

### 5. Run a turn (`turn`)

`session.run` sends one prompt and returns once the turn has ended, with the
outcome, the final answer text (`final_text`), the turn's items, and its
token usage. A turn that failed or was cancelled still returns; read
`result.outcome` to tell.

```python
    result = await within("the turn", STREAM_BUDGET_MS, session.run(PROMPT))
    _require_terminal(result.outcome, "completed")
```

To stop it, cancel the task that awaits it: a queued turn is taken back, a
running one is cancelled, and `run` re-raises `CancelledError` once the turn
has ended.

### 6. Read a turn as it streams, and answer a permission request (`approval`)

A prompt that touches the disk makes the agent ask first. Register your
handler before you send the turn. The choices are server-minted: a choice the
request did not offer is refused and reported to `on_approval_error` instead
of being sent.

```python
    session.on_approval_error(failures.append)
    session.on_approval(lambda request: ApprovalDecisionInput(choice_id="allow_once"))
```

To show the turn while it runs, send it yourself and read its items. Each
iteration yields an item as it changes (the prompt, the tool call, the
agent's messages), and the loop ends when the turn ends:

```python
    turn = await within(
        "the turn/start ack",
        COMMAND_BUDGET_MS,
        session.send_user_turn(
            SendUserTurnOptions(input=[{"type": "text", "text": APPROVAL_PROMPT}])
        ),
    )
```

```python
    async for item in turn.items():
        kinds.append(str(item.get("kind")))
```

The authoritative answer to the approval is the host's `approval/resolved`,
which the session records in `session.fold.resolved_approvals()`.

### 7. Cancel a running turn (`cancel`)

`turn.cancel()` only asks. The turn is over when `turn.completed` settles,
with the terminal `"cancelled"`:

```python
    await within("the turn/cancel ack", COMMAND_BUDGET_MS, turn.cancel())
    outcome = await within("the cancelled turn's end", STREAM_BUDGET_MS, completed)
    _require_terminal(outcome, "cancelled")
```

### 8–10. Close, reopen, resume (`resume`, `resume-effective-model`, `resume-history`)

The session lease belongs to the live host, so the first one drains cleanly
before a second loads the same session — with its history intact.

```python
    await within("the first host's orderly drain", CLOSE_BUDGET_MS, first.close())
    exit_ = await first.exit
    _equals(exit_.kind, "cleanShutdown", "the first host's exit after stdin EOF")
```

```python
    resumed_session = await within(
        "the session/resume reply",
        COMMAND_BUDGET_MS,
        client.resume_session(
            ResumeSessionOptions(session_id=session_id, exclude_items=False)
        ),
    )
```

### 11. A cursor that never existed is refused (`resume-rejects-unknown-cursor`)

Only the pinned refusal counts: resuming from an impossible cursor fails with
the typed `notFound` error, not with silence and not with a different error
wearing its name.

### 12. Shut down (`terminate`)

Close stdin, let the host drain, and read the exit the SDK classified.

```python
    await within("the host's orderly drain and exit", CLOSE_BUDGET_MS, client.close())
    classification = await within(
        "the SDK's exit classification", COMMAND_BUDGET_MS, client.exit
    )
    _equals(classification.kind, "cleanShutdown", "the SDK's exit classification")
```

## The same journey, blocking

`--sync` reruns all twelve steps on the SDK's `SyncMuseClient` — the
loop-runner wrapper for plain scripts (a notebook cell already runs inside an
event loop, so use the async `MuseClient` there). A turn looks like this:

```python
def _run_sync_turn(session: "SyncSession[Any]", prompt: str) -> SyncTurn:
    return session.send_user_turn(
        SendUserTurnOptions(
            input=[{"type": "text", "text": prompt}], composer_input=prompt
        )
    )
```

## Notes

- The journey launches its child with the SDK dev gate enabled
  (`MUSE_EXPERIMENTAL_SDK_ENABLED=on`) and an isolated `HOME`, so it never
  reads your credentials, telemetry settings, or real muse state. That is how
  the JOURNEY's own child is launched; it is not reader guidance.
- The acceptance test for this page is
  `tests/test_quickstart_journey.py` (step parity against the TypeScript
  registry, all twelve segments required) and
  `tests/test_readme_matches_journey.py` (every Python snippet above is a
  verbatim excerpt of the program).
