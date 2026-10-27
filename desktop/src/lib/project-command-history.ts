import { invoke } from "@tauri-apps/api/core";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { createDiagnosticLogger } from "./diagnostic-logging";
import { WORKSPACE_CONFIG_PATH } from "./project-colors";
import type { ProjectFilePreview } from "./project-files";
import { withWorkspaceSchema } from "./workspace-config-schema";

export type CommandRunHistory = Record<string, number>;

function parseWorkspace(source: string | undefined): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(source?.trim() ? source : "{}", errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(".pi/workspace.jsonc is malformed; cannot save command history.");
  }
  return value as Record<string, unknown>;
}

export function commandHistoryFromWorkspaceConfig(source: string | undefined): CommandRunHistory {
  const history = parseWorkspace(source).recentCommandRuns;
  if (history === undefined) return {};
  if (!history || typeof history !== "object" || Array.isArray(history)
    || Object.entries(history).some(([key, value]) => !/^(launch|package):.+$/.test(key)
      || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(".pi/workspace.jsonc has an invalid recentCommandRuns field.");
  }
  return history as CommandRunHistory;
}

/** A late load/save response must not move a command backwards in time. */
export function mergeCommandHistory(...histories: readonly CommandRunHistory[]): CommandRunHistory {
  const merged: CommandRunHistory = {};
  for (const history of histories) {
    for (const [key, time] of Object.entries(history)) merged[key] = Math.max(merged[key] ?? 0, time);
  }
  return merged;
}

export function workspaceConfigWithCommandRun(source: string | undefined, key: string, time: number): string {
  const history = mergeCommandHistory(commandHistoryFromWorkspaceConfig(source), { [key]: time });
  const base = source?.trim() ? source : "{}\n";
  return withWorkspaceSchema(applyEdits(base, modify(base, ["recentCommandRuns"], history, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  })));
}

/** Persist an already accepted launch to its original project, even after a UI switch. */
export async function persistCommandRun(workspace: string, key: string, time: number, send = invoke): Promise<CommandRunHistory | undefined> {
  try {
    const exists = await send<boolean>("project_file_exists", { workspace, path: WORKSPACE_CONFIG_PATH });
    let current = exists ? await send<ProjectFilePreview>("read_project_file", { workspace, path: WORKSPACE_CONFIG_PATH }) : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const content = workspaceConfigWithCommandRun(current?.content, key, time);
      const result = await send<{ written: boolean; document: ProjectFilePreview | null }>("write_project_workspace_config_if_unchanged", {
        workspace, expectedContent: current?.content ?? null, content,
      });
      if (result.written && result.document) return commandHistoryFromWorkspaceConfig(result.document.content);
      current = result.document ?? undefined;
    }
    throw new Error(".pi/workspace.jsonc changed repeatedly; command history was not saved.");
  } catch (error) {
    // History is best-effort: never turn a successfully started PTY into a failed launch.
    createDiagnosticLogger(() => ({ workspace }), send).report(error, "frontend:command-history-save");
    return undefined;
  }
}
