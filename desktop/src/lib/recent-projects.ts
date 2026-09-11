export const RECENT_PROJECTS_STORAGE_KEY = "pix.desktop.recentProjects";
export const WORKSPACE_STORAGE_KEY = "pix.desktop.workspace";
export const WORKSPACE_QUERY_PARAM = "workspace";
export const MAX_RECENT_PROJECTS = 20;

export function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
}

/** Parent directory shown under the project name, without repeating the basename. */
export function projectParentPath(path: string): string {
  let value = path;
  while (
    value.length > 1
    && /[\\/]$/u.test(value)
    && !/^[A-Za-z]:[\\/]$/u.test(value)
  ) {
    value = value.slice(0, -1);
  }

  const separator = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (separator < 0) return value;
  if (separator === 0) return value.slice(0, 1);
  if (separator === 2 && /^[A-Za-z]:/u.test(value)) return value.slice(0, 3);
  return value.slice(0, separator);
}

export function isAbsoluteProjectPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function workspaceFromLocation(url: string): string | undefined {
  try {
    const workspace = new URL(url).searchParams.get(WORKSPACE_QUERY_PARAM)?.trim();
    return workspace && isAbsoluteProjectPath(workspace) ? workspace : undefined;
  } catch {
    return undefined;
  }
}

export function projectWindowUrl(currentUrl: string, workspace: string): string {
  if (!isAbsoluteProjectPath(workspace)) throw new Error("Project path must be absolute.");
  const url = new URL(currentUrl);
  url.searchParams.set(WORKSPACE_QUERY_PARAM, workspace);
  url.hash = "";
  return url.toString();
}

/** Local app route for a new Tauri webview window, preserving non-workspace query state. */
export function projectWindowRoute(currentUrl: string, workspace: string): string {
  const url = new URL(projectWindowUrl(currentUrl, workspace));
  return `${url.pathname}${url.search}`;
}

export function buildRecentProjects(paths: readonly string[], selectedPath?: string): string[] {
  const candidates = selectedPath ? [selectedPath, ...paths] : paths;
  const result: string[] = [];
  const seen = new Set<string>();

  for (const path of candidates) {
    if (!isAbsoluteProjectPath(path)) continue;
    const key = projectPathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
    if (result.length === MAX_RECENT_PROJECTS) break;
  }

  return result;
}

export function parseRecentProjects(serialized: string | null, selectedPath?: string): string[] {
  if (!serialized) return buildRecentProjects([], selectedPath);
  try {
    const parsed: unknown = JSON.parse(serialized);
    return buildRecentProjects(
      Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [],
      selectedPath,
    );
  } catch {
    return buildRecentProjects([], selectedPath);
  }
}

/** Stable hue used only as a visual identity for a project's folder icon. */
export function projectFolderHue(path: string): number {
  let identity = path.replaceAll("\\", "/").normalize("NFKC");
  if (identity.length > 1 && !/^[A-Za-z]:\/$/u.test(identity)) identity = identity.replace(/\/+$/u, "");
  if (/^[A-Za-z]:\//u.test(identity) || identity.startsWith("//")) identity = identity.toLocaleLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

function projectPathKey(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
    ? path.toLocaleLowerCase()
    : path;
}
