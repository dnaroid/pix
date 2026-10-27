import { invoke } from "@tauri-apps/api/core";
import {
  parseActiveSessionIds,
  parseSessionTabIds,
} from "../lib/session-tabs";
import { windowLayoutKey } from "../lib/window-layout-storage";
import { parseSessionTabModels, type SessionTabModels } from "../lib/session-tab-model";
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
  projectIconPathFromWorkspaceConfig,
  workspaceConfigWithProjectSettings,
  WORKSPACE_CONFIG_PATH,
} from "../lib/project-colors";
import {
  projectIconDataUrl,
  type ProjectIconImage,
  type ProjectSettingsDraft,
} from "../lib/project-icon";
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
  sessionTabModels: SessionTabModels;
};

export function restoreProjectWorkspace(
  locationUrl: string,
  storage: Pick<Storage, "getItem">,
): WorkspaceRestore {
  const windowWorkspace = workspaceFromLocation(locationUrl);
  try {
    const query = new URL(locationUrl).searchParams;
    const restoredEmptyWindow = query.get("restoreWindow") === "1" && query.get("workspace") === "";
    const saved = storage.getItem(WORKSPACE_STORAGE_KEY);
    const validSaved = saved && isAbsoluteProjectPath(saved) ? saved : undefined;
    const initialWorkspace = restoredEmptyWindow ? "" : windowWorkspace ?? validSaved;
    return {
      workspace: initialWorkspace ?? "",
      recentProjects: parseRecentProjects(
        storage.getItem(RECENT_PROJECTS_STORAGE_KEY),
        initialWorkspace,
      ),
      activeSessionIds: parseActiveSessionIds(storage.getItem(windowLayoutKey("activeSessions"))),
      sessionTabIds: parseSessionTabIds(storage.getItem(windowLayoutKey("sessionTabs"))),
      sessionTabModels: parseSessionTabModels(storage.getItem(windowLayoutKey("sessionTabModels"))),
    };
  } catch {
    // The URL is independent of localStorage and must retain its startup precedence.
    return {
      workspace: windowWorkspace ?? "",
      recentProjects: buildRecentProjects([], windowWorkspace),
      activeSessionIds: new Map(),
      sessionTabIds: new Map(),
      sessionTabModels: new Map(),
    };
  }
}

export function createProjectWorkspaceStore(options: ProjectWorkspaceStoreOptions) {
  let recentProjects = $state<string[]>([]);
  let projectColors = $state<Map<string, string>>(new Map());
  /** Project path -> data URL of its canonical `.pi/project-icon.*` logo. */
  let projectIcons = $state<Map<string, string>>(new Map());
  let externalEditor = $state<string | undefined>(undefined);
  let gitCiFixModelRef = $state<string | undefined>(undefined);
  let projectIconModel: string | undefined;
  let colorLoadGeneration = 0;
  let colorSaveGeneration = 0;

  function remember(path: string): void {
    recentProjects = buildRecentProjects(recentProjects, path);
    try {
      localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(recentProjects));
    } catch {
      // Keep the in-memory recent list usable when storage is unavailable.
    }
    if (options.workspace() === path) refreshColors([path]);
    else pruneProjectColors();
  }

  function forget(path: string): void {
    recentProjects = recentProjects.filter((project) => project !== path);
    try {
      localStorage.setItem(RECENT_PROJECTS_STORAGE_KEY, JSON.stringify(recentProjects));
    } catch (error) {
      options.reportError(error);
    }
    // Preserve the current project's identity even if its shortcut is removed.
    pruneProjectColors();
  }

  async function openInFinder(path: string): Promise<void> {
    try {
      await invoke("reveal_project_entry", { workspace: path, path: null });
    } catch (error) {
      options.reportError(error);
    }
  }

  function restore(): {
    workspace: string;
    activeSessionIds: Map<string, string>;
    sessionTabIds: Map<string, string[]>;
    sessionTabModels: SessionTabModels;
  } {
    const restored = restoreProjectWorkspace(window.location.href, localStorage);
    void invoke("desktop_window_workspace", { workspace: restored.workspace }).catch(options.reportError);
    recentProjects = restored.recentProjects;
    return restored;
  }

  function pruneProjectColors(): Set<string> {
    const activePaths = new Set(recentProjects);
    if (options.workspace()) activePaths.add(options.workspace());
    projectColors = new Map([...projectColors].filter(([path]) => activePaths.has(path)));
    projectIcons = new Map([...projectIcons].filter(([path]) => activePaths.has(path)));
    return activePaths;
  }

  function refreshColors(paths: readonly string[]): void {
    const generation = ++colorLoadGeneration;
    const activePaths = pruneProjectColors();
    for (const projectPath of paths) {
      if (activePaths.has(projectPath)) void loadProjectColor(projectPath, generation);
    }
  }

  async function loadProjectColor(projectPath: string, generation: number): Promise<void> {
    const preview = await invoke<ProjectFilePreview>("read_project_file", {
      workspace: projectPath,
      path: WORKSPACE_CONFIG_PATH,
    }).catch(() => undefined);
    if (generation !== colorLoadGeneration || (!recentProjects.includes(projectPath) && options.workspace() !== projectPath)) return;
    const color = projectColorFromWorkspaceConfig(preview?.content);
    const next = new Map(projectColors);
    if (color) next.set(projectPath, color);
    else next.delete(projectPath);
    projectColors = next;
    await loadProjectIcon(projectPath, projectIconPathFromWorkspaceConfig(preview?.content), generation);
  }

  async function loadProjectIcon(
    projectPath: string,
    iconPath: string | undefined,
    generation: number,
  ): Promise<void> {
    const image = iconPath
      ? await invoke<ProjectIconImage>("read_project_icon", { workspace: projectPath, path: iconPath })
        .catch(() => undefined)
      : undefined;
    if (generation !== colorLoadGeneration || (!recentProjects.includes(projectPath) && options.workspace() !== projectPath)) return;
    setProjectIcon(projectPath, image ? projectIconDataUrl(image) : undefined);
  }

  function setProjectIcon(projectPath: string, dataUrl: string | undefined): void {
    if (projectIcons.get(projectPath) === dataUrl) return;
    const next = new Map(projectIcons);
    if (dataUrl) next.set(projectPath, dataUrl);
    else next.delete(projectPath);
    projectIcons = next;
  }

  function saveColor(color: string | undefined): Promise<string | undefined> {
    return saveSettings({ color, icon: { kind: "keep" } });
  }

  async function saveSettings(draft: ProjectSettingsDraft): Promise<string | undefined> {
    const workspace = options.workspace();
    if (!workspace) return "Open a project before changing project settings.";
    const generation = ++colorSaveGeneration;
    colorLoadGeneration += 1;
    const { color, icon } = draft;
    try {
      // The image is written first; config only references it after success.
      const iconPath = icon.kind === "image"
        ? await invoke<string>("save_project_icon", { workspace, dataBase64: icon.image.dataBase64 })
        : undefined;
      if (generation !== colorSaveGeneration || options.workspace() !== workspace) {
        return "The active project changed before settings could be saved.";
      }
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
        const content = workspaceConfigWithProjectSettings(
          current?.content,
          icon.kind === "keep" ? { color } : { color, icon: iconPath },
        );
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
          if (icon.kind !== "keep") {
            setProjectIcon(workspace, icon.kind === "image" ? projectIconDataUrl(icon.image) : undefined);
          }
          refreshColors([workspace]);
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

  async function pickIcon(): Promise<ProjectIconImage | undefined> {
    return (await invoke<ProjectIconImage | null>("pick_project_icon_image")) ?? undefined;
  }

  async function generateIcon(prompt?: string): Promise<ProjectIconImage> {
    const workspace = options.workspace();
    if (!workspace) throw new Error("Open a project before generating a logo.");
    await loadPreferences(workspace);
    if (options.workspace() !== workspace) throw new Error("The active project changed.");
    return invoke<ProjectIconImage>("generate_project_icon_image", {
      workspace,
      model: projectIconModel ?? null,
      prompt: prompt?.trim() || null,
    });
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
    const preferences = resolveDesktopPreferences(globalConfig?.content, projectConfig?.content);
    externalEditor = preferences.externalEditor;
    gitCiFixModelRef = preferences.gitCiFixModelRef;
    projectIconModel = preferences.projectIconModel;
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
    get projectIcons() { return projectIcons; },
    get externalEditor() { return externalEditor; },
    get gitCiFixModelRef() { return gitCiFixModelRef; },
    remember,
    forget,
    openInFinder,
    restore,
    refreshColors,
    saveColor,
    saveSettings,
    pickIcon,
    generateIcon,
    loadPreferences,
    listDirectory,
    openInEditor,
  };
}
