/**
 * Recipe: resume a session and verify what came back.
 *
 * Runs against a real `muse serve` host, twice: one host starts a
 * session and is shut down cleanly, and a SECOND host — a fresh process over
 * the same state directory — resumes it. That is the shape of the real
 * failure this recipe exists for (your app restarted, or the host went away),
 * and it is why the recipe cannot be played from a canned transcript: only a
 * real host proves the state survived a process boundary.
 *
 * What it teaches (and what the docs page walks through):
 *  - "resume worked" means "the state survived", not "the call returned". The
 *    answer carries four things worth checking, and this journey checks each:
 *    the session's identity and workspace, the provider and model it will run
 *    the NEXT turn on, the history you asked for inline, the late-joiner
 *    pending set, and the view cursor your subscription now starts at.
 *  - the provider/model check is the one to write by hand. A resumed session
 *    that forgot its effective model would take the user's next turn
 *    somewhere the user did not choose — the #19806/#22745 regression class.
 *  - a view cursor is opaque and server-issued. Send one the host never
 *    issued and the resume is REFUSED (`notFound`), not silently widened.
 *
 * The session is started naming a model the host itself offers, and that is
 * setup rather than lesson: a credential-less host resolves no default model,
 * so a session started without one carries `modelId: null` from birth and the
 * check above would pass on a session that never had a model to lose. Naming
 * one makes the surviving value a real value — and the id is read from the
 * host's own catalog, never pinned here, because the bundled catalog is free
 * to change.
 *
 * The two halves use two different client surfaces on purpose. Setup goes
 * through the kit's connection-level `Host` because it reads the catalog
 * before starting the session. The RESUME — the half this page is about —
 * goes through `MuseClient`, the surface an integrator resuming a session
 * should be using: `spawn` reads the durability profile off the handshake for
 * you, and `resumeSession` hands back a wired `Session` whose `opening`
 * carries the typed wire answer every assertion below reads. The two do not
 * compose in one host: `MuseClient` claims the connection's single
 * notification handler, which is the kit recorder's slot.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MspError, MuseClient } from "@muse-code/sdk";
import type { SessionResumeResult } from "@muse-code/msp";

import {
  HOST_DRAIN_WINDOW_MS,
  Host,
  STUB_VIEW_CURSOR,
  arrayAt,
  drainQuietly,
  equals,
  objectAt,
  isolatedHostEnv,
  requireHost,
  stringAt,
  within,
} from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

/** Announce the cookbook, not the quickstart, in the host's attribution. */
const CLIENT_INFO = { name: "muse_sdk_cookbook", version: "0.0.0" };

/**
 * A cursor no host ever issued: it names a session that does not exist. Built
 * to be structurally valid so the refusal is about the ANCHOR being missing
 * and not about the string being unparseable — the same shape the committed
 * `cursor-never-existed` transcript records.
 */
const IMPOSSIBLE_CURSOR = "v:00000000-0000-7000-8000-000000000000:1";

interface Context {
  readonly museBin: string;
  readonly home: string;
  readonly workspaceRoot: string;
  /** The host that starts the session; closed before the resume host spawns. */
  host?: Host;
  /** The host that resumes it — a different process over the same state. */
  resumeClient?: MuseClient;
  sessionId?: string;
  /** What `session/start` reported, so the resume can be checked against it. */
  startedProviderId?: string;
  startedModelId?: string;
  resumed?: SessionResumeResult;
  /** The cursor the resume served, handed straight back in the suffix arm. */
  servedCursor?: string;
}

function requireResumed(context: Context): SessionResumeResult {
  if (context.resumed === undefined) throw new Error("`resume` did not finish");
  return context.resumed;
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "start",
    title: "Start a session on one host, naming a model and folding one view event",
    async run(context) {
      const host = await Host.start(
        {
          museBin: context.museBin,
          home: context.home,
          workspaceRoot: context.workspaceRoot,
          clientInfo: CLIENT_INFO,
        },
        HANDSHAKE_BUDGET_MS,
      );
      context.host = host;

      // Read the model out of the host's own catalog. A pinned id here would
      // red this recipe every time the bundled catalog moved, and would prove
      // nothing the host had not already been told.
      const catalog = await within(
        "model/list",
        COMMAND_BUDGET_MS,
        host.msp.connection.request("model/list", {}),
      );
      const rows = arrayAt(catalog, "models", "model/list result");
      const row = rows[0];
      if (row === undefined) throw new Error("the host offered no models to start a session with");
      const offered = row as Record<string, unknown>;
      const providerId = stringAt(offered, "providerId", "a model/list row");
      const modelId = stringAt(offered, "modelId", "a model/list row");

      const result = await within(
        "session/start",
        COMMAND_BUDGET_MS,
        host.msp.connection.command(
          "session/start",
          { workspaceRoot: context.workspaceRoot, providerId, modelId },
          { maxAttempts: 1 },
        ),
      );
      const session = objectAt(result, "session", "session/start result");
      equals(session["status"], "idle", "a fresh session's status");
      equals(session["providerId"], providerId, "the new session's provider");
      equals(session["modelId"], modelId, "the new session's model");
      // The session id is the ONLY thing an app has to persist; everything
      // else below is what the resume must hand back.
      const sessionId = stringAt(session, "sessionId", "session/start session");
      context.sessionId = sessionId;
      context.startedProviderId = providerId;
      context.startedModelId = modelId;

      // Put ONE real event in the session's view. Setup, not lesson, and the
      // reason is VACUITY rather than failure: a session that has emitted
      // nothing has an empty view whose head cursor is `""`, the defined
      // before-genesis sentinel. The host accepts that cursor and still
      // answers `none`/`cursorSuffix` for it, so the suffix arm below would go
      // GREEN while exercising only the degenerate case — it would never test
      // that a real minted cursor round-trips. Folding one event makes the
      // cursor a minted one, so the arm proves what it claims. Setting the
      // approval mode is the cheapest state change that folds into the view
      // without a model or credentials.
      //
      // `denyUnmatched` deliberately: it is the most conservative mode in the
      // vocabulary, so nothing here can be mistaken for advice about which
      // mode to run.
      const mode = await within(
        "session/setApprovalMode",
        COMMAND_BUDGET_MS,
        host.msp.connection.command(
          "session/setApprovalMode",
          { sessionId, mode: "denyUnmatched" },
          { maxAttempts: 1 },
        ),
      );
      equals(mode["applyOutcome"], "completed", "the approval-mode change's outcome");
    },
  },
  {
    id: "host-goes-away",
    title: "Shut that host down cleanly, so nothing is holding the session open",
    async run(context) {
      const host = requireHost(context);
      const exit = await host.close(CLOSE_BUDGET_MS);
      equals(exit.code, 0, "the first host's exit code after stdin EOF");
      context.host = undefined;
    },
  },
  {
    id: "resume",
    title: "Resume the session from a second host, asking for the history inline",
    async run(context) {
      const sessionId = context.sessionId;
      if (sessionId === undefined) throw new Error("`start` did not finish");
      const client = await within(
        "the resume host's spawn and MSP handshake",
        HANDSHAKE_BUDGET_MS,
        MuseClient.spawn({
          museBin: context.museBin,
          args: ["serve"],
          cwd: context.workspaceRoot,
          env: isolatedHostEnv(context.home),
          clientInfo: CLIENT_INFO,
          // The kit's owned drain window (see HOST_DRAIN_WINDOW_MS), so the
          // drain bound and the SDK's actual window cannot drift apart.
          shutdownTimeoutMs: HOST_DRAIN_WINDOW_MS,
        }),
      );
      context.resumeClient = client;
      const session = await within(
        "session/resume",
        COMMAND_BUDGET_MS,
        // `excludeItems: false` is stated rather than left to the default:
        // this recipe is about what comes back, so it asks for all of it.
        client.resumeSession({ sessionId, excludeItems: false }),
      );
      const opening = session.opening;
      if (opening?.verb !== "session/resume") {
        throw new Error(
          `resumeSession did not report a session/resume opening: ${String(opening?.verb)}`,
        );
      }
      context.resumed = opening.result;
    },
  },
  {
    id: "same-session",
    title: "It is the session that was asked for, in the workspace it was started in",
    async run(context) {
      const resumed = requireResumed(context);
      equals(resumed.session.sessionId, context.sessionId, "the resumed session id");
      equals(resumed.session.workspaceRoot, context.workspaceRoot, "the resumed workspace root");
    },
  },
  {
    id: "effective-model",
    title: "The resumed session still names the provider and model it will run on",
    async run(context) {
      const { providerId, modelId } = requireResumed(context).session;
      // Both members are declared nullable, so `null` is a real answer the
      // wire can carry — and the answer a session that lost its effective
      // model across the process boundary would give.
      if (providerId === null || modelId === null) {
        throw new Error(
          `the resumed session lost its effective model (providerId=${JSON.stringify(providerId)}, ` +
            `modelId=${JSON.stringify(modelId)})`,
        );
      }
      // Non-null is not enough: a session resumed onto some OTHER model runs
      // the user's next turn somewhere they did not choose, which reads as
      // "resume worked" everywhere except the bill and the answer.
      equals(providerId, context.startedProviderId, "the resumed provider vs the one started with");
      equals(modelId, context.startedModelId, "the resumed model vs the one started with");
    },
  },
  {
    id: "inline-history",
    title: "The history is served inline, as asked, and not deferred to paging",
    async run(context) {
      const history = requireResumed(context).history;
      // `mode` reports what was SERVED, never what was asked for, so it is the
      // member to read: a downgrade to `snapshot` or `none` means an inline
      // render would silently show an empty transcript.
      equals(history.mode, "inline", "the served history mode for an include-items resume");
      // `noneReason` is sent exactly when `mode` is `"none"` and never for any
      // other mode, which is what lets a client read the pair as one answer:
      // "none" alone does not say whether the client's own transcript is still
      // current, and the reason does. The page teaches that pair, so both arms
      // this journey can reach are asserted rather than left as prose — the
      // absent half here, and `cursorSuffix` in `cursor-resume-is-a-suffix`
      // below (PR #25986 review).
      equals(history.noneReason, undefined, "noneReason on a served inline history");
      if (!Array.isArray(history.items)) {
        throw new Error(
          `an inline history must carry its items array, got ${JSON.stringify(history.items)}`,
        );
      }
      // EXACT, never merely "is an array". This journey takes no turn, so the
      // one correct answer is zero items — and `Array.isArray` alone passes
      // just as happily on a substituted, partial, or duplicated array, which
      // is the same vacuity the model check above had to shed (PR #25986
      // review). Proving that a real conversation survives the restart needs a
      // prior turn, so it is the arm this recipe still owes (#26022); until it
      // lands, this at least cannot pass on the wrong history.
      equals(history.items.length, 0, "a zero-turn session's resumed item count");
    },
  },
  {
    id: "pending-and-cursor",
    title: "The late-joiner pending set and a real view cursor come back too",
    async run(context) {
      const resumed = requireResumed(context);
      // Empty is the normal answer for a session that was never mid-approval;
      // what matters to a client is that the SET is served, because a
      // non-empty one is work the UI owes the user the moment it repaints.
      if (!Array.isArray(resumed.pendingRequests)) {
        throw new Error(
          `pendingRequests must be served as an array, got ${JSON.stringify(resumed.pendingRequests)}`,
        );
      }
      // EXACT, for the same reason the item count is: this session never took
      // a turn and never asked for permission, so the one right answer is an
      // empty set, and `Array.isArray` would stay green while a regression
      // served a phantom or stale pointer on every idle resume — the UI would
      // then prompt a user about an approval nobody is waiting on
      // (PR #25986 review).
      equals(
        resumed.pendingRequests.length,
        0,
        "a never-mid-approval session's resumed pending set",
      );
      const cursor = resumed.viewCursor;
      if (typeof cursor !== "string") {
        throw new Error(`session/resume must serve a view cursor, got ${JSON.stringify(cursor)}`);
      }
      // A client must NEVER read a cursor's text: it is opaque, and
      // "empty-vs-non-empty carries no semantics". An earlier revision asserted
      // non-empty as though `""` were a defect, which invented a rule the
      // protocol does not have (PR #25986 review).
      //
      // This throw is the opposite thing, and it is a HARNESS PRECONDITION
      // rather than client guidance: `start` folded a view event on purpose, so
      // the head cursor must now be a minted one. If it is `""` the fold did
      // not happen — a future host that stops treating the approval-mode
      // reconfigure as view-visible would land here — and every check below
      // would then pass on the degenerate before-genesis case while proving
      // nothing about a real cursor.
      if (cursor === "") {
        throw new Error(
          "`start` folded one view event, so the resumed head cursor must be past genesis; " +
            'got the before-genesis sentinel "", which would make the suffix arm vacuous',
        );
      }
      // The stub IS checked too, because it is not a cursor at all — it is the
      // pre-Seam-C placeholder, so serving it means the view fold is not wired.
      if (cursor === STUB_VIEW_CURSOR) {
        throw new Error(`session/resume returned the pre-Seam-C stub cursor ${cursor}`);
      }
      context.servedCursor = cursor;
    },
  },
  {
    id: "cursor-resume-is-a-suffix",
    title: "Resuming with the served cursor answers none/cursorSuffix, not a snapshot",
    async run(context) {
      const client = context.resumeClient;
      if (client === undefined) throw new Error("`resume` did not finish");
      const sessionId = context.sessionId;
      const cursor = context.servedCursor;
      if (sessionId === undefined || cursor === undefined) {
        throw new Error("`pending-and-cursor` did not finish");
      }
      // Hand back the cursor the host just gave us, VERBATIM and unexamined.
      // This is the one answer that means "your transcript is still current",
      // and it is the branch the docs page leads with — so it is proven here
      // rather than described. It costs no extra turn: a cursor resume is a
      // suffix subscription, and the suffix of a session with nothing after
      // the cursor is empty.
      //
      // Round-tripping the value unexamined is the whole point of the opacity
      // rule. It is ALSO why this arm needs `start`'s folded event to mean
      // anything: the host answers `none`/`cursorSuffix` for the before-genesis
      // `""` just as readily, so without a minted cursor this segment would be
      // green and vacuous. The precondition in `pending-and-cursor` is what
      // keeps that from happening silently.
      const session = await within(
        "session/resume with the served cursor",
        COMMAND_BUDGET_MS,
        client.resumeSession({ sessionId, cursor }),
      );
      const opening = session.opening;
      if (opening?.verb !== "session/resume") {
        throw new Error(
          `resumeSession did not report a session/resume opening: ${String(opening?.verb)}`,
        );
      }
      const history = opening.result.history;
      equals(history.mode, "none", "the served history mode for a retained-cursor resume");
      // The DISCRIMINATOR. `"none"` on its own does not tell a client whether
      // its own transcript is current; only this reason does, and a client
      // that reads `mode` alone will render a stale view as a live one.
      equals(history.noneReason, "cursorSuffix", "why no history was served");
      // No history means none of it: a suffix resume carries neither an items
      // array nor a snapshot to fold.
      equals(history.items, null, "items on a suffix resume");
      equals(history.snapshot, null, "snapshot on a suffix resume");
    },
  },
  {
    id: "rejects-unissued-cursor",
    title: "A cursor the host never issued is refused, not quietly widened",
    async run(context) {
      const client = context.resumeClient;
      if (client === undefined) throw new Error("`resume` did not finish");
      const sessionId = context.sessionId;
      if (sessionId === undefined) throw new Error("`start` did not finish");
      let refusal: unknown;
      try {
        await within(
          "session/resume with an unissued cursor",
          COMMAND_BUDGET_MS,
          client.resumeSession({ sessionId, cursor: IMPOSSIBLE_CURSOR }),
        );
      } catch (error) {
        refusal = error;
      }
      if (refusal === undefined) {
        throw new Error(
          `session/resume accepted a cursor that never existed (${IMPOSSIBLE_CURSOR}); a client that ` +
            "invents cursors must be told, not silently served someone else's history",
        );
      }
      if (!(refusal instanceof MspError)) throw refusal;
      // The typed family an integrator branches on, and the code the wire
      // carries. Both, because the kind is what code should read and the code
      // is what a reader sees in a log.
      equals(refusal.kind, "notFound", "the refusal's error kind");
      equals(refusal.code, -32011, "the refusal's error code");
    },
  },
  {
    id: "drain",
    title: "Close the resume host and let it exit cleanly",
    async run(context) {
      const client = context.resumeClient;
      if (client === undefined) throw new Error("`resume` did not finish");
      await within("the resume host's orderly drain and exit", CLOSE_BUDGET_MS, client.close());
      equals((await client.exit).kind, "cleanShutdown", "the resume host's exit classification");
      context.resumeClient = undefined;
    },
  },
];

export const resumeAndVerify: Recipe = {
  id: "resume-and-verify",
  title: "Resume a session and verify what came back",
  docsPage: "developer-docs/src/content/docs/cookbook/resume-a-session.mdx",
  needs: ["museBin"],
  async run(hosts: RecipeHosts): Promise<JourneyReport> {
    const museBin = hosts.museBin;
    if (museBin === undefined) throw new Error("museBin is required");
    const context: Context = {
      museBin,
      // ONE home for both hosts: that shared state directory is what makes
      // the second host a resume rather than a fresh start.
      home: await mkdtemp(join(tmpdir(), "muse-cookbook-home-")),
      workspaceRoot: await mkdtemp(join(tmpdir(), "muse-cookbook-ws-")),
    };
    return await runJourney(SEGMENTS, context, async (owned) => {
      // BOTH slots: a journey that failed before its drain can own two live
      // children, and a teardown that reclaimed only one would leak the other
      // silently.
      if (owned.host !== undefined) await owned.host.abandon(CLOSE_BUDGET_MS);
      const client = owned.resumeClient;
      if (client !== undefined) {
        await drainQuietly("the resume host", CLOSE_BUDGET_MS, () => client.close());
      }
    });
  },
};
