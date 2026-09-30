/** Allow connection/startup work to settle before the first catalog request. */
export const REGISTRY_STARTUP_DELAY_MS = 3_000;

export interface RegistryStartupState {
  readonly ready: boolean;
  readonly client: object | null;
  readonly workspace: string;
  readonly blocked: boolean;
}

export function createRegistryStartupLoader(options: {
  state: () => RegistryStartupState;
  refresh: () => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: RegistryStartupState | undefined;
  let loaded: RegistryStartupState | undefined;
  let disposed = false;

  function sameTarget(a: RegistryStartupState | undefined, b: RegistryStartupState): boolean {
    return a?.client === b.client && a?.workspace === b.workspace;
  }

  function cancel(): void {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  }

  function sync(): void {
    if (disposed) return;
    const state = options.state();
    if (!state.ready || !state.client || !state.workspace) {
      cancel();
      loaded = undefined;
      return;
    }
    // Returning before the next target loads must not reuse a cleared catalog.
    if (!sameTarget(loaded, state)) loaded = undefined;
    if (state.blocked || !sameTarget(pending, state)) cancel();
    if (state.blocked || sameTarget(loaded, state) || timer !== undefined) return;
    pending = state;
    timer = setTimeout(() => {
      timer = undefined;
      pending = undefined;
      const current = options.state();
      if (disposed) return;
      if (!current.ready || current.blocked || !sameTarget(state, current)) {
        sync();
        return;
      }
      loaded = current;
      options.refresh();
    }, REGISTRY_STARTUP_DELAY_MS);
  }

  return {
    sync,
    dispose(): void {
      disposed = true;
      cancel();
    },
  };
}
