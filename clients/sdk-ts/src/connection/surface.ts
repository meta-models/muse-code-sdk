/**
 * The types a typed `Connection` checks calls against (FR-100032-3).
 *
 * Every type here is computed from the generated stable method → type maps,
 * so no params or result shape is restated by hand and none can drift from
 * the schema. Internal: the package does not export these helpers.
 */

import type { MspMethodMap, MspNotificationMap } from "@muse-code/msp";

/** Every client-to-server method the stable map names. */
export type MethodName = keyof MspMethodMap & string;

/** A method's `params` type; `undefined` for a method that takes none. */
export type MethodParams<M extends MethodName> = MspMethodMap[M] extends { params: infer P } ? P : never;

/** A method's `result` type. */
export type MethodResult<M extends MethodName> = MspMethodMap[M] extends { result: infer R } ? R : never;

/**
 * What a typed `request()`/`command()` resolves with: the method's result
 * type, still open to members a newer host adds (the wire evolves
 * additively), so it also stays assignable where `Record<string, unknown>`
 * was expected before these types existed.
 */
export type WireResult<M extends MethodName> = MethodResult<M> & Record<string, unknown>;

/**
 * The params a caller passes to `command()`: the method's params without
 * `commandId`, which the connection mints (INV-013).
 */
export type CommandParams<M extends MethodName> =
  MethodParams<M> extends infer P ? (P extends object ? Omit<P, "commandId"> : Record<string, never>) : never;

/**
 * The trailing `params` argument of a typed call: absent for a method that
 * takes none, optional when every member is optional, required otherwise.
 */
export type ParamsArgument<P> = [P] extends [undefined]
  ? []
  : Record<string, never> extends P
    ? [params?: P]
    : [params: P];

/**
 * Every notification the stable map names. The map also lists the two
 * client-sent ones (`initialized`, `userInput/engaged`); a listener on either
 * compiles but never runs, since the host does not send them.
 */
export type NotificationName = keyof MspNotificationMap & string;

/** A notification's `params` type; `undefined` for one that carries none. */
export type NotificationParams<M extends NotificationName> = MspNotificationMap[M];

/**
 * A method name the given names do NOT include. A listed method never
 * matches, so the untyped fallback cannot accept a mistyped call to a typed
 * method.
 */
export type UnlistedMethod<Names extends string, M extends string> = M extends Names ? never : M;
