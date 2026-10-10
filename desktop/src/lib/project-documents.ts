export interface ProjectDocumentsSnapshot {
  readonly plans: string[];
  readonly todoExists: boolean;
}

export const EMPTY_PROJECT_DOCUMENTS: ProjectDocumentsSnapshot = {
  plans: [],
  todoExists: false,
};

export const PROJECT_TODO_PATH = ".pi/TODO.md";

export function isEditableProjectMarkdown(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized === PROJECT_TODO_PATH
    || (/^\.pi\/plans\/.+\.md$/i.test(normalized) && !normalized.split("/").includes(".."));
}

/** Only authored Markdown plans are Registry dirty signals. Editor scratch and
 * generated output can still be opened in Preview without scheduling a push.
 * Mirror ACP's canonicalRegistryEntryName and the native Registry indicator.
 */
const REGISTRY_SERVICE_PLAN_SEGMENTS = new Set([
  "node_modules", "__pycache__", "artifacts", "cache", "tmp", "temp",
  "coverage", "build", "dist", "out", "target", "venv", "thumbs.db", "desktop.ini",
]);

export function isCanonicalProjectPlanPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (!isEditableProjectMarkdown(normalized) || !normalized.startsWith(".pi/plans/")) return false;
  return normalized.slice(".pi/plans/".length).split("/").every((segment) =>
    Boolean(segment) && segment !== "." && segment !== ".."
      && !segment.startsWith(".") && !segment.endsWith("~")
      && !/\.(?:tmp|temp|bak|backup|lock|swp|swo|orig|log|pid|pyc|pyo)$/i.test(segment)
      && !/-(?:wal|shm|journal)$/i.test(segment)
      && !REGISTRY_SERVICE_PLAN_SEGMENTS.has(segment.toLowerCase()),
  );
}

export function projectDocumentLabel(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith(".pi/plans/")) return normalized.slice(".pi/plans/".length);
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}
