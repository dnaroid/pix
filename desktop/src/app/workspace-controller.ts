import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import {
  isAbsoluteProjectPath,
  projectWindowUrl,
  workspaceFromLocation,
  WORKSPACE_STORAGE_KEY,
} from "../lib/recent-projects";

type WorkspaceControllerOptions = {
  workspace: () => string;
  blocked: () => boolean;
  previewDirty: () => boolean;
  closeSessionSelector: () => void;
  rememberProject: (path: string) => void;
  loadDesktopPreferences: (path: string) => void | Promise<void>;
  closeWorkspaceSessions: () => Promise<void>;
  resetForWorkspace: (selected: string) => void;
  loadWorkspace: (selected: string) => Promise<void>;
  setOperationRunning: (running: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createWorkspaceController(options: WorkspaceControllerOptions) {
  async function choose(): Promise<void> {
    if (options.blocked()) return;
    const workspace = options.workspace();
    const selected = await open({
      directory: true,
      multiple: false,
      canCreateDirectories: true,
      title: "Choose or create a Pix project folder",
      ...(workspace ? { defaultPath: workspace } : {}),
    });
    if (typeof selected !== "string") return;
    await select(selected);
  }

  async function chooseInNewWindow(): Promise<void> {
    const workspace = options.workspace();
    const selected = await open({
      directory: true,
      multiple: false,
      canCreateDirectories: true,
      title: "Choose or create a Pix project folder for a new window",
      ...(workspace ? { defaultPath: workspace } : {}),
    });
    if (typeof selected !== "string") return;
    openInNewWindow(selected);
  }

  async function persist(selected: string): Promise<void> {
    await invoke("desktop_window_workspace", { workspace: selected }).catch(options.reportError);
    try {
      if (workspaceFromLocation(window.location.href)) {
        window.history.replaceState(null, "", projectWindowUrl(window.location.href, selected));
      } else {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, selected);
      }
    } catch {
      // A storage or history failure should not prevent opening the project for this run.
    }
  }

  function openInNewWindow(selected: string): void {
    if (!isAbsoluteProjectPath(selected)) return;
    options.rememberProject(selected);
    const label = `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    void invoke("desktop_open_project_window", { label, workspace: selected }).catch(options.reportError);
  }

  async function select(selected: string): Promise<void> {
    if (options.blocked()) return;
    options.closeSessionSelector();
    if (!isAbsoluteProjectPath(selected)) {
      options.setErrorMessage("The selected project path is not absolute.");
      return;
    }
    const workspace = options.workspace();
    if (selected === workspace) {
      options.rememberProject(selected);
      void options.loadDesktopPreferences(selected);
      return;
    }
    if (options.previewDirty() && !window.confirm("Discard unsaved Preview changes and switch projects?")) return;

    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      if (workspace) {
        const windowLabel = getCurrentWindow().label;
        await Promise.allSettled([
          invoke("package_terminal_stop_workspace", { windowLabel, workspace }),
          invoke("idx_operation_stop_workspace", { windowLabel, workspace }),
        ]).then((results) => {
          for (const result of results) {
            if (result.status === "rejected") options.reportError(result.reason);
          }
        });
      }
      await options.closeWorkspaceSessions();
      await persist(selected);
      options.resetForWorkspace(selected);
      options.rememberProject(selected);
      await options.loadWorkspace(selected);
    } catch (error) {
      options.reportError(error);
    } finally {
      options.setOperationRunning(false);
    }
  }

  return {
    choose,
    chooseInNewWindow,
    openInNewWindow,
    select,
  };
}
