interface Options {
  workspace: () => string;
  visible: () => boolean;
  invalidateTree: () => void;
  listRoot: () => Promise<unknown>;
  reportHealth: (error: string | null) => void;
}

/** Retry project health without mounting or revealing the explorer. */
export function createSidebarProjectRetry(options: Options) {
  let generation = 0;
  let disposed = false;
  async function retry(): Promise<void> {
    const workspace = options.workspace();
    if (disposed || !workspace) return;
    const request = ++generation;
    options.invalidateTree();
    // The mounted explorer owns its directory state and health reporting.
    if (options.visible()) return;
    let error: string | null = null;
    try {
      await options.listRoot();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    if (!disposed && request === generation && options.workspace() === workspace && !options.visible()) {
      options.reportHealth(error);
    }
  }
  return {
    retry,
    invalidate(): void { generation++; },
    dispose(): void { disposed = true; generation++; },
  };
}
