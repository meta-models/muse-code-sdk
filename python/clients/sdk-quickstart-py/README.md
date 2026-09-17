# Quickstart: your first Muse session from Python

This is the shortest complete path from nothing to a working `muse-code-sdk`
program: start the agent, run a turn, answer its permission request, cancel
it, reload the session later, and shut down. Follow it top to bottom. You do
not need to read the SDK source.

Everything below is executed by `src/quickstart_journey/journey.py` in this
directory. The code you read here is the code that runs — a test holds every
snippet on this page to the program's own source — so it cannot go stale.

## What you need

- Python 3.10 or newer, with the two SDK packages importable
  (`pip install muse-code-sdk muse-code-msp`, or editable installs of
  `clients/msp-py` and `clients/sdk-py` from this tree).
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

`Host.start` — a thin harness helper over the SDK's `spawn_msp_connection` —
launches your own `muse serve` child in an isolated `HOME` and completes the
MSP handshake. You cannot send traffic before the handshake completes.

```python
    context.host = await Host.start(
        HostOptions(
            muse_bin=context.muse_bin,
            home=context.home,
            workspace_root=context.workspace_root,
            client_info=QUICKSTART_CLIENT_INFO,
        ),
        HANDSHAKE_BUDGET_MS,
    )
```

### 2. Check the handshake (`handshake`)

The result names the server, your `museHome`, the session durability profile,
and the schema fingerprint. The Python SDK's fingerprint posture is the
STRICT gate: a host serving a different schema than the SDK was built against
fails `initialize` with an exact error, so if you got here, they match.

```python
    schema = _object_at(result, "schema", "initialize result")
    # The Python SDK's fingerprint posture is the STRICT gate (C-638-4): a
    # mismatch fails `initialize`, so reaching here proves the gate passed —
    # the explicit equality keeps the fact readable in the report.
    _equals(
        _string_at(schema, "fingerprint", "initialize schema"),
        muse_code.EXPECTED_SCHEMA_FINGERPRINT,
        "the served schema fingerprint vs the fingerprint muse-code-sdk pins",
    )
```

### 3. Start a session (`session-new`)

`session/start` is a command: it is acknowledged durably, and the host also
announces the new session on the push stream. A default start has written no
durable fact yet, so its view cursor is exactly the before-genesis `""`.

```python
    result = await within(
        "the session/start ack",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "session/start", {"workspaceRoot": context.workspace_root}, max_attempts=1
        ),
    )
```

### 4. Read the effective model (`session-effective-model`)

A session always names the provider and model it will actually use.

```python
    read = await within(
        "the session/read result",
        COMMAND_BUDGET_MS,
        host.connection.request(
            "session/read", {"sessionId": session_id, "excludeItems": True}
        ),
    )
    session = _object_at(read, "session", "session/read result")
    _string_at(session, "providerId", "session/read session")
    _string_at(session, "modelId", "session/read session")
```

### 5. Run a turn (`turn`)

Send a prompt, watch the answer stream in as `item/delta` notifications, and
wait for the turn's terminal.

```python
    await host.wait_for(
        "the turn/started notification",
        COMMAND_BUDGET_MS,
        lambda n: n.method == "turn/started" and n.params.get("turnId") == turn_id,
    )
    completed = await host.wait_for(
        "the turn/completed notification",
        STREAM_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    _require_terminal(completed.params, "completed")
```

### 6. Answer a permission request (`approval`)

A prompt that touches the disk makes the agent ask first. The choices are
server-minted; you answer with one of them, and the authoritative outcome is
the view stream's `approval/resolved`, never the ack.

```python
    approval_id = _string_at(event.params, "approvalId", "approval/requested params")
    decided = await within(
        "the approval/decide ack",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "approval/decide",
            {
                "sessionId": session_id,
                "approvalId": approval_id,
                "requirementId": {"approvalId": approval_id, "sourceIndex": 0},
                "choiceId": "allow_once",
                "feedback": None,
            },
            max_attempts=1,
        ),
    )
```

### 7. Cancel a running turn (`cancel`)

```python
    await within(
        "the turn/cancel ack",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "turn/cancel", {"sessionId": session_id, "turnId": turn_id}, max_attempts=1
        ),
    )
    completed = await host.wait_for(
        "the cancelled turn/completed notification",
        STREAM_BUDGET_MS,
        lambda n: n.method == "turn/completed" and n.params.get("turnId") == turn_id,
    )
    _require_terminal(completed.params, "cancelled")
```

### 8–10. Close, reopen, resume (`resume`, `resume-effective-model`, `resume-history`)

The session lease belongs to the live host, so the first one drains cleanly
before a second loads the same session — with its history intact.

```python
    resumed = await within(
        "the session/resume ack",
        COMMAND_BUDGET_MS,
        host.connection.command(
            "session/resume",
            {"sessionId": session_id, "excludeItems": False},
            max_attempts=1,
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
    exit_ = await host.close(CLOSE_BUDGET_MS)
    _equals(exit_.code, 0, "the host's exit code after stdin EOF")
    _equals(exit_.signal, None, "the host's exit signal after stdin EOF")
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
