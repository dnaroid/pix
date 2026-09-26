import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { isProjectRelativePath } from "./project-tree";

export const MAX_STORED_EXPANDED_DIRECTORIES = 256;

export function projectExplorerExpandedDirectoriesFromWorkspaceConfig(source: string | undefined): string[] {
  if (!source) return [];
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0 || !isRecord(parsed) || !isRecord(parsed.projectExplorer)) return [];
  const expanded = parsed.projectExplorer.expandedDirectories;
  if (!Array.isArray(expanded)) return [];
  return compactExpandedDirectories(expanded.filter((path): path is string => typeof path === "string"));
}

/**
 * Store only relative folder paths under the project-local workspace config.
 * The tree itself remains lazy and is never serialized.
 */
export function workspaceConfigWithProjectExplorerExpandedDirectories(
  source: string | undefined,
  paths: readonly string[],
): string {
  const base = source?.trim() ? source : "{}\n";
  const errors: ParseError[] = [];
  const parsed = parse(base, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0 || !isRecord(parsed)) {
    throw new Error(".pi/workspace.jsonc is malformed; fix it before saving Project Explorer state.");
  }
  if (parsed.projectExplorer !== undefined && !isRecord(parsed.projectExplorer)) {
    throw new Error(".pi/workspace.jsonc has an invalid projectExplorer field.");
  }
  const currentExplorer = isRecord(parsed.projectExplorer) ? parsed.projectExplorer : undefined;
  if (
    currentExplorer?.expandedDirectories !== undefined
    && (!Array.isArray(currentExplorer.expandedDirectories)
      || currentExplorer.expandedDirectories.some((path) => typeof path !== "string"))
  ) {
    throw new Error(".pi/workspace.jsonc has an invalid projectExplorer.expandedDirectories field.");
  }

  const expandedDirectories = compactExpandedDirectories(paths);
  const removeWholeExplorer = expandedDirectories.length === 0
    && currentExplorer !== undefined
    && Object.keys(currentExplorer).every((key) => key === "expandedDirectories");
  const edits = removeWholeExplorer
    ? modify(base, ["projectExplorer"], undefined, formattingOptions())
    : modify(
        base,
        ["projectExplorer", "expandedDirectories"],
        expandedDirectories.length > 0 ? expandedDirectories : undefined,
        formattingOptions(),
      );
  const next = applyEdits(base, edits);
  return next.endsWith("\n") ? next : `${next}\n`;
}

export function compactExpandedDirectories(paths: readonly string[]): string[] {
  const valid: string[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!isProjectRelativePath(path) || seen.has(path)) continue;
    seen.add(path);
    valid.push(path);
  }
  return valid.length <= MAX_STORED_EXPANDED_DIRECTORIES
    ? valid
    : valid.slice(valid.length - MAX_STORED_EXPANDED_DIRECTORIES);
}

function formattingOptions() {
  return { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
