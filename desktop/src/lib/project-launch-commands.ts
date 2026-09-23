import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export interface LaunchCommand {
  id: string;
  name: string;
  command: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function launchCommandsFromWorkspaceConfig(source: string | undefined): LaunchCommand[] {
  if (!source) return [];
  const errors: ParseError[] = [];
  const parsed = parse(source, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length || !isRecord(parsed)) return [];
  if (parsed.launchCommands === undefined) return [];
  if (!Array.isArray(parsed.launchCommands) || parsed.launchCommands.some((item) =>
    !isRecord(item) || typeof item.id !== "string" || typeof item.name !== "string" || typeof item.command !== "string")) {
    throw new Error(".pi/workspace.jsonc has an invalid launchCommands field; fix it before saving launch commands.");
  }
  return parsed.launchCommands as LaunchCommand[];
}

export function workspaceConfigWithLaunchCommands(source: string | undefined, commands: readonly LaunchCommand[]): string {
  const base = source?.trim() ? source : "{}\n";
  const errors: ParseError[] = [];
  const parsed = parse(base, errors, { allowTrailingComma: true, disallowComments: false }) as unknown;
  if (errors.length || !isRecord(parsed)) throw new Error(".pi/workspace.jsonc is malformed; fix it before saving launch commands.");
  if (parsed.launchCommands !== undefined) launchCommandsFromWorkspaceConfig(base);
  if (commands.some((item) => !item.id.trim() || !item.name.trim() || !item.command.trim())) throw new Error("Launch command name and command are required.");
  const next = applyEdits(base, modify(base, ["launchCommands"], commands, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  }));
  return next.endsWith("\n") ? next : `${next}\n`;
}
