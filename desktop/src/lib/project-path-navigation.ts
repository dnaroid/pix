import { isWorkspaceProjectFilePath } from "./project-files";

export type ProjectPathKind = "file" | "directory";
export interface ProjectPathNavigation {
  validate: (path: string, kind: ProjectPathKind) => Promise<boolean>;
  open: (path: string) => Promise<void>;
}

export function scopedProjectPathNavigation(
  workspace: string,
  isCurrent: () => boolean,
  navigation: ProjectPathNavigation,
): ProjectPathNavigation {
  return {
    async validate(path, kind) {
      const relative = workspaceRelativePath(path, workspace);
      if (!relative || !isCurrent()) return false;
      const valid = await navigation.validate(relative, kind);
      return valid && isCurrent();
    },
    async open(path) {
      const relative = workspaceRelativePath(path, workspace);
      if (relative && isCurrent()) await navigation.open(relative);
    },
  };
}

export function workspaceRelativePath(path: string, workspace: string): string | undefined {
  const root = workspace.replaceAll("\\", "/").replace(/\/+$/u, "");
  let relative = path.replaceAll("\\", "/");
  if (!root || /[\u0000-\u001f]/u.test(relative)) return;
  if (relative.startsWith(`${root}/`)) relative = relative.slice(root.length + 1);
  if (!isWorkspaceProjectFilePath(relative) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(relative)) return;
  return relative;
}
