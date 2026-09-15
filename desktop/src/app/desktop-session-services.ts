import type { AcpClient } from "../lib/acp-client";
import type { ActiveSessionState } from "./active-session-state.svelte";
import { createAutocompleteStore } from "./autocomplete.svelte";
import { createSessionActivityStore } from "./session-activity.svelte";
import { createSessionCatalog } from "./session-catalog.svelte";
import { createSessionHistory } from "./session-history.svelte";
import { createSessionInspectorPreference } from "./session-inspector-preference.svelte";
import { createSessionMetadataStore } from "./session-metadata.svelte";
import { createSessionRuntimeStore } from "./session-runtime.svelte";
import { createSessionTabsState } from "./session-tabs-state.svelte";

type DesktopSessionServicesOptions = {
  client: () => AcpClient | null;
  workspace: () => string;
  state: ActiveSessionState;
  statusReady: () => boolean;
  operationRunning: () => boolean;
  refreshQueueState: (sessionId: string) => void | Promise<void>;
  scheduleScrollToLatest: () => void;
  recoverUnavailableSession: (
    client: AcpClient,
    sessionId: string,
    workspace: string,
  ) => void | Promise<void>;
  onActivityChanged?: (sessionId: string) => void;
  reportError: (error: unknown) => void;
};

export function createDesktopSessionServices(options: DesktopSessionServicesOptions) {
  const activity = createSessionActivityStore({ onChange: options.onActivityChanged });
  const inspectorPreference = createSessionInspectorPreference();
  const tabs = createSessionTabsState();
  const catalog = createSessionCatalog({
    client: options.client,
    workspace: options.workspace,
    tabs,
    reportError: options.reportError,
  });
  const runtime = createSessionRuntimeStore({
    client: options.client,
    workspace: options.workspace,
    activeSessionId: () => options.state.sessionId,
    setActiveReady: options.state.setRuntimeReady,
    setActiveConfigOptions: options.state.setConfigOptions,
    refreshQueueState: options.refreshQueueState,
    reportError: options.reportError,
  });
  const metadata = createSessionMetadataStore({
    updateSessionInfo: catalog.updateInfo,
    setConfigOptions: runtime.setConfigOptions,
    activeSessionId: () => options.state.sessionId,
    setActiveConfigOptions: options.state.setConfigOptions,
  });
  const history = createSessionHistory({
    client: options.client,
    state: options.state,
    workspace: options.workspace,
    ensureRuntime: runtime.ensure,
    runtimeReady: runtime.isReady,
    scheduleScrollToLatest: options.scheduleScrollToLatest,
    recoverUnavailableSession: options.recoverUnavailableSession,
    reportError: options.reportError,
  });
  const autocomplete = createAutocompleteStore({
    client: options.client,
    activeSessionId: () => options.state.sessionId,
    settingsReady: () => options.statusReady()
      && options.state.runtimeReady
      && !options.operationRunning()
      && !history.loading,
    promptReady: () => options.statusReady() && options.state.runtimeReady,
  });

  return {
    activity,
    inspectorPreference,
    tabs,
    catalog,
    runtime,
    metadata,
    history,
    autocomplete,
  };
}

export type DesktopSessionServices = ReturnType<typeof createDesktopSessionServices>;
