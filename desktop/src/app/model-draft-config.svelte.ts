import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { RuntimeStatus } from "../lib/acp-client";
import {
  AUTO_MODEL_REF,
  applyLocalModelThinkingSelection,
  clampThinkingLevel,
  modelThinkingConfigState,
  withAutoModelRoutingOption,
} from "../lib/model-thinking";
import type { ModelConfigOptions } from "./model-config-options";
import { createDraftModelDisplay } from "./draft-model-display.svelte";

/**
 * Faster cadence for a draft quota refresh flagged
 * `modelUsageCredentialPending`: the Claude Code credential was missing, so
 * the retry's provider query reads only local credentials and performs no
 * provider network traffic until Claude Code refreshes its login. The chain
 * returns to the normal five-minute cadence once the flag is absent.
 */
const MODEL_USAGE_CREDENTIAL_RETRY_MS = 60_000;
const MODEL_USAGE_REFRESH_MS = 5 * 60_000;

export function createModelDraftConfig(options: ModelConfigOptions) {
  const display = createDraftModelDisplay(() => options.preferences?.defaultSelection);
  let configOptions = $state<SessionConfigOption[]>([]);
  let modelOverride = $state<{ modelRef: string; thinkingLevel: string } | null>(null);
  let runtimeStatus = $state<RuntimeStatus | undefined>(undefined);
  let modelUsageRefreshing = $state(false);
  let autoRoutingAvailable = $state(false);
  let autoRoutingSelected = $state(false);
  let routedTierId = $state<string | undefined>(undefined);
  let generation = 0;
  let usageGeneration = 0;
  let routingStatusGeneration = 0;
  let selectionInitialized = false;
  let usageRefreshTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleUsageRefresh(requestGeneration: number, modelRef: string, thinkingLevel: string, delay: number): void {
    usageRefreshTimer = setTimeout(() => {
      usageRefreshTimer = undefined;
      if (requestGeneration !== usageGeneration || !options.draftSessionTabOpen()) return;
      void refreshUsage(modelRef, thinkingLevel);
    }, delay);
  }

  function clearUsageRefresh(): void {
    if (usageRefreshTimer === undefined) return;
    clearTimeout(usageRefreshTimer);
    usageRefreshTimer = undefined;
  }

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
    if (!requestClient || !requestWorkspace || !options.statusReady() || !options.draftSessionTabOpen()
      || !effectiveModelRef || effectiveModelRef === AUTO_MODEL_REF) return;
    clearUsageRefresh();
    const requestGeneration = ++usageGeneration;
    if (clearPrevious) runtimeStatus = undefined;
    modelUsageRefreshing = true;
    let nextRefreshDelay = MODEL_USAGE_REFRESH_MS;
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
      const modelUsage = response.modelUsage
        ?? (response.modelUsageRefresh === "failed" ? runtimeStatus?.modelUsage : undefined);
      runtimeStatus = {
        sessionId: "draft",
        modelUsageRefresh: response.modelUsageRefresh,
        ...(modelUsage ? { modelUsage } : {}),
      };
      if (response.modelUsageRefresh === "unavailable" && response.modelUsageCredentialPending === true) {
        nextRefreshDelay = MODEL_USAGE_CREDENTIAL_RETRY_MS;
      }
    } catch {
      // Draft quota is best-effort just like live runtime quota. Keep the model
      // selector usable even when provider usage is temporarily unavailable.
    } finally {
      if (requestGeneration === usageGeneration) {
        modelUsageRefreshing = false;
        if (requestClient === options.client() && requestWorkspace === options.workspace() && options.draftSessionTabOpen()) {
          scheduleUsageRefresh(requestGeneration, effectiveModelRef, effectiveThinking, nextRefreshDelay);
        }
      }
    }
  }

  async function refresh(): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace || !options.statusReady()) return;
    const requestGeneration = ++generation;
    const preserveAutoSelection = autoRoutingSelected;
    const initializeSelection = !selectionInitialized;
    try {
      const response = await requestClient.draftConfig(requestWorkspace);
      if (
        requestGeneration !== generation
        || requestClient !== options.client()
        || requestWorkspace !== options.workspace()
      ) return;
      // Warm the display even before New Conversation is opened. Only defaults
      // from this sessionless response are remembered, never a staged override.
      const defaultAuto = response.modelRoutingEnabled && response.modelRoutingDefault;
      display.remember(requestWorkspace, withAutoModelRoutingOption(response.configOptions, response.modelRoutingEnabled, defaultAuto));
      if (!options.draftSessionTabOpen()) return;
      autoRoutingAvailable = response.modelRoutingEnabled;
      autoRoutingSelected = autoRoutingAvailable
        && (preserveAutoSelection || (initializeSelection && response.modelRoutingDefault));
      selectionInitialized = true;
      routedTierId = undefined;
      configOptions = withAutoModelRoutingOption(response.configOptions, autoRoutingAvailable, autoRoutingSelected);
      const state = modelThinkingConfigState(configOptions);
      if (state.currentModel && state.currentModel.ref !== AUTO_MODEL_REF) {
        void refreshUsage(state.currentModel.ref, state.currentThinking);
      }
    } catch (error) {
      if (
        requestGeneration === generation
        && requestClient === options.client()
        && requestWorkspace === options.workspace()
        && options.draftSessionTabActive()
      ) options.reportError(error);
    }
  }

  async function refreshRoutingAvailability(): Promise<void> {
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace || !options.statusReady()) return;
    const requestGeneration = ++routingStatusGeneration;
    try {
      const response = await requestClient.modelRoutingStatus(requestWorkspace);
      if (
        requestGeneration !== routingStatusGeneration
        || requestClient !== options.client()
        || requestWorkspace !== options.workspace()
      ) return;
      autoRoutingAvailable = response.enabled;
      if (!autoRoutingAvailable) {
        autoRoutingSelected = false;
        routedTierId = undefined;
      }
    } catch {
      if (requestGeneration === routingStatusGeneration) autoRoutingAvailable = false;
    }
  }

  function reset(): void {
    configOptions = [];
    modelOverride = null;
    runtimeStatus = undefined;
    modelUsageRefreshing = false;
    autoRoutingAvailable = false;
    autoRoutingSelected = false;
    routedTierId = undefined;
    selectionInitialized = false;
    clearUsageRefresh();
    generation += 1;
    usageGeneration += 1;
    routingStatusGeneration += 1;
  }

  function applySelection(modelRef: string, thinkingLevel: string): string {
    generation += 1;
    if (modelRef === AUTO_MODEL_REF) {
      if (!autoRoutingAvailable) throw new Error("Automatic model routing is disabled.");
      clearUsageRefresh();
      usageGeneration += 1;
      modelUsageRefreshing = false;
      autoRoutingSelected = true;
      routedTierId = undefined;
      modelOverride = null;
      runtimeStatus = undefined;
      configOptions = withAutoModelRoutingOption(configOptions, true, true);
      selectionInitialized = true;
      return "off";
    }
    selectionInitialized = true;
    autoRoutingSelected = false;
    routedTierId = undefined;
    configOptions = applyLocalModelThinkingSelection(configOptions, modelRef, thinkingLevel);
    const state = modelThinkingConfigState(configOptions);
    modelOverride = { modelRef, thinkingLevel: state.currentThinking };
    void refreshUsage(modelRef, state.currentThinking, true);
    return state.currentThinking;
  }

  function applyConfigValue(configId: string, value: string): void {
    if (configId === "model" && value === AUTO_MODEL_REF) {
      applySelection(AUTO_MODEL_REF, "off");
      return;
    }
    const state = modelThinkingConfigState(configOptions);
    const modelRef = configId === "model" ? value : state.currentModel?.ref;
    if (!modelRef) throw new Error("Model selection is unavailable.");
    const selected = state.models.find((model) => model.ref === modelRef);
    if (!selected) throw new Error(`Unknown model: ${modelRef}`);
    generation += 1;
    const thinkingLevel = configId === "thought_level"
      ? value
      : clampThinkingLevel(state.currentThinking, selected.thinkingLevels);
    configOptions = applyLocalModelThinkingSelection(configOptions, modelRef, thinkingLevel);
    const next = modelThinkingConfigState(configOptions);
    modelOverride = { modelRef, thinkingLevel: next.currentThinking };
    void refreshUsage(modelRef, next.currentThinking, true);
  }

  async function route(prompt: string, attachmentCount: number, signal?: AbortSignal): Promise<{ modelRef: string; thinkingLevel: string } | null> {
    if (!autoRoutingAvailable || !autoRoutingSelected) return null;
    const requestClient = options.client();
    const requestWorkspace = options.workspace();
    if (!requestClient || !requestWorkspace || !options.statusReady()) return null;
    const requestGeneration = generation;
    const response = await requestClient.routeModel(requestWorkspace, prompt, attachmentCount, signal);
    if (
      requestGeneration !== generation
      || requestClient !== options.client()
      || requestWorkspace !== options.workspace()
      || !options.draftSessionTabActive()
      || !autoRoutingSelected
    ) return null;
    routedTierId = response.tierId;
    return { modelRef: response.modelRef, thinkingLevel: response.thinkingLevel };
  }

  function pickerConfigOptions(source: readonly SessionConfigOption[], draftOwner: boolean): SessionConfigOption[] {
    return withAutoModelRoutingOption(source, autoRoutingAvailable, draftOwner && autoRoutingSelected);
  }

  return {
    get configOptions() { return configOptions; },
    get displayConfigOptions() { return display.options(options.workspace()); },
    get modelOverride() { return modelOverride; },
    get runtimeStatus() { return runtimeStatus; },
    get modelUsageRefreshing() { return modelUsageRefreshing; },
    get autoRoutingAvailable() { return autoRoutingAvailable; },
    get autoRoutingSelected() { return autoRoutingSelected; },
    get routedTierId() { return routedTierId; },
    refresh,
    refreshRoutingAvailability,
    refreshUsage,
    reset,
    applySelection,
    applyConfigValue,
    route,
    pickerConfigOptions,
  };
}

export type ModelDraftConfig = ReturnType<typeof createModelDraftConfig>;
