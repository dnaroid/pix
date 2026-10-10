import { createModelConfigActions } from "./model-config-actions";
import type { ModelConfigOptions } from "./model-config-options";
import { createModelDraftConfig } from "./model-draft-config.svelte";
import { createModelPickerState } from "./model-picker-state.svelte";
import { untrack } from "svelte";

export function createModelConfig(options: ModelConfigOptions) {
  const draft = createModelDraftConfig(options);
  const picker = createModelPickerState(options, draft);
  const actions = createModelConfigActions(options, draft, picker);

  // Read local defaults at startup, not only when the model picker is opened.
  $effect(() => { void options.preferences.load(); });
  $effect(() => {
    const client = options.client();
    const workspace = options.workspace();
    if (client && workspace && options.statusReady()) {
      untrack(() => { void draft.refresh(); });
    }
  });
  $effect(() => () => draft.reset());

  return {
    get draftConfigOptions() { return draft.configOptions; },
    get draftDisplayConfigOptions() { return draft.displayConfigOptions; },
    get draftModelOverride() { return draft.modelOverride; },
    get draftRuntimeStatus() { return draft.runtimeStatus; },
    get draftModelUsageRefreshing() { return draft.modelUsageRefreshing; },
    get draftAutoRoutingAvailable() { return draft.autoRoutingAvailable; },
    get draftAutoRoutingSelected() { return draft.autoRoutingSelected; },
    get draftRoutedTierId() { return draft.routedTierId; },
    get pickerOpen() { return picker.open; },
    get pickerDraft() { return picker.draft; },
    refreshDraftConfig: draft.refresh,
    refreshDraftModelUsage: draft.refreshUsage,
    routeDraftModel: draft.route,
    pickerConfigOptions: (configOptions: Parameters<typeof draft.pickerConfigOptions>[0]) =>
      draft.pickerConfigOptions(configOptions, picker.draft),
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
