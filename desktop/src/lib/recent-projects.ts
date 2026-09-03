export const RECENT_PROJECTS_STORAGE_KEY = "pix.desktop.recentProjects";
export const WORKSPACE_STORAGE_KEY = "pix.desktop.workspace";
export const MAX_RECENT_PROJECTS = 20;

export function projectName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? "workspace";
}

export function isAbsoluteProjectPath(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
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
  const name = projectName(path).normalize("NFKC").toLocaleLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 360;
}

function projectPathKey(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\")
    ? path.toLocaleLowerCase()
    : path;
}
