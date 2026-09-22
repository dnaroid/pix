import { invoke } from "@tauri-apps/api/core";
import {
  updateVisibleModelRefsInPixConfig,
  visibleModelRefsFromPixConfig,
} from "../lib/model-visibility";
import {
  modelThinkingPreferencesFromPixConfig,
  updateModelThinkingPreferenceInPixConfig,
} from "../lib/model-thinking-preferences";
import {
  modelDefaultSelectionFromPixConfig,
  updateModelDefaultSelectionInPixConfig,
  type ModelDefaultSelection,
} from "../lib/model-default-preference";
import type { SettingsConfigDocument } from "../lib/settings";

type ModelPreferencesStoreOptions = {
  reportError: (error: unknown) => void;
};

export function createModelPreferencesStore(options: ModelPreferencesStoreOptions) {
  let visibleModelRefs = $state<string[] | undefined>(undefined);
  let rememberedThinkingByModel = $state<Record<string, string>>({});
  let defaultSelection = $state<ModelDefaultSelection | undefined>(undefined);
  let visibleModelsSavePromise: Promise<void> | null = null;

  async function waitForVisibleModelsSave(): Promise<void> {
    await visibleModelsSavePromise?.catch(() => undefined);
  }

  async function load(): Promise<void> {
    try {
      const document = await invoke<SettingsConfigDocument>("read_user_config", { kind: "desktop" });
      visibleModelRefs = visibleModelRefsFromPixConfig(document.content);
      rememberedThinkingByModel = modelThinkingPreferencesFromPixConfig(document.content);
      defaultSelection = modelDefaultSelectionFromPixConfig(document.content);
    } catch {
      visibleModelRefs = undefined;
      rememberedThinkingByModel = {};
      defaultSelection = undefined;
    }
  }

  async function saveVisibleModelRefs(modelRefs: readonly string[]): Promise<void> {
    const save = performVisibleModelRefsSave(modelRefs);
    visibleModelsSavePromise = save;
    try {
      await save;
    } finally {
      if (visibleModelsSavePromise === save) visibleModelsSavePromise = null;
    }
  }

  async function performVisibleModelRefsSave(modelRefs: readonly string[]): Promise<void> {
    let document = await invoke<SettingsConfigDocument>("read_user_config", { kind: "desktop" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const content = updateVisibleModelRefsInPixConfig(document.content, modelRefs);
      const result = await invoke<{ written: boolean; document: SettingsConfigDocument }>(
        "write_user_config_if_unchanged",
        { kind: "desktop", expectedContent: document.content, content },
      );
      if (result.written) {
        visibleModelRefs = visibleModelRefsFromPixConfig(result.document.content) ?? [...modelRefs];
        return;
      }
      document = result.document;
    }
    throw new Error("Pix settings changed repeatedly while model visibility was being saved. Try again.");
  }

  async function rememberThinkingPreference(modelRef: string, thinkingLevel: string): Promise<void> {
    try {
      let document = await invoke<SettingsConfigDocument>("read_user_config", { kind: "desktop" });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const content = updateModelThinkingPreferenceInPixConfig(document.content, modelRef, thinkingLevel);
        const result = await invoke<{ written: boolean; document: SettingsConfigDocument }>(
          "write_user_config_if_unchanged",
          { kind: "desktop", expectedContent: document.content, content },
        );
        if (result.written) {
          rememberedThinkingByModel = modelThinkingPreferencesFromPixConfig(result.document.content);
          return;
        }
        document = result.document;
      }
      throw new Error("Pix settings changed repeatedly while model thinking preference was being saved.");
    } catch (error) {
      options.reportError(error);
    }
  }

  async function saveDefaultSelection(selection: ModelDefaultSelection): Promise<void> {
    let document = await invoke<SettingsConfigDocument>("read_user_config", { kind: "desktop" });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const content = updateModelDefaultSelectionInPixConfig(document.content, selection);
      const result = await invoke<{ written: boolean; document: SettingsConfigDocument }>(
        "write_user_config_if_unchanged",
        { kind: "desktop", expectedContent: document.content, content },
      );
      if (result.written) {
        defaultSelection = modelDefaultSelectionFromPixConfig(result.document.content) ?? selection;
        return;
      }
      document = result.document;
    }
    throw new Error("Pix settings changed repeatedly while the default model was being saved. Try again.");
  }

  return {
    get visibleModelRefs() { return visibleModelRefs; },
    get rememberedThinkingByModel() { return rememberedThinkingByModel; },
    get defaultSelection() { return defaultSelection; },
    waitForVisibleModelsSave,
    load,
    saveVisibleModelRefs,
    rememberThinkingPreference,
    saveDefaultSelection,
  };
}
