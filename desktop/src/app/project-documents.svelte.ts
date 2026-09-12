import { invoke } from "@tauri-apps/api/core";
import type { ProjectFilePreview } from "../lib/project-files";
import {
  EMPTY_PROJECT_DOCUMENTS,
  PROJECT_TODO_PATH,
  isEditableProjectMarkdown,
  type ProjectDocumentsSnapshot,
} from "../lib/project-documents";

type ProjectDocumentsStoreOptions = {
  workspace: () => string;
  openProjectFile: (path: string) => void | Promise<void>;
  showEmptyFile: (file: ProjectFilePreview) => void;
  afterSave: (file: ProjectFilePreview, workspace: string) => void;
  clearError: () => void;
  reportError: (error: unknown) => void;
};

export function createProjectDocumentsStore(options: ProjectDocumentsStoreOptions) {
  let snapshot = $state<ProjectDocumentsSnapshot>(EMPTY_PROJECT_DOCUMENTS);
  let generation = 0;

  function reset(): void {
    generation += 1;
    snapshot = EMPTY_PROJECT_DOCUMENTS;
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
    if (!workspace || !isEditableProjectMarkdown(path)) return false;
    options.clearError();
    try {
      const saved = await invoke<ProjectFilePreview>("write_project_markdown", {
        workspace,
        path,
        content,
      });
      if (options.workspace() !== workspace) return false;
      options.afterSave(saved, workspace);
      void load(workspace);
      return true;
    } catch (error) {
      if (options.workspace() === workspace) options.reportError(error);
      return false;
    }
  }

  return {
    get snapshot() { return snapshot; },
    reset,
    load,
    open,
    save,
  };
}
