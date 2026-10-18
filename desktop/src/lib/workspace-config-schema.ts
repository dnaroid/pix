import { applyEdits, modify, parse } from "jsonc-parser";

export const WORKSPACE_SCHEMA_URL = "https://unpkg.com/pi-ui-extend/schemas/workspace.json";

/** Add editor metadata to an already validated workspace document, preserving custom schemas. */
export function withWorkspaceSchema(source: string): string {
  const parsed = parse(source) as Record<string, unknown>;
  const next = parsed.$schema === undefined
    ? applyEdits(source, modify(source, ["$schema"], WORKSPACE_SCHEMA_URL, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        getInsertionIndex: () => 0,
      }))
    : source;
  return next.endsWith("\n") ? next : `${next}\n`;
}
