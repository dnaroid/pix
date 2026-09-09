import { parse } from "jsonc-parser";

export interface DesktopPreferences {
  readonly externalEditor: string;
}

export const DEFAULT_EXTERNAL_EDITOR = "zed";

export function resolveDesktopPreferences(
  globalSource: string | undefined,
  projectSource: string | undefined,
): DesktopPreferences {
  const globalEditor = externalEditorFromSource(globalSource);
  const projectEditor = externalEditorFromSource(projectSource);
  return { externalEditor: projectEditor ?? globalEditor ?? DEFAULT_EXTERNAL_EDITOR };
}

export function externalEditorLabel(editor: string): string {
  switch (editor.trim().toLowerCase()) {
    case "zed": return "Zed";
    case "code":
    case "vscode":
    case "visual studio code": return "VS Code";
    case "cursor": return "Cursor";
    case "subl":
    case "sublime":
    case "sublime text": return "Sublime Text";
    case "idea":
    case "intellij":
    case "intellij idea": return "IntelliJ IDEA";
    case "webstorm": return "WebStorm";
    default: return editor.trim() || "editor";
  }
}

function externalEditorFromSource(source: string | undefined): string | undefined {
  if (!source?.trim()) return undefined;
  try {
    const parsed = parse(source, undefined, { allowTrailingComma: true }) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.desktop)) return undefined;
    const editor = parsed.desktop.externalEditor;
    return typeof editor === "string" && editor.trim() ? editor.trim() : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
