# Quickstart: your first Muse session from TypeScript

This is the shortest complete path from nothing to a working `@muse-code/sdk`
program: start the agent, run a turn, answer its permission request, cancel it,
reload the session later, and shut down. Follow it top to bottom. You do not
need to read the SDK source.

Everything below is executed by `src/journey.ts` in this directory. The code
you read here is the code that runs, so it cannot go stale.

## What you need

- Node 20 or newer.
- A release-built `tbh` binary. Build one from this repository:

  ```sh
  cargo build --release -p tbh-cli --bin tbh
  ```

  The binary is at `target/release/tbh`. Its MSP surface is what your program
  talks to.

## Run it

From `projects/tbh`:

```sh
npm ci
npm run build --workspace @muse-code/sdk
MUSE_BIN=$PWD/target/release/tbh npm run journey --workspace @muse-code/sdk-quickstart
```

You get one line per step, then a verdict:

```
PASS  spawn                          43ms  Spawn the release-built host and keep it alive
PASS  handshake                       0ms  The handshake result describes the host and matches the SDK's schema pin
PASS  session-new                    14ms  Start a new session in the workspace
PASS  turn                                 Send a prompt and receive the agent's answer as a stream
...
journey OK (passed=12 expectBlocked=0 unblocked=0 failed=0)
```

You do **not** need an API key or a live provider to run that. The journey
starts its own loopback fake model endpoint on `127.0.0.1` and hands the host a
`HOME` configured to use it, so the turn, approval and cancel steps run for
real and nothing leaves the machine. See
[Running without a provider](#running-without-a-provider) for the other mode.

## The journey, step by step

### 1. Spawn the host

`spawnMspConnection` starts your own `tbh serve` child and returns a handshake
you have not sent anything on yet. You cannot send traffic before the
handshake completes — that is enforced by the type, not by convention.

```ts
const handshake = spawnMspConnection({
  command: museBin,
  args: ["serve"],
  cwd: workspaceRoot,
  onStderr: (chunk) => stderr.push(chunk),
});
```

Pass `env` if you want a specific `HOME`; the journey does, so it never
touches your real sessions.

### 2. Complete the handshake

```ts
const msp = await handshake.initialize({
  clientInfo: { name: "my-app", version: "1.0.0" },
});
```

`msp.initializeResult` tells you who answered: `serverInfo`, `museHome`,
`sessionDurability`, and the protocol `schema.fingerprint`. The SDK compares
that fingerprint to the one it was built against and sets
`msp.fingerprintWarning` if they differ. A difference is a **warning, never an
error** — an older SDK keeps working against a newer host.

From here on you talk through `msp.connection`.

### 3. Start a session

```ts
const result = await msp.connection.command(
  "session/start",
  { workspaceRoot },
  { maxAttempts: 1 },
);
const sessionId = result.session.sessionId;
```

Use `command` rather than `request` for anything that changes state. It mints
a `commandId` for you and remembers it, so a retry after a dropped reply joins
the original command instead of starting a second one. `result.viewCursor` is
your position in the session's event stream.

The host also pushes `session/started` with the same session. Subscribe before
you need it:

```ts
msp.connection.onNotification((notification) => { /* ... */ });
```

### 4. Send a prompt and read the answer as it streams

```ts
const ack = await msp.connection.command(
  "turn/start",
  { sessionId, input: [{ type: "text", text: "Reply with the single word: hello" }] },
  { maxAttempts: 1 },
);
// ack.status === "accepted", ack.disposition === "started", ack.turnId
```

The ack means the turn was admitted, not finished. The answer arrives as
notifications:

| notification     | what it means                                   |
| ---------------- | ----------------------------------------------- |
| `turn/started`   | the turn is running                              |
| `item/started`   | a new item (e.g. the agent's message) has begun  |
| `item/delta`     | more text for that item                          |
| `item/completed` | that item is final                               |
| `turn/completed` | the turn is over; `terminal` says how it ended   |

Accumulate `item/delta` for live output, and treat the `item/completed` text
as authoritative. `turn/completed.terminal` is `"completed"`, `"cancelled"` or
`"failed"`; on `"failed"` the notification carries `reason` and `error`.

### 5. Answer a permission request

When the agent wants to do something that needs your consent, the host pushes
`approval/requested`. Answer it:

```ts
const decided = await msp.connection.command(
  "approval/decide",
  {
    sessionId,
    approvalId,
    requirementId: { approvalId, sourceIndex: 0 },
    choiceId: "allow_once",
    feedback: null,
  },
  { maxAttempts: 1 },
);
// decided.terminal === true
```

`approval/resolved` follows, naming the same `approvalId`. The turn then
continues.

### 6. Cancel a running turn

```ts
await msp.connection.command("turn/cancel", { sessionId, turnId }, { maxAttempts: 1 });
```

Cancellation is not instant and it is not an error. Wait for
`turn/completed`; its `terminal` will be `"cancelled"`.

### 7. Shut the host down cleanly

```ts
const exit = await msp.close();   // { code: 0, signal: null }
```

`close()` closes stdin, and the host drains and exits. The session's writer
lease is released with it — which is what lets a later process load the same
session.

### 8. Reload the session in a new process

Spawn and handshake exactly as before, then:

```ts
const resumed = await msp.connection.command(
  "session/resume",
  { sessionId, excludeItems: false },
  { maxAttempts: 1 },
);
```

You get back:

- `resumed.session` — the same `sessionId`, its `workspaceRoot`, `status`,
  `turnCount`, `providerId` and `modelId`.
- `resumed.viewCursor` — where the session now is.
- `resumed.history` — with `excludeItems: false` this is
  `{ mode: "inline", items: [...] }`: the conversation so far.
- `resumed.pendingRequests` — approvals and questions still waiting for you.

Pass `cursor` instead to resume from a specific point.

### 9. Shut down again

Same `close()`. Same clean exit.

## Running without a provider

The default run configures a provider for you. The other mode configures none:

```sh
MUSE_BIN=$PWD/target/release/tbh \
  npm run journey --workspace @muse-code/sdk-quickstart -- --no-provider
```

A host with no provider cannot run a model, so the six steps that need one —
`session-effective-model`, `turn`, `approval`, `cancel`,
`resume-effective-model` and `resume-history` — fail, and the run exits
non-zero. That is the honest answer, not a defect in your setup: this mode
exists to isolate the steps that need no model at all (spawn, handshake,
session lifecycle, resume, clean shutdown) when you are debugging one of them.

**It is not the acceptance run.** The acceptance artifact for issue #21932 is
the default provider-configured run, with all twelve steps passing.

## Testing your own client

```sh
# The binary-free half: the expect-block contract itself.
npm test --workspace @muse-code/sdk-quickstart

# The acceptance run: the whole journey against a real binary.
MUSE_BIN=$PWD/target/release/tbh npm run journey:test --workspace @muse-code/sdk-quickstart
```

`journey:test` never skips itself. If `MUSE_BIN` is missing it fails and tells
you the build command, because an acceptance artifact that quietly skips reads
as proof and is not proof. It runs in the provider-configured mode, so it needs
no credentials either — the same loopback endpoint, started and torn down by
the test.

### Expect-blocks, and why every step above is required

Every one of the twelve steps is required today. The journey asserts what the
protocol is **specified** to do, not what the current host happens to do, so a
step the host cannot yet satisfy carries an *expect-block* naming its open
issues and prints the real failure. Nothing is ever written to match a
known-wrong result: a quickstart that froze the behavior of the day would
become the thing standing in the way of fixing it.

Two rules keep a block honest, and they are what promoted the last of them:

- **A block excuses only the failure it names.** A block carries the signature
  of the failure its issues cause. A blocked step that fails for any other
  reason is a real failure and reds the run.
- **A block that stops being true reds the run.** If a blocked step starts
  passing, the journey exits non-zero with `EXPECT-BLOCK IS STALE`. The fix is
  to delete that step's `expectBlock`, which promotes it to required — the
  promotion is a deletion, because no assertion had been bent to match the
  blocked behavior and so there is nothing to unbend.

While any step carries a block, this README carries a section listing them with
their issue numbers, and `npm test` holds the two to each other in both
directions. That is why there is no such section right now: with nothing
blocked there is nothing to disclose, and a block that came back could not
arrive quietly.

## One note about the SDK gate

`tbh serve` is behind a default-off flag while the protocol is in Developer
Preview, so the journey sets `MUSE_EXPERIMENTAL_SDK_ENABLED` on the child it
spawns. **That is not advice for your application.** It is how this test
harness launches a host today; #21033 owns retiring the gate. Build your client
against `muse serve` as a supported command.

## Where things live

| file                | what it is                                             |
| ------------------- | ------------------------------------------------------ |
| `src/journey.ts`    | the twelve segments, with every assertion, plus the two run modes |
| `src/provider.ts`   | the loopback fake first-party endpoint and the `HOME` that points the host at it — the TypeScript twin of `FakeMetaEndpoint` in `crates/cli/tests/msp_serve_assembly.rs` |
| `src/host.ts`       | spawning, the notification recorder, bounded waits — re-exported from the shared kit in `clients/sdk-cookbook/src/kit/` |
| `src/segments.ts`   | the expect-block contract — re-exported from the same shared kit |
| `src/main.ts`       | the command-line runner                                 |
| `test/journey.test.ts`  | the acceptance run                                  |
| `test/segments.test.ts` | the expect-block contract's own tests               |
