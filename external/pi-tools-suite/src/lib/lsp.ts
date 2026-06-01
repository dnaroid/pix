import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { toAbsolutePath } from "../lsp/_shared/paths.js";
import { getGlobalLspManager } from "../lsp/manager.js";
import { getEventPaths, isMutationToolResult } from "../lsp/mutation-events.js";

export type LspEnrichableToolResult<TDetails = unknown> = AgentToolResult<TDetails>;

export type LspMutationToolResultInput<TDetails = unknown> = {
  toolName: string;
  input: unknown;
  result: LspEnrichableToolResult<TDetails>;
  ctx: ExtensionContext;
  isError?: boolean;
};

function textContent(text: string): AgentToolResult<unknown>["content"][number] {
  return { type: "text", text };
}

function hasLspDiagnosticsContent(result: LspEnrichableToolResult): boolean {
  return result.content.some((part) => typeof (part as { text?: unknown }).text === "string" && (part as { text: string }).text.includes("LSP diagnostics:"));
}

function isMissingFileError(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "ENOENT" || String((error as Error)?.message ?? error).includes("ENOENT");
}

export async function appendLspDiagnosticsToMutationResult<T extends LspEnrichableToolResult>(options: LspMutationToolResultInput<T["details"]> & { result: T }): Promise<T> {
  if (options.isError || !isMutationToolResult({ toolName: options.toolName, input: options.input, details: options.result.details })) return options.result;
  if (hasLspDiagnosticsContent(options.result)) return options.result;

  try {
    const files = [...new Set(getEventPaths(options.input, options.result.details).map((inputPath) => toAbsolutePath(inputPath, options.ctx.cwd)))].filter((file) => existsSync(file));
    if (files.length === 0) return options.result;

    const manager = getGlobalLspManager();
    const summaries: string[] = [];
    for (const file of files) {
      const summary = await manager.updateDiagnosticsForFile(options.ctx, file);
      if (summary.trim()) summaries.push(summary);
    }

    const summary = summaries.join("\n\n");
    if (!summary.trim()) return options.result;

    return {
      ...options.result,
      content: [...options.result.content, textContent(summary)],
    };
  } catch (error) {
    if (isMissingFileError(error)) return options.result;
    return {
      ...options.result,
      content: [...options.result.content, textContent(`LSP diagnostics:\n\n⚠️ lsp: ${(error as Error).message}`)],
    };
  }
}

export async function shutdownGlobalLspManager(): Promise<void> {
  await getGlobalLspManager().shutdownAll();
}
