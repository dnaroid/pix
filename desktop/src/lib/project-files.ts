export interface ProjectFilePreview {
  path: string;
  content: string;
}

export interface ProjectFileLineRange {
  readonly startLine: number;
  readonly endLine: number;
}

/** True only for workspace-relative Preview paths owned by the active project. */
export function isWorkspaceProjectFilePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.startsWith("~/") || normalized.startsWith("//")) return false;
  if (/^[A-Za-z]:\//u.test(normalized)) return false;
  return !normalized.split("/").includes("..");
}
