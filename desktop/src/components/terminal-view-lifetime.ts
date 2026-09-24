/** Owns callbacks that must not touch xterm after its view has unmounted. */
export function createTerminalViewLifetime(
  requestFrame: typeof requestAnimationFrame = requestAnimationFrame,
  cancelFrame: typeof cancelAnimationFrame = cancelAnimationFrame,
  setTimer: (callback: () => void, delay: number) => number = (callback, delay) => window.setTimeout(callback, delay),
  clearTimer: (handle: number) => void = (handle) => window.clearTimeout(handle),
) {
  let active = true;
  let initialFrame: number | undefined;
  let fitFrame: number | undefined;
  const timers = new Set<number>();
  const listeners = new Set<() => void>();

  function schedule(callback: () => void, kind: "initial" | "fit"): void {
    if (!active || (kind === "initial" ? initialFrame : fitFrame) !== undefined) return;
    const frame = requestFrame(() => {
      if (kind === "initial") initialFrame = undefined;
      else fitFrame = undefined;
      if (active) callback();
    });
    if (kind === "initial") initialFrame = frame;
    else fitFrame = frame;
  }

  return {
    isActive: () => active,
    scheduleInitial: (callback: () => void) => schedule(callback, "initial"),
    scheduleFit: (callback: () => void) => schedule(callback, "fit"),
    setTimeout(callback: () => void, delay: number): number | null {
      if (!active) return null;
      const handle = setTimer(() => {
        timers.delete(handle);
        if (active) callback();
      }, delay);
      timers.add(handle);
      return handle;
    },
    clearTimeout(handle: number): void {
      timers.delete(handle);
      clearTimer(handle);
    },
    listen(target: EventTarget, name: string, callback: EventListener): void {
      if (!active) return;
      const guarded: EventListener = (event) => { if (active) callback(event); };
      target.addEventListener(name, guarded);
      listeners.add(() => target.removeEventListener(name, guarded));
    },
    resolveLinks<T>(resolve: () => readonly T[] | Promise<readonly T[]>, callback: (links: readonly T[] | undefined) => void): void {
      if (!active) return;
      void Promise.resolve().then(() => active ? resolve() : undefined).then(
        (links) => { if (active) callback(links); },
        () => { if (active) callback(undefined); },
      );
    },
    dispose(): void {
      if (!active) return;
      active = false;
      if (initialFrame !== undefined) cancelFrame(initialFrame);
      if (fitFrame !== undefined) cancelFrame(fitFrame);
      for (const handle of timers) clearTimer(handle);
      timers.clear();
      for (const remove of listeners) remove();
      listeners.clear();
      initialFrame = undefined;
      fitFrame = undefined;
    },
  };
}

export type TerminalViewLifetime = ReturnType<typeof createTerminalViewLifetime>;
