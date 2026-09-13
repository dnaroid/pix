import type { ContentBlock, SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";
import { isAgentControlState, type AgentControlAction } from "./agent-control";
import type { RegistryActionRequest } from "./registry";
import { isRecord, parseQueueState, parseQueuedUserMessage, parseRuntimeStatus } from "./acp-response-parsers";
import type {
  AgentControlStatus,
  AutocompleteSettings,
  DcpStatsStatus,
  ForkMessage,
  LazySessionHistory,
  LazySessionImage,
  PromptFileImage,
  QueuedUserMessage,
  QueueAction,
  QueueItem,
  QueueState,
  RuntimeStatus,
  UserMessageAction,
  UserMessageActionResult,
} from "./acp-client-types";

export type AcpRequest = <Response>(
  method: string,
  params: unknown,
  timeoutMs?: number | null,
  signal?: AbortSignal,
) => Promise<Response>;

export class AcpPixExtensions {
  constructor(private readonly request: AcpRequest) {}

  draftConfig(cwd: string): Promise<{ configOptions: SessionConfigOption[] }> {
    return this.request("pix/session/draft_config", { cwd });
  }

  async sessionHistory(sessionId: string, full = false): Promise<LazySessionHistory> {
    const response = await this.request<unknown>("pix/session/history", full ? { sessionId, full: true } : { sessionId }, null);
    if (!isRecord(response) || !Array.isArray(response.updates) || !Array.isArray(response.deferredToolCallIds)) {
      throw new Error("pix/session/history returned an invalid response");
    }
    const updates: SessionUpdate[] = [];
    for (const update of response.updates) {
      if (!isRecord(update) || typeof update.sessionUpdate !== "string") {
        throw new Error("pix/session/history returned an invalid update");
      }
      updates.push(update as unknown as SessionUpdate);
    }
    const deferredToolCallIds: string[] = [];
    for (const toolCallId of response.deferredToolCallIds) {
      if (typeof toolCallId !== "string") throw new Error("pix/session/history returned an invalid deferred tool id");
      deferredToolCallIds.push(toolCallId);
    }
    return { updates, deferredToolCallIds };
  }

  async toolResult(sessionId: string, toolCallId: string): Promise<SessionUpdate> {
    const response = await this.request<unknown>("pix/session/tool_result", { sessionId, toolCallId }, null);
    if (!isRecord(response) || !isRecord(response.update) || typeof response.update.sessionUpdate !== "string") {
      throw new Error("pix/session/tool_result returned an invalid response");
    }
    return response.update as unknown as SessionUpdate;
  }

  async sessionImage(sessionId: string, imageId: string): Promise<LazySessionImage> {
    const response = await this.request<unknown>("pix/session/image", { sessionId, imageId }, null);
    if (!isRecord(response) || typeof response.data !== "string" || typeof response.mimeType !== "string") {
      throw new Error("pix/session/image returned an invalid response");
    }
    return { data: response.data, mimeType: response.mimeType };
  }

  async forkMessages(sessionId: string): Promise<ForkMessage[]> {
    return this.messageList("pix/session/fork_messages", sessionId);
  }

  async branchUserMessages(sessionId: string): Promise<ForkMessage[]> {
    return this.messageList("pix/session/branch_user_messages", sessionId, null);
  }

  async agentControl(sessionId: string, action: AgentControlAction): Promise<AgentControlStatus> {
    const response = await this.request<unknown>("pix/session/agent_control", { sessionId, action }, null);
    if (!isRecord(response) || typeof response.sessionId !== "string" || !isAgentControlState(response.state)) {
      throw new Error("pix/session/agent_control returned an invalid response");
    }
    return { sessionId: response.sessionId, state: response.state };
  }

  async runtimeStatus(sessionId: string, refreshModelUsage = false): Promise<RuntimeStatus> {
    return parseRuntimeStatus(await this.request<unknown>("pix/session/runtime_status", { sessionId, refreshModelUsage }));
  }

  async dcpStats(sessionId: string): Promise<DcpStatsStatus> {
    const response = await this.request<unknown>("pix/session/dcp_stats", { sessionId });
    if (!isRecord(response) || typeof response.sessionId !== "string" || (response.dcpStats !== undefined && typeof response.dcpStats !== "string")) {
      throw new Error("pix/session/dcp_stats returned an invalid response");
    }
    return { sessionId: response.sessionId, ...(typeof response.dcpStats === "string" ? { dcpStats: response.dcpStats } : {}) };
  }

  async userMessageAction(sessionId: string, entryId: string, action: UserMessageAction): Promise<UserMessageActionResult> {
    const response = await this.request<unknown>("pix/session/user_message_action", { sessionId, entryId, action }, null);
    if (!isRecord(response) || (response.status !== "ok" && response.status !== "warning" && response.status !== "cancelled")) {
      throw new Error("pix/session/user_message_action returned an invalid response");
    }
    return {
      status: response.status,
      ...(typeof response.editorText === "string" ? { editorText: response.editorText } : {}),
      ...(typeof response.revertedChanges === "number" ? { revertedChanges: response.revertedChanges } : {}),
      ...(typeof response.changedFiles === "number" ? { changedFiles: response.changedFiles } : {}),
      ...(typeof response.warning === "string" ? { warning: response.warning } : {}),
    };
  }

  reloadSession(sessionId: string): Promise<{ configOptions: SessionConfigOption[] }> {
    return this.configOptions("pix/session/reload", { sessionId });
  }

  async enhancePrompt(sessionId: string, draft: string): Promise<string> {
    const response = await this.request<unknown>("pix/prompt/enhance", { sessionId, draft }, null);
    if (!isRecord(response) || typeof response.prompt !== "string" || response.prompt.trim().length === 0) {
      throw new Error("pix/prompt/enhance returned an invalid response");
    }
    return response.prompt;
  }

  async gitAssist(sessionId: string, kind: "review" | "commit-message", diff: string): Promise<string> {
    const response = await this.request<unknown>("pix/git/assist", { sessionId, kind, diff }, null);
    if (!isRecord(response) || typeof response.text !== "string" || response.text.trim().length === 0) {
      throw new Error("pix/git/assist returned an invalid response");
    }
    return response.text;
  }

  importSession(sessionId: string, path: string): Promise<{ configOptions: SessionConfigOption[] }> {
    return this.configOptions("pix/session/import", { sessionId, path });
  }

  async requestHistory(sessionId: string): Promise<string[]> {
    const response = await this.request<unknown>("pix/request-history", { sessionId }, null);
    if (!isRecord(response) || !Array.isArray(response.entries) || response.entries.some((entry) => typeof entry !== "string")) {
      throw new Error("pix/request-history returned an invalid response");
    }
    return response.entries as string[];
  }

  async queueState(sessionId: string): Promise<QueueState> {
    return parseQueueState(await this.request<unknown>("pix/session/queue_state", { sessionId }, null));
  }

  async registryAction(sessionId: string, action: RegistryActionRequest): Promise<void> {
    const response = await this.request<unknown>("pix/registry/action", { sessionId, ...action }, null);
    if (!isRecord(response)) throw new Error("pix/registry/action returned an invalid response");
  }

  async queueMessage(
    sessionId: string,
    prompt: readonly ContentBlock[],
    displayText: string,
    fileImages: readonly PromptFileImage[] = [],
  ): Promise<{ disposition: "steering" | "auto"; itemId: string }> {
    const response = await this.request<unknown>("pix/session/queue_message", {
      sessionId,
      prompt,
      displayText,
      ...(fileImages.length > 0 ? { _meta: { "pix.fileImages": fileImages } } : {}),
    }, null);
    if (!isRecord(response) || !["steering", "auto"].includes(String(response.disposition)) || typeof response.itemId !== "string") {
      throw new Error("pix/session/queue_message returned an invalid response");
    }
    return { disposition: response.disposition as "steering" | "auto", itemId: response.itemId };
  }

  async deferMessage(
    sessionId: string,
    prompt: readonly ContentBlock[],
    displayText: string,
    fileImages: readonly PromptFileImage[] = [],
  ): Promise<{ itemId: string }> {
    const response = await this.request<unknown>("pix/session/defer_message", {
      sessionId,
      prompt,
      displayText,
      ...(fileImages.length > 0 ? { _meta: { "pix.fileImages": fileImages } } : {}),
    }, null);
    if (!isRecord(response) || response.disposition !== "deferred" || typeof response.itemId !== "string") {
      throw new Error("pix/session/defer_message returned an invalid response");
    }
    return { itemId: response.itemId };
  }

  async queueAction(sessionId: string, item: QueueItem, action: QueueAction): Promise<{
    message?: QueuedUserMessage;
    interruptRequired: boolean;
  }> {
    const response = await this.request<unknown>("pix/session/queue_action", {
      sessionId,
      source: item.source,
      index: item.index,
      text: item.text,
      action,
    }, null);
    if (!isRecord(response)) throw new Error("pix/session/queue_action returned an invalid response");
    const queued = response.message === undefined ? undefined : parseQueuedUserMessage(response.message);
    if (response.message !== undefined && !queued) throw new Error("pix/session/queue_action returned an invalid message");
    return {
      ...(queued ? { message: queued } : {}),
      interruptRequired: response.interruptRequired === true,
    };
  }

  async takeAutoMessage(sessionId: string): Promise<QueuedUserMessage | undefined> {
    const response = await this.request<unknown>("pix/session/take_auto_message", { sessionId }, null);
    if (!isRecord(response)) throw new Error("pix/session/take_auto_message returned an invalid response");
    if (response.message === undefined) return undefined;
    const queued = parseQueuedUserMessage(response.message);
    if (!queued) throw new Error("pix/session/take_auto_message returned an invalid message");
    return queued;
  }

  resumeSessionPath(sessionId: string, path: string): Promise<{ configOptions: SessionConfigOption[] }> {
    return this.configOptions("pix/session/resume_path", { sessionId, path });
  }

  async autocomplete(sessionId: string, draft: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request<unknown>("pix/autocomplete", { sessionId, draft }, 30_000, signal);
    if (!isRecord(response) || typeof response.completion !== "string") {
      throw new Error("pix/autocomplete returned an invalid response");
    }
    return response.completion;
  }

  async autocompleteSettings(sessionId: string): Promise<AutocompleteSettings> {
    const response = await this.request<unknown>("pix/autocomplete/config", { sessionId });
    if (
      !isRecord(response)
      || typeof response.enabled !== "boolean"
      || typeof response.debounceMs !== "number"
      || !Number.isFinite(response.debounceMs)
    ) {
      throw new Error("pix/autocomplete/config returned an invalid response");
    }
    return { enabled: response.enabled, debounceMs: response.debounceMs };
  }

  private async messageList(method: string, sessionId: string, timeoutMs: number | null = 30_000): Promise<ForkMessage[]> {
    const response = await this.request<unknown>(method, { sessionId }, timeoutMs);
    if (!isRecord(response) || !Array.isArray(response.messages)) {
      throw new Error(`${method} returned an invalid response`);
    }
    return response.messages.map((message) => {
      if (!isRecord(message) || typeof message.entryId !== "string" || typeof message.text !== "string") {
        throw new Error(`${method} returned an invalid response`);
      }
      return { entryId: message.entryId, text: message.text };
    });
  }

  private async configOptions(method: string, params: unknown): Promise<{ configOptions: SessionConfigOption[] }> {
    const response = await this.request<unknown>(method, params, null);
    if (!isRecord(response)) throw new Error(`${method} returned an invalid response`);
    return {
      configOptions: Array.isArray(response.configOptions)
        ? response.configOptions as SessionConfigOption[]
        : [],
    };
  }
}
