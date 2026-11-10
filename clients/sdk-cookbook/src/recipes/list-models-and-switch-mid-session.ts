/**
 * Recipe: list models and switch mid-session.
 *
 * Runs against the release-built `muse serve` binary with no credentials: the
 * model catalog composes its bundled rows logged out, so listing and switching
 * are fully headless. Actually RUNNING a turn on the chosen model needs a real
 * provider — that arm is out of scope here and the docs page says so.
 *
 * What it teaches (and what the docs page walks through), all through the
 * SDK facade — `MuseClient.spawn`, `startSession`, `listModels`,
 * `Session.setModel`, and the session's own fold:
 *  - a session's `modelId`/`providerId` are NULLABLE, and a fresh logged-out
 *    session really starts with `modelId: null`: no durable selection record
 *    exists until one lands. That unselected state is what the switch below
 *    moves out of.
 *  - `listModels` is a QUERY (`model/list`): no commandId, no durable record.
 *    Its rows carry everything a picker UI renders (`displayLabel`,
 *    `providerId`, `modelId`), and with a `sessionId` supplied the row
 *    matching that session's effective model is flagged `isActive`.
 *  - `setModel` is a COMMAND (`session/setModel`): the ack means the selection
 *    was admitted, and the durable `session/modelChanged` record means it
 *    happened. A client that treats the ack as "done" has skipped the record
 *    every other attached client will fold.
 *  - the session `MuseClient` hands back folds every frame for you, so the
 *    record shows up in `session.fold.sessionState` with no listener code.
 *  - verification is a read, not a memory: `session/read` returns the session
 *    with the switched `providerId`/`modelId`, and a fresh `listModels` flags
 *    the new row `isActive` — the same statements the fold makes.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MuseClient } from "@muse-code/sdk";
import type { Session } from "@muse-code/sdk";
import type { ModelListResult } from "@muse-code/msp";

import {
  HOST_DRAIN_WINDOW_MS,
  TimeoutError,
  drainQuietly,
  equals,
  isolatedHostEnv,
  objectAt,
  stringAt,
  within,
} from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const COMMAND_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

/** One catalog row, narrowed to the members this recipe reads. */
interface CatalogRow {
  readonly providerId: string;
  readonly modelId: string;
  readonly displayLabel: string;
  readonly isActive: boolean;
}

interface Context {
  readonly museBin: string;
  client?: MuseClient;
  session?: Session;
  /**
   * The model members of the `session/start` result, verbatim. Both are
   * nullable on the wire, and a fresh logged-out session really does start
   * with `modelId: null`: no durable selection record exists until one lands,
   * and the wire says so rather than inventing a default.
   */
  startup?: { readonly providerId: string | null; readonly modelId: string | null };
  /** The catalog row the recipe switches to. */
  target?: CatalogRow;
}

/**
 * Check the `listModels` rows' members at run time, failing with the row's
 * index so a malformed catalog names its defect: the SDK types the result,
 * but it does not validate what the host sent.
 */
function catalogRows(result: ModelListResult): readonly CatalogRow[] {
  const models: unknown = result.models;
  if (!Array.isArray(models)) {
    throw new Error(`model/list result: "models" is not an array (got ${JSON.stringify(models)})`);
  }
  return models.map((row: unknown, index) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`model/list row ${String(index)} is not an object`);
    }
    const entry = row as Record<string, unknown>;
    const where = `model/list row ${String(index)}`;
    const isActive = entry["isActive"];
    if (typeof isActive !== "boolean") {
      throw new Error(`${where}: "isActive" is not a boolean (got ${JSON.stringify(isActive)})`);
    }
    return {
      providerId: stringAt(entry, "providerId", where),
      modelId: stringAt(entry, "modelId", where),
      displayLabel: stringAt(entry, "displayLabel", where),
      isActive,
    };
  });
}

function sameModel(
  a: { readonly providerId: string; readonly modelId: string },
  b: { readonly providerId: string; readonly modelId: string },
): boolean {
  return a.providerId === b.providerId && a.modelId === b.modelId;
}

/** Narrow a result member to a string or a wire `null`. */
function nullableString(member: unknown, where: string): string | null {
  if (member !== null && typeof member !== "string") {
    throw new Error(`${where} is neither a string nor null (got ${JSON.stringify(member)})`);
  }
  return member;
}

/**
 * Re-check the session's fold until `probe` finds what it wants. The facade
 * folds every frame but has no state-change hook, so a short bounded re-check
 * is the wait; the budget is a failure cap, not pacing.
 */
async function untilFolded<T>(
  what: string,
  budgetMs: number,
  probe: () => T | undefined,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const found = probe();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new TimeoutError(what, budgetMs);
    // Polls because Session has no fold-change event yet (#81895).
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function requireClient(context: Context): MuseClient {
  if (context.client === undefined) throw new Error("`spawn` did not finish");
  return context.client;
}

function requireSwitch(context: Context): { session: Session; target: CatalogRow } {
  const session = context.session;
  const target = context.target;
  if (session === undefined || target === undefined) {
    throw new Error("`switch` did not finish");
  }
  return { session, target };
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "spawn",
    title: "Spawn the release-built host and complete the handshake",
    async run(context) {
      context.client = await within(
        "the host's spawn and MSP handshake",
        HANDSHAKE_BUDGET_MS,
        MuseClient.spawn({
          museBin: context.museBin,
          args: ["serve"],
          cwd: await mkdtemp(join(tmpdir(), "muse-cookbook-ws-")),
          env: isolatedHostEnv(await mkdtemp(join(tmpdir(), "muse-cookbook-home-"))),
          clientInfo: { name: "muse_sdk_cookbook", version: "0.0.0" },
          // The kit's owned drain window (see HOST_DRAIN_WINDOW_MS), so the
          // drain bound and the SDK's actual window cannot drift apart.
          shutdownTimeoutMs: HOST_DRAIN_WINDOW_MS,
        }),
      );
    },
  },
  {
    id: "session",
    title: "Start a session and read the model members it started with",
    async run(context) {
      const client = requireClient(context);
      const session = await within(
        "session/start",
        COMMAND_BUDGET_MS,
        client.startSession({
          workspaceRoot: await mkdtemp(join(tmpdir(), "muse-cookbook-session-ws-")),
        }),
      );
      context.session = session;
      if (session.opening?.verb !== "session/start") {
        throw new Error("the session did not open through session/start");
      }
      const info = session.opening.result.session;
      equals(info.status, "idle", "a fresh session's status");
      // Verbatim, nulls included. A fresh logged-out session has no durable
      // model-selection record yet, and this is where a client learns that:
      // `modelId` is null until a selection lands — the state this recipe
      // switches OUT of.
      context.startup = {
        providerId: nullableString(info.providerId, "session/start session providerId"),
        modelId: nullableString(info.modelId, "session/start session modelId"),
      };
    },
  },
  {
    id: "list-models",
    title: "List the catalog and pick the row to switch to",
    async run(context) {
      const client = requireClient(context);
      const session = context.session;
      const startup = context.startup;
      if (session === undefined || startup === undefined) {
        throw new Error("`session` did not finish");
      }
      // A query, not a command: no commandId. Passing the sessionId is what
      // makes `isActive` meaningful — it flags the row matching THIS
      // session's effective model.
      const rows = catalogRows(
        await within(
          "the model/list reply",
          COMMAND_BUDGET_MS,
          client.listModels({ sessionId: session.sessionId }),
        ),
      );
      if (rows.length === 0) {
        throw new Error("the bundled catalog served no rows; nothing to switch to");
      }
      // "Is this row the session's current model?" — written once so the
      // sanity check and the target pick below can never quietly disagree
      // about what "current" means. With no selection yet, no row is current.
      const isCurrentModel = (row: CatalogRow): boolean =>
        startup.modelId !== null &&
        row.modelId === startup.modelId &&
        row.providerId === startup.providerId;
      // `isActive` is a projection of the session's effective model, not an
      // independent opinion: with no selection yet, no row is active, and an
      // active row must be the model the session reported at start.
      for (const row of rows) {
        if (row.isActive && !isCurrentModel(row)) {
          throw new Error(
            `catalog row ${row.providerId}/${row.modelId} is flagged active but the session's model is ${String(startup.providerId)}/${String(startup.modelId)}`,
          );
        }
      }
      // Any row that is not already the effective model is a real switch. A
      // fresh session has no effective model, so even a single-row bundled
      // catalog gives this recipe a genuine state change to demonstrate.
      const target = rows.find((row) => !isCurrentModel(row));
      if (target === undefined) {
        throw new Error(
          `every one of the ${String(rows.length)} catalog rows is already the session's model; nothing to switch to`,
        );
      }
      context.target = target;
    },
  },
  {
    id: "switch",
    title: "Switch the session's model and read the admission ack",
    async run(context) {
      const session = context.session;
      const target = context.target;
      if (session === undefined || target === undefined) {
        throw new Error("`list-models` did not finish");
      }
      // A command this time: the SDK mints the commandId and verifies the
      // ack's echo. The ack says the selection was ADMITTED — the durable
      // record it produces is the next segment's evidence.
      const ack = await within(
        "the session/setModel ack",
        COMMAND_BUDGET_MS,
        session.setModel({ providerId: target.providerId, modelId: target.modelId }),
      );
      equals(ack.status, "accepted", "session/setModel ack status");
    },
  },
  {
    id: "model-changed",
    title: "Wait for the durable session/modelChanged record to reach the session",
    async run(context) {
      const { session, target } = requireSwitch(context);
      // Matched on the target model AND the user source, not just the
      // family: a host is free to land selection records of its own (a
      // startup default, a policy change), and with a single-row catalog
      // even the modelId cannot tell those apart. A client-initiated
      // setModel folds as `source: "user"` — that pair is what identifies
      // this switch's record. The host writes it right after the ack, so
      // it may not have arrived the moment `setModel` resolves.
      const changed = await untilFolded(
        "the user-sourced session/modelChanged record for the switched model",
        COMMAND_BUDGET_MS,
        () => {
          const record = session.fold.sessionState.get("session/modelChanged");
          return record != null && record.source === "user" && record.modelId === target.modelId
            ? record
            : undefined;
        },
      );
      equals(changed.providerId, target.providerId, "the changed model's provider");
    },
  },
  {
    id: "fold",
    title: "Read the change off the session's fold",
    async run(context) {
      const { session, target } = requireSwitch(context);
      const startup = context.startup;
      if (startup === undefined) throw new Error("`session` did not finish");
      // What a UI reads when it renders: the fold keeps the latest value per
      // session-state family, so the `session/modelChanged` slot now holds
      // the new selection — no listener of yours was needed to put it there.
      const folded = session.fold.sessionState.get("session/modelChanged");
      if (folded === undefined || folded === null) {
        throw new Error("the fold holds no session/modelChanged value after the switch");
      }
      equals(folded.modelId, target.modelId, "the folded model change's modelId");
      equals(folded.providerId, target.providerId, "the folded model change's providerId");
      // And it moved: the slot no longer says what the session started with.
      if (folded.modelId === startup.modelId && folded.providerId === startup.providerId) {
        throw new Error("the folded selection is still the model the session started with");
      }
    },
  },
  {
    id: "verify",
    title: "Read the session back and re-list: both report the new model",
    async run(context) {
      const client = requireClient(context);
      const { session, target } = requireSwitch(context);
      const sessionId = session.sessionId;
      // Verification is a read, not a memory. `session/read` serves the
      // session as folded from its durable records — if the switch is here,
      // it survived, and every later resume will see it. The facade wraps no
      // read yet, so it goes through `client.command`.
      const read = await within(
        "the session/read reply",
        COMMAND_BUDGET_MS,
        client.command("session/read", { sessionId }),
      );
      const info = objectAt(read, "session", "session/read result");
      equals(info["providerId"], target.providerId, "the read-back session's providerId");
      equals(info["modelId"], target.modelId, "the read-back session's modelId");
      // ...and the catalog agrees: the switched row is the active one now,
      // and no row disagrees with it.
      const relisted = catalogRows(
        await within("the model/list reply", COMMAND_BUDGET_MS, client.listModels({ sessionId })),
      );
      const active = relisted.filter((row) => row.isActive);
      if (active.length === 0) {
        throw new Error("no catalog row is flagged active after the switch");
      }
      for (const row of active) {
        if (!sameModel(row, target)) {
          throw new Error(
            `catalog row ${row.providerId}/${row.modelId} is flagged active after switching to ${target.providerId}/${target.modelId}`,
          );
        }
      }
    },
  },
  {
    id: "drain",
    title: "Close the client and let the host exit cleanly",
    async run(context) {
      const client = requireClient(context);
      await within("the orderly drain", CLOSE_BUDGET_MS, client.close());
      // `cleanShutdown` is the SDK's row for exit code 0 after stdin EOF.
      const classification = await within("the exit classification", CLOSE_BUDGET_MS, client.exit);
      equals(classification.kind, "cleanShutdown", "the SDK's exit classification");
      context.client = undefined;
    },
  },
];

export const listModelsAndSwitchMidSession: Recipe = {
  id: "list-models-and-switch-mid-session",
  title: "List models and switch mid-session",
  docsPage: "developer-docs/src/content/docs/cookbook/list-models-and-switch-mid-session.mdx",
  needs: ["museBin"],
  async run(hosts: RecipeHosts): Promise<JourneyReport> {
    const museBin = hosts.museBin;
    if (museBin === undefined) throw new Error("museBin is required");
    const context: Context = { museBin };
    return await runJourney(SEGMENTS, context, async (owned) => {
      const client = owned.client;
      if (client !== undefined) {
        await drainQuietly("the host", CLOSE_BUDGET_MS, () => client.close());
      }
    });
  },
};
