# Quickstart: your first Muse session from TypeScript

This is the shortest complete path from nothing to a working `@muse-code/sdk`
program: start the agent, run a turn, answer its permission request, cancel it,
reload the session later, and shut down. Follow it top to bottom. You do not
need to read the SDK source.

Everything below is executed by `src/journey.ts` in this directory. The code
you read here is the code that runs, so it cannot go stale.

## What you need

- Node 20 or newer.
- An installed `muse` binary (any recent release). Its MSP surface is what
  your program talks to.

## Run it

From a `muse-code-sdk` checkout:

```sh
npm ci
npm run build --workspace @muse-code/sdk
MUSE_BIN=$(command -v muse) npm run journey --workspace @muse-code/sdk-quickstart
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

`MuseClient.spawn` starts your own `muse serve` child and completes the
handshake in one call. You cannot send anything before the handshake
completes; the client you get back is ready to use.

```ts
const client = await MuseClient.spawn({
  args: ["serve"],
  clientInfo: { name: "my_app", version: "1.0.0" },
});
```

Leave out `museBin` and the SDK runs the first `muse` on your `PATH`; pass
`museBin` to pick a binary. `args: ["serve"]` starts the protocol host: a bare
`muse` is the interactive app. The journey also passes `museBin` (the build it
tests), `cwd`, and an `env` with its own `HOME`, so it never touches your real
sessions.

### 2. Check the handshake

`client.initializeResult` tells you who answered: `serverInfo`, `museHome`,
`sessionDurability`, and the protocol `schema.fingerprint`. Compare that
fingerprint with the SDK's `EXPECTED_SCHEMA_FINGERPRINT` if you want to know
whether the two were built from the same schema. A difference is a **warning,
never an error**: an older SDK keeps working against a newer host.

### 3. Start a session

```ts
const session = await client.startSession({ workspaceRoot });
```

`session.sessionId` names the session. The client owns the connection: it
sends each state-changing call with an id it mints, so a retry after a dropped
reply joins the original call instead of starting a second one, and it routes
every event the host pushes to the session it belongs to. The host's reply is
on `session.opening.result`; a new session starts `idle`.

### 4. Run a turn

```ts
const result = await session.run("Reply with the single word: hello");
// result.outcome.kind === "completed", result.finalText === "hello"
```

`run` sends one prompt and resolves once the turn has ended, with the
`outcome`, the final answer text (`finalText`), the turn's `items`, and its
token `usage`. A turn that failed or was cancelled still resolves: read
`result.outcome` to tell. When `outcome.kind` is `"completed"` (the host
reported the turn's end), `outcome.params.terminal` is `"completed"`,
`"cancelled"` or `"failed"`; on `"failed"` it carries
`error` (`kind`, `message`, `retryable`) and usually a display-only `reason`,
except a turn the host died during, which carries `reason` and no `error`.

To stop it, pass an `AbortSignal`:
`session.run(prompt, { signal: AbortSignal.timeout(60_000) })`. A queued turn
is taken back, a running one is cancelled, and `run` rejects with the signal's
reason once the turn has ended.

### 5. Read a turn as it streams

To show the answer while it is still being written, send the turn yourself
and read its items:

```ts
const turn = await session.sendUserTurn({ input: [{ type: "text", text: prompt }] });
for await (const item of turn.items()) {
  // render each item: the prompt, tool calls, the agent's messages
}
const outcome = await turn.completed;
```

`turn.items()` replays what the session already holds for the turn, then
follows it live, and ends when the turn ends. `turn.deltas()` is the live
text as it arrives. A turn can hold several agent messages, each labelled
with a `messagePhase`: `"commentary"` while it works, then the final answer.
`turn.completed` always settles, so an awaited turn cannot hang on a host
that went away.

### 6. Answer a permission request

When the agent wants to do something that needs your consent, the session
calls your handler. Register it before you send the turn:

```ts
session.onApproval(() => ({ choiceId: "allow_once" }));
```

The choices are offered by the host on the request
(`request.availableChoices`); a choice the request did not offer is refused
and reported to `session.onApprovalError` instead of being sent. The approval
is settled when the host's `approval/resolved` arrives, which the session
records in `session.fold.resolvedApprovals()`. The turn then continues.

### 7. Cancel a running turn

```ts
await turn.cancel();
const outcome = await turn.completed;
// outcome.params.terminal === "cancelled"
```

Cancellation is not instant and it is not an error. `cancel()` only asks;
the turn is over when `turn.completed` settles, with the terminal
`"cancelled"`. `turn.interrupt()` is the stop button's version of the same
request.

### 8. Shut the host down cleanly

```ts
await client.close();
const exit = await client.exit;   // { kind: "cleanShutdown" }
```

`close()` closes stdin, and the host drains and exits. The session's writer
lease is released with it — which is what lets a later process load the same
session.

### 9. Reload the session in a new process

Spawn exactly as before, then:

```ts
const resumed = await client.resumeSession({ sessionId, excludeItems: false });
```

The host's reply is on `resumed.opening.result`:

- `session` — the same `sessionId`, its `workspaceRoot`, `status`,
  `turnCount`, `providerId` and `modelId`.
- `viewCursor` — where the session now is.
- `history` — with `excludeItems: false` this is
  `{ mode: "inline", items: [...] }`: the conversation so far.
- `pendingRequests` — approvals and questions still waiting for you. Pass
  `onApproval` to `resumeSession` itself so a waiting approval reaches your
  handler.

Pass `cursor` instead to resume from a specific point.

### 10. Shut down again

Same `close()`. Same clean exit.

## Running without a provider

The default run configures a provider for you. The other mode configures none:

```sh
MUSE_BIN=$(command -v muse) \
  npm run journey --workspace @muse-code/sdk-quickstart -- --no-provider
```

A host with no provider cannot run a model, so the six steps that need one —
`session-effective-model`, `turn`, `approval`, `cancel`,
`resume-effective-model` and `resume-history` — fail, and the run exits
non-zero. That is the honest answer, not a defect in your setup: this mode
exists to isolate the steps that need no model at all (spawn, handshake,
session lifecycle, resume, clean shutdown) when you are debugging one of them.

**It is not the acceptance run.** The acceptance artifact is the default
provider-configured run, with all twelve steps passing.

## Testing your own client

```sh
# The binary-free half: the expect-block contract itself.
npm test --workspace @muse-code/sdk-quickstart

# The acceptance run: the whole journey against a real binary.
MUSE_BIN=$(command -v muse) npm run journey:test --workspace @muse-code/sdk-quickstart
```

`journey:test` never skips itself. If `MUSE_BIN` is missing it fails and tells
you how to point `MUSE_BIN` at a `muse` binary, because an acceptance artifact that quietly skips reads
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

Since the GA flip, `muse serve` runs by default. The journey still sets
`MUSE_EXPERIMENTAL_SDK_ENABLED` on the child it spawns, because the variable
survives as the off-switch and pinning the run open keeps an operator's `off`
in the environment from silently changing what the journey proves. **That is
not advice for your application.** It is how this test harness launches a host
today; the gate now stays as that off-switch, with its eventual retirement
tracked as future cleanup rather than a pending default flip. Build your
client against `muse serve` as a supported command.

## Where things live

| file                | what it is                                             |
| ------------------- | ------------------------------------------------------ |
| `src/journey.ts`    | the twelve segments, with every assertion, plus the two run modes |
| `src/provider.ts`   | the loopback fake first-party endpoint and the `HOME` that points the host at it — the TypeScript twin of the host's `FakeMetaEndpoint` test helper |
| `src/host.ts`       | the isolated host environment, bounded waits and typed readers — re-exported from the shared kit in `clients/sdk-cookbook/src/kit/` |
| `src/segments.ts`   | the expect-block contract — re-exported from the same shared kit |
| `src/main.ts`       | the command-line runner                                 |
| `test/journey.test.ts`  | the acceptance run                                  |
| `test/segments.test.ts` | the expect-block contract's own tests               |
