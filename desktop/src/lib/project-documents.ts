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

export function projectDocumentLabel(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith(".pi/plans/")) return normalized.slice(".pi/plans/".length);
  return normalized.split("/").filter(Boolean).at(-1) ?? path;
}
