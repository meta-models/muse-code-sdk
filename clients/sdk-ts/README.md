# `@muse-code/sdk`

The MSP TypeScript facade (tdd SS7.1). Owning spec: `specs/14990-muse-sdk/`.

**Zero runtime dependencies** (INV-009): pure TypeScript over `@muse-code/msp` plus
the Node standard library. A proposed runtime dependency is an owner
escalation under the #211 O-3 precedent — official protocol-owner SDKs,
pinned exact, supply-chain reviewed — not a local decision.

**Nothing is published to npm** before 1.0 (tdd D-013).

## The loop

```sh
cd projects/tbh
npm ci          # installs the pinned workspace devDependencies from the lockfile
npm run check   # tsc --strict over both packages
npm test        # build + node:test; TEST-009 builds/runs the Rust serve-fixture
```

CI runs exactly this in the non-required, path-filtered `tbh-muse-sdk-ts`
workflow.

## Consuming this package (#211 and #210)

Both in-repo consumers import from the package barrel; nothing reaches into
`src/` paths, and nothing re-derives a rule the core already holds.

**Fold a canned or live event stream.** `Session` composes the two stores, the
SS4.13 pending set, and the per-turn handles. Feed it `ViewEvent`s — a wire
notification's `method` paired with its generated params object — and read the
fold:

```ts
import { readSessionDurability, Session } from "@muse-code/sdk";

const session = new Session({
  sessionId,
  durability: readSessionDurability(initializeResult), // never defaulted; see below
});

const turn = session.turn(turnId);          // a handle, before or after its events

// Events enter HERE and only here — `session.fold` is read-only, so turn
// routing cannot be bypassed. Nothing below settles until they arrive.
for (const event of viewEvents) session.apply(event); // {method, params} per notification

for await (const item of turn.items()) render(item);
const outcome = await turn.completed;        // settles on EVERY no-run exit (INV-014)
```

`turn.completed` resolves `{kind: "completed"}`, `{kind: "unqueued"}` for a
reclaimed queued submit, or `{kind: "terminalUnknown"}` after an ephemeral host
death. For the launch-failure exit (`"deferred_start_failed"`) branch on the
wire marker via `isLaunchFailure(outcome)` — `terminal: "failed"` plus
`error.kind: "launchError"`. Do **not** read `observedStart: false` as that
marker: it is a session-local observation and is also false for a legitimate
terminal-first fold (a single-shot turn, a gap fill, or a consumer that
attached mid-stream).

The two async iterators end when the turn settles and never on a local
timeout. `items()` replays what the fold already holds for the turn before its
live tail. **`deltas()` is live-only** — nothing is replayed to a
late-attached iterator, because the store keeps accumulated field text
(`fold.items.accumulated(itemId)`) rather than the delta event sequence.

**A dropped delivery is a pause, not a hole.** When a slow subscription
overflows, the host sends `view/gap` and the SDK recovers by the SS4.8
splice-fill without the consumer doing anything: `session.fold.current` goes
false, the live tail is held, `view/page` walks `(after, next)`, and the paged
prefix then the held tail reach the iterators in cursor order. Deltas lost in
the hole stay lost by design (the fill lands final item states, not the delta
sequence). A fill that cannot complete is reported — never swallowed:

```ts
session.onGapError((failure) => {
  // MuseGapFillError: `reason` ("noConnection" | "pageFailed" | "pageStalled")
  // plus the hole's own opaque `after`/`next`.
  report(failure);
  // `session.fold.current` stays false and `session.fold.pendingGap` still
  // names the hole; recovering from there (a resume, or D-030's re-anchor) is
  // the consumer's call.
});
```

**Open sessions and submit through the facade.** `MuseClient.spawn` owns the
host, runs the SS1.4 handshake, and reads `sessionDurability` off it, so a
consumer never re-derives the SS2.13.1 profile by hand:

```ts
import { MuseClient } from "@muse-code/sdk";

const client = await MuseClient.spawn({
  museBin: "muse",
  args: ["serve"], // spawn passes args through verbatim; a bare `muse` is the TUI
  clientInfo: { name: "dm", version: "1.0.0" },
});

const session = await client.startSession({ workspaceRoot });
// or: await client.resumeSession({ sessionId, cursor })
session.opening;                      // the typed wire result, by verb

const turn = await session.sendUserTurn({ input: [{ type: "text", text }] });
for await (const item of turn.items()) render(item);
await turn.completed;

session.onApproval(async (request) => ({ choiceId: request.availableChoices[0].choiceId }));
session.onApprovalError((failure) => report(failure));

await client.close();                 // orderly SS2.1.2 shutdown; NOT a death
```

The returned `Turn` IS the handle this session routes events to — not a copy —
and the submit is visible as an optimistic SS4.13 pending entry from the moment
it is sent, before the ack. Approval choices are **server-minted only** (D-006):
a `choiceId` the request never offered is refused before the frame is built and
reported to `onApprovalError`. Registering no handler at all is the supported
posture, not a degraded one (D-008): the client runs under the server's own
default-deny and this SDK parks nothing.

`session.apply(...)` returns `io` alongside `retirements` — a promise for the
client→server I/O that event triggered (an SS4.13 replay, an approval decision).
Awaiting it is optional and always safe; it never rejects.

**Discharge the host-death obligation.** Read the profile from the handshake
once, then hand every death notification to the session. SS2.13.3b names TWO —
the process exit AND transport EOF — and `MuseClient` reports the EOF half
itself, because it is the only layer that knows whether the close was its own:

```ts
const discharge = session.hostExited(await child.exit);
// or, from MuseClient's own wiring: session.hostExited({ kind: "transportEof" })
```

Exit 0 is not a death and discharges nothing. A **durable** session's abnormal
death also discharges nothing — its terminals arrive on resume (FM-001) — and
only rejects the live turn-waits with the classification. An **ephemeral** one
marks every still-`inProgress` item terminal-unknown, retires every pending
command, refuses further events, and permanently refuses `commandId` replay
(tdd SS2.13.3b) — across every session the same client opens, and it withholds
`resumeSession` for the discharged session rather than reattaching. An **unrecognized** `sessionDurability` is treated exactly
like ephemeral: SS2.13.1 forbids inferring a durability guarantee from a value
this SDK predates, and the absent-means-durable rule keys on the member being
*missing*, not on its value being unfamiliar.

**Report defects here, not in the adapter.** A fold rule the core gets wrong
is a #14990 bug; a fixture the fold cannot consume is a #210 fixture request.
Neither is ever patched locally in `@muse-code/acp` (spec Sibling lanes).

## What is here (slices 1 and 2, and slice 3 in full)

- `src/fingerprint.ts` — the schema staleness anchor. `EXPECTED_SCHEMA_
  FINGERPRINT` is test-bound to `schema/msp/stable/manifest.json`, so a schema
  advance that forgets the SDK reds this lane. **A red fingerprint means
  "re-pin after a schema advance", not "the SDK is broken"** — the failure
  message says so.
- `src/fold/item-store.ts` — the item half of the SS4 fold: upsert-by-revision
  (replace iff strictly higher) and per-field delta accumulation whose
  concatenation equals the final committed value.
- `src/fold/state-store.ts` — the session-state half: replace-wholesale,
  cursor-ordered, latest-wins; an explicit `null` clears and is a fact.
- `src/pending/pending-command-set.ts` — the complete SS4.13 `PendingCommand`
  fold (decision record D-032): deterministic anchoring, the four retirement
  arms, nothing-admitted holds, queue-movement re-verification, the five
  snapshot-join arms with `queuedTurns` reordering, the no-snapshot reconnect
  rules, and the ephemeral-profile discard obligation.
- `src/connection/connection.ts` — the transport-less NDJSON connection:
  awaited serialized writes, bounded inbound framing, request correlation,
  typed `data.kind` errors, server-request routing, and the UUIDv7
  `commandId` retry/value-identical-ack contract. A process binding supplies
  the duplex transport.
- `src/connection/spawn.ts` — the owned Node stdio process binding. Before
  handshake it exposes no send method; `initialize` sends the SS1.4 sequence
  exactly once and returns the ready connection, negotiated capabilities,
  fingerprint warning (when any), stderr-forwarding seam, and the bounded
  close path. `MuseServeChild` captures a bounded 8 KiB / 100-line stderr
  tail from birth, maps every process exit through the SS2.11 table, and
  exposes the same owned child on the handshake and initialized connection.
  `close()` is the only termination surface and it is bounded: stdin EOF
  first so the host can drain (SS2.1.2), then `SIGTERM` and one `SIGKILL`
  escalation once `shutdownTimeoutMs` (default 30 s) has passed, and it
  resolves on the exit actually observed — so a wedged host is the crash row
  carrying the delivered signal, never a synthesized clean shutdown. It ends
  once the child's stdio closes; on POSIX the SDK spawns the host as the
  leader of an SDK-owned process group and the TERM/KILL stages signal that
  group ([#22777](https://github.com/mslsrc/tbh/issues/22777)), so a
  grandchild that inherited the host's stdout is ended with the host and
  cannot stall the close. On Windows the ladder still signals only the
  child — no subtree containment is claimed there (spec FR-017b).
- `src/fold/session-fold.ts` — the two stores bound to the generated view
  types, plus the turn lifecycle and the approval/user-input view events as
  fold inputs. A compile-time assertion fails if a later #206 enrollment adds
  a view notification the fold would silently ignore.
- `src/facade/session.ts` — `Session`: the fold, the pending set, per-turn
  event routing, and the SS2.13.3b host-death discharge.
- `src/facade/gap-fill.ts` — the SS4.8 splice-fill: the live-frame buffer, the
  `view/page` walk bounded by progress rather than by an attempt cap, and the
  cursor-equality overlap discard. Only the splice-fill path is built; D-030's
  re-anchor alternative is the #208 lane's spec work.
- `src/facade/turn-handle.ts` — `TurnHandle`: the SS3.1.4 turn-wait and the
  fold-backed `items()`/`deltas()` iterators.
- `src/facade/host-death.ts` — reading `sessionDurability` off the handshake
  (SS2.13.1) and classifying an exit as abnormal (SS2.11).
- `test/helpers/tolerance-corpus-runner.ts` — #210's workspace-only TEST-008
  runner. It discovers the three `sdk-tolerance` manifests, feeds item events
  through `ItemStore<Item>`, and preserves every notification for lossless
  tolerance assertions. It does not duplicate #14990 T019's `SessionFold`.

## `qa/` — the `--area sdk` black-box QA driver

`qa/` is **not part of the shipped facade**. It is a QA driver (issue #22764,
spec 14990 Scenario 6) that plays an external integrator: it reaches
`@muse-code/sdk` only through `src/index.ts`, spawns the real `tbh serve` binary
over MSP stdio, and tees every wire byte so each finding can be stated as
"public API said X, wire said Y". A finding without both halves is refused at
construction, and the driver never files anything — the auto-qa procedure
(`specs/2159-auto-qa-skill`, `--area sdk`) does that.

```sh
cd projects/tbh
CARGO_TARGET_DIR=$(scripts/probe-env.sh --print) cargo build -p tbh-cli --bin tbh
export MUSE_QA_SDK_BIN=$CARGO_TARGET_DIR/debug/tbh
npm run qa:sdk -- --json /tmp/sdk-qa.json --markdown /tmp/sdk-qa.md
```

Without `MUSE_QA_SDK_BIN` (or a `tbh` in `target/debug`) the driver exits 2 and
runs nothing: it never substitutes a fixture host, because a green pass against
a canned transcript would prove nothing about the product. For the same reason
its real-binary contract arm reports a loud non-pass rather than a silent skip —
building `tbh` is a multi-minute Rust build that does not belong in this Node
lane, so CI runs the rest and the QA procedure, which always has a binary,
carries that coverage.

Every finding also carries a **facade-vs-binary** component decided by replaying
the captured host frames into a fresh SDK with no binary present. `facade` is a
bug in this package; `binary` is a bug in `tbh`.

## What is not here yet, and what it waits on

No gap below waits on a wire shape any more — #24021 enrolled the last one,
`view/gap` — and the facade itself is complete: `MuseClient.spawn`, the two
session verbs returning a `Session`, `sendUserTurn`, and
`session.onApproval`'s idempotent `approval/decide` landed with #23980 against
the #22946 command-plane enrollment, and the SS4.8 in-iterator splice-fill
landed with T032 against the #24021 one. The condition
and the command that re-derives what remains live once, in
`specs/14990-muse-sdk/tasks.md` under "The slice-3 blocker" — INV-001 holds
with no exception, so a shape the generated layer lacks is a #206 enrollment
request, never a local interface.

| Missing | Waits on |
| --- | --- |
| Snapshot ingestion + splice against a real `Snapshot` (FR-008, TEST-006) | Nothing shape-side: the object is the generated `ViewSnapshot` (#22946) and A-5's two one-family fixtures are in `schema/msp/transcripts/`. Sequenced behind spec 210 T061's host-generated corpus regeneration ([#18953](https://github.com/mslsrc/tbh/issues/18953)), which flips those fixtures' provenance. The store-level seed+splice algebra IS covered. |
| Corpus replay + checkpoint equality (TEST-001/007) | Its own PR (plan slice 1c): the golden transcripts LANDED with [#14951](https://github.com/par-msl/tbh/pull/14951) (merged 2026-08-13) and sit in `schema/msp/transcripts/`. Same T061 sequencing as the row above. |
| D-030's re-anchor recovery (drop folded state, re-anchor at the latest compaction snapshot) | The owning [#208](https://github.com/mslsrc/tbh/issues/208) lane's spec work: when each path is sane, and how a re-anchor interacts with buffered live events, is theirs to state (tdd SS4.8). This package builds the OTHER sanctioned path, splice-fill, which is complete (T032/FR-020) — the server requires neither and holds no partial-fill state. |

## Why the stores are generic

The concrete item/event payload types are generated, not written here
(INV-001). The stores were built while the session-view plane was still being
enrolled, so they state only the *algebraic precondition* each rule needs —
an item has an identity and a revision — and take the payload as a type
parameter. #14953 landed 2026-08-13, and `SessionFold` now binds those
parameters to `@muse-code/msp`'s types with no change to the fold logic and no
protocol shape ever restated locally.

The same discipline is why `ItemStore.markEphemeralHostDeath` asks its caller
for an `isInProgress` probe instead of reading `item.status` itself: the store
stays wire-shape-blind, and `src/facade/host-death.ts` supplies the probe
where `tsc` checks the field and its value against the generated `Item`.
