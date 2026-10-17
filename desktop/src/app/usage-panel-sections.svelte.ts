import { invoke } from "@tauri-apps/api/core";
import type { ProjectFilePreview } from "../lib/project-files";
import { WORKSPACE_CONFIG_PATH } from "../lib/project-colors";
import { USAGE_SECTION_IDS, usageCollapsedSections, workspaceConfigWithUsageSection, type UsageSectionId } from "../lib/usage-panel-sections";

// A panel may unmount/reopen before its final write completes. New instances
// wait for accepted toggles, without retaining component state in this queue.
const saves = new Map<string, Promise<void>>();

async function readConfig(workspace: string): Promise<ProjectFilePreview | undefined> {
  const exists = await invoke<boolean>("project_file_exists", { workspace, path: WORKSPACE_CONFIG_PATH });
  return exists ? invoke<ProjectFilePreview>("read_project_file", { workspace, path: WORKSPACE_CONFIG_PATH }) : undefined;
}

async function saveSection(workspace: string, id: UsageSectionId, open: boolean): Promise<void> {
  let current = await readConfig(workspace);
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = workspaceConfigWithUsageSection(current?.content, id, open);
    const result = await invoke<{ written: boolean; document: ProjectFilePreview | null }>("write_project_workspace_config_if_unchanged", {
      workspace, expectedContent: current?.content ?? null, content,
    });
    if (result.written) return;
    current = result.document ?? undefined;
  }
  throw new Error(".pi/workspace.jsonc changed repeatedly while usage panel state was being saved.");
}

export function createUsagePanelSections(reportError: (error: unknown, workspace: string) => void) {
  let collapsed = $state<ReadonlySet<string>>(new Set(USAGE_SECTION_IDS));
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
    touched = new Map();
    if (!workspace) return;
    try {
      await saves.get(nextWorkspace);
      if (disposed || owner !== generation) return;
      const document = await readConfig(nextWorkspace);
      if (disposed || owner !== generation) return;
      const next = new Set(usageCollapsedSections(document?.content));
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
    const target = workspace;
    // Persist accepted input to its original project, even if the panel closes.
    const pending = (saves.get(target) ?? Promise.resolve())
      .then(() => saveSection(target, id, open))
      .catch((error) => reportError(error, target));
    saves.set(target, pending);
    void pending.then(() => { if (saves.get(target) === pending) saves.delete(target); });
    return pending;
  }

  return {
    load, setOpen,
    get ready() { return ready; },
    isOpen: (id: UsageSectionId) => !collapsed.has(id),
    dispose() { disposed = true; generation++; },
  };
}

export type UsagePanelSections = ReturnType<typeof createUsagePanelSections>;
