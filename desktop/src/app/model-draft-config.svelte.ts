import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  applyLocalModelThinkingSelection,
  clampThinkingLevel,
  modelThinkingConfigState,
} from "../lib/model-thinking";
import type { ModelConfigOptions } from "./model-config-options";

export function createModelDraftConfig(options: ModelConfigOptions) {
  let configOptions = $state<SessionConfigOption[]>([]);
  let modelOverride = $state<{ modelRef: string; thinkingLevel: string } | null>(null);
  let generation = 0;

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
    generation += 1;
  }

  function applySelection(modelRef: string, thinkingLevel: string): string {
    configOptions = applyLocalModelThinkingSelection(configOptions, modelRef, thinkingLevel);
    const state = modelThinkingConfigState(configOptions);
    modelOverride = { modelRef, thinkingLevel: state.currentThinking };
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
  }

  return {
    get configOptions() { return configOptions; },
    get modelOverride() { return modelOverride; },
    refresh,
    reset,
    applySelection,
    applyConfigValue,
  };
}

export type ModelDraftConfig = ReturnType<typeof createModelDraftConfig>;
