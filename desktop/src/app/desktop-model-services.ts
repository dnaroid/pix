import type { AcpClient } from "../lib/acp-client";
import type { ActiveSessionState } from "./active-session-state.svelte";
import type { DesktopSessionServices } from "./desktop-session-services";
import type { DesktopSessionTransitionServices } from "./desktop-session-transition-services";
import { createModelConfig } from "./model-config.svelte";
import { createModelPreferencesStore } from "./model-preferences.svelte";

type DesktopModelServicesOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  statusReady: () => boolean;
  operationRunning: () => boolean;
  changingConfig: () => string | null;
  state: ActiveSessionState;
  sessions: DesktopSessionServices;
  draftSession: () => DesktopSessionTransitionServices["draft"];
  closeCommandPicker: () => void;
  reloadResources: (options?: { echo?: boolean }) => Promise<void>;
  reportError: (error: unknown) => void;
};

export function createDesktopModelServices(options: DesktopModelServicesOptions) {
  const preferences = createModelPreferencesStore({ reportError: options.reportError });
  const config = createModelConfig({
    client: options.client,
    workspace: options.workspace,
    statusReady: options.statusReady,
    activeSessionId: () => options.state.sessionId,
    activeSessionRuntimeReady: () => options.state.runtimeReady,
    activeConfigOptions: () => options.state.configOptions,
    setActiveConfigOptions: options.state.setConfigOptions,
    draftSessionTabOpen: () => options.draftSession().open,
    draftSessionTabActive: () => options.draftSession().active,
    operationRunning: options.operationRunning,
    changingConfig: options.changingConfig,
    closeCommandPicker: options.closeCommandPicker,
    reloadResources: options.reloadResources,
    preferences,
    runtime: options.sessions.runtime,
    reportError: options.reportError,
  });

  return { preferences, config };
}

export type DesktopModelServices = ReturnType<typeof createDesktopModelServices>;
