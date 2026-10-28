import type { ProjectWikiConfig } from "./project-wiki";

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

/** Candidates are Wiki-relative; only the configured index represents the root. */
export function wikiFolderIndexCandidates(directory: string, config: ProjectWikiConfig): string[] {
  if (!directory) return [config.index];
  return [...new Set([
    ...(parentDirectory(config.index) === directory ? [config.index] : []),
    `${directory}/index.md`,
    `${directory}/index.markdown`,
  ])];
}

/** The owning folder replaces its index file in the navigation tree. */
export function wikiIndexOwner(path: string, config: ProjectWikiConfig): string | null {
  if (path === config.index) return parentDirectory(path);
  const parent = parentDirectory(path);
  return parent && /^index\.(?:md|markdown)$/iu.test(path.slice(parent.length + 1)) ? parent : null;
}

export interface ProjectWikiNavigationOptions {
  workspace: () => string;
  config: () => ProjectWikiConfig;
  exists: (workspace: string, path: string) => Promise<boolean>;
  onOpenFile: (path: string) => void;
  onMissingIndex: (directory: string) => void;
  onError: (error: unknown) => void;
}

/** A late index lookup must never replace a newer file, folder or project choice. */
export function createProjectWikiNavigation(options: ProjectWikiNavigationOptions) {
  let generation = 0;
  let disposed = false;

  function cancel(): void { generation++; }

  function openFile(path: string): void {
    if (disposed) return;
    cancel();
    options.onOpenFile(`${options.config().path}/${path}`);
  }

  async function openDirectory(directory: string): Promise<void> {
    if (disposed) return;
    const owner = ++generation;
    const workspace = options.workspace();
    const config = { ...options.config() };
    const current = () => {
      if (disposed || owner !== generation || options.workspace() !== workspace) return false;
      const latest = options.config();
      return latest.path === config.path && latest.index === config.index;
    };
    try {
      for (const index of wikiFolderIndexCandidates(directory, config)) {
        const path = `${config.path}/${index}`;
        const exists = await options.exists(workspace, path);
        if (!current()) return;
        if (exists) { options.onOpenFile(path); return; }
      }
      if (current()) options.onMissingIndex(directory);
    } catch (error) {
      if (current()) options.onError(error);
    }
  }

  return {
    openFile,
    openDirectory,
    cancel,
    dispose() { disposed = true; cancel(); },
  };
}
