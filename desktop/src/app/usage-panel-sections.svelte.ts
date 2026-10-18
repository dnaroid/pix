import { USAGE_SECTION_IDS, usageCollapsedSections, usageProviderOrder, workspaceConfigWithUsageProviderOrder, workspaceConfigWithUsageSection, type UsageSectionId } from "../lib/usage-panel-sections";
import { pendingWorkspaceConfigSaves, persistWorkspaceConfigEdit, readWorkspaceConfig, type WorkspaceConfigEdit } from "./workspace-config-persistence";

export function createUsagePanelSections(reportError: (error: unknown, workspace: string) => void) {
  let collapsed = $state<ReadonlySet<string>>(new Set(USAGE_SECTION_IDS));
  let providerOrder = $state<readonly string[]>([]);
  let ready = $state(false);
  let workspace = "";
  let generation = 0;
  let disposed = false;
  let touched = new Map<UsageSectionId, boolean>();

  async function load(nextWorkspace: string): Promise<void> {
    if (disposed) return;
    if (nextWorkspace === workspace && ready) return;
    const owner = ++generation;
    workspace = nextWorkspace;
    ready = false;
    collapsed = new Set(USAGE_SECTION_IDS);
    providerOrder = [];
    touched = new Map();
    if (!workspace) return;
    try {
      await pendingWorkspaceConfigSaves(nextWorkspace);
      if (disposed || owner !== generation) return;
      const document = await readWorkspaceConfig(nextWorkspace);
      if (disposed || owner !== generation) return;
      const next = new Set(usageCollapsedSections(document?.content));
      providerOrder = usageProviderOrder(document?.content);
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

  function setOpen(id: UsageSectionId, open: boolean): Promise<void> {
    if (disposed || !workspace || (ready && open === !collapsed.has(id))) return Promise.resolve();
    const next = new Set(collapsed);
    if (open) next.delete(id);
    else next.add(id);
    collapsed = next;
    touched.set(id, open);
    return persist(workspace, (source) => workspaceConfigWithUsageSection(source, id, open));
  }

  function setProviderOrder(order: readonly string[]): Promise<void> {
    if (disposed || !ready || !workspace) return Promise.resolve();
    const next = [...new Set(order)];
    if (next.length === providerOrder.length && next.every((id, index) => id === providerOrder[index])) return Promise.resolve();
    providerOrder = next;
    return persist(workspace, (source) => workspaceConfigWithUsageProviderOrder(source, next));
  }

  function persist(target: string, edit: WorkspaceConfigEdit): Promise<void> {
    return persistWorkspaceConfigEdit(target, edit, "usage panel state", reportError);
  }

  return {
    load, setOpen, setProviderOrder,
    get ready() { return ready; },
    get providerOrder() { return providerOrder; },
    isOpen: (id: UsageSectionId) => !collapsed.has(id),
    dispose() { disposed = true; generation++; },
  };
}

export type UsagePanelSections = ReturnType<typeof createUsagePanelSections>;
