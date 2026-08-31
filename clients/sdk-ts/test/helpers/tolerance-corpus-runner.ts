import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { Item, Notification } from "@muse-code/msp";
import type {
  ItemCompletedParams,
  ItemDeltaParams,
  ItemStartedParams,
  ItemUpdatedParams,
} from "@muse-code/msp";

import { ItemStore } from "../../src/index.js";

interface TranscriptLine {
  readonly dir: "client" | "server";
  readonly raw: string;
}

interface TranscriptManifest {
  readonly scenario: string;
  readonly provenance: string;
}

export interface ToleranceReplay {
  readonly scenario: string;
  readonly provenance: string;
  readonly items: readonly Item[];
  readonly notifications: readonly Notification[];
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

function replayScenario(projectRoot: string, manifest: TranscriptManifest): ToleranceReplay {
  const transcriptPath = join(
    projectRoot,
    "schema",
    "msp",
    "transcripts",
    manifest.scenario,
    "transcript.ndjson",
  );
  const lines = readFileSync(transcriptPath, "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => parseJson<TranscriptLine>(line));
  const items = new ItemStore<Item>();
  const notifications: Notification[] = [];

  for (const line of lines) {
    if (line.dir !== "server") continue;
    const frame = parseJson<Record<string, unknown>>(line.raw);
    if (typeof frame["method"] !== "string") continue;

    const notification = frame as unknown as Notification;
    notifications.push(notification);
    switch (notification.method) {
      case "item/started":
        items.apply((notification.params as unknown as ItemStartedParams).item);
        break;
      case "item/updated":
        items.apply((notification.params as unknown as ItemUpdatedParams).item);
        break;
      case "item/completed":
        items.apply((notification.params as unknown as ItemCompletedParams).item);
        break;
      case "item/delta": {
        const params = notification.params as unknown as ItemDeltaParams;
        items.applyDelta(params.itemId, params.delta, params.field);
        break;
      }
      default:
        // TEST-008 is deliberately tolerant: every non-item notification is
        // preserved for the caller, while the item fold keeps running.
        break;
    }
  }

  return {
    scenario: manifest.scenario,
    provenance: manifest.provenance,
    items: items.list(),
    notifications,
  };
}

export function replayToleranceCorpus(projectRoot: string): readonly ToleranceReplay[] {
  const transcriptsRoot = join(projectRoot, "schema", "msp", "transcripts");
  return readdirSync(transcriptsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = join(transcriptsRoot, entry.name, "manifest.json");
      return parseJson<TranscriptManifest>(readFileSync(manifestPath, "utf8"));
    })
    .filter((manifest) => manifest.provenance === "sdk-tolerance")
    .sort((left, right) => left.scenario.localeCompare(right.scenario))
    .map((manifest) => replayScenario(projectRoot, manifest));
}
