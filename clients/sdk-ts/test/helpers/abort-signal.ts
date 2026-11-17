/**
 * Test helper shared by the `session.events()` suites: an abort signal whose
 * live `abort` listeners can be counted, to prove a stream deregisters.
 */

/**
 * An abort signal that tracks which `abort` listeners are still attached, by
 * identity, to prove deregistration: removing a different function does not
 * count, and a `once` listener goes when the signal fires, as the platform
 * drops it then without a `removeEventListener` call.
 */
export function countingSignal(): { signal: AbortSignal; listeners: () => number; abort: () => void } {
  const controller = new AbortController();
  const signal = controller.signal;
  const attached = new Map<EventListener, boolean>();
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, listener: EventListener, options?: AddEventListenerOptions) => {
    if (type === "abort") attached.set(listener, options?.once === true);
    add(type, listener, options);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, listener: EventListener, options?: EventListenerOptions) => {
    if (type === "abort") attached.delete(listener);
    remove(type, listener, options);
  }) as typeof signal.removeEventListener;
  const abort = (): void => {
    controller.abort();
    for (const [listener, once] of attached) if (once) attached.delete(listener);
  };
  return { signal, listeners: () => attached.size, abort };
}
