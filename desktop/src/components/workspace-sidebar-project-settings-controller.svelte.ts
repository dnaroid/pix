interface WorkspaceSidebarProjectSettingsControllerOptions {
  readonly workspace: () => string;
  readonly closeProjectSwitcher: () => void;
  readonly saveProjectColor: (color: string | undefined) => Promise<string | undefined>;
}

export function createWorkspaceSidebarProjectSettingsController(
  options: WorkspaceSidebarProjectSettingsControllerOptions,
) {
  let open = $state(false);
  let saving = $state(false);
  let error = $state<string | null>(null);

  function reset(): void {
    open = false;
    saving = false;
    error = null;
  }

  function show(): void {
    if (!options.workspace()) return;
    options.closeProjectSwitcher();
    error = null;
    open = true;
  }

  async function save(color: string | undefined): Promise<void> {
    const requestWorkspace = options.workspace();
    if (!requestWorkspace || saving) return;
    saving = true;
    error = null;
    try {
      const nextError = await options.saveProjectColor(color);
      if (options.workspace() !== requestWorkspace) return;
      if (nextError) {
        error = nextError;
        return;
      }
      open = false;
    } finally {
      if (options.workspace() === requestWorkspace) saving = false;
    }
  }

  function close(): void {
    if (saving) return;
    open = false;
    error = null;
  }

  return {
    get open() { return open; },
    get saving() { return saving; },
    get error() { return error; },
    reset,
    show,
    save,
    close,
  };
}
