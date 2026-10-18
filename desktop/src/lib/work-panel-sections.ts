import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { withWorkspaceSchema } from "./workspace-config-schema";

/** Work panel accordion order: Plans first, then Tasks. */
export const WORK_SECTION_IDS = ["plans", "tasks"] as const;
export type WorkSectionId = typeof WORK_SECTION_IDS[number];

function config(source: string | undefined): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(source?.trim() ? source : "{}", errors, { allowTrailingComma: true });
  if (errors.length || !isRecord(parsed)) throw new Error(".pi/workspace.jsonc is malformed; fix it before saving Work panel state.");
  if (parsed.workPanel !== undefined && !isRecord(parsed.workPanel)) throw new Error(".pi/workspace.jsonc has an invalid workPanel field.");
  const collapsed = isRecord(parsed.workPanel) ? parsed.workPanel.collapsedSections : undefined;
  if (collapsed !== undefined && (!Array.isArray(collapsed) || collapsed.some((id) => typeof id !== "string"))) {
    throw new Error(".pi/workspace.jsonc has an invalid workPanel.collapsedSections field.");
  }
  return parsed;
}

/** Collapsed Work section ids; unknown ids are retained for compatibility. */
export function workCollapsedSections(source: string | undefined): string[] {
  const panel = config(source).workPanel;
  return isRecord(panel) && Array.isArray(panel.collapsedSections) ? [...new Set(panel.collapsedSections as string[])] : [];
}

/** Change one section, preserving comments, sibling settings and unknown ids. */
export function workspaceConfigWithWorkSection(source: string | undefined, id: WorkSectionId, open: boolean): string {
  const collapsed = new Set(workCollapsedSections(source));
  if (open) collapsed.delete(id);
  else collapsed.add(id);
  const base = source?.trim() ? source : "{}\n";
  return withWorkspaceSchema(applyEdits(base, modify(base, ["workPanel", "collapsedSections"], [...collapsed], {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  })));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
