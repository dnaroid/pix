import dcpModule from "../../external/pi-tools-suite/src/dcp/index.js";
import { loadConfig } from "../../external/pi-tools-suite/src/dcp/config.js";
import { createState } from "../../external/pi-tools-suite/src/dcp/state.js";

export const user = (text: string, timestamp: number) => ({ role: "user", content: text, timestamp } as any);
export const assistant = (text: string, timestamp: number) => ({ role: "assistant", content: [{ type: "text", text }], timestamp,
  provider: "fixture", model: "large", api: "openai-responses", stopReason: "stop",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as any);

/** Real DCP hooks with an injected manager and no network/model calls. */
export async function runtime(manager: any) {
  const state = createState();
  const config = loadConfig({ homeDir: "/__dcp_full_branch_integration__" });
  config.debug = false;
  config.compress.minContextPercent = 0.99;
  config.compress.maxContextPercent = 0.995;
  config.compress.summaryBuffer = false;
  config.compress.autoCompress.enabled = false;
  config.compress.autoCandidates.enabled = false;
  config.compress.messageMode.enabled = false;
  const handlers = new Map<string, any[]>(), tools = new Map<string, any>(), commands = new Map<string, any>();
  const sent: any[] = [];
  const ctx: any = { sessionManager: manager, cwd: manager.getCwd(), hasUI: false,
    model: { provider: "fixture", id: "large", contextWindow: 1_000_000, maxTokens: 4_096 },
    getContextUsage: () => ({ tokens: 4_000, contextWindow: 1_000_000 }),
    ui: { notify() {} }, abort() { throw new Error("provider send aborted"); },
  };
  await dcpModule({ on(name: string, fn: any) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand(name: string, command: any) { commands.set(name, command); },
    appendEntry(type: string, data: unknown) { ctx.sessionManager.appendCustomEntry(type, data); },
    sendMessage(message: unknown) { sent.push(message); },
  } as any, { state, config });
  const emit = async (name: string, event: any = {}) => {
    let result: any;
    for (const fn of handlers.get(name) ?? []) result = await fn({ type: name, ...event }, ctx);
    return result;
  };
  const project = (messages = ctx.sessionManager.buildSessionContext().messages) => emit("context", { messages });
  const send = (p: any) => emit("before_provider_request", { payload: { messages: p.messages } });
  return { ctx, state, config, tools, commands, emit, project, send, sent };
}
