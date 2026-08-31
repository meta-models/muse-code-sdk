/**
 * The wire-tap oracle.
 *
 * Every check answers ONE question: does what the public API said agree with
 * what the wire actually carried? A finding that cannot be phrased as
 * "public API said X, wire said Y" is not a finding this harness can make —
 * `finding()` refuses to build it (charter decision 4). That refusal is the
 * whole reason an integrator can act on the output: it never rests on a field
 * only an insider can see.
 *
 * Each check declares its CONSTRAINT, and the constraint decides the filing
 * track (charter decision 2):
 *  - `spec`   — a named requirement is violated: `bug` + `auto`.
 *  - `silent` — no spec constrains this, but an integrator will depend on it:
 *               the spec-gap TRACK. It ALSO files as `bug` + `auto` — no
 *               `spec-gap` label exists (owner ruling 2026-08-25, #23111) —
 *               and names its owning spec in the body, which is the routing
 *               that forces constrain-vs-document.
 */

import type { WireFrame, WireLog } from "./tap.js";

export interface SpecRef {
  /** e.g. `FR-014`, `INV-012`. */
  readonly id: string;
  /** The owning spec file, cited by path (never a line number). */
  readonly source: string;
}

export type SpecConstraint =
  | { readonly kind: "spec"; readonly id: string; readonly ref: SpecRef }
  | {
      readonly kind: "silent";
      /** Why an integrator depends on this even though no spec says so. */
      readonly hazard: string;
      /** The specs that must constrain it or document it as unconstrained. */
      readonly candidates: readonly SpecRef[];
    };

const SDK_SPEC = "specs/14990-muse-sdk/spec.md";
const MSP_TDD = "specs/13929-msp-activation/tdd.md";

function specRef(id: string, source = SDK_SPEC): SpecRef {
  return { id, source };
}

/** What a README-level integrator can observe. Nothing here is SDK-internal. */
export type ApiObservation =
  | {
      readonly kind: "initializeResult";
      readonly result: Record<string, unknown>;
      readonly fingerprintWarning: unknown;
    }
  | {
      readonly kind: "requestOk";
      readonly step: string;
      readonly method: string;
      readonly result: Record<string, unknown>;
    }
  | {
      readonly kind: "requestError";
      readonly step: string;
      readonly method: string;
      readonly error: {
        readonly name: string;
        readonly message: string;
        readonly code?: number;
        readonly kind?: string;
      };
    }
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  | { readonly kind: "protocolError"; readonly message: string }
  | { readonly kind: "exit"; readonly classification: Record<string, unknown> };

export interface ObservedRun {
  readonly api: readonly ApiObservation[];
  readonly wire: WireLog;
  /** Methods the harness deliberately asked for, beyond the handshake pair. */
  readonly requestedMethods: readonly string[];
}

/**
 * Which half a finding indicts.
 *
 * The oracle sees a disagreement between the public API and the wire; WHICH
 * side is wrong is a separate judgement, and only the check that made the
 * observation can make it. "The SDK returned something the host never served"
 * indicts the facade; "the host answered one id twice" indicts the binary.
 * Attribution consumes this, so getting it wrong routes a fix lane to the
 * wrong package — the exact failure the two-track discipline exists to stop.
 */
export type Indicted = "facade" | "binary";

export interface OracleFinding {
  readonly checkId: string;
  readonly indicts: Indicted;
  readonly title: string;
  readonly constraint: SpecConstraint;
  readonly track: "bug" | "spec-gap";
  readonly summary: string;
  readonly apiSaid: string;
  readonly wireSaid: string;
  readonly evidence: readonly string[];
}

export interface OracleCheck {
  readonly id: string;
  readonly title: string;
  readonly constraint: SpecConstraint;
  run(observed: ObservedRun): readonly OracleFinding[];
}

/** Raised when a caller tries to build a finding with no wire evidence. */
export class QaEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QaEvidenceError";
  }
}

export interface FindingInput {
  readonly indicts: Indicted;
  readonly summary: string;
  readonly apiSaid: string;
  readonly wireSaid: string;
  readonly evidence: readonly string[];
}

/**
 * Build a finding, or refuse. The refusal is load-bearing: a QA harness that
 * can emit "internal field Z looked wrong" produces reports nobody outside
 * the team can act on, and the charter rules those out at the source.
 */
export function finding(check: OracleCheck, input: FindingInput): OracleFinding {
  if (input.apiSaid.trim() === "") {
    throw new QaEvidenceError(`${check.id}: a finding must state what the PUBLIC API said`);
  }
  if (input.wireSaid.trim() === "") {
    throw new QaEvidenceError(`${check.id}: a finding must state what the WIRE said`);
  }
  return {
    checkId: check.id,
    indicts: input.indicts,
    title: check.title,
    constraint: check.constraint,
    track: check.constraint.kind === "spec" ? "bug" : "spec-gap",
    summary: input.summary,
    apiSaid: input.apiSaid,
    wireSaid: input.wireSaid,
    evidence: [...input.evidence],
  };
}

function methodOf(frame: WireFrame): string | undefined {
  const method = frame.json?.["method"];
  return typeof method === "string" ? method : undefined;
}

function idKeyOf(frame: WireFrame): string | undefined {
  if (frame.json === undefined || !("id" in frame.json)) return undefined;
  const id = frame.json["id"];
  if (id === null) return undefined;
  return typeof id === "number" || typeof id === "string" ? `${typeof id}:${String(id)}` : undefined;
}

const isRequest = (frame: WireFrame): boolean =>
  methodOf(frame) !== undefined && idKeyOf(frame) !== undefined;
const isResponse = (frame: WireFrame): boolean =>
  methodOf(frame) === undefined && idKeyOf(frame) !== undefined;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

const O1: OracleCheck = {
  id: "O1",
  title: "the handshake happens once, in SS1.4 order",
  constraint: { kind: "spec", id: "FR-013", ref: specRef("FR-013") },
  run(observed) {
    const outbound = observed.wire.outbound;
    if (outbound.length === 0) return [];
    const initializes = outbound.filter((frame) => methodOf(frame) === "initialize");
    const initializedAt = outbound.findIndex((frame) => methodOf(frame) === "initialized");
    const handshakeReached = observed.api.some((entry) => entry.kind === "initializeResult");
    if (!handshakeReached) return [];

    const findings: OracleFinding[] = [];
    if (initializes.length !== 1 || methodOf(outbound[0] as WireFrame) !== "initialize") {
      findings.push(
        finding(O1, {
          indicts: "facade",
          summary: "the client's first wire frame was not exactly one `initialize`",
          apiSaid: "initialize() resolved once and returned an InitializeResult",
          wireSaid: `the client wrote ${initializes.length} \`initialize\` frame(s); the first outbound method was \`${methodOf(outbound[0] as WireFrame) ?? "<none>"}\``,
          evidence: outbound.slice(0, 3).map((frame) => frame.raw),
        }),
      );
    }
    const early = outbound.findIndex(
      (frame, index) =>
        index > 0 && methodOf(frame) !== "initialized" && (initializedAt < 0 || index < initializedAt),
    );
    if (early >= 0) {
      findings.push(
        finding(O1, {
          indicts: "facade",
          summary: "traffic was written before the `initialized` notification",
          apiSaid: "no request was issued until initialize() had resolved",
          wireSaid: `outbound frame ${early} (\`${methodOf(outbound[early] as WireFrame) ?? "<response>"}\`) preceded \`initialized\``,
          evidence: outbound.slice(0, early + 1).map((frame) => frame.raw),
        }),
      );
    }
    return findings;
  },
};

const O2: OracleCheck = {
  id: "O2",
  title: "the surfaced InitializeResult IS the served result",
  constraint: { kind: "spec", id: "FR-013", ref: specRef("FR-013") },
  run(observed) {
    const surfaced = observed.api.find((entry) => entry.kind === "initializeResult");
    if (surfaced === undefined) return [];
    const request = observed.wire.outbound.find((frame) => methodOf(frame) === "initialize");
    const key = request === undefined ? undefined : idKeyOf(request);
    const response = observed.wire.inbound.find(
      (frame) => isResponse(frame) && idKeyOf(frame) === key,
    );
    if (response === undefined) {
      return [
        finding(O2, {
          indicts: "facade",
          summary: "the SDK returned an InitializeResult with no matching response on the wire",
          apiSaid: "initialize() resolved with an InitializeResult",
          wireSaid: `no response frame carries the \`initialize\` request id ${key ?? "<none>"}`,
          evidence: observed.wire.inbound.slice(0, 3).map((frame) => frame.raw),
        }),
      ];
    }
    const served = response.json?.["result"];
    if (canonical(served) === canonical(surfaced.result)) return [];
    return [
      finding(O2, {
        indicts: "facade",
          summary: "the InitializeResult the SDK returned differs from the one the host served",
        apiSaid: `initialize() returned ${canonical(surfaced.result)}`,
        wireSaid: `the host served ${canonical(served)}`,
        evidence: [response.raw],
      }),
    ];
  },
};

const O3: OracleCheck = {
  id: "O3",
  title: "every settled call maps 1:1 onto a request/response pair",
  constraint: { kind: "spec", id: "FR-014", ref: specRef("FR-014") },
  run(observed) {
    const findings: OracleFinding[] = [];
    const requestIds = new Set<string>();
    const duplicated: string[] = [];
    for (const frame of observed.wire.outbound.filter(isRequest)) {
      const key = idKeyOf(frame) as string;
      if (requestIds.has(key)) duplicated.push(key);
      requestIds.add(key);
    }
    if (duplicated.length > 0) {
      findings.push(
        finding(O3, {
          indicts: "facade",
          summary: "the SDK reused a request id that was still in flight",
          apiSaid: "each call was issued as its own request",
          wireSaid: `request id(s) ${duplicated.join(", ")} were written twice`,
          evidence: observed.wire.outbound.filter(isRequest).map((frame) => frame.raw),
        }),
      );
    }

    const answered = new Map<string, WireFrame[]>();
    const unsolicited: WireFrame[] = [];
    for (const frame of observed.wire.inbound.filter(isResponse)) {
      const key = idKeyOf(frame) as string;
      if (!requestIds.has(key)) {
        unsolicited.push(frame);
        continue;
      }
      answered.set(key, [...(answered.get(key) ?? []), frame]);
    }
    for (const [key, frames] of answered) {
      if (frames.length < 2) continue;
      findings.push(
        finding(O3, {
          indicts: "binary",
          summary: "the host answered one request id more than once",
          apiSaid: "the call settled exactly once, with a single result",
          wireSaid: `the host answered id ${key} twice (${frames.length} responses); the SDK surfaces only the first, so an integrator never learns the second existed`,
          evidence: frames.map((frame) => frame.raw),
        }),
      );
    }
    if (unsolicited.length > 0) {
      findings.push(
        finding(O3, {
          indicts: "binary",
          summary: "the host sent a response for an id the client never requested",
          apiSaid: "no call is outstanding for that id",
          wireSaid: `${unsolicited.length} response frame(s) carry an id the client never sent`,
          evidence: unsolicited.map((frame) => frame.raw),
        }),
      );
    }

    const settled = observed.api.filter(
      (entry) => entry.kind === "requestOk" || entry.kind === "requestError",
    ).length;
    const handshakeRequests = observed.wire.outbound.filter(
      (frame) => methodOf(frame) === "initialize",
    ).length;
    const callRequests = observed.wire.outbound.filter(isRequest).length - handshakeRequests;
    if (settled > 0 && callRequests < settled) {
      findings.push(
        finding(O3, {
          indicts: "facade",
          summary: "a call settled through the public API with no request on the wire",
          apiSaid: `${settled} call(s) settled`,
          wireSaid: `only ${callRequests} non-handshake request frame(s) were written`,
          evidence: observed.wire.outbound.map((frame) => frame.raw),
        }),
      );
    }
    return findings;
  },
};

const O4: OracleCheck = {
  id: "O4",
  title: "the surfaced error kind IS the served `data.kind`",
  constraint: { kind: "spec", id: "INV-012", ref: specRef("INV-012") },
  run(observed) {
    const findings: OracleFinding[] = [];
    const occurrences = settledOccurrences(observed);
    for (const entry of observed.api) {
      if (entry.kind !== "requestError") continue;
      const served = servedErrorFor(observed, entry.method, occurrences.get(entry) ?? 0);
      if (served === undefined) continue;
      const wireKind = served.kind;
      if (wireKind === undefined) continue;
      if (entry.error.kind === wireKind) continue;
      findings.push(
        finding(O4, {
          indicts: "facade",
          summary: `the SDK retyped the \`${entry.method}\` error`,
          apiSaid: `MspError.kind === ${JSON.stringify(entry.error.kind ?? null)}`,
          wireSaid: `the host served error.data.kind === ${JSON.stringify(wireKind)}`,
          evidence: [served.raw],
        }),
      );
    }
    return findings;
  },
};

const O5: OracleCheck = {
  id: "O5",
  title: "a served error with no `data.kind` reaches the caller as a framing violation",
  constraint: {
    kind: "silent",
    hazard:
      "`ErrorObject.data` is optional in the generated schema, so a host may serve a well-formed JSON-RPC error with no `kind`. INV-012 makes `data.kind` the only branch point a client has, so the SDK rejects such a response as a local ProtocolError. The integrator therefore sees a TRANSPORT fault where the host served a deliberate SERVER error — different retry posture, different bug report, and no `code` to branch on. Nothing today forbids the host from serving it, and nothing warns the integrator that it can happen.",
    candidates: [specRef("INV-012"), specRef("FR-015"), specRef("SS1.6", MSP_TDD)],
  },
  run(observed) {
    const findings: OracleFinding[] = [];
    const occurrences = settledOccurrences(observed);
    for (const entry of observed.api) {
      if (entry.kind !== "requestError") continue;
      const served = servedErrorFor(observed, entry.method, occurrences.get(entry) ?? 0);
      if (served === undefined || served.kind !== undefined) continue;
      findings.push(
        finding(O5, {
          indicts: "binary",
          summary: `the \`${entry.method}\` error carried no \`data.kind\``,
          apiSaid: `the call rejected with ${entry.error.name}: ${JSON.stringify(entry.error.message)} — kind ${JSON.stringify(entry.error.kind ?? null)}, code ${JSON.stringify(entry.error.code ?? null)}`,
          wireSaid: `the host served a JSON-RPC error with code ${JSON.stringify(served.code ?? null)} and no \`data.kind\` at all`,
          evidence: [served.raw],
        }),
      );
    }
    return findings;
  },
};

interface ServedError {
  readonly kind: string | undefined;
  readonly code: number | undefined;
  readonly raw: string;
}

/**
 * For each settled call, its ordinal among the settled calls using the SAME
 * method.
 *
 * A scenario may call one method more than once — two `session/resume` in
 * D19649, two `setApprovalMode` in D21861 — and the wire carries one request
 * per call. Pairing an error to "the first outbound frame with this method"
 * therefore crosses the wires the moment a method repeats: two faithful errors
 * of different kinds read as a retype (a phantom `O4:facade` that files a false
 * SDK bug), and a second call's real retype goes unchecked whenever the first
 * call settled OK. The ordinal must count EVERY settled call, not just the
 * failing ones, or an ok-then-error pair still mis-indexes.
 */
function settledOccurrences(observed: ObservedRun): ReadonlyMap<ApiObservation, number> {
  const seen = new Map<string, number>();
  const occurrence = new Map<ApiObservation, number>();
  for (const entry of observed.api) {
    if (entry.kind !== "requestOk" && entry.kind !== "requestError") continue;
    const next = seen.get(entry.method) ?? 0;
    occurrence.set(entry, next);
    seen.set(entry.method, next + 1);
  }
  return occurrence;
}

/** The wire error answering the `occurrence`-th request the harness sent for `method`. */
function servedErrorFor(
  observed: ObservedRun,
  method: string,
  occurrence: number,
): ServedError | undefined {
  const request = observed.wire.outbound.filter((frame) => methodOf(frame) === method)[occurrence];
  if (request === undefined) return undefined;
  const key = idKeyOf(request);
  const response = observed.wire.inbound.find(
    (frame) => isResponse(frame) && idKeyOf(frame) === key && "error" in (frame.json ?? {}),
  );
  if (response === undefined) return undefined;
  const error = response.json?.["error"] as { data?: unknown; code?: unknown } | undefined;
  const kind = (error?.data as { kind?: unknown } | undefined)?.kind;
  return {
    kind: typeof kind === "string" ? kind : undefined,
    code: typeof error?.code === "number" ? error.code : undefined,
    raw: response.raw,
  };
}

const O6: OracleCheck = {
  id: "O6",
  title: "the fingerprint warning agrees with the served fingerprint",
  constraint: { kind: "spec", id: "FR-006", ref: specRef("FR-006") },
  run(observed) {
    const surfaced = observed.api.find((entry) => entry.kind === "initializeResult");
    if (surfaced === undefined) return [];
    const request = observed.wire.outbound.find((frame) => methodOf(frame) === "initialize");
    const key = request === undefined ? undefined : idKeyOf(request);
    const response = observed.wire.inbound.find(
      (frame) => isResponse(frame) && idKeyOf(frame) === key,
    );
    const result = response?.json?.["result"] as { schema?: { fingerprint?: unknown } } | undefined;
    const servedFingerprint = result?.schema?.fingerprint;
    if (typeof servedFingerprint !== "string") return [];
    const warned = surfaced.fingerprintWarning !== null && surfaced.fingerprintWarning !== undefined;
    const surfacedFingerprint = (surfaced.result as { schema?: { fingerprint?: unknown } }).schema
      ?.fingerprint;
    if (surfacedFingerprint === servedFingerprint) {
      // The warning's own truth is checked by the SDK's fingerprint tests; the
      // wire-tap question is only whether the client was told the truth about
      // what the host served.
      return [];
    }
    return [
      finding(O6, {
        indicts: "facade",
          summary: "the fingerprint the client sees is not the fingerprint the host served",
        apiSaid: `initializeResult.schema.fingerprint === ${JSON.stringify(surfacedFingerprint)} (warning ${warned ? "raised" : "absent"})`,
        wireSaid: `the host served ${JSON.stringify(servedFingerprint)}`,
        evidence: response === undefined ? [] : [response.raw],
      }),
    ];
  },
};

const O7: OracleCheck = {
  id: "O7",
  title: "the SDK writes nothing the caller did not ask for",
  constraint: {
    kind: "silent",
    hazard:
      "No requirement bounds the set of frames the facade may write on the caller's behalf. An integrator counting requests, budgeting a metered host, or auditing what left the machine depends on that set being exactly what they called.",
    candidates: [specRef("FR-013"), specRef("FR-014")],
  },
  run(observed) {
    const allowed = new Set(["initialize", "initialized", ...observed.requestedMethods]);
    const strays = observed.wire.outbound.filter((frame) => {
      const method = methodOf(frame);
      // Responses to server-initiated requests are answers, not client traffic.
      return method !== undefined && !allowed.has(method);
    });
    if (strays.length === 0) return [];
    return [
      finding(O7, {
        indicts: "facade",
          summary: "the SDK wrote a method the harness never called",
        apiSaid: `the harness called: ${[...allowed].join(", ")}`,
        wireSaid: `the wire also carried: ${[...new Set(strays.map((frame) => methodOf(frame) ?? "?"))].join(", ")}`,
        evidence: strays.map((frame) => frame.raw),
      }),
    ];
  },
};

/** Every check, in report order. */
export const ORACLE_CHECKS: readonly OracleCheck[] = [O1, O2, O3, O4, O5, O6, O7];

export function runOracle(
  observed: ObservedRun,
  checks: readonly OracleCheck[] = ORACLE_CHECKS,
): readonly OracleFinding[] {
  return checks.flatMap((check) => check.run(observed));
}
