/**
 * Recipe: handle a schema fingerprint mismatch.
 *
 * The SDK pins the protocol-schema fingerprint it was written against
 * (`EXPECTED_SCHEMA_FINGERPRINT`) and compares it against what the host
 * advertises at handshake. The posture this recipe exists to teach — and the
 * three lines integrators get wrong — is: a mismatch is a WARNING, never an
 * error. Additive-optional schema evolution means an older SDK keeps working
 * against a newer host, so surface the warning and keep going.
 *
 * Two arms:
 *  - the MATCH arm runs against the release-built `tbh serve` and proves the
 *    served fingerprint equals the SDK's pin, so no warning is raised;
 *  - the MISMATCH arm feeds a synthetic newer-host fingerprint through the
 *    same `checkServedFingerprint` the connection machinery uses, and proves
 *    the result is a descriptive warning value — not a throw.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXPECTED_SCHEMA_FINGERPRINT, checkServedFingerprint } from "@muse-code/sdk";

import { Host, equals, objectAt, requireHost, stringAt } from "../kit/host.js";
import { runJourney } from "../kit/segments.js";
import type { JourneyReport, Segment } from "../kit/segments.js";
import type { Recipe, RecipeHosts } from "../runner.js";

const HANDSHAKE_BUDGET_MS = 30_000;
const CLOSE_BUDGET_MS = 30_000;

/** A fingerprint no bundle has ever had: what a newer host might serve. */
const NEWER_HOST_FINGERPRINT = `sha256:${"f".repeat(64)}`;

interface Context {
  readonly museBin: string;
  host?: Host;
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
          // Announce the cookbook, not the quickstart, in the host's
          // session/audit attribution (PR #24319 review).
          clientInfo: { name: "muse-sdk-cookbook", version: "0.0.0" },
        },
        HANDSHAKE_BUDGET_MS,
      );
    },
  },
  {
    id: "match",
    title: "The served fingerprint matches the SDK's pin, so no warning is raised",
    async run(context) {
      const host = requireHost(context);
      const result = host.msp.initializeResult as unknown as Record<string, unknown>;
      const schema = objectAt(result, "schema", "initialize result");
      const served = stringAt(schema, "fingerprint", "initialize schema");
      equals(served, EXPECTED_SCHEMA_FINGERPRINT, "the served schema fingerprint vs the SDK pin");
      // Both sides of the same conclusion: the SDK compared at handshake and
      // raised nothing, and running the comparison ourselves agrees.
      equals(host.msp.fingerprintWarning, undefined, "the SDK's handshake fingerprint warning");
      equals(checkServedFingerprint(served), undefined, "checkServedFingerprint on a match");
    },
  },
  {
    id: "mismatch-is-a-warning",
    title: "A newer host's fingerprint produces a warning value, never a throw",
    async run(context) {
      // No doctored binary needed: this is the exact comparison the SDK runs
      // at handshake, fed the fingerprint a newer host would serve.
      requireHost(context);
      const warning = checkServedFingerprint(NEWER_HOST_FINGERPRINT);
      if (warning === undefined) {
        throw new Error("a mismatched fingerprint produced no warning at all");
      }
      equals(warning.kind, "schemaFingerprintMismatch", "the warning's kind");
      equals(warning.pinned, EXPECTED_SCHEMA_FINGERPRINT, "the warning's pinned fingerprint");
      equals(warning.served, NEWER_HOST_FINGERPRINT, "the warning's served fingerprint");
      if (warning.message.length === 0) {
        throw new Error("the warning carries no human-readable message");
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

export const fingerprintMismatch: Recipe = {
  id: "fingerprint-mismatch",
  title: "Handle a schema fingerprint mismatch",
  docsPage: "developer-docs/src/content/docs/cookbook/handle-a-fingerprint-mismatch.mdx",
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
