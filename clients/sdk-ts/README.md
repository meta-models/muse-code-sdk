# `@muse-code/sdk`

The TypeScript SDK for Muse Code: a typed Node client for driving a Muse Code
agent over the Muse Session Protocol (MSP).

- Spawn a `muse serve` host, open and resume sessions, and send turns.
- Stream a turn's items and text deltas as async iterators; await the turn's
  server-authored outcome.
- Answer tool-approval requests with a handler you register — or register
  none and run under the server's own default-deny.
- Answer the agent's questions: list them with
  `session.fold.pendingUserInputs()` and answer with
  `session.answerUserInput`.
- A client-side fold keeps a live, typed view of the session — items, session
  state, pending commands — with gap recovery after dropped deliveries and
  safe same-command retry that can never double-submit.
- Observe the connection itself: `client.onNotification` hears every
  notification the host sends (including ones that name no session, such as
  `usage/changed`), `onProtocolError` hears messages the SDK rejects as
  malformed, and `client.closed` resolves when the connection closes. Each
  `on*` call returns its own unsubscribe function.

**Zero runtime dependencies**: pure TypeScript over the Node standard
library. The MSP wire declarations are bundled into the package, so nothing
else is needed to typecheck against it.

## Install

```sh
npm install @muse-code/sdk
npm install -D @types/node   # required for TypeScript consumers
```

Node 20 or newer. `@types/node` is declared as an **optional peer
dependency**: a JavaScript consumer needs nothing, while a TypeScript
consumer installs it explicitly — without it the declarations that name
`ChildProcess`, `Readable` and friends do not resolve.

You also need the Muse Code CLI: a `muse` binary on `PATH`, or an explicit
path passed at spawn time.

**This package versions in lockstep with Muse Code**: the SDK version is the
Muse Code release it ships with — `@muse-code/sdk X.Y.Z` pairs with Muse Code
`X.Y.Z`. The stable MSP surface follows the product's compatibility posture:
evolution is additive, and a breaking change follows a documented deprecation
and changelog path. Surfaces marked experimental (`x-msp-openness`)
may change or be removed with a changelog entry and no deprecation window. Pin an
exact version, and read the changelog before moving off it.

## Use

```ts
import { MuseClient } from "@muse-code/sdk";

const client = await MuseClient.spawn({
  args: ["serve"],
  clientInfo: { name: "my_app", version: "1.0.0" },
});

const session = await client.startSession({ workspaceRoot: process.cwd() });

const result = await session.run("Summarize this repository.");
console.log(result.finalText);

await client.close();
```

`clientInfo.name` must be a machine identifier: lowercase letters, digits and
`_` only (`[a-z0-9_]+`), at most 64 characters. The host refuses any other
name at `initialize`. `workspaceRoot` must be an absolute path.

`session.run` sends one turn and resolves when the turn has ended, with the
outcome, the final answer text, the turn's items, and its token usage. A turn
that failed or was cancelled still resolves; read `result.outcome` to tell.
The final answer is the last completed agent message that is not commentary.
Pass input parts instead of a string, and the turn options as the second
argument:
`session.run(parts, { reasoningEffort: "high" })`.

To stop it, pass an `AbortSignal`, for example
`session.run(prompt, { signal: AbortSignal.timeout(60_000) })`. A turn still
waiting in the queue is taken back, and a running turn is cancelled. `run`
then waits for the turn to end and rejects with the signal's reason. An
already-aborted signal sends nothing. The signal can stop a turn only after
the host has answered its `turn/start`: if the host stalls before it answers,
`run` keeps waiting until it does, timeout signal or not.

To follow a turn as it runs, send it yourself and read its items:

```ts
const turn = await session.sendUserTurn({
  input: [{ type: "text", text: "Summarize this repository." }],
});
for await (const item of turn.items()) console.log(item);
await turn.completed;
```

`turn.items()` replays what the session already holds before its live tail;
`turn.deltas()` is live-only. `turn.completed` settles on every exit, so an
awaited turn can never hang on a session that ended without an answer.

To approve tool use programmatically, register a handler on the session;
approval choices are server-minted, and a decision the request never offered
is refused and reported rather than sent:

```ts
session.onApproval(async (request) => ({
  choiceId: request.availableChoices[0].choiceId,
}));
```

An approval still pending when you resume a session arrives right after the
resume reply, so pass the handler to `resumeSession` itself:

```ts
const session = await client.resumeSession({
  sessionId,
  onApproval: async (request) => ({
    choiceId: request.availableChoices[0].choiceId,
  }),
  onApprovalError: (failure) => console.error(failure.kind, failure.approvalId),
});
```

Pass `onApprovalError` there too: a failure for an approval that arrived with
the resume reply can happen before `resumeSession` returns, so
`session.onApprovalError` would be too late to hear it. That covers a handler
that throws, picks a choice that was not offered, or adds feedback to a choice
that takes none (which is then answered with the reject choice).

To render incrementally, read `session.events()`: every event the session
folds from then on, with what it changed. Read the current state first, then
subscribe in the same tick, and nothing is missed, including the events that
arrived before `startSession` or `resumeSession` returned:

```ts
const session = await client.startSession();
renderAll(session.fold); // the state so far
for await (const { frame, outcome, item } of session.events()) {
  // `item` is the item as of this event; `session.fold` may already be ahead.
  render(frame.method, outcome.fold, item);
}
```

Each event arrives once, in order, including events the SDK fetches to fill a
gap in delivery. `break` (or an `AbortSignal` passed as
`session.events({ signal })`) stops listening. The stream ends when the
client closes or an ephemeral host dies, and rejects with `MuseHostDiedError`
when a durable host dies, as `turn.items()` does. Reading it changes nothing else:
`turn.unqueue()` still returns the queued input it takes back, and that input
is not repeated on an event.

To also watch what each sub-agent does, step by step, pass
`session.events({ subagents: true })`. Each sub-agent's events arrive in the
same stream, in order with the session's own, with `subagent` set to the
sub-agent they belong to (`itemId`, `subagentId`, `childSessionId`); their
`frame`, `outcome` and `item` are the sub-agent's own:

```ts
for await (const event of session.events({ subagents: true })) {
  if (event.subagent !== undefined) renderStep(event.subagent.subagentId, event.item);
  else render(event.frame.method, event.outcome.fold, event.item);
}
```

The SDK subscribes to each running sub-agent while such a stream is open, and
unsubscribes when the sub-agent finishes or no stream needs it. A sub-agent
already running when the stream opens streams from then on. Approval requests
from a sub-agent still arrive once, on the session, through `onApproval`.
Known limitation: if the host refuses the subscription to a sub-agent
(usually because it already finished, sometimes because it runs on another
host), its steps do not arrive and no reason is given; its start and result
still arrive on the session. A sub-agent resumed after it finished a turn is
not subscribed again, so the steps of that later run do not arrive either.

To answer a question the agent asks, read it from
`session.fold.pendingUserInputs()` and answer it with `session.answerUserInput`,
one answer per question: `selectedLabel` for a single-select question,
`selectedLabels` for a multiple-select one, or `freeText`. The question leaves
the list when the server settles it:

```ts
const [prompt] = session.fold.pendingUserInputs();
const [question] = prompt?.questions ?? [];
if (prompt !== undefined && question !== undefined) {
  await session.answerUserInput(prompt.userInputId, [
    { questionId: question.id, selectedLabel: "Yes" },
  ]);
}
```

To stop a running turn, call `turn.interrupt()` (the stop gesture; pass
`{ retract: true }` to also take the prompt back) or `turn.cancel()`. Both are
requests: the turn is over when `turn.completed` settles. `turn.steer({ input })`
adds input to the running turn, and `turn.unqueue()` takes back a queued one.
The session itself can `fork`, `compact`, `rename`, and `leave`, and switch its
model, reasoning effort, or approval mode (`setModel`, `setReasoningEffort`,
`setApprovalMode`); `client.listModels()` lists the models it accepts.

To send a wire method the facade does not wrap, use `client.command` (a
command: the client mints its `commandId`) or `client.request` (a query).
Params and result are typed from the generated method map; a method the map
does not list is still sent, untyped:

```ts
const ack = await client.command("task/stop", { sessionId, taskId });
const { models } = await client.request("model/list");
```

For a raw connection (`const { connection } = await spawnMspConnection({ ... }).initialize({ ... })`),
`request` and `command` are typed the same way, and `addNotificationListener` gives one
notification method's typed params:

```ts
connection.addNotificationListener("turn/completed", (params) => {
  console.log(params.turnId, params.terminal);
});
```

Status: developer preview. The facade — spawn, session open/resume, turns,
approvals, questions, and recovery after dropped deliveries — is complete and covered by
the conformance suites in the source repository.

## Not yet available

`@muse-code/acp` is not published on npm and is not part of this public
repository. There is no supported ACP adapter to install today; please do not
depend on that package name. If an ACP adapter ships, it will be announced in
a public release.

## Documentation

- Guides, cookbook recipes, and the protocol reference:
  <https://meta-models.github.io/muse-code-sdk/>
- TypeScript API reference:
  <https://meta-models.github.io/muse-code-sdk/next/generated/sdk/>
- Source and issues: <https://github.com/meta-models/muse-code-sdk>
