import { createWikiConsistencyTreeState } from "../components/wiki-consistency-tree-state.svelte";
import { createProjectFilesRefresh } from "../lib/project-files-refresh";

type TreeStateOptions = Parameters<typeof createWikiConsistencyTreeState>[0];

interface Options extends Omit<TreeStateOptions, "wikiPath"> {
  /** Project-level Wiki root; null while unknown or unreadable. */
  readonly wikiPath: () => string | null;
  /** Periodic metadata refresh; tests inject a deterministic scheduler. */
  readonly periodic?: (refresh: () => Promise<void>) => { dispose(): void };
}

export const WIKI_CONSISTENCY_CONTEXT = Symbol("wiki-consistency");

/**
 * One background Wiki status/findings scan per project, shared by the Wiki tree
 * and the Wiki Conflicts tab, independent of whether the Wiki panel is mounted.
 */
export function createWikiConsistencyOwner(options: Options) {
  // A mounted tree has freshly loaded configuration; prefer it for the same project.
  let observed: { workspace: string; path: string } | undefined;
  const wikiPath = () => {
    const workspace = options.workspace();
    if (observed && observed.workspace === workspace) return observed.path;
    return options.wikiPath() ?? "";
  };
  const state = createWikiConsistencyTreeState({ ...options, wikiPath });
  let disposed = false;
  // Headless hosts (Node tests) have no focus/visibility signals to drive refresh.
  const defaultPeriodic = typeof window === "undefined" || typeof document === "undefined"
    ? () => ({ dispose() {} }) : createProjectFilesRefresh;
  const periodic = (options.periodic ?? defaultPeriodic)(async () => { state.refresh(); });

  return {
    summary: state.summary,
    findings: state.findings,
    wikiPath,
    refresh(): void { if (!disposed) state.refresh(); },
    /** Called by the mounted tree whenever its loaded Wiki configuration changes. */
    observeConfig(workspace: string, path: string): void {
      if (disposed) return;
      if (observed?.workspace === workspace && observed.path === path) return;
      observed = { workspace, path };
      state.refresh();
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      periodic.dispose();
      state.dispose();
      observed = undefined;
    },
  };
}

export type WikiConsistencyOwner = ReturnType<typeof createWikiConsistencyOwner>;
