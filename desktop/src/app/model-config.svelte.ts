import { createModelConfigActions } from "./model-config-actions";
import type { ModelConfigOptions } from "./model-config-options";
import { createModelDraftConfig } from "./model-draft-config.svelte";
import { createModelPickerState } from "./model-picker-state.svelte";

export function createModelConfig(options: ModelConfigOptions) {
  const draft = createModelDraftConfig(options);
  const picker = createModelPickerState(options, draft);
  const actions = createModelConfigActions(options, draft, picker);

  return {
    get draftConfigOptions() { return draft.configOptions; },
    get draftModelOverride() { return draft.modelOverride; },
    get draftRuntimeStatus() { return draft.runtimeStatus; },
    get draftModelUsageRefreshing() { return draft.modelUsageRefreshing; },
    get pickerOpen() { return picker.open; },
    get pickerDraft() { return picker.draft; },
    refreshDraftConfig: draft.refresh,
    refreshDraftModelUsage: draft.refreshUsage,
    resetDraft: draft.reset,
    openPicker: picker.show,
    closePicker: picker.close,
    applySelection: actions.applySelection,
    applyModelSlashCommand: actions.applyModelSlashCommand,
    applyThinkingSlashCommand: actions.applyThinkingSlashCommand,
    setConfigValue: actions.setConfigValue,
    setConfig: actions.setConfig,
  };
}
