import { invoke } from "@tauri-apps/api/core";
import {
  ACTIVE_SESSIONS_STORAGE_KEY,
  parseActiveSessionIds,
  parseSessionTabIds,
  SESSION_TABS_STORAGE_KEY,
} from "../lib/session-tabs";
import {
  buildRecentProjects,
  isAbsoluteProjectPath,
  parseRecentProjects,
  RECENT_PROJECTS_STORAGE_KEY,
  workspaceFromLocation,
  WORKSPACE_STORAGE_KEY,
} from "../lib/recent-projects";
import {
  projectColorFromWorkspaceConfig,
  workspaceConfigWithProjectColor,
  WORKSPACE_CONFIG_PATH,
} from "../lib/project-colors";
import { resolveDesktopPreferences } from "../lib/desktop-config";
import type { ProjectFilePreview } from "../lib/project-files";
import type { ProjectTreeEntry } from "../lib/project-tree";

type ProjectWorkspaceStoreOptions = {
  workspace: () => string;
  reportError: (error: unknown) => void;
  afterSave?: (workspace: string) => void;
};

type WorkspaceRestore = {
  workspace: string;
  recentProjects: string[];
  activeSessionIds: Map<string, string>;
  sessionTabIds: Map<string, string[]>;
};

export function restoreProjectWorkspace(
  locationUrl: string,
  storage: Pick<Storage, "getItem">,
): WorkspaceRestore {
  const windowWorkspace = workspaceFromLocation(locationUrl);
  try {
    const saved = storage.getItem(WORKSPACE_STORAGE_KEY);
    const validSaved = saved && isAbsoluteProjectPath(saved) ? saved : undefined;
    const initialWorkspace = windowWorkspace ?? validSaved;
    return {
      workspace: initialWorkspace ?? "",
      recentProjects: parseRecentProjects(
        storage.getItem(RECENT_PROJECTS_STORAGE_KEY),
        initialWorkspace,
      ),
      activeSessionIds: parseActiveSessionIds(storage.getItem(ACTIVE_SESSIONS_STORAGE_KEY)),
      sessionTabIds: parseSessionTabIds(storage.getItem(SESSION_TABS_STORAGE_KEY)),
    };
  } catch {
    // The URL is independent of localStorage and must retain its startup precedence.
    return {
      workspace: windowWorkspace ?? "",
      recentProjects: buildRecentProjects([], windowWorkspace),
      activeSessionIds: new Map(),
      sessionTabIds: new Map(),
    };
  }
}

export function createProjectWorkspaceStore(options: ProjectWorkspaceStoreOptions) {
  let recentProjects = $state<string[]>([]);
  let projectColors = $state<Map<string, string>>(new Map());
  let externalEditor = $state<string | undefined>(undefined);
  let colorLoadGeneration = 0;
  let colorSaveGeneration = 0;

  function remember(path: string): void {
    recentProjects = buildRecentProjects(recentProjects, path);
    try {
      localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(recentProjects));
    } catch {
      // Keep the in-memory recent list usable when storage is unavailable.
    }
    refreshColors(recentProjects);
  }

  function restore(): {
    workspace: string;
    activeSessionIds: Map<string, string>;
    sessionTabIds: Map<string, string[]>;
  } {
    const restored = restoreProjectWorkspace(window.location.href, localStorage);
    recentProjects = restored.recentProjects;
    return restored;
  }

  function refreshColors(paths: readonly string[]): void {
    const generation = ++colorLoadGeneration;
    const activePaths = new Set(paths);
    projectColors = new Map([...projectColors].filter(([path]) => activePaths.has(path)));
    for (const projectPath of paths) void loadProjectColor(projectPath, generation);
  }

  async function loadProjectColor(projectPath: string, generation: number): Promise<void> {
    const preview = await invoke<ProjectFilePreview>("read_project_file", {
      workspace: projectPath,
      path: WORKSPACE_CONFIG_PATH,
    }).catch(() => undefined);
    if (generation !== colorLoadGeneration || !recentProjects.includes(projectPath)) return;
    const color = projectColorFromWorkspaceConfig(preview?.content);
    const next = new Map(projectColors);
    if (color) next.set(projectPath, color);
    else next.delete(projectPath);
    projectColors = next;
  }

  async function saveColor(color: string | undefined): Promise<string | undefined> {
    const workspace = options.workspace();
    if (!workspace) return "Open a project before changing project settings.";
    const generation = ++colorSaveGeneration;
    colorLoadGeneration += 1;
    try {
      const exists = await invoke<boolean>("project_file_exists", {
        workspace,
        path: WORKSPACE_CONFIG_PATH,
      });
      if (generation !== colorSaveGeneration || options.workspace() !== workspace) {
        return "The active project changed before settings could be saved.";
      }
      let current = exists
        ? await invoke<ProjectFilePreview>("read_project_file", {
            workspace,
            path: WORKSPACE_CONFIG_PATH,
          })
        : undefined;
      if (generation !== colorSaveGeneration || options.workspace() !== workspace) {
        return "The active project changed before settings could be saved.";
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const content = workspaceConfigWithProjectColor(current?.content, color);
        const result = await invoke<{ written: boolean; document: ProjectFilePreview | null }>(
          "write_project_workspace_config_if_unchanged",
          {
            workspace,
            expectedContent: current?.content ?? null,
            content,
          },
        );
        if (generation !== colorSaveGeneration || options.workspace() !== workspace) return undefined;
        if (result.written && result.document) {
          const savedColor = projectColorFromWorkspaceConfig(result.document.content);
          const next = new Map(projectColors);
          if (savedColor) next.set(workspace, savedColor);
          else next.delete(workspace);
          projectColors = next;
          refreshColors(recentProjects);
          options.afterSave?.(workspace);
          return undefined;
        }
        current = result.document ?? undefined;
      }
      return ".pi/workspace.jsonc changed repeatedly while project settings were being saved. Try again.";
    } catch (error) {
      if (generation !== colorSaveGeneration || options.workspace() !== workspace) return undefined;
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function loadPreferences(projectPath: string): Promise<void> {
    const [globalConfig, projectConfig] = await Promise.all([
      invoke<ProjectFilePreview>("read_home_file", { path: "~/.config/pi/pix-desktop.jsonc" }).catch(() => undefined),
      invoke<ProjectFilePreview>("read_project_file", {
        workspace: projectPath,
        path: ".pi/pix-desktop.jsonc",
      }).catch(() => undefined),
    ]);
    if (options.workspace() !== projectPath) return;
    externalEditor = resolveDesktopPreferences(globalConfig?.content, projectConfig?.content).externalEditor;
  }

  async function listDirectory(path: string): Promise<ProjectTreeEntry[]> {
    const workspace = options.workspace();
    if (!workspace) return [];
    const entries = await invoke<ProjectTreeEntry[]>("list_project_directory", {
      workspace,
      path: path || null,
    });
    return options.workspace() === workspace ? entries : [];
  }

  async function openInEditor(path?: string): Promise<void> {
    const workspace = options.workspace();
    if (!workspace) return;
    try {
      await loadPreferences(workspace);
      if (options.workspace() !== workspace) return;
      if (!externalEditor) {
        options.reportError(new Error("Choose an external file editor in Settings → Desktop → Editor."));
        return;
      }
      await invoke("open_in_external_editor", {
        workspace,
        path: path || null,
        editor: externalEditor,
      });
    } catch (error) {
      if (options.workspace() === workspace) options.reportError(error);
    }
  }

  return {
    get recentProjects() { return recentProjects; },
    get projectColors() { return projectColors; },
    get externalEditor() { return externalEditor; },
    remember,
    restore,
    refreshColors,
    saveColor,
    loadPreferences,
    listDirectory,
    openInEditor,
  };
}
