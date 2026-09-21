import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import {
  AUTO_MODEL_REF,
  clampThinkingLevel,
  modelThinkingConfigState,
} from "../lib/model-thinking";
import { parseDesktopModelRef } from "./desktop-helpers";
import type { ModelConfigOptions } from "./model-config-options";
import type { ModelDraftConfig } from "./model-draft-config.svelte";
import type { ModelPickerState } from "./model-picker-state.svelte";

export function createModelConfigActions(
  options: ModelConfigOptions,
  draftConfig: ModelDraftConfig,
  picker: ModelPickerState,
) {
  async function applySelection(modelRef: string, thinkingLevel: string): Promise<void> {
    if (!picker.draft && modelRef === AUTO_MODEL_REF) {
      if (!draftConfig.autoRoutingAvailable) throw new Error("Automatic model routing is disabled.");
      picker.close();
      await options.openDraftSessionTab();
      if (!options.draftSessionTabActive()) return;
      if (draftConfig.configOptions.length === 0) await draftConfig.refresh();
      draftConfig.applySelection(AUTO_MODEL_REF, "off");
      return;
    }
    if (picker.draft) {
      if (!options.draftSessionTabActive() || options.operationRunning()) {
        throw new Error("Model and thinking settings are unavailable right now.");
      }
      const currentThinking = draftConfig.applySelection(modelRef, thinkingLevel);
      if (modelRef !== AUTO_MODEL_REF) {
        await options.preferences.rememberThinkingPreference(modelRef, currentThinking);
      }
      return;
    }

    const requestClient = options.client();
    const sessionId = picker.sessionId;
    if (!requestClient || !sessionId || options.runtime.configChangeInProgress(sessionId) || options.operationRunning()) {
      throw new Error("Model and thinking settings are unavailable right now.");
    }

    let configOptions = options.runtime.getConfigOptions(sessionId)
      ?? (sessionId === options.activeSessionId() ? options.activeConfigOptions() : []);
    const initial = modelThinkingConfigState(configOptions);
    const selectedModel = initial.models.find((model) => model.ref === modelRef);
    if (!selectedModel) throw new Error(`Unknown model: ${modelRef}`);
    if (!selectedModel.thinkingLevels.includes(thinkingLevel)) {
      throw new Error(`${selectedModel.name} does not support ${thinkingLevel} thinking.`);
    }

    const generation = options.runtime.beginConfigChange(sessionId, "model-thinking");
    try {
      let state = modelThinkingConfigState(configOptions);
      if (state.currentModel?.ref !== modelRef) {
        const modelOption = configOptions.find((option) => option.id === "model" && option.type === "select");
        if (!modelOption || modelOption.type !== "select") throw new Error("Model selection is unavailable.");
        configOptions = (await requestClient.setConfigOption(sessionId, modelOption, modelRef)).configOptions;
        if (
          requestClient !== options.client()
          || !options.runtime.isReady(sessionId)
          || !options.runtime.configChangeIsCurrent(sessionId, generation)
        ) return;
        options.runtime.setConfigOptions(sessionId, configOptions);
        state = modelThinkingConfigState(configOptions);
      }

      const effectiveThinking = clampThinkingLevel(thinkingLevel, state.currentThinkingLevels);
      if (state.currentThinking !== effectiveThinking) {
        const thinkingOption = configOptions.find((option) => option.id === "thought_level" && option.type === "select");
        if (!thinkingOption || thinkingOption.type !== "select") throw new Error("Thinking selection is unavailable.");
        configOptions = (await requestClient.setConfigOption(sessionId, thinkingOption, effectiveThinking)).configOptions;
        if (
          requestClient !== options.client()
          || !options.runtime.isReady(sessionId)
          || !options.runtime.configChangeIsCurrent(sessionId, generation)
        ) return;
        options.runtime.setConfigOptions(sessionId, configOptions);
      }
      const applied = modelThinkingConfigState(configOptions);
      await options.preferences.rememberThinkingPreference(modelRef, applied.currentThinking);
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) options.reportError(error);
      throw error;
    } finally {
      options.runtime.endConfigChange(sessionId, generation);
    }
  }

  async function setConfigValue(configId: string, value: string): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    const source = options.draftSessionTabActive() ? draftConfig.configOptions : options.activeConfigOptions();
    const configOption = source.find((candidate) => candidate.id === configId);
    if (!requestClient || !configOption) {
      throw new Error(`/${configId === "model" ? "model" : "thinking"} is unavailable.`);
    }
    const validValues = configOption.type === "select"
      ? configOption.options.flatMap((entry) => "options" in entry ? entry.options.map((item) => item.value) : [entry.value])
      : [];
    if (configOption.type !== "select" || !validValues.includes(value)) {
      throw new Error(`Unknown ${configId === "model" ? "model" : "thinking level"}: ${value}`);
    }

    if (options.draftSessionTabActive()) {
      draftConfig.applyConfigValue(configId, value);
      return;
    }

    if (!sessionId) throw new Error(`/${configId === "model" ? "model" : "thinking"} is unavailable.`);
    const nextOptions = (await requestClient.setConfigOption(sessionId, configOption, value)).configOptions;
    options.runtime.setConfigOptions(sessionId, nextOptions);
  }

  async function applyModelSlashCommand(value: string): Promise<void> {
    const parsed = parseDesktopModelRef(value);
    if (!parsed) {
      options.reportError(new Error("Model must use provider/model[:thinking] format."));
      return;
    }
    try {
      await setConfigValue("model", parsed.modelRef);
      if (parsed.thinking) await setConfigValue("thought_level", parsed.thinking);
      await options.reloadResources({ echo: false });
    } catch (error) {
      options.reportError(error);
    }
  }

  async function applyThinkingSlashCommand(level: string): Promise<void> {
    try {
      await setConfigValue("thought_level", level);
    } catch (error) {
      options.reportError(error);
    }
  }

  async function setConfig(configOption: SessionConfigOption, value: string | boolean): Promise<void> {
    const requestClient = options.client();
    const sessionId = options.activeSessionId();
    if (
      !requestClient
      || !sessionId
      || !options.activeSessionRuntimeReady()
      || options.runtime.configChangeInProgress(sessionId)
    ) return;
    const generation = options.runtime.beginConfigChange(sessionId, configOption.id);
    try {
      const nextOptions = (await requestClient.setConfigOption(sessionId, configOption, value)).configOptions;
      if (
        requestClient !== options.client()
        || !options.runtime.isReady(sessionId)
        || !options.runtime.configChangeIsCurrent(sessionId, generation)
      ) return;
      options.runtime.setConfigOptions(sessionId, nextOptions);
    } catch (error) {
      if (requestClient === options.client() && sessionId === options.activeSessionId()) options.reportError(error);
    } finally {
      options.runtime.endConfigChange(sessionId, generation);
    }
  }

  return {
    applySelection,
    applyModelSlashCommand,
    applyThinkingSlashCommand,
    setConfigValue,
    setConfig,
  };
}
