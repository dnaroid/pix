import type { AcpClient } from "../lib/acp-client";
import type { createPromptRuntime } from "./prompt-runtime.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";

type PromptRuntime = ReturnType<typeof createPromptRuntime>;
type SessionRuntime = ReturnType<typeof createSessionRuntimeStore>;

type DcpCompressionOptions = {
  client: () => AcpClient | null;
  activeSessionId: () => string | null;
  runtime: SessionRuntime;
  prompts: PromptRuntime;
  operationRunning: () => boolean;
  sessionHistoryLoading: () => boolean;
  available: () => boolean;
  reportError: (error: unknown) => void;
};

export function createDcpCompression(options: DcpCompressionOptions) {
  let sessionIds = $state<Set<string>>(new Set());

  async function compress(): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    const agentControlState = sessionId ? options.prompts.agentState(sessionId) : "idle";
    if (
      !requestClient
      || !sessionId
      || !options.runtime.isReady(sessionId)
      || options.prompts.isRunning(sessionId)
      || options.prompts.hasPromptRun(sessionId)
      || options.operationRunning()
      || options.sessionHistoryLoading()
      || agentControlState !== "idle"
      || !options.available()
      || sessionIds.has(sessionId)
    ) return;

    const compressing = new Set(sessionIds);
    compressing.add(sessionId);
    sessionIds = compressing;
    try {
      await options.prompts.runPromptRequest(
        requestClient,
        sessionId,
        [{ type: "text", text: "/dcp compress" }],
      );
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) options.reportError(error);
    } finally {
      const next = new Set(sessionIds);
      next.delete(sessionId);
      sessionIds = next;
    }
  }

  function clear(sessionId: string): void {
    if (!sessionIds.has(sessionId)) return;
    const next = new Set(sessionIds);
    next.delete(sessionId);
    sessionIds = next;
  }

  function reset(): void {
    sessionIds = new Set();
  }

  return {
    get sessionIds() { return sessionIds; },
    compress,
    clear,
    reset,
  };
}
