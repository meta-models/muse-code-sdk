/**
 * The owned-host spawn and notification recorder now live in the shared
 * cookbook kit (`clients/sdk-cookbook/src/kit/host.ts`, issue #24225) so the
 * quickstart journey and every cookbook recipe spawn and observe hosts the
 * same way. This module re-exports it unchanged: `Host.start` still launches
 * `muse serve` with the same environment, budgets, and failure text.
 */

export {
  Host,
  SDK_GATE_ENV,
  STUB_VIEW_CURSOR,
  TimeoutError,
  arrayAt,
  equals,
  objectAt,
  stringAt,
  within,
} from "@muse-code/sdk-cookbook/kit";
export type { HostOptions, RecordedNotification } from "@muse-code/sdk-cookbook/kit";
