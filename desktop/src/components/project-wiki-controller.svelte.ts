import { invoke } from "@tauri-apps/api/core";
import { readWorkspaceConfig } from "../app/workspace-config-persistence";
import type { ProjectFilePreview } from "../lib/project-files";
import { getProjectWikiConfig, type ProjectWikiConfig } from "../lib/project-wiki";

type Send = <T>(command: string, args: Record<string, unknown>) => Promise<T>;
interface Options {
  readConfig?: (workspace: string) => Promise<ProjectFilePreview | undefined>;
  send?: Send;
  prepare?: () => Promise<() => void>;
  report: (error: unknown, workspace: string) => void;
}

/** Configuration and initialization own their project, even across late IPC replies. */
export function createProjectWikiController(options: Options) {
  const send = options.send ?? invoke;
  const readConfig = options.readConfig ?? readWorkspaceConfig;
  const state = $state({
    config: null as ProjectWikiConfig | null,
    loading: false,
    creating: false,
    exists: false,
    indexExists: false,
    configExists: false,
    error: null as string | null,
  });
  let workspace = "";
  let generation = 0;
  let disposed = false;
  let reading: Promise<void> | undefined;

  function report(error: unknown, target: string): void {
    state.error = error instanceof Error ? error.message : String(error);
    options.report(error, target);
  }

  async function load(target: string, owner: number): Promise<void> {
    const current = () => !disposed && owner === generation && workspace === target;
    state.loading = true;
    try {
      const document = await readConfig(target);
      if (!current()) return;
      const config = getProjectWikiConfig(document?.content);
      const [exists, indexExists] = await Promise.all([
        send<boolean>("project_directory_exists", { workspace: target, path: config.path }),
        send<boolean>("project_file_exists", { workspace: target, path: config.indexPath }),
      ]);
      if (!current()) return;
      state.config = config;
      state.configExists = document !== undefined;
      state.exists = exists;
      state.indexExists = indexExists;
      state.error = null;
    } catch (error) {
      if (current()) { state.config = null; report(error, target); }
    } finally {
      if (current()) state.loading = false;
    }
  }

  function refresh(): Promise<void> {
    if (disposed || !workspace || state.creating) return Promise.resolve();
    if (reading) return reading;
    const pending = load(workspace, generation);
    reading = pending;
    void pending.finally(() => { if (reading === pending) reading = undefined; });
    return pending;
  }

  function selectWorkspace(next: string): Promise<void> {
    if (disposed || workspace === next) return Promise.resolve();
    generation++;
    workspace = next;
    reading = undefined;
    state.config = null;
    state.exists = false;
    state.indexExists = false;
    state.configExists = false;
    state.creating = false;
    state.loading = false;
    state.error = null;
    return refresh();
  }

  async function initialize(): Promise<string | undefined> {
    const config = state.config;
    if (!workspace || disposed || !config || state.creating || state.loading) return;
    const target = workspace;
    const owner = generation;
    const current = () => !disposed && owner === generation && workspace === target;
    let release: (() => void) | undefined;
    state.creating = true;
    state.error = null;
    try {
      release = await options.prepare?.();
      if (!current()) return;
      const directory = config.indexPath.slice(0, config.indexPath.lastIndexOf("/"));
      // Create only missing parents, one level at a time. Native exclusive creation
      // rejects symlinks/collisions; never replace an existing folder or index.
      let parent = "";
      for (const name of directory.split("/")) {
        const path = parent ? `${parent}/${name}` : name;
        const exists = await send<boolean>("project_directory_exists", { workspace: target, path });
        if (!current()) return;
        if (!exists) {
          await send("create_project_entry", { workspace: target, parent: parent || null, name, kind: "directory" });
          if (!current()) return;
        }
        parent = path;
      }
      const indexExists = await send<boolean>("project_file_exists", { workspace: target, path: config.indexPath });
      if (!current()) return;
      if (!indexExists) {
        await send("create_project_entry", {
          workspace: target, parent, name: config.indexPath.slice(parent.length + 1), kind: "file",
        });
        if (!current()) return;
        await send("write_project_file", {
          workspace: target, path: config.indexPath, expectedContent: "",
          content: "# Project wiki\n\nDescribe the project, its requirements and rules here.\n\n## Contents\n\nCreate pages and sections in the Wiki sidebar, then link them from this index.\n",
        });
        if (!current()) return;
      }
      state.exists = true;
      state.indexExists = true;
      return config.indexPath;
    } catch (error) {
      if (current()) report(error, target);
      return undefined;
    } finally {
      release?.();
      if (current()) state.creating = false;
    }
  }

  return {
    state,
    selectWorkspace,
    refresh,
    initialize,
    dispose() { disposed = true; generation++; reading = undefined; },
  };
}
