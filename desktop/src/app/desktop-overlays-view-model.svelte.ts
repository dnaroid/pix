import type { ComponentProps } from "svelte";
import DesktopOverlays from "../components/DesktopOverlays.svelte";
import { quotaWaitTimezoneLabel } from "../lib/quota-wait";
import type { PendingElicitation, createElicitationStore } from "./elicitation.svelte";
import type { createDesktopCommandController } from "./desktop-command-controller.svelte";
import type { createModelConfig } from "./model-config.svelte";
import type { createModelPreferencesStore } from "./model-preferences.svelte";
import type { QuotaWaitStore } from "./quota-wait.svelte";

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
  activeSessionId: () => string | null;
  elicitation: ReturnType<typeof createElicitationStore>;
  commands: ReturnType<typeof createDesktopCommandController>;
  modelConfig: ReturnType<typeof createModelConfig>;
  preferences: ReturnType<typeof createModelPreferencesStore>;
  quotaWait: QuotaWaitStore;
  focusComposer: () => void | Promise<void>;
}) {
  const props = $derived.by<OverlaysProps>(() => {
    const pending = options.pendingElicitation();
    const picker = options.commands.picker;
    const sessionId = options.activeSessionId();
    const waitState = options.quotaWait.popupVisible(sessionId);
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
      quotaWait: sessionId && waitState ? {
        sessionId,
        wait: waitState,
        nowMs: options.quotaWait.nowMs,
        onRetry: (id: string) => void options.quotaWait.sendAction(id, "retry"),
        onCancelAutoResume: (id: string) => void options.quotaWait.sendAction(id, "cancel"),
        onHide: (id: string) => options.quotaWait.hide(id),
      } : null,
      quotaWaitSchedule: sessionId && options.quotaWait.scheduleVisible(sessionId) ? {
        sessionId,
        timezoneLabel: quotaWaitTimezoneLabel(),
        onSubmit: (id: string, command: string) => void options.quotaWait.submitSchedule(id, command),
        onCancel: (id: string) => options.quotaWait.closeSchedule(id),
      } : null,
      modelThinking: options.modelConfig.pickerOpen ? {
        configOptions: options.modelConfig.pickerConfigOptions(options.displayedConfigOptions()),
        visibleModelRefs: options.preferences.visibleModelRefs,
        rememberedThinkingByModel: options.preferences.rememberedThinkingByModel,
        defaultSelection: options.preferences.defaultSelection,
        disabled: !options.canUseSession()
          || options.changingConfig() !== null
          || (options.draftSessionTabActive()
            ? !options.draftConfigAvailable()
            : !options.activeSessionRuntimeReady()),
        onApply: options.modelConfig.applySelection,
        onSetDefault: options.preferences.saveDefaultSelection,
        onVisibleModelsChange: options.preferences.saveVisibleModelRefs,
        onClose: options.modelConfig.closePicker,
        restoreFocus: () => { void options.focusComposer(); },
      } : null,
    };
  });

  return {
    get props() { return props; },
  };
}
