import type { ModelConfigOptions } from "./model-config-options";
import type { ModelDraftConfig } from "./model-draft-config.svelte";

export function createModelPickerState(options: ModelConfigOptions, draftConfig: ModelDraftConfig) {
  let open = $state(false);
  let sessionId = $state<string | null>(null);
  let draft = $state(false);

  function close(): void {
    open = false;
    sessionId = null;
    draft = false;
  }

  $effect(() => {
    const pickerLostOwner = draft
      ? !options.draftSessionTabActive()
      : sessionId !== options.activeSessionId();
    if (open && pickerLostOwner) close();
  });

  async function show(): Promise<void> {
    const draftOwner = options.draftSessionTabActive();
    if (
      (!draftOwner && (!options.activeSessionId() || !options.activeSessionRuntimeReady()))
      || options.operationRunning()
      || options.changingConfig()
    ) return;
    const activeSessionId = options.activeSessionId();
    options.closeCommandPicker();
    if (draftOwner && draftConfig.configOptions.length === 0) await draftConfig.refresh();
    await options.preferences.waitForVisibleModelsSave();
    if (
      options.operationRunning()
      || options.changingConfig()
      || (draftOwner
        ? !options.draftSessionTabActive() || draftConfig.configOptions.length === 0
        : activeSessionId !== options.activeSessionId() || !options.activeSessionRuntimeReady())
    ) return;
    await options.preferences.load();
    if (
      options.operationRunning()
      || options.changingConfig()
      || (draftOwner
        ? !options.draftSessionTabActive()
        : activeSessionId !== options.activeSessionId() || !options.activeSessionRuntimeReady())
    ) return;
    draft = draftOwner;
    sessionId = draftOwner ? null : activeSessionId;
    open = true;
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
