import type { ActiveSessionState } from "./active-session-state.svelte";
import type { DesktopProjectServices } from "./desktop-project-services";
import type { DesktopSessionServices } from "./desktop-session-services";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { confirmDesktopAction } from "../lib/confirm-action";
import { createDiagnosticLogger } from "../lib/diagnostic-logging";
import { createProjectRelocation } from "./project-relocation";
import { createWorkspaceController } from "./workspace-controller";

type SessionTabController = {
  closeSessionSelector: () => void;
  closeWorkspaceSessions: () => Promise<void>;
};

type ProjectActions = {
  reset: () => void;
};

type WorkspaceSessionStartup = {
  open: () => Promise<void>;
};

type DesktopWorkspaceServicesOptions = {
  workspace: () => string;
  setWorkspace: (workspace: string) => void;
  blocked: () => boolean;
  state: ActiveSessionState;
  sessions: DesktopSessionServices;
  project: DesktopProjectServices;
  sessionTabs: () => SessionTabController;
  projectActions: () => ProjectActions;
  startup: () => WorkspaceSessionStartup;
  resetWorkbench: () => void;
  setOperationRunning: (running: boolean) => void;
  setErrorMessage: (message: string | null) => void;
  reportError: (error: unknown) => void;
};

export function createDesktopWorkspaceServices(options: DesktopWorkspaceServicesOptions) {
  const diagnostics = createDiagnosticLogger(() => ({ workspace: options.workspace() }));
  const relocation = createProjectRelocation({
    invoke: (command, args) => invoke(command, args),
    confirm: (message, confirmOptions) => confirmDesktopAction(message, { kind: "warning", ...confirmOptions }),
    pickFolder: async (defaultPath) => {
      const selected = await open({
        directory: true,
        multiple: false,
        title: "Locate the renamed or moved project folder",
        defaultPath,
      });
      return typeof selected === "string" ? selected : null;
    },
    storage: () => localStorage,
    recentProjects: () => options.project.workspace.recentProjects,
    relocateInMemory: (from, to) => {
      options.sessions.tabs.relocateWorkspace(from, to);
      options.project.workspace.relocate(from, to);
    },
    reportWarning: (message) => diagnostics.report(new Error(message), "frontend:warning", "project-relocation"),
  });
  const controller = createWorkspaceController({
    relocation,
    workspace: options.workspace,
    blocked: options.blocked,
    previewDirty: () => options.project.preview.dirty,
    closeSessionSelector: () => options.sessionTabs().closeSessionSelector(),
    rememberProject: options.project.workspace.remember,
    loadDesktopPreferences: options.project.workspace.loadPreferences,
    closeWorkspaceSessions: () => options.sessionTabs().closeWorkspaceSessions(),
    resetForWorkspace: (selected) => {
      options.sessions.catalog.invalidate();
      options.project.preview.close();
      options.project.git.closeDiff();
      options.resetWorkbench();
      options.setWorkspace(selected);
      options.sessions.catalog.reset();
      options.project.tasks.reset();
      options.project.documents.reset();
      options.sessions.activity.reset();
      options.project.registry.reset();
      options.project.git.reset();
      options.sessions.metadata.reset();
      options.projectActions().reset();
      options.sessions.tabs.resetTabs();
      options.state.resetWorkspaceConversation();
      options.sessions.runtime.reset();
    },
    loadWorkspace: async (selected) => {
      void options.project.registry.autoCleanProject(selected);
      await Promise.all([
        options.startup().open(),
        options.project.tasks.load(selected),
        options.project.documents.load(selected),
        options.project.workspace.loadPreferences(selected),
        options.project.registry.refreshProjectInitialization(),
      ]);
    },
    setOperationRunning: options.setOperationRunning,
    setErrorMessage: options.setErrorMessage,
    reportError: options.reportError,
  });

  return { controller };
}

export type DesktopWorkspaceServices = ReturnType<typeof createDesktopWorkspaceServices>;
