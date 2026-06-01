function patchTextFromInput(input: unknown): string | undefined {
  if (typeof input === "string") return input;
  if (typeof input !== "object" || input === null) return undefined;

  const record = input as Record<string, unknown>;
  for (const key of ["input", "patch", "text", "content"]) {
    if (typeof record[key] === "string") return record[key];
  }
  return undefined;
}

function changedFilesFromDetails(details: unknown): string[] {
  if (typeof details !== "object" || details === null) return [];
  const changedFiles = (details as Record<string, unknown>).changedFiles;
  if (!Array.isArray(changedFiles)) return [];
  return changedFiles.filter((file): file is string => typeof file === "string" && file.trim().length > 0);
}

function addPaths(paths: Set<string>, inputPaths: string[]): void {
  for (const inputPath of inputPaths) {
    addPath(paths, inputPath);
  }
}

function addPath(paths: Set<string>, inputPath: string): void {
  const trimmed = inputPath.trim();
  if (trimmed) paths.add(trimmed);
}

function uniqueNonEmptyPaths(inputPaths: string[]): string[] {
  const paths = new Set<string>();
  addPaths(paths, inputPaths);
  return [...paths];
}

export function getEventPaths(input: unknown, details?: unknown): string[] {
  const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : undefined;
  const exactChangedFiles = changedFilesFromDetails(details);
  if (exactChangedFiles.length > 0) return uniqueNonEmptyPaths(exactChangedFiles);

  const paths = new Set<string>();

  if (typeof record?.path === "string") addPath(paths, record.path);
  if (typeof record?.file_path === "string") addPath(paths, record.file_path);
  if (Array.isArray(record?.paths)) addPaths(paths, record.paths.filter((file): file is string => typeof file === "string"));

  // apply_patch receives the whole patch in a tool-specific field rather than
  // a top-level path. Extract every affected file so multi-file patches refresh
  // diagnostics for all changed files.
  const patchText = patchTextFromInput(input);
  if (patchText) {
    const headerPattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;
    for (const match of patchText.matchAll(headerPattern)) {
      const patchPath = match[1]?.trim();
      if (patchPath) addPath(paths, patchPath);
    }

    const movePattern = /^\*\*\* Move to: (.+)$/gm;
    for (const match of patchText.matchAll(movePattern)) {
      const patchPath = match[1]?.trim();
      if (patchPath) addPath(paths, patchPath);
    }
  }

  return [...paths];
}

export function isMutationToolResult(event: { toolName?: string; input: unknown; details?: unknown }): boolean {
  const toolName = typeof event.toolName === "string" ? event.toolName : "";
  const baseName = (toolName.split(".").pop() ?? toolName).toLowerCase();
  if (["write", "edit", "apply_patch"].includes(baseName)) return true;
  if (baseName === "ast_apply") return changedFilesFromDetails(event.details).length > 0;

  // Some tool providers may wrap/rename apply_patch but still expose the patch
  // body in the input. Treat patch-shaped input as a file mutation.
  const patchText = patchTextFromInput(event.input);
  return typeof patchText === "string" && /^\*\*\* Begin Patch\b/m.test(patchText);
}
