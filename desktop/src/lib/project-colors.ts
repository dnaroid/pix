import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export const WORKSPACE_CONFIG_PATH = ".pi/workspace.jsonc";

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/iu;

export function normalizeProjectColor(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const color = value.trim();
  return HEX_COLOR.test(color) ? color : undefined;
}

/**
 * Read the optional project identity color from a workspace-local JSONC file.
 * Invalid or unsupported values deliberately fall back to the deterministic
 * project color instead of surfacing a blocking workspace error.
 */
export function projectColorFromWorkspaceConfig(source: string | undefined): string | undefined {
  if (!source) return undefined;
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0 || !isRecord(parsed) || typeof parsed.color !== "string") return undefined;
  return normalizeProjectColor(parsed.color);
}

/** Update only the color property while retaining comments and future fields. */
export function workspaceConfigWithProjectColor(source: string | undefined, color: string | undefined): string {
  const base = source?.trim() ? source : "{}\n";
  const errors: ParseError[] = [];
  const parsed = parse(base, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length > 0 || !isRecord(parsed)) {
    throw new Error(".pi/workspace.jsonc is malformed; fix it before saving project settings.");
  }
  const normalized = color === undefined ? undefined : normalizeProjectColor(color);
  if (color !== undefined && !normalized) throw new Error("Project color must be a hex color.");
  const edits = modify(base, ["color"], normalized, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  });
  const next = applyEdits(base, edits);
  return next.endsWith("\n") ? next : `${next}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
