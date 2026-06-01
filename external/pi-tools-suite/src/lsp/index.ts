import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendLspDiagnosticsToMutationResult, shutdownGlobalLspManager } from "./tool-result.js";

// renderer.ts is intentionally empty — TUI rendering removed.
export { LspManager, getGlobalLspManager } from "./manager";
export { getEventPaths, isMutationToolResult } from "./mutation-events";
export {
  appendLspDiagnosticsToMutationResult,
  shutdownGlobalLspManager,
  type LspEnrichableToolResult,
  type LspMutationToolResultInput,
} from "./tool-result";

export default function piLspExtension(pi: ExtensionAPI) {
  pi.on("tool_result", async (event, ctx) => {
    const result = await appendLspDiagnosticsToMutationResult({
      toolName: event.toolName,
      input: event.input,
      result: { content: event.content, details: event.details },
      ctx,
      isError: event.isError,
    });

    if (result.content === event.content && result.details === event.details) return undefined;
    return { content: result.content, details: result.details };
  });

  pi.on("session_shutdown", async () => {
    await shutdownGlobalLspManager();
  });
}
