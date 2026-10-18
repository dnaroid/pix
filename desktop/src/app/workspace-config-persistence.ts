import { invoke } from "@tauri-apps/api/core";
import type { ProjectFilePreview } from "../lib/project-files";
import { WORKSPACE_CONFIG_PATH } from "../lib/project-colors";

export type WorkspaceConfigEdit = (source: string | undefined) => string;

// Panels may unmount/reopen before their final write completes. All Desktop view-state
// writers of .pi/workspace.jsonc share one per-workspace queue so their compare-and-swap
// edits never race each other, without retaining component state in this queue.
const saves = new Map<string, Promise<void>>();

export async function readWorkspaceConfig(workspace: string): Promise<ProjectFilePreview | undefined> {
  const exists = await invoke<boolean>("project_file_exists", { workspace, path: WORKSPACE_CONFIG_PATH });
  return exists ? invoke<ProjectFilePreview>("read_project_file", { workspace, path: WORKSPACE_CONFIG_PATH }) : undefined;
}

async function saveConfig(workspace: string, edit: WorkspaceConfigEdit, label: string): Promise<void> {
  let current = await readWorkspaceConfig(workspace);
  for (let attempt = 0; attempt < 3; attempt++) {
    const content = edit(current?.content);
    const result = await invoke<{ written: boolean; document: ProjectFilePreview | null }>("write_project_workspace_config_if_unchanged", {
      workspace, expectedContent: current?.content ?? null, content,
    });
    if (result.written) return;
    current = result.document ?? undefined;
  }
  throw new Error(`.pi/workspace.jsonc changed repeatedly while ${label} was being saved.`);
}

/** Resolve after every accepted write queued for this workspace. */
export function pendingWorkspaceConfigSaves(workspace: string): Promise<void> | undefined {
  return saves.get(workspace);
}

/** Queue one edit for its original project, even if the requesting panel closes. */
export function persistWorkspaceConfigEdit(
  workspace: string,
  edit: WorkspaceConfigEdit,
  label: string,
  reportError: (error: unknown, workspace: string) => void,
): Promise<void> {
  const pending = (saves.get(workspace) ?? Promise.resolve())
    .then(() => saveConfig(workspace, edit, label))
    .catch((error) => reportError(error, workspace));
  saves.set(workspace, pending);
  void pending.then(() => { if (saves.get(workspace) === pending) saves.delete(workspace); });
  return pending;
}
