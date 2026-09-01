/**
 * Recipe: survive the host dying under you.
 *
 * Hosts die. A crash, an out-of-memory kill, an operator's stray signal — none
 * of them ask your app first. What this recipe teaches is the durability fork
 * every embedder has to get right:
 *
 *  - read `sessionDurability` off the handshake with `readSessionDurability`
 *    BEFORE you need it (absent means durable; an unrecognized value
 *    guarantees NOTHING and must never fall through to durable);
 *  - when the host dies, report the death to every session (`Session.
 *    hostExited`) and branch on the discharge it returns:
 *      durable   -> live waits reject with `MuseHostDiedError`, the stores are
 *                   left exactly as observed, and the terminals reconcile when
 *                   you resume the session on a fresh host;
 *      ephemeral -> the obligation discharges in full: in-progress items come
 *                   back annotated terminal-unknown, pending commands are
 *                   retired with their inputs handed back (and deliberately NO
 *                   composer restore), and reattaching is off the table;
 *  - an orderly close is NOT a death: `hostExited` answers `notADeath` and
 *    the session stays usable.
 *
 * Two arms, mirroring that fork:
 *
 *  - the DURABLE arm runs against the release-built `muse serve`: it reads the
 *    durable profile off the real handshake, kills the host mid-session with
 *    SIGKILL, watches the SDK classify the exit as a crash, sees a live turn
 *    wait reject instead of hang, and then resumes the same session on a
 *    freshly spawned host to prove the state survived.
 *  - the EPHEMERAL arm is transport-less on purpose: the real host declares a
 *    durable profile, so the recipe constructs a `Session` with the ephemeral
 *    profile directly — the SDK's sanctioned fold-only form — seeds it with
 *    applied view events and a pending command, and discharges it with a
 *    synthetic crash row. Synthesizing the profile is how the arm stays
 *    deterministic and headless; it is not how an application should pick a
 *    profile (always read the handshake).
 *
 * HARNESS PLUMBING, NOT CLIENT GUIDANCE: the SDK deliberately exposes no pid
 * or kill on its public surface — an external death does not come through the
 * SDK. To deliver one on demand, the journey launches the host through a
 * three-line shell wrapper that prints the host's pid on stderr (captured via
 * the SDK's own `onStderr` tap) and `exec`s the real binary, so the printed
 * pid IS the host's pid. Your application never does this; the host that dies
 * under you needs no help.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DiscardedSessions,
  MuseClient,
  MuseHostDiedError,
  MuseSessionDiscardedError,
  readSessionDurability,
  Session,
} from "@muse-code/sdk";
import type { ExitClassification, HostDeathDischarge, TurnOutcome } from "@muse-code/sdk";
import type { InitializeResult, Item } from "@muse-code/msp";

import { TimeoutError, equals, isolatedHostEnv, within } from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const EXIT_BUDGET_MS = 15_000;
const SETTLE_BUDGET_MS = 10_000;
const CLOSE_BUDGET_MS = 30_000;

/** The stderr marker the shell wrapper prints. Test plumbing; see the header. */
const PID_MARKER = "muse-cookbook-host-pid";

/**
 * A wait's settlement, captured without letting a rejection escape: the whole
 * point of the durable arm is that this promise REJECTS, so the handler is
 * attached the moment the wait exists.
 */
type Settled =
  | { readonly kind: "resolved"; readonly outcome: TurnOutcome }
  | { readonly kind: "rejected"; readonly error: unknown };

function capture(wait: Promise<TurnOutcome>): Promise<Settled> {
  return wait.then(
    (outcome) => ({ kind: "resolved", outcome }),
    (error) => ({ kind: "rejected", error }),
  );
}

interface Context {
  readonly museBin: string;
  /** Shared by BOTH hosts, so the durable session's state persists across them. */
  readonly home: string;
  readonly workspaceRoot: string;
  clientA?: MuseClient;
  hostPid?: number;
  sessionA?: Session;
  sessionId?: string;
  /** The wait registered before the death; the durable arm asserts it rejects. */
  doomedWait?: Promise<Settled>;
  exitRow?: ExitClassification;
  clientB?: MuseClient;
  sessionB?: Session;
  /** The transport-less ephemeral arm's session and its latched discharge. */
  ephemeral?: Session<string>;
  ephemeralDischarge?: HostDeathDischarge<string>;
  /** The client-scoped discard registry the ephemeral discharge writes into. */
  discarded?: DiscardedSessions;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`no ${what}: an earlier segment did not finish`);
  return value;
}

/**
 * Spawn a host through `MuseClient.spawn` — the facade this page teaches.
 *
 * `killable` selects the wrapper described in the header: `$$` is the shell's
 * own pid and `exec` REPLACES the shell with the host binary, so the pid the
 * marker names is the pid the host runs under. The plain arm launches the
 * binary directly; nothing kills that host, so it needs no marker.
 */
async function spawnHost(
  context: Context,
  killable: boolean,
): Promise<{ client: MuseClient; stderr: () => string }> {
  let stderrText = "";
  const shared = {
    clientInfo: { name: "muse_sdk_cookbook", version: "0.0.0" },
    cwd: context.workspaceRoot,
    env: isolatedHostEnv(context.home),
    onStderr: (chunk: string) => {
      stderrText += chunk;
    },
  };
  const client = await within(
    "the MSP handshake",
    HANDSHAKE_BUDGET_MS,
    killable
      ? MuseClient.spawn({
          ...shared,
          museBin: "/bin/sh",
          args: ["-c", `echo "${PID_MARKER}=$$" >&2; exec "$0" serve`, context.museBin],
        })
      : MuseClient.spawn({ ...shared, museBin: context.museBin, args: ["serve"] }),
  );
  return { client, stderr: () => stderrText };
}

/** Wait for the wrapper's pid marker to land on the recorded stderr. */
async function hostPid(stderr: () => string, budgetMs: number): Promise<number> {
  const deadline = Date.now() + budgetMs;
  const marker = new RegExp(`${PID_MARKER}=(\\d+)`);
  for (;;) {
    const match = marker.exec(stderr());
    if (match?.[1] !== undefined) return Number(match[1]);
    if (Date.now() > deadline) throw new TimeoutError("the host pid marker on stderr", budgetMs);
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * A synthetic handshake result for the transport-less arm. Only
 * `sessionDurability` matters here; everything else is the minimum the type
 * requires. An application never builds one of these — it reads the real
 * result off `MuseClient.spawn` / `MspHandshake.initialize`.
 */
function syntheticHandshake(sessionDurability?: string): InitializeResult {
  return {
    experimentalApi: false,
    grantedCapabilities: [],
    museHome: "/nowhere/.muse",
    platformFamily: "unix",
    platformOs: "linux",
    schema: { fingerprint: "sha256:0", version: 1 },
    serverInfo: { name: "a-host-that-never-ran", version: "0.0.0" },
    userAgent: "a-host-that-never-ran/0.0.0",
    ...(sessionDurability === undefined ? {} : { sessionDurability }),
  };
}

const EPHEMERAL_SESSION_ID = "an-ephemeral-conversation";

/** An `item/started` view event for the fold-only arm. */
function itemStarted(item: Item, viewCursor: string): { method: string; params: unknown } {
  return {
    method: "item/started",
    params: { item, sessionId: EPHEMERAL_SESSION_ID, viewCursor },
  };
}

/** The synthetic crash row the ephemeral arm discharges with. */
const SIGKILL_ROW: ExitClassification = {
  exitCode: null,
  exitSignal: "SIGKILL",
  kind: "crash",
  stderrTail: [],
};

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "spawn-and-read-durability",
    title: "Spawn the release host and read its durability profile off the handshake",
    async run(context) {
      const spawned = await spawnHost(context, true);
      context.clientA = spawned.client;
      context.hostPid = await hostPid(spawned.stderr, SETTLE_BUDGET_MS);
      // Read the profile the moment you have the handshake — after the host
      // dies is too late to ask it. The release host's sessions are durable.
      const profile = readSessionDurability(context.clientA.initializeResult);
      equals(profile.kind, "durable", "the release host's durability profile");
    },
  },
  {
    id: "start-a-session-and-follow-a-turn",
    title: "Start a session and register a turn wait the host will never answer",
    async run(context) {
      const client = must(context.clientA, "spawned client");
      context.sessionA = await within(
        "session/start",
        COMMAND_BUDGET_MS,
        client.startSession({ workspaceRoot: context.workspaceRoot }),
      );
      context.sessionId = context.sessionA.sessionId;
      // A consumer following a turn is a promise held across the death. This
      // turn id gets no answer — deliberately: what the durable arm proves is
      // that the death REJECTS the wait instead of leaving it hanging forever,
      // and a wait that settles on its own before the kill could not prove it.
      const wait = context.sessionA.turn("a-turn-you-were-following").completed;
      context.doomedWait = capture(wait);
      // And a command in flight: a client-side pending record, exactly like
      // the ephemeral arm's. The durable arm's promise is that a death
      // touches NONE of this — the entry must survive the kill untouched.
      context.sessionA.pending.submitted({
        commandId: "cmd-durable-1",
        input: "work in flight",
      });
    },
  },
  {
    id: "the-host-dies",
    title: "SIGKILL the host mid-session and read the SDK's exit classification",
    async run(context) {
      const client = must(context.clientA, "spawned client");
      const pid = must(context.hostPid, "host pid");
      // The death itself: from OUTSIDE the SDK, exactly like the OOM killer.
      process.kill(pid, "SIGKILL");
      const exit = await within("the exit classification", EXIT_BUDGET_MS, client.exit);
      equals(exit.kind, "crash", "the SDK's reading of the exit");
      if (exit.kind !== "crash") throw new Error("unreachable");
      // A signal kill has NO exit code; the signal is the whole diagnostic.
      equals(exit.exitCode, null, "a signal kill's exit code");
      equals(exit.exitSignal, "SIGKILL", "the signal that ended the host");
      context.exitRow = exit;
    },
  },
  {
    id: "durable-death-rejects-the-waiters",
    title: "The durable discharge: waits reject with MuseHostDiedError, nothing is discarded",
    async run(context) {
      const session = must(context.sessionA, "started session");
      const exit = must(context.exitRow, "exit classification");
      // Report every notification of the death. The client already reported
      // the transport EOF the kill produced; this reports the process exit.
      // Whichever arrives first latches the discharge — a later report replays
      // it and settles anything the drain left open, so double-reporting is
      // not just safe, it is required.
      const discharge = session.hostExited(exit);
      equals(discharge.kind, "durableDeath", "the discharge arm for a durable session");
      equals(discharge.profile.kind, "durable", "the profile the discharge names");

      // The wait registered before the death is REJECTED — not hung, not
      // resolved with an invented terminal.
      const settled = await within(
        "the followed turn's wait settling",
        SETTLE_BUDGET_MS,
        must(context.doomedWait, "captured turn wait"),
      );
      equals(settled.kind, "rejected", "a durable death rejects a live turn wait");
      if (settled.kind !== "rejected") throw new Error("unreachable");
      if (!(settled.error instanceof MuseHostDiedError)) {
        throw new Error(`the wait rejected with ${String(settled.error)}, not MuseHostDiedError`);
      }

      // FM-001's other half: NOTHING is discarded. The items and pending
      // commands are left exactly as observed; their terminals arrive when
      // the session resumes on a fresh host.
      equals(session.pending.discarded, false, "a durable death discards no pending commands");
      const survivor = session.pending.get("cmd-durable-1");
      equals(survivor?.commandId, "cmd-durable-1", "the pending command after the death");
      equals(survivor?.input, "work in flight", "the pending command's input, untouched");

      // Asking about a turn AFTER the death inherits the rejection instead of
      // hanging: no answer is coming on this connection.
      const late = await within(
        "a post-death turn wait settling",
        SETTLE_BUDGET_MS,
        capture(session.turn("a-turn-asked-about-after-the-death").completed),
      );
      equals(late.kind, "rejected", "a wait registered after a durable death");
      if (late.kind !== "rejected") throw new Error("unreachable");
      if (!(late.error instanceof MuseHostDiedError)) {
        throw new Error(`the late wait rejected with ${String(late.error)}, not MuseHostDiedError`);
      }
    },
  },
  {
    id: "resume-on-a-fresh-host",
    title: "Spawn a fresh host and resume the same session: the state survived",
    async run(context) {
      const sessionId = must(context.sessionId, "session id");
      const spawned = await spawnHost(context, false);
      context.clientB = spawned.client;
      equals(
        readSessionDurability(context.clientB.initializeResult).kind,
        "durable",
        "the fresh host's durability profile",
      );
      const resumed = await within(
        "session/resume",
        COMMAND_BUDGET_MS,
        context.clientB.resumeSession({ sessionId, excludeItems: false }),
      );
      context.sessionB = resumed;
      equals(resumed.sessionId, sessionId, "the resumed session's id");
      if (resumed.opening?.verb !== "session/resume") {
        throw new Error("the session did not open through session/resume");
      }
      const info = resumed.opening.result.session;
      equals(info.sessionId, sessionId, "the session the fresh host loaded");
      // The session's own record of its workspace survived the SIGKILL: this
      // is state the DEAD host wrote and the fresh host read back.
      equals(info.workspaceRoot, context.workspaceRoot, "the workspace root after the crash");
    },
  },
  {
    id: "an-orderly-close-is-not-a-death",
    title: "Close the fresh host cleanly and see hostExited answer notADeath",
    async run(context) {
      const client = must(context.clientB, "fresh client");
      const session = must(context.sessionB, "resumed session");
      await within("the orderly drain", CLOSE_BUDGET_MS, client.close());
      const exit = await within("the exit classification", EXIT_BUDGET_MS, client.exit);
      equals(exit.kind, "cleanShutdown", "the exit row after an orderly close");
      // The third discharge arm: an orderly exit is the ONE row where the
      // drain completed and the durable records were written. Nothing
      // discharges, no wait is disturbed, and the session object stays valid.
      const discharge = session.hostExited(exit);
      equals(discharge.kind, "notADeath", "an orderly close discharges nothing");
      context.clientB = undefined;
    },
  },
  {
    id: "read-the-ephemeral-and-unrecognized-profiles",
    title: "The three durability readings: absent, ephemeral, and unrecognized",
    async run() {
      // Absent is DECIDABLE, not fabricated: the member is optional only so
      // adding it was additive, and no host that omits it is ephemeral.
      equals(
        readSessionDurability(syntheticHandshake()).kind,
        "durable",
        "an absent sessionDurability",
      );
      equals(
        readSessionDurability(syntheticHandshake("ephemeral")).kind,
        "ephemeral",
        "a declared ephemeral profile",
      );
      // The sharpest clause, and the one implementations get wrong by writing
      // `value === "ephemeral" ? ephemeral : durable`: a value this SDK has
      // never heard of guarantees NOTHING. Assume nothing survives that host.
      const unknown = readSessionDurability(syntheticHandshake("holographic"));
      equals(unknown.kind, "unrecognized", "a durability value this SDK predates");
      // And the consequence, witnessed, not just taught: an abnormal death on
      // the unrecognized profile discharges exactly as ephemeral does.
      const assumeNothing = new Session<string>({
        sessionId: "a-session-on-an-unknown-profile",
        durability: unknown,
      });
      equals(
        assumeNothing.hostExited(SIGKILL_ROW).kind,
        "discharged",
        "an unrecognized profile's abnormal death",
      );
    },
  },
  {
    id: "ephemeral-death-discharges-in-full",
    title: "An ephemeral host's death: terminal-unknown items, retired commands, settled waits",
    async run(context) {
      // Fold-only construction is the SDK's sanctioned transport-less form —
      // and the honest way to demo this arm headlessly, because the real host
      // declares durable. An application reads the profile off the handshake.
      // The discard registry is client-scoped state: a discharge writes the
      // dead session's id and its retired commandIds into it, and those facts
      // are what a client's resume refusal and replay refusal read.
      context.discarded = new DiscardedSessions();
      const session = new Session<string>({
        sessionId: EPHEMERAL_SESSION_ID,
        durability: readSessionDurability(syntheticHandshake("ephemeral")),
        discarded: context.discarded,
      });
      context.ephemeral = session;
      // One in-progress item, one already-terminal item, one pending command,
      // one live turn wait: each clause of the discharge gets a witness.
      session.apply(
        itemStarted(
          { itemId: "tool-1", kind: "toolCall", revision: 1, status: "inProgress", turnId: "turn-1" },
          "v:1",
        ),
      );
      session.apply(
        itemStarted(
          { itemId: "msg-1", kind: "agentMessage", revision: 1, status: "completed", turnId: "turn-1" },
          "v:2",
        ),
      );
      session.pending.submitted({ commandId: "cmd-1", input: "and fix the flaky test" });
      const wait = capture(session.turn("turn-1").completed);

      const discharge = session.hostExited(SIGKILL_ROW);
      equals(discharge.kind, "discharged", "the discharge arm for an ephemeral session");
      if (discharge.kind !== "discharged") throw new Error("unreachable");
      context.ephemeralDischarge = discharge;

      // In-progress items come back annotated terminal-unknown — the item
      // that already completed is left alone, and no completion is invented.
      equals(discharge.terminalUnknownItems.length, 1, "one item was still in progress");
      equals(discharge.terminalUnknownItems[0]?.itemId, "tool-1", "the in-progress item");
      equals(
        discharge.terminalUnknownItems[0]?.kind,
        "terminalUnknown",
        "the annotation's kind",
      );

      // Pending commands are retired with their INPUT handed back, so your UI
      // can show the user what was in flight. Deliberately NO composer
      // restore: the client does not know whether the work ran, and inviting
      // a resubmit is inviting a double execution.
      equals(discharge.retiredCommands.length, 1, "one command was pending");
      const retired = discharge.retiredCommands[0];
      equals(retired?.commandId, "cmd-1", "the retired command");
      equals(retired?.kind, "terminalUnknown", "the retirement's kind");
      if (retired?.kind !== "terminalUnknown") throw new Error("unreachable");
      equals(retired.input, "and fix the flaky test", "the input handed back");
      if (Object.hasOwn(retired, "restoreToComposer")) {
        throw new Error("a terminal-unknown retirement must not offer a composer restore");
      }

      // The live wait SETTLES — resolved with the terminal-unknown outcome,
      // not rejected: for an ephemeral session "stop waiting" is an answer.
      const settled = await within("the turn wait settling", SETTLE_BUDGET_MS, wait);
      equals(settled.kind, "resolved", "an ephemeral discharge settles live waits");
      if (settled.kind !== "resolved") throw new Error("unreachable");
      equals(settled.outcome.kind, "terminalUnknown", "the settled outcome");
    },
  },
  {
    id: "after-a-discharge-nothing-lies",
    title: "The discharged session refuses new events, new submits, and reattachment",
    async run(context) {
      const session = must(context.ephemeral, "discharged ephemeral session");
      const discharge = must(context.ephemeralDischarge, "latched discharge");
      // No more folding: a trailing drain frame is refused, never woven into
      // a transcript the client was told to discard.
      const refused = session.apply(
        itemStarted(
          { itemId: "tool-2", kind: "toolCall", revision: 1, status: "inProgress" },
          "v:3",
        ),
      );
      equals(refused.fold.kind, "refusedSessionDiscarded", "folding after a discharge");
      // No new submits either — a command accepted now would be retired
      // "we don't know whether this ran" about input never sent to any host.
      let refusedSubmit = false;
      try {
        session.pending.submitted({ commandId: "cmd-2", input: "one more thing" });
      } catch (error) {
        refusedSubmit = error instanceof MuseSessionDiscardedError;
      }
      equals(refusedSubmit, true, "submitting after a discharge throws MuseSessionDiscardedError");
      // Asking about an unknown turn settles terminal-unknown on the spot
      // rather than hanging a wait no host will ever answer.
      const late = await within(
        "a post-discharge turn wait settling",
        SETTLE_BUDGET_MS,
        capture(session.turn("turn-asked-about-too-late").completed),
      );
      equals(late.kind, "resolved", "a wait registered after the discharge settles");
      if (late.kind !== "resolved") throw new Error("unreachable");
      equals(late.outcome.kind, "terminalUnknown", "the late wait's settled outcome");
      // The discharge recorded its facts in the client-scoped registry — the
      // exact reads behind "do not reattach" and "do not replay these ids".
      const discarded = must(context.discarded, "discard registry");
      equals(discarded.sessionIds.has(EPHEMERAL_SESSION_ID), true, "the dead session is recorded");
      equals(discarded.commandIds.has("cmd-1"), true, "the retired commandId is recorded");
      // A second notification of the SAME death replays the SAME discharge —
      // the retired inputs are a one-shot delta, and replaying the first
      // report is what keeps a client reading the later notification from
      // silently losing them.
      equals(session.hostExited(SIGKILL_ROW), discharge, "a repeat report replays the discharge");
    },
  },
];

export const surviveTheHostDying: Recipe = {
  id: "survive-the-host-dying",
  title: "Survive the host dying under you",
  docsPage: "developer-docs/src/content/docs/cookbook/survive-the-host-dying.mdx",
  needs: ["museBin"],
  async run(hosts: RecipeHosts): Promise<JourneyReport> {
    const museBin = hosts.museBin;
    if (museBin === undefined) throw new Error("museBin is required");
    const context: Context = {
      museBin,
      home: await mkdtemp(join(tmpdir(), "muse-cookbook-home-")),
      workspaceRoot: await mkdtemp(join(tmpdir(), "muse-cookbook-ws-")),
    };
    return await runJourney(SEGMENTS, context, async (owned) => {
      // The killed host first: if a segment failed before the kill, the
      // wrapper child is still alive and nothing below closes it.
      if (owned.hostPid !== undefined) {
        try {
          process.kill(owned.hostPid, "SIGKILL");
        } catch {
          // Already gone — the expected case.
        }
      }
      for (const client of [owned.clientA, owned.clientB]) {
        if (client === undefined) continue;
        try {
          await within("the teardown close", CLOSE_BUDGET_MS, client.close());
        } catch (error) {
          process.stderr.write(`warning: teardown close failed (${String(error)})\n`);
        }
      }
    });
  },
};
