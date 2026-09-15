import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { RuntimeStatus } from "../lib/acp-client";
import {
  applyLocalModelThinkingSelection,
  clampThinkingLevel,
  modelThinkingConfigState,
} from "../lib/model-thinking";
import type { ModelConfigOptions } from "./model-config-options";

export function createModelDraftConfig(options: ModelConfigOptions) {
  let configOptions = $state<SessionConfigOption[]>([]);
  let modelOverride = $state<{ modelRef: string; thinkingLevel: string } | null>(null);
  let runtimeStatus = $state<RuntimeStatus | undefined>(undefined);
  let modelUsageRefreshing = $state(false);
  let generation = 0;
  let usageGeneration = 0;

  async function refreshUsage(
    modelRef?: string,
    thinkingLevel?: string,
    clearPrevious = false,
  ): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    const state = modelThinkingConfigState(configOptions);
    const effectiveModelRef = modelRef ?? state.currentModel?.ref;
    const effectiveThinking = thinkingLevel ?? state.currentThinking;
    if (!requestClient || !requestWorkspace || !options.statusReady() || !effectiveModelRef) return;
    const requestGeneration = ++usageGeneration;
    if (clearPrevious) runtimeStatus = undefined;
    modelUsageRefreshing = true;
    try {
      const response = await requestClient.draftConfig(requestWorkspace, {
        modelRef: effectiveModelRef,
        thinkingLevel: effectiveThinking,
      }, true);
      if (
        requestGeneration !== usageGeneration
        || requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || !options.draftSessionTabOpen()
      ) return;
      runtimeStatus = {
        sessionId: "draft",
        modelUsageRefresh: response.modelUsageRefresh,
        ...(response.modelUsage ? { modelUsage: response.modelUsage } : {}),
      };
    } catch {
      // Draft quota is best-effort just like live runtime quota. Keep the model
      // selector usable even when provider usage is temporarily unavailable.
    } finally {
      if (requestGeneration === usageGeneration) modelUsageRefreshing = false;
    }
  }

  async function refresh(): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace || !options.statusReady()) return;
    const requestGeneration = ++generation;
    try {
      const response = await requestClient.draftConfig(requestWorkspace);
      if (
        requestGeneration !== generation
        || requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || !options.draftSessionTabOpen()
      ) return;
      configOptions = response.configOptions;
      const state = modelThinkingConfigState(configOptions);
      if (state.currentModel) void refreshUsage(state.currentModel.ref, state.currentThinking);
    } catch (error) {
      if (
        requestGeneration === generation
        && requestClient === options.client()
        && requestWorkspace === options.workspace()
        && options.draftSessionTabActive()
      ) options.reportError(error);
    }
  }

  function reset(): void {
    configOptions = [];
    modelOverride = null;
    runtimeStatus = undefined;
    modelUsageRefreshing = false;
    generation += 1;
    usageGeneration += 1;
  }

  function applySelection(modelRef: string, thinkingLevel: string): string {
    configOptions = applyLocalModelThinkingSelection(configOptions, modelRef, thinkingLevel);
    const state = modelThinkingConfigState(configOptions);
    modelOverride = { modelRef, thinkingLevel: state.currentThinking };
    void refreshUsage(modelRef, state.currentThinking, true);
    return state.currentThinking;
  }

  function applyConfigValue(configId: string, value: string): void {
    const state = modelThinkingConfigState(configOptions);
    const modelRef = configId === "model" ? value : state.currentModel?.ref;
    if (!modelRef) throw new Error("Model selection is unavailable.");
    const selected = state.models.find((model) => model.ref === modelRef);
    if (!selected) throw new Error(`Unknown model: ${modelRef}`);
    const thinkingLevel = configId === "thought_level"
      ? value
      : clampThinkingLevel(state.currentThinking, selected.thinkingLevels);
    configOptions = applyLocalModelThinkingSelection(configOptions, modelRef, thinkingLevel);
    const next = modelThinkingConfigState(configOptions);
    modelOverride = { modelRef, thinkingLevel: next.currentThinking };
    void refreshUsage(modelRef, next.currentThinking, true);
  }

  return {
    get configOptions() { return configOptions; },
    get modelOverride() { return modelOverride; },
    get runtimeStatus() { return runtimeStatus; },
    get modelUsageRefreshing() { return modelUsageRefreshing; },
    refresh,
    refreshUsage,
    reset,
    applySelection,
    applyConfigValue,
  };
}

export type ModelDraftConfig = ReturnType<typeof createModelDraftConfig>;
