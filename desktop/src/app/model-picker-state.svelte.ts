import type { ModelConfigOptions } from "./model-config-options";
import type { ModelDraftConfig } from "./model-draft-config.svelte";

export function createModelPickerState(options: ModelConfigOptions, draftConfig: ModelDraftConfig) {
  let open = $state(false);
  let sessionId = $state<string | null>(null);
  let draft = $state(false);
  let opening = $state(false);
  let generation = 0;

  function close(): void {
    generation++;
    opening = false;
    open = false;
    sessionId = null;
    draft = false;
  }

  $effect(() => {
    const pickerLostOwner = draft
      ? !options.draftSessionTabActive()
      : sessionId !== options.activeSessionId();
    if ((open || opening) && pickerLostOwner) close();
  });

  async function show(): Promise<void> {
    if (open || opening) {
      close();
      return;
    }
    const draftOwner = options.draftSessionTabActive();
    if (
      (!draftOwner && (!options.activeSessionId() || !options.activeSessionRuntimeReady()))
      || options.operationRunning()
      || options.changingConfig()
    ) return;
    const activeSessionId = options.activeSessionId();
    const request = ++generation;
    opening = true;
    draft = draftOwner;
    sessionId = draftOwner ? null : activeSessionId;
    try {
      options.closeCommandPicker();
      if (draftOwner && draftConfig.configOptions.length === 0) await draftConfig.refresh();
      else if (!draftOwner) await draftConfig.refreshRoutingAvailability();
      if (request !== generation) return;
      await options.preferences.waitForVisibleModelsSave();
      if (
        request !== generation
        || options.operationRunning()
        || options.changingConfig()
        || (draftOwner
          ? !options.draftSessionTabActive() || draftConfig.configOptions.length === 0
          : activeSessionId !== options.activeSessionId() || !options.activeSessionRuntimeReady())
      ) return;
      await options.preferences.load();
      if (
        request !== generation
        || options.operationRunning()
        || options.changingConfig()
        || (draftOwner
          ? !options.draftSessionTabActive()
          : activeSessionId !== options.activeSessionId() || !options.activeSessionRuntimeReady())
      ) return;
      open = true;
    } finally {
      if (request === generation) opening = false;
    }
  }

  return {
    get open() { return open; },
    get sessionId() { return sessionId; },
    get draft() { return draft; },
    show,
    close,
  };
}

export type ModelPickerState = ReturnType<typeof createModelPickerState>;
