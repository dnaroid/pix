import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { withWorkspaceSchema } from "./workspace-config-schema";

export const USAGE_SECTION_IDS = ["provider-limits", "overview", "activity", "daily", "models", "sessions", "cache"] as const;
export type UsageSectionId = typeof USAGE_SECTION_IDS[number];
export const USAGE_SECTIONS_CONTEXT = Symbol("usage-panel-sections");

function config(source: string | undefined): Record<string, unknown> {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(source?.trim() ? source : "{}", errors, { allowTrailingComma: true });
  if (errors.length || !isRecord(parsed)) throw new Error(".pi/workspace.jsonc is malformed; fix it before saving usage panel state.");
  if (parsed.usagePanel !== undefined && !isRecord(parsed.usagePanel)) throw new Error(".pi/workspace.jsonc has an invalid usagePanel field.");
  const collapsed = isRecord(parsed.usagePanel) ? parsed.usagePanel.collapsedSections : undefined;
  if (collapsed !== undefined && (!Array.isArray(collapsed) || collapsed.some((id) => typeof id !== "string"))) {
    throw new Error(".pi/workspace.jsonc has an invalid usagePanel.collapsedSections field.");
  }
  const order = isRecord(parsed.usagePanel) ? parsed.usagePanel.providerOrder : undefined;
  if (order !== undefined && (!Array.isArray(order) || order.some((id) => typeof id !== "string"))) {
    throw new Error(".pi/workspace.jsonc has an invalid usagePanel.providerOrder field.");
  }
  return parsed;
}

export function usageCollapsedSections(source: string | undefined): string[] {
  const panel = config(source).usagePanel;
  return isRecord(panel) && Array.isArray(panel.collapsedSections) ? [...new Set(panel.collapsedSections as string[])] : [];
}

export function usageProviderOrder(source: string | undefined): string[] {
  const panel = config(source).usagePanel;
  return isRecord(panel) && Array.isArray(panel.providerOrder) ? [...new Set(panel.providerOrder as string[])] : [];
}

/** Cache provider-family order without changing disclosure state or sibling settings. */
export function workspaceConfigWithUsageProviderOrder(source: string | undefined, order: readonly string[]): string {
  config(source);
  const base = source?.trim() ? source : "{}\n";
  return withWorkspaceSchema(applyEdits(base, modify(base, ["usagePanel", "providerOrder"], [...new Set(order)], {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  })));
}

/** Change one stable section id, preserving comments, sibling settings and other windows' toggles. */
export function workspaceConfigWithUsageSection(source: string | undefined, id: UsageSectionId, open: boolean): string {
  const collapsed = new Set(usageCollapsedSections(source));
  if (open) collapsed.delete(id);
  else collapsed.add(id);
  const base = source?.trim() ? source : "{}\n";
  const next = applyEdits(base, modify(base, ["usagePanel", "collapsedSections"], [...collapsed], {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  }));
  return withWorkspaceSchema(next);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
