import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { AcpClient } from "../lib/acp-client";
import {
  applyLocalModelThinkingSelection,
  clampThinkingLevel,
  modelThinkingConfigState,
} from "../lib/model-thinking";
import { parseDesktopModelRef } from "./desktop-helpers";
import type { createModelPreferencesStore } from "./model-preferences.svelte";
import type { createSessionRuntimeStore } from "./session-runtime.svelte";

type ModelPreferencesStore = ReturnType<typeof createModelPreferencesStore>;
type SessionRuntimeStore = ReturnType<typeof createSessionRuntimeStore>;

type ModelConfigOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  statusReady: () => boolean;
  activeSessionId: () => string | null;
  activeSessionRuntimeReady: () => boolean;
  activeConfigOptions: () => SessionConfigOption[];
  setActiveConfigOptions: (options: SessionConfigOption[]) => void;
  draftSessionTabOpen: () => boolean;
  draftSessionTabActive: () => boolean;
  operationRunning: () => boolean;
  changingConfig: () => string | null;
  closeCommandPicker: () => void;
  reloadResources: (options?: { echo?: boolean }) => Promise<void>;
  preferences: ModelPreferencesStore;
  runtime: SessionRuntimeStore;
  reportError: (error: unknown) => void;
};

export function createModelConfig(options: ModelConfigOptions) {
  let draftConfigOptions = $state<SessionConfigOption[]>([]);
  let draftModelOverride = $state<{ modelRef: string; thinkingLevel: string } | null>(null);
  let pickerOpen = $state(false);
  let pickerSessionId = $state<string | null>(null);
  let pickerDraft = $state(false);
  let draftConfigGeneration = 0;

  $effect(() => {
    const pickerLostOwner = pickerDraft
      ? !options.draftSessionTabActive()
      : pickerSessionId !== options.activeSessionId();
    if (pickerOpen && pickerLostOwner) closePicker();
  });

  async function refreshDraftConfig(): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace || !options.statusReady()) return;
    const generation = ++draftConfigGeneration;
    try {
      const response = await requestClient.draftConfig(requestWorkspace);
      if (
        generation !== draftConfigGeneration
        || requestClient !== options.client()
        || requestWorkspace !== options.workspace()
        || !options.draftSessionTabOpen()
      ) return;
      draftConfigOptions = response.configOptions;
    } catch (error) {
      if (
        generation === draftConfigGeneration
        && requestClient === options.client()
        && requestWorkspace === options.workspace()
        && options.draftSessionTabActive()
      ) options.reportError(error);
    }
  }

  function resetDraft(): void {
    draftConfigOptions = [];
    draftModelOverride = null;
    draftConfigGeneration += 1;
  }

  async function openPicker(): Promise<void> {
    const draft = options.draftSessionTabActive();
    if (
      (!draft && (!options.activeSessionId() || !options.activeSessionRuntimeReady()))
      || options.operationRunning()
      || options.changingConfig()
    ) return;
    const sessionId = options.activeSessionId();
    options.closeCommandPicker();
    if (draft && draftConfigOptions.length === 0) await refreshDraftConfig();
    await options.preferences.waitForVisibleModelsSave();
    if (
      options.operationRunning()
      || options.changingConfig()
      || (draft
        ? !options.draftSessionTabActive() || draftConfigOptions.length === 0
        : sessionId !== options.activeSessionId() || !options.activeSessionRuntimeReady())
    ) return;
    await options.preferences.load();
    if (
      options.operationRunning()
      || options.changingConfig()
      || (draft
        ? !options.draftSessionTabActive()
        : sessionId !== options.activeSessionId() || !options.activeSessionRuntimeReady())
    ) return;
    pickerDraft = draft;
    pickerSessionId = draft ? null : sessionId;
    pickerOpen = true;
  }

  function closePicker(): void {
    pickerOpen = false;
    pickerSessionId = null;
    pickerDraft = false;
  }

  async function applySelection(modelRef: string, thinkingLevel: string): Promise<void> {
    if (pickerDraft) {
      if (!options.draftSessionTabActive() || options.operationRunning()) {
        throw new Error("Model and thinking settings are unavailable right now.");
      }
      draftConfigOptions = applyLocalModelThinkingSelection(draftConfigOptions, modelRef, thinkingLevel);
      const state = modelThinkingConfigState(draftConfigOptions);
      draftModelOverride = { modelRef, thinkingLevel: state.currentThinking };
      await options.preferences.rememberThinkingPreference(modelRef, state.currentThinking);
      return;
    }

    const requestClient = options.client();
    const sessionId = pickerSessionId;
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
    const source = options.draftSessionTabActive() ? draftConfigOptions : options.activeConfigOptions();
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
      const state = modelThinkingConfigState(draftConfigOptions);
      const modelRef = configId === "model" ? value : state.currentModel?.ref;
      if (!modelRef) throw new Error("Model selection is unavailable.");
      const selected = state.models.find((model) => model.ref === modelRef);
      if (!selected) throw new Error(`Unknown model: ${modelRef}`);
      const thinkingLevel = configId === "thought_level"
        ? value
        : clampThinkingLevel(state.currentThinking, selected.thinkingLevels);
      draftConfigOptions = applyLocalModelThinkingSelection(draftConfigOptions, modelRef, thinkingLevel);
      const next = modelThinkingConfigState(draftConfigOptions);
      draftModelOverride = { modelRef, thinkingLevel: next.currentThinking };
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
    get draftConfigOptions() { return draftConfigOptions; },
    get draftModelOverride() { return draftModelOverride; },
    get pickerOpen() { return pickerOpen; },
    get pickerDraft() { return pickerDraft; },
    refreshDraftConfig,
    resetDraft,
    openPicker,
    closePicker,
    applySelection,
    applyModelSlashCommand,
    applyThinkingSlashCommand,
    setConfigValue,
    setConfig,
  };
}
