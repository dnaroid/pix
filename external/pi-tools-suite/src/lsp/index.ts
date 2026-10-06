import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendLspDiagnosticsToMutationResult, shutdownGlobalLspManager } from "./tool-result.js";
import { monitorLsp } from "./runtime-control";
import { createLspPanel } from "./renderer";
import { attachSharedLsp } from "./shared-manager";
import { lspProjectIdentity } from "./broker-identity";

export { LspManager, getGlobalLspManager } from "./manager";
export { getEventPaths, isMutationToolResult } from "./mutation-events";
export {
  appendLspDiagnosticsToMutationResult,
  shutdownGlobalLspManager,
  type LspEnrichableToolResult,
  type LspMutationToolResultInput,
} from "./tool-result";

export default function piLspExtension(pi: ExtensionAPI) {
  let sessionOwner: ExtensionContext["sessionManager"] | undefined;
  let sessionProject: string | undefined;
  let sessionEpoch = 0;
  pi.registerCommand("lsp", {
    description: "Monitor this project's running language servers",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) { ctx.ui.notify("The LSP panel requires an interactive terminal", "warning"); return; }
      await ctx.ui.custom<undefined>((tui, _theme, _keys, done) => createLspPanel(
        () => monitorLsp(ctx),
        () => tui.requestRender(),
        done,
      ));
    },
  });
  pi.registerCommand("lsp-control", {
    description: "Inspect this project's running language servers",
    handler: async (args, ctx) => {
      const request = JSON.parse(args || '{"action":"status"}');
      if (request.action !== "status") throw new Error("LSP monitoring only supports status");
      const snapshot = await monitorLsp(ctx);
      ctx.ui.setStatus("pix:lsp", JSON.stringify(snapshot));
    },
  });
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

  pi.on("session_start", async (_event, ctx) => {
    const epoch = ++sessionEpoch;
    const previous = sessionOwner;
    const project = lspProjectIdentity(ctx.cwd);
    const sameOwner = sessionProject === project && previous === ctx.sessionManager;
    sessionOwner = ctx.sessionManager;
    sessionProject = project;
    // A fresh SDK session must fence pending trust/diagnostics even when it
    // stays in the same project. Other attached tabs retain project state.
    // bindExtensions can also repeat session_start for the unchanged session.
    if (!sameOwner) await shutdownGlobalLspManager(previous ? { sessionManager: previous } : ctx);
    if (epoch !== sessionEpoch) return;
    if (process.platform === "win32") return;
    try { await attachSharedLsp(ctx); }
    catch (error) { if (epoch === sessionEpoch) ctx.ui.notify(`LSP broker: ${(error as Error).message}`, "warning"); }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    sessionEpoch += 1;
    const previous = sessionOwner;
    sessionOwner = undefined;
    sessionProject = undefined;
    await shutdownGlobalLspManager(previous ? { sessionManager: previous } : ctx);
  });
}
