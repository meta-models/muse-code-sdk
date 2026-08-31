/**
 * @packageDocumentation
 * `@muse-code/sdk` — the MSP TypeScript facade (tdd SS7.1).
 *
 * (The tag above is load-bearing: without it TypeDoc attaches this header to
 * the first re-export, whose generated reference page then publishes this
 * prose instead of the export's own TSDoc.)
 *
 * Slices 1 and 2 (spec `14990-muse-sdk`, plan.md) ship the workspace, the schema
 * fingerprint pin, and the transport-less core: the item/state fold algebra,
 * `SessionFold` binding it to the generated wire types, the complete SS4.13
 * pending-command fold, and the duplex-agnostic NDJSON connection with its
 * typed stdio handshake.
 *
 * Slice 3 ships the SS7.1 facade: `MuseClient` (incl. `spawn`), `Session`,
 * `TurnHandle`'s iterators and INV-014 turn-wait, the SS2.13.3b host-death
 * discharge on BOTH notifications (process exit and transport EOF), the
 * `sendUserTurn` and `approval/decide` submit verbs, the SS4.13 retirement
 * drivers those verbs made reachable, and the SS4.8 gap splice-fill inside the
 * iterators (FR-020).
 *
 * Not here yet, each with its named dependency; the condition and the command
 * that re-derives it live once, in `specs/14990-muse-sdk/tasks.md` under "The
 * slice-3 blocker".
 *  - Snapshot ingestion (FR-008) — sequenced behind spec 210 T061's corpus
 *    regeneration, not behind a shape.
 *  - Corpus replay + checkpoint equality (slice 1c) — runnable now; own PR.
 */

export {
  EXPECTED_SCHEMA_FINGERPRINT,
  checkServedFingerprint,
  fingerprintMismatchMessage,
} from "./fingerprint.js";
export type { FingerprintWarning } from "./fingerprint.js";

export { ItemStore } from "./fold/item-store.js";
export type {
  DeltaApplyOutcome,
  ItemApplyOutcome,
  RevisionedItem,
  TerminalUnknownItemAnnotation,
} from "./fold/item-store.js";

export { SessionStateStore } from "./fold/state-store.js";
export type { StateApplyOutcome, StateValue } from "./fold/state-store.js";

export { SessionFold } from "./fold/session-fold.js";
export type {
  FoldItems,
  FoldOutcome,
  FoldSessionState,
  PendingApproval,
  SessionStateMethod,
  SessionStateParams,
  StaleDroppableMethod,
  TurnEntry,
  TurnState,
  ViewEvent,
} from "./fold/session-fold.js";

export {
  COMMAND_REJECTED_CODE,
  COMMAND_REJECTED_KIND,
  PendingCommandSet,
} from "./pending/pending-command-set.js";
export type {
  CommandErrorResponse,
  PendingCommandAck,
  PendingCommandEntry,
  PendingCommandSetOptions,
  PendingDisposition,
  PendingJoinPlan,
  PendingRetirement,
  ReplayAnswer,
  SnapshotJoinFacts,
} from "./pending/pending-command-set.js";

export {
  Connection,
  createUuidV7Mint,
  MspError,
  ProtocolError,
} from "./connection/connection.js";
export type {
  CommandOptions,
  ConnectionOptions,
  DuplexTransport,
  NotificationHandler,
  ProtocolErrorHandler,
  ServerRequestHandler,
} from "./connection/connection.js";

export {
  MspHandshake,
  MuseServeChild,
  SpawnedMspConnection,
  spawnMspConnection,
} from "./connection/spawn.js";

export { MuseClient } from "./facade/client.js";
export type {
  MuseClientOptions,
  MuseClientSpawnOptions,
  ResumeSessionOptions,
  StartSessionOptions,
} from "./facade/client.js";

export type {
  ExitClassification,
  MuseServeChildOptions,
  ProcessExit,
  SpawnMspConnectionOptions,
} from "./connection/spawn.js";

// The client-scoped SS2.13.3b discard memory. Exported as
// `SessionOptions.discarded`'s type: a consumer composing bare `Session`s can
// share one registry across them. `MuseClient` builds its own and accepts
// none — the cross-client sharing knob was declined (Constitution XI; see the
// constructor note in `facade/client.ts`).
export { DiscardedSessions } from "./facade/discarded.js";

export {
  MuseForeignSessionError,
  MuseGapFillError,
  MuseSessionDiscardedError,
} from "./errors.js";
export type { GapFillFailureReason } from "./errors.js";

// The FR-020 filler itself stays OFF the barrel (Constitution XI): `GapFiller`
// is `Session`'s internal with no consumer, exactly like `ApprovalRouter` and
// `TurnSubmitter`. Its handler TYPE is exported because a consumer writes one.
export type { GapFillFailureHandler } from "./facade/gap-fill.js";

// Trimmed deliberately (Constitution XI): `isAbnormalHostDeath`,
// `isItemInProgress`, and `survivesHostDeath` are `Session`'s own internals
// with no consumer, and a barrel export would freeze them into `@muse-code/sdk`'s
// contract the moment #211 adopts the package.
export { MuseHostDiedError, readSessionDurability } from "./facade/host-death.js";
export type {
  AbnormalExit,
  HostDeathDischarge,
  HostDeathNotification,
  SessionDurabilityProfile,
  TransportEof,
} from "./facade/host-death.js";

export { Session } from "./facade/session.js";
export type {
  PendingCommandView,
  SessionApplyOutcome,
  SessionApplyRefusal,
  SessionFoldView,
  SessionGapBuffered,
  SessionGapOverlap,
  SessionOpening,
  SessionOptions,
} from "./facade/session.js";

// The two submit-side modules `Session` composes. `ApprovalRouter` and
// `TurnSubmitter` themselves stay OFF the barrel (Constitution XI): they are
// `Session`'s internals with no consumer, and exporting them would freeze two
// more classes into `@muse-code/sdk`'s contract. Their TYPES are exported because a
// consumer writes an `ApprovalHandler` and reads an `ApprovalFailure`.
export type {
  ApprovalDecisionInput,
  ApprovalFailure,
  ApprovalFailureHandler,
  ApprovalHandler,
} from "./facade/approval.js";
export type { SendUserTurnOptions } from "./facade/turn-submit.js";

// `Turn` (the narrow consumer view), not `TurnHandle`: the concrete class's
// Session-fed mutators would let an embedder fabricate a terminal (INV-006).
export { isLaunchFailure } from "./facade/turn-handle.js";
export type { FoldedItem, Turn, TurnOutcome } from "./facade/turn-handle.js";
