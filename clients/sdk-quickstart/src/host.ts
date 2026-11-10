/**
 * The harness helpers the journey shares with every cookbook recipe live in
 * the shared cookbook kit (`clients/sdk-cookbook/src/kit/host.ts`, issue
 * #24225): the isolated host environment, the owned drain window, bounded
 * waits, and the typed readers for untyped result members. The journey talks
 * to the host through the SDK's own `MuseClient`, so it needs none of the
 * kit's raw-connection `Host` recorder.
 */

export {
  HOST_DRAIN_WINDOW_MS,
  STUB_VIEW_CURSOR,
  arrayAt,
  drainQuietly,
  equals,
  isolatedHostEnv,
  objectAt,
  stringAt,
  within,
} from "@muse-code/sdk-cookbook/kit";
