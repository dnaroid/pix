import { workCollapsedSections, workspaceConfigWithWorkSection, type WorkSectionId } from "../lib/work-panel-sections";
import { pendingWorkspaceConfigSaves, persistWorkspaceConfigEdit, readWorkspaceConfig } from "./workspace-config-persistence";

/**
 * Plans/Tasks accordion state for the Work sidebar tab, persisted per project in
 * `.pi/workspace.jsonc` (`workPanel.collapsedSections`). Both sections default open.
 */
export function createWorkPanelSections(reportError: (error: unknown, workspace: string) => void) {
  let collapsed = $state<ReadonlySet<string>>(new Set());
  let ready = $state(false);
  let workspace = "";
  let generation = 0;
  let disposed = false;
  let touched = new Map<WorkSectionId, boolean>();

  async function load(nextWorkspace: string): Promise<void> {
    if (disposed) return;
    if (nextWorkspace === workspace) return;
    const owner = ++generation;
    workspace = nextWorkspace;
    ready = false;
    collapsed = new Set();
    touched = new Map();
    if (!workspace) { ready = true; return; }
    try {
      await pendingWorkspaceConfigSaves(nextWorkspace);
      if (disposed || owner !== generation) return;
      const document = await readWorkspaceConfig(nextWorkspace);
      if (disposed || owner !== generation) return;
      const next = new Set(workCollapsedSections(document?.content));
      // User input during a slow restore takes precedence over the disk sample.
      for (const [id, open] of touched) {
        if (open) next.delete(id);
        else next.add(id);
      }
      collapsed = next;
    } catch (error) {
      if (!disposed && owner === generation) {
        collapsed = new Set([...touched].filter(([, open]) => !open).map(([id]) => id));
        reportError(error, nextWorkspace);
      }
    } finally {
      if (!disposed && owner === generation) ready = true;
    }
  }

  function setOpen(id: WorkSectionId, open: boolean): Promise<void> {
    if (disposed || !workspace || open === !collapsed.has(id)) return Promise.resolve();
    const next = new Set(collapsed);
    if (open) next.delete(id);
    else next.add(id);
    collapsed = next;
    touched.set(id, open);
    return persistWorkspaceConfigEdit(workspace, (source) => workspaceConfigWithWorkSection(source, id, open), "Work panel state", reportError);
  }

  return {
    load, setOpen,
    toggle: (id: WorkSectionId) => setOpen(id, collapsed.has(id)),
    get ready() { return ready; },
    isOpen: (id: WorkSectionId) => !collapsed.has(id),
    dispose() { disposed = true; generation++; },
  };
}

export type WorkPanelSections = ReturnType<typeof createWorkPanelSections>;
