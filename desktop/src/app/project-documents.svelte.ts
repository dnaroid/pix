import { invoke } from "@tauri-apps/api/core";
import { confirmDesktopDeletion } from "../lib/confirm-deletion";
import { isWorkspaceProjectFilePath, type ProjectFilePreview } from "../lib/project-files";
import {
  EMPTY_PROJECT_DOCUMENTS,
  PROJECT_TODO_PATH,
  isEditableProjectMarkdown,
  isCanonicalProjectPlanPath,
  type ProjectDocumentsSnapshot,
} from "../lib/project-documents";

type ProjectDocumentsStoreOptions = {
  workspace: () => string;
  openProjectFile: (path: string) => void | Promise<void>;
  showEmptyFile: (file: ProjectFilePreview) => void;
  previewId: () => number | undefined;
  afterSave: (file: ProjectFilePreview, workspace: string, previewId: number | undefined) => void;
  afterDelete?: (path: string, workspace: string) => void;
  clearError: () => void;
  reportError: (error: unknown) => void;
};

export function createProjectDocumentsStore(options: ProjectDocumentsStoreOptions) {
  let snapshot = $state<ProjectDocumentsSnapshot>(EMPTY_PROJECT_DOCUMENTS);
  let generation = 0;
  let workspaceGeneration = 0;
  const writes = new Map<string, Promise<ProjectFilePreview>>();
  let removing = $state<string | null>(null);

  function reset(): void {
    generation += 1;
    workspaceGeneration += 1;
    snapshot = EMPTY_PROJECT_DOCUMENTS;
    removing = null;
  }

  async function load(projectPath: string): Promise<void> {
    const requestGeneration = ++generation;
    try {
      const next = await invoke<ProjectDocumentsSnapshot>("list_project_documents", {
        workspace: projectPath,
      });
      if (requestGeneration !== generation || options.workspace() !== projectPath) return;
      snapshot = next;
    } catch (error) {
      if (requestGeneration === generation && options.workspace() === projectPath) options.reportError(error);
    }
  }

  async function refresh(): Promise<void> {
    const workspace = options.workspace();
    if (workspace) await load(workspace);
  }

  function open(path: string, exists = true): void {
    if (!options.workspace() || !isEditableProjectMarkdown(path)) return;
    if (exists) {
      void options.openProjectFile(path);
      return;
    }
    if (path === PROJECT_TODO_PATH) options.showEmptyFile({ path, content: "" });
  }

  async function save(path: string, content: string): Promise<boolean> {
    const workspace = options.workspace();
    if (!workspace || !isWorkspaceProjectFilePath(path) || removing === path) return false;
    const requestGeneration = workspaceGeneration;
    const previewId = options.previewId();
    const isCurrent = () => requestGeneration === workspaceGeneration && options.workspace() === workspace;
    const key = `${workspace}\0${path}`;
    const command = isEditableProjectMarkdown(path) ? "write_project_markdown" : "write_project_file";
    options.clearError();
    try {
      const previous = writes.get(key) ?? Promise.resolve();
      const pending = previous.catch(() => {}).then(() => invoke<ProjectFilePreview>(command, {
        workspace, path, content,
      })).finally(() => {
        if (writes.get(key) === pending) writes.delete(key);
      });
      writes.set(key, pending);
      const saved = await pending;
      if (!isCurrent()) return false;
      options.afterSave(saved, workspace, previewId);
      void load(workspace);
      return true;
    } catch (error) {
      if (isCurrent()) options.reportError(error);
      return false;
    }
  }

  async function removePlan(path: string): Promise<void> {
    const workspace = options.workspace();
    if (!workspace || removing || !isCanonicalProjectPlanPath(path) || !snapshot.plans.includes(path)) return;
    const requestGeneration = workspaceGeneration;
    const isCurrent = () => requestGeneration === workspaceGeneration && options.workspace() === workspace;
    removing = path;
    try {
      if (!await confirmDesktopDeletion(`Delete plan “${path}”?\n\nThe file and any unsaved changes will be lost. This cannot be undone.`, {
        title: "Delete plan?", okLabel: "Delete",
      }) || !isCurrent()) return;
      // Let an in-flight save finish first; new saves of this plan are blocked.
      await writes.get(`${workspace}\0${path}`)?.catch(() => {});
      if (!isCurrent()) return;
      options.clearError();
      await invoke("delete_project_entry", { workspace, path });
      if (!isCurrent()) return;
      generation += 1;
      snapshot = { ...snapshot, plans: snapshot.plans.filter((candidate) => candidate !== path) };
      options.afterDelete?.(path, workspace);
      await load(workspace);
    } catch (error) {
      if (isCurrent()) options.reportError(error);
    } finally {
      if (isCurrent()) removing = null;
    }
  }

  return {
    get snapshot() { return snapshot; },
    get removing() { return removing; },
    reset,
    load,
    refresh,
    open,
    save,
    removePlan,
  };
}
