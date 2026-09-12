import type { ComponentProps } from "svelte";
import DesktopOverlays from "../components/DesktopOverlays.svelte";
import type { PendingElicitation, createElicitationStore } from "./elicitation.svelte";
import type { createDesktopCommandController } from "./desktop-command-controller.svelte";
import type { createModelConfig } from "./model-config.svelte";
import type { createModelPreferencesStore } from "./model-preferences.svelte";

type OverlaysProps = ComponentProps<typeof DesktopOverlays>;
type ModelThinkingProps = NonNullable<OverlaysProps["modelThinking"]>;

export function createDesktopOverlaysViewModel(options: {
  pendingElicitation: () => PendingElicitation | null;
  displayedConfigOptions: () => ModelThinkingProps["configOptions"];
  canUseSession: () => boolean;
  changingConfig: () => string | null;
  draftSessionTabActive: () => boolean;
  draftConfigAvailable: () => boolean;
  activeSessionRuntimeReady: () => boolean;
  elicitation: ReturnType<typeof createElicitationStore>;
  commands: ReturnType<typeof createDesktopCommandController>;
  modelConfig: ReturnType<typeof createModelConfig>;
  preferences: ReturnType<typeof createModelPreferencesStore>;
}) {
  const props = $derived.by<OverlaysProps>(() => {
    const pending = options.pendingElicitation();
    const picker = options.commands.picker;
    return {
      elicitation: pending?.kind === "form" ? {
        message: pending.message,
        field: pending.field,
        onValueChange: (value) => options.elicitation.updateFormValue(pending, value),
        onAnswer: (accepted) => options.elicitation.answerForm(pending, accepted),
      } : null,
      commandPicker: picker ? {
        picker,
        onSelect: (value) => void options.commands.selectOption(value),
        onClose: () => options.commands.setPicker(null),
      } : null,
      modelThinking: options.modelConfig.pickerOpen ? {
        configOptions: options.displayedConfigOptions(),
        visibleModelRefs: options.preferences.visibleModelRefs,
        rememberedThinkingByModel: options.preferences.rememberedThinkingByModel,
        disabled: !options.canUseSession()
          || options.changingConfig() !== null
          || (options.draftSessionTabActive()
            ? !options.draftConfigAvailable()
            : !options.activeSessionRuntimeReady()),
        onApply: options.modelConfig.applySelection,
        onVisibleModelsChange: options.preferences.saveVisibleModelRefs,
        onClose: options.modelConfig.closePicker,
      } : null,
    };
  });

  return {
    get props() { return props; },
  };
}
