import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmDesktopAction } from "../lib/confirm-action";
import {
  isAbsoluteProjectPath,
  projectWindowUrl,
  workspaceFromLocation,
  WORKSPACE_STORAGE_KEY,
} from "../lib/recent-projects";
import type { ProjectRelocation, ProjectSelectionPlan } from "./project-relocation";

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
  /** Renamed/moved project detection and path-keyed state relocation. */
  relocation?: Pick<ProjectRelocation, "plan" | "relocate" | "record">;
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

  function recordIdentity(path: string): void {
    void options.relocation?.record(path).catch(options.reportError);
  }

  async function planSelection(selected: string): Promise<ProjectSelectionPlan> {
    if (!options.relocation) return { target: selected };
    try {
      return await options.relocation.plan(selected);
    } catch (error) {
      // Detection is advisory; an unexpected failure must not block opening.
      options.reportError(error);
      return { target: selected };
    }
  }

  async function select(selected: string): Promise<void> {
    if (options.blocked()) return;
    options.closeSessionSelector();
    if (!isAbsoluteProjectPath(selected)) {
      options.setErrorMessage("The selected project path is not absolute.");
      return;
    }
    const workspace = options.workspace();
    // Without relocation support keep the switch synchronous up to the first native call.
    const plan = options.relocation ? await planSelection(selected) : { target: selected };
    if (!plan || options.blocked() || options.workspace() !== workspace) return;
    await apply(workspace, plan.target, plan.relocateFrom);
  }

  /**
   * Startup check for the restored workspace: offers relocation when the
   * folder was renamed/moved, otherwise only records its stable identity.
   */
  async function reconcile(): Promise<void> {
    const workspace = options.workspace();
    if (!workspace || !options.relocation || options.blocked()) return;
    const plan = await planSelection(workspace);
    if (!plan || options.blocked() || options.workspace() !== workspace) return;
    if (plan.target === workspace && !plan.relocateFrom) {
      recordIdentity(workspace);
      return;
    }
    await apply(workspace, plan.target, plan.relocateFrom);
  }

  async function apply(workspace: string, selected: string, relocateFrom?: string): Promise<void> {
    if (selected === workspace && !relocateFrom) {
      options.rememberProject(selected);
      void options.loadDesktopPreferences(selected);
      recordIdentity(selected);
      return;
    }
    if (options.previewDirty() && !await confirmDesktopAction("Discard unsaved Preview changes and switch projects?")) return;
    if (options.blocked() || options.workspace() !== workspace) return;

    options.setOperationRunning(true);
    options.setErrorMessage(null);
    try {
      if (workspace) {
        const windowLabel = getCurrentWindow().label;
        await Promise.allSettled([
          invoke("package_terminal_stop_workspace", { windowLabel, workspace }),
        ]).then((results) => {
          for (const result of results) {
            if (result.status === "rejected") options.reportError(result.reason);
          }
        });
      }
      await options.closeWorkspaceSessions();
      let relocated = true;
      if (relocateFrom && options.relocation) {
        try {
          await options.relocation.relocate(relocateFrom, selected);
        } catch (error) {
          // Still open the folder; the identity stays unrecorded so the move is offered again.
          relocated = false;
          options.reportError(error);
        }
      }
      await persist(selected);
      options.resetForWorkspace(selected);
      options.rememberProject(selected);
      await options.loadWorkspace(selected);
      if (relocated) recordIdentity(selected);
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
    reconcile,
    select,
  };
}
