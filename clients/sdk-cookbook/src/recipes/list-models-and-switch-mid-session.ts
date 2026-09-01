/**
 * Recipe: list models and switch mid-session.
 *
 * Runs against the release-built `muse serve` binary with no credentials: the
 * model catalog composes its bundled rows logged out, so listing and switching
 * are fully headless. Actually RUNNING a turn on the chosen model needs a real
 * provider — that arm is out of scope here and the docs page says so.
 *
 * What it teaches (and what the docs page walks through):
 *  - a session's `modelId`/`providerId` are NULLABLE, and a fresh logged-out
 *    session really starts with `modelId: null`: no durable selection record
 *    exists until one lands. That unselected state is what the switch below
 *    moves out of.
 *  - `model/list` is a QUERY: no commandId, no durable record. Its rows carry
 *    everything a picker UI renders (`displayLabel`, `providerId`, `modelId`),
 *    and with a `sessionId` supplied the row matching that session's effective
 *    model is flagged `isActive`.
 *  - `session/setModel` is a COMMAND: the ack means the selection was
 *    admitted, and the durable `session/modelChanged` notification means it
 *    happened. A client that treats the ack as "done" has skipped the record
 *    every other attached client will fold.
 *  - verification is a read, not a memory: `session/read` returns the session
 *    with the switched `providerId`/`modelId`, and a fresh `model/list` flags
 *    the new row `isActive` — the same statements the client's own fold makes
 *    after applying `session/modelChanged`.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Session, readSessionDurability } from "@muse-code/sdk";

import { Host, arrayAt, equals, objectAt, requireHost, stringAt } from "../kit/host.js";
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
  host?: Host;
  sessionId?: string;
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
 * Narrow the untyped `model/list` rows to the members the recipe reads,
 * failing with the row's index so a malformed catalog names its defect.
 */
function catalogRows(result: Record<string, unknown>): readonly CatalogRow[] {
  return arrayAt(result, "models", "model/list result").map((row, index) => {
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

/** Narrow an untyped MSP result member to a string or a wire `null`. */
function nullableStringAt(
  value: Record<string, unknown>,
  key: string,
  where: string,
): string | null {
  const member = value[key];
  if (member !== null && typeof member !== "string") {
    throw new Error(`${where}: "${key}" is neither a string nor null (got ${JSON.stringify(member)})`);
  }
  return member;
}

const SEGMENTS: ReadonlyArray<Segment<Context>> = [
  {
    id: "spawn",
    title: "Spawn the release-built host and complete the handshake",
    async run(context) {
      context.host = await Host.start(
        {
          museBin: context.museBin,
          home: await mkdtemp(join(tmpdir(), "muse-cookbook-home-")),
          workspaceRoot: await mkdtemp(join(tmpdir(), "muse-cookbook-ws-")),
          clientInfo: { name: "muse_sdk_cookbook", version: "0.0.0" },
        },
        HANDSHAKE_BUDGET_MS,
      );
    },
  },
  {
    id: "session",
    title: "Start a session and read the model members it started with",
    async run(context) {
      const host = requireHost(context);
      const result = await host.msp.connection.command(
        "session/start",
        { workspaceRoot: await mkdtemp(join(tmpdir(), "muse-cookbook-session-ws-")) },
        { maxAttempts: 1 },
      );
      const session = objectAt(result, "session", "session/start result");
      equals(session["status"], "idle", "a fresh session's status");
      context.sessionId = stringAt(session, "sessionId", "session/start session");
      // Verbatim, nulls included. A fresh logged-out session has no durable
      // model-selection record yet, and this is where a client learns that:
      // `modelId` is null until a selection lands — the state this recipe
      // switches OUT of.
      context.startup = {
        providerId: nullableStringAt(session, "providerId", "session/start session"),
        modelId: nullableStringAt(session, "modelId", "session/start session"),
      };
    },
  },
  {
    id: "list-models",
    title: "List the catalog and pick the row to switch to",
    async run(context) {
      const host = requireHost(context);
      const sessionId = context.sessionId;
      const startup = context.startup;
      if (sessionId === undefined || startup === undefined) {
        throw new Error("`session` did not finish");
      }
      // A query, not a command: request, no commandId. Passing the sessionId
      // is what makes `isActive` meaningful — it flags the row matching THIS
      // session's effective model.
      const result = await host.msp.connection.request("model/list", { sessionId });
      const rows = catalogRows(result);
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
      const host = requireHost(context);
      const sessionId = context.sessionId;
      const target = context.target;
      if (sessionId === undefined || target === undefined) {
        throw new Error("`list-models` did not finish");
      }
      // A command this time: `Connection.command` mints the commandId and
      // verifies the ack's echo. The ack says the selection was ADMITTED —
      // the durable record it produces is the next segment's frame.
      const ack = await host.msp.connection.command(
        "session/setModel",
        { sessionId, model: { providerId: target.providerId, modelId: target.modelId } },
        { maxAttempts: 1 },
      );
      equals(ack["status"], "accepted", "session/setModel ack status");
    },
  },
  {
    id: "model-changed",
    title: "Observe the durable session/modelChanged notification",
    async run(context) {
      const host = requireHost(context);
      const sessionId = context.sessionId;
      const target = context.target;
      if (sessionId === undefined || target === undefined) {
        throw new Error("`switch` did not finish");
      }
      // Matched on the target model AND the user source, not just the
      // method: a host is free to fold selection records of its own (a
      // startup default, a policy change), and with a single-row catalog
      // even the modelId cannot tell those apart. A client-initiated
      // session/setModel folds as `source: "user"` — that pair is what
      // identifies this switch's record.
      const changed = await host.waitFor(
        "the user-sourced session/modelChanged notification for the switched model",
        COMMAND_BUDGET_MS,
        (notification) =>
          notification.method === "session/modelChanged" &&
          notification.params["sessionId"] === sessionId &&
          notification.params["modelId"] === target.modelId &&
          notification.params["source"] === "user",
      );
      equals(changed.params["providerId"], target.providerId, "the changed model's provider");
    },
  },
  {
    id: "fold",
    title: "Fold the notifications and read the change off sessionState",
    async run(context) {
      const host = requireHost(context);
      const sessionId = context.sessionId;
      const target = context.target;
      if (sessionId === undefined || target === undefined) {
        throw new Error("`switch` did not finish");
      }
      // What a real client does with these frames: fold them. The SDK's
      // `Session` keeps the latest value per session-state family, so after
      // the switch the `session/modelChanged` slot holds the new selection.
      const session = new Session({
        sessionId,
        durability: readSessionDurability(host.msp.initializeResult),
      });
      for (const notification of host.notifications()) {
        if (notification.params["sessionId"] !== sessionId) continue;
        session.apply(notification);
      }
      const folded = session.fold.sessionState.get("session/modelChanged");
      if (folded === undefined || folded === null) {
        throw new Error("the fold holds no session/modelChanged value after the switch");
      }
      equals(folded.modelId, target.modelId, "the folded model change's modelId");
      equals(folded.providerId, target.providerId, "the folded model change's providerId");
    },
  },
  {
    id: "verify",
    title: "Read the session back and re-list: both report the new model",
    async run(context) {
      const host = requireHost(context);
      const sessionId = context.sessionId;
      const target = context.target;
      if (sessionId === undefined || target === undefined) {
        throw new Error("`switch` did not finish");
      }
      // Verification is a read, not a memory. `session/read` serves the
      // session as folded from its durable records — if the switch is here,
      // it survived, and every later resume will see it.
      const read = await host.msp.connection.request("session/read", { sessionId });
      const session = objectAt(read, "session", "session/read result");
      equals(session["providerId"], target.providerId, "the read-back session's providerId");
      equals(session["modelId"], target.modelId, "the read-back session's modelId");
      // ...and the catalog agrees: the switched row is the active one now,
      // and no row disagrees with it.
      const relisted = catalogRows(
        await host.msp.connection.request("model/list", { sessionId }),
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
    title: "Close stdin and let the host exit cleanly",
    async run(context) {
      const host = requireHost(context);
      const exit = await host.close(CLOSE_BUDGET_MS);
      equals(exit.code, 0, "the host's exit code after stdin EOF");
      const classification = await host.msp.child.exit;
      equals(classification.kind, "cleanShutdown", "the SDK's exit classification");
      context.host = undefined;
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
      await owned.host?.abandon(CLOSE_BUDGET_MS);
    });
  },
};
