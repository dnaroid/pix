import { parse } from "jsonc-parser";

export interface DesktopPreferences {
  readonly externalEditor: string | undefined;
}

export const EXTERNAL_EDITOR_OPTIONS = [
  { value: "gram", label: "Gram" },
  { value: "zed", label: "Zed" },
  { value: "code", label: "Visual Studio Code" },
  { value: "cursor", label: "Cursor" },
  { value: "subl", label: "Sublime Text" },
  { value: "idea", label: "IntelliJ IDEA" },
  { value: "webstorm", label: "WebStorm" },
] as const;

export function resolveDesktopPreferences(
  globalSource: string | undefined,
  projectSource: string | undefined,
): DesktopPreferences {
  const globalEditor = externalEditorFromSource(globalSource);
  const projectEditor = externalEditorFromSource(projectSource);
  return { externalEditor: projectEditor ?? globalEditor };
}

export function externalEditorLabel(editor: string | undefined): string {
  const configured = editor?.trim() ?? "";
  switch (configured.toLowerCase()) {
    case "gram": return "Gram";
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
    default: return configured || "External Editor";
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
